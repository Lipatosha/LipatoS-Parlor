import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { readFileSync } from 'node:fs';

const cn = JSON.parse(readFileSync(new URL('../languages/cn.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((node, part) => node?.[part], cn) ?? key;

let store = null;
globalThis.foundry = {
    utils: {
        randomID: () => Math.random().toString(36).slice(2, 12),
        deepClone: value => structuredClone(value),
        getProperty: () => null
    }
};
globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: { get: () => null, find: () => null },
    actors: { get: () => null },
    i18n: { localize: lookup, format: lookup },
    settings: {
        settings: new Map([['parlor.beetleRace', {}]]),
        get: () => structuredClone(store),
        set: async (_m, _k, value) => { store = structuredClone(value); return value; }
    }
};
globalThis.ui = { notifications: { warn: () => {} } };
globalThis.Hooks = { callAll: () => {} };

const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { BeetleRaceGame } = await import('../scripts/games/beetlerace/BeetleRaceGame.js');
const { BeetleRaceLibrary } = await import('../scripts/games/beetlerace/BeetleRaceLibrary.js');
const { PARADE_STEP_MS, PARADE_INTRO_MS, COUNTDOWN_MS } = await import('../scripts/games/beetlerace/BeetleRaceRules.js');
const { INTERVENTION_LEAD_STEPS } = await import('../scripts/games/beetlerace/BeetleRaceSim.js');

const PLAYER = 'actor:alice';
const GM_SEAT = 'actor:dm';

function makeGame({ parade = true } = {}) {
    const race = { ...BeetleRaceLibrary.resolveRace('preset:ravencup'), parade };
    let seed = 1;
    return new BeetleRaceGame({
        sessionId: 'br-test',
        participants: [
            { id: PLAYER, type: 'user', name: 'Alice', controllerId: 'u1' },
            { id: GM_SEAT, type: 'user', name: 'DM', controllerId: 'gm1' },
            { id: 'bot_0', type: 'bot', name: 'Bot' }
        ],
        gameOptions: { race, exemptParticipantIds: [GM_SEAT] },
        // 固定种子：同一份测试每次跑出同一场比赛
        beetleRaceRng: () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    });
}

// 快进到阶段变化（比赛那一段最长几十秒，按 100ms 一格推）
function runUntil(game, phase, limitMs = 200000) {
    let spent = 0;
    while (game.phase !== phase && spent < limitMs) {
        mock.timers.tick(100);
        spent += 100;
    }
    return spent;
}

describe('BeetleRaceGame 流程', () => {
    let deltas;
    beforeEach(() => {
        store = { beetles: [], bubbles: [], moves: [], races: [], stats: {} };
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
        deltas = [];
        mock.method(SettlementManager, 'getBalance', (id) => (id === PLAYER ? 100 : 0));
        mock.method(SettlementManager, 'applyDeltas', async (entries) => { deltas.push(...entries); return true; });
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it('第一场先巡游：开幕一段，然后每只一个节拍，巡完进下注', () => {
        const game = makeGame();
        game.start();
        assert.equal(game.phase, 'PARADE');
        // 开幕那段第一只还没上台，所以第一个节拍要多等一个开幕
        mock.timers.tick(PARADE_STEP_MS);
        assert.equal(game.paradeIndex, 0, '开幕期间不该换下一只');
        mock.timers.tick(PARADE_INTRO_MS);
        assert.equal(game.paradeIndex, 1);
        const spent = runUntil(game, 'BETTING');
        assert.equal(game.phase, 'BETTING');
        assert.equal(spent, PARADE_STEP_MS * 5, '剩下五只，一只一个节拍');
    });

    it('GM 可以跳过巡游', async () => {
        const game = makeGame();
        game.start();
        await game.handleGMAction('skipParade');
        assert.equal(game.phase, 'BETTING');
    });

    it('下注：可以押几只、可以改注、合计不能超过余额；不进账的席位不查余额', () => {
        const game = makeGame({ parade: false });
        game.start();
        assert.equal(game.phase, 'BETTING');
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 3, amount: 60 }).ok, true);
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 0, amount: 30 }).ok, true);
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 1, amount: 20 }).reason, 'chips', '60+30+20 超过 100');
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 3, amount: 70 }).ok, true, '改注按新注额算：70+30');
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 9, amount: 5 }).reason, 'invalid-lane');
        assert.equal(game.handlePlayerAction(GM_SEAT, 'placeBet', { lane: 2, amount: 99999 }).ok, true, 'DM 席位不进账，押多少都行');
        assert.equal(game.handlePlayerAction(PLAYER, 'placeBet', { lane: 3, amount: 0 }).ok, true, '0 = 撤掉这只');
        assert.deepEqual(game.bets.filter(b => b.userId === PLAYER).map(b => [b.lane, b.amount]), [[0, 30]]);
    });

    it('下注倒计时到点自动封盘；倒数完开跑；跑完进结算，派彩按冠军倍率', async () => {
        const game = makeGame({ parade: false });
        game.start();
        game.handlePlayerAction(PLAYER, 'placeBet', { lane: 0, amount: 10 });
        game.handlePlayerAction(PLAYER, 'placeBet', { lane: 1, amount: 10 });
        game.handlePlayerAction(PLAYER, 'placeBet', { lane: 2, amount: 10 });
        mock.timers.tick(game.race.betSeconds * 1000);
        assert.equal(game.phase, 'COUNTDOWN');
        mock.timers.tick(COUNTDOWN_MS);
        assert.equal(game.phase, 'RACING');
        runUntil(game, 'RESOLVING');
        assert.equal(game.phase, 'RESOLVING');
        assert.equal(game.order.length, 6);

        const winner = game.order[0];
        const row = game.result.rows.find(r => r.id === PLAYER);
        const expected = [0, 1, 2].includes(winner) ? Math.floor(10 * game.race.lanes[winner].multiplier) : 0;
        assert.equal(row.payout, expected);
        assert.equal(row.net, expected - 30);
    });

    it('结算只在下一场 / 散桌时记一次账，DM 和机器人不进账；第二场不再巡游', async () => {
        const game = makeGame();
        game.start();
        await game.handleGMAction('skipParade');
        game.handlePlayerAction(PLAYER, 'placeBet', { lane: 0, amount: 50 });
        game.handlePlayerAction(GM_SEAT, 'placeBet', { lane: 1, amount: 500 });
        game.handlePlayerAction('bot_0', 'placeBet', { lane: 2, amount: 40 });
        await game.handleGMAction('closeBetting');
        runUntil(game, 'RESOLVING');
        assert.equal(deltas.length, 0, '结算前不动钱');
        await game.handleGMAction('newRound');
        assert.deepEqual(deltas.map(d => d.userId), [PLAYER]);
        assert.equal(game.phase, 'BETTING');
        assert.equal(game.round, 2);
        assert.equal(game.bets.length, 0);
        await game.handleGMAction('finishGame');
        assert.equal(deltas.length, 1, '同一场账不会记两次');
    });

    it('局中散桌不动钱', async () => {
        const game = makeGame({ parade: false });
        game.start();
        game.handlePlayerAction(PLAYER, 'placeBet', { lane: 0, amount: 50 });
        await game.handleGMAction('closeBetting');
        mock.timers.tick(COUNTDOWN_MS + 3000);
        assert.equal((await game.handleGMAction('finishGame')).reason, 'phase');
        assert.equal(deltas.length, 0);
    });

    it('作弊：排在主机当前步之后，招式参数取开局快照；封盘前、比赛外不许作弊', async () => {
        const game = makeGame({ parade: false });
        game.start();
        assert.equal((await game.handleGMAction('cheat', { lane: 1, moveId: 'preset:spellFreeze' })).reason, 'phase');
        await game.handleGMAction('closeBetting');
        mock.timers.tick(COUNTDOWN_MS + 5000);
        assert.equal(game.phase, 'RACING');
        const hostStep = game._sim.step;
        const lines = game.race.cheats.find(move => move.id === 'preset:spellFreeze').bubbles;
        await BeetleRaceLibrary.savePresetMoveOptions('preset:spellFreeze', { enabled: false, bubbleIds: [] });
        assert.equal((await game.handleGMAction('cheat', { lane: 1, moveId: 'preset:spellFreeze', bubbles: ['伪造台词'] })).ok, true);
        const iv = game.run.interventions[0];
        assert.equal(iv.actionId, 'freeze');
        assert.deepEqual(iv.bubbles, lines, '干预只认开局快照，不受工坊或请求参数影响');
        assert.ok(game._sim.pool.every(move => move.bubbles.length >= 2), '模拟规格保留随机招式台词池');
        assert.ok(iv.step >= hostStep + INTERVENTION_LEAD_STEPS);
        assert.equal((await game.handleGMAction('cheat', { lane: 1, moveId: 'nope' })).reason, 'invalid-move');
        assert.equal((await game.handleGMAction('bias', { lane: 2, mul: 9 })).ok, true);
        assert.equal(game.biases[2], 1.8, '暗调被夹在上限');
    });

    it('一场跑完会给上场的甲虫记战绩', async () => {
        const game = makeGame({ parade: false });
        game.start();
        await game.handleGMAction('closeBetting');
        runUntil(game, 'RESOLVING');
        await Promise.resolve();
        const stats = BeetleRaceLibrary.listBeetles().filter(b => game.race.lanes.some(l => l.beetleId === b.id)).map(b => b.stats);
        assert.ok(stats.every(s => s.races === 1));
        assert.equal(stats.reduce((sum, s) => sum + s.wins, 0), 1);
    });

    it('散桌后定时器停掉：会话没了就不再跑比赛、不记战绩', async () => {
        const { ParlorManager } = await import('../scripts/core/ParlorManager.js');
        const game = makeGame({ parade: false });
        ParlorManager._sessions.set(game.sessionId, { game, isHostGM: true });
        try {
            game.start();
            await game.handleGMAction('closeBetting');
            mock.timers.tick(COUNTDOWN_MS + 2000);
            assert.equal(game.phase, 'RACING');
            ParlorManager._sessions.delete(game.sessionId);
            runUntil(game, 'RESOLVING', 120000);
            assert.equal(game.phase, 'RACING', '会话没了之后比赛停在原地');
            assert.equal(BeetleRaceLibrary.listBeetles().every(b => b.stats.races === 0), true);
        } finally {
            ParlorManager._sessions.delete(game.sessionId);
        }
    });

    it('客户端的计时用收到状态那一刻换算，不看自己建实例的时间', () => {
        const host = makeGame({ parade: false });
        host.start();
        mock.timers.tick(10000);
        const state = host.getState();
        game.user.isGM = false;
        try {
            const client = makeGame({ parade: false });
            mock.timers.tick(5000);
            client.setState(state);
            mock.timers.tick(2000);
            const remaining = client.getClock().bettingRemainingMs;
            assert.equal(remaining, host.race.betSeconds * 1000 - 12000);
        } finally {
            game.user.isGM = true;
        }
    });
});
