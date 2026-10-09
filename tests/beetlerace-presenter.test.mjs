import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import { readFileSync } from 'node:fs';

const cn = JSON.parse(readFileSync(new URL('../languages/cn.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((node, part) => node?.[part], cn) ?? key;
const format = (key, data = {}) => String(lookup(key)).replace(/\{(\w+)\}/gu, (m, k) => data[k] ?? m);

let store = null;
globalThis.foundry = {
    utils: {
        randomID: () => Math.random().toString(36).slice(2, 12),
        deepClone: value => structuredClone(value),
        getProperty: () => null,
        escapeHTML: value => String(value ?? '')
    }
};
globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: { get: () => null, find: () => null, filter: () => [] },
    actors: { get: () => null },
    i18n: { localize: lookup, format },
    settings: {
        settings: new Map([['parlor.beetleRace', {}]]),
        get: () => structuredClone(store),
        set: async (_m, _k, value) => { store = structuredClone(value); return value; }
    }
};
globalThis.ui = { notifications: { warn: () => {}, info: () => {}, error: () => {} } };
globalThis.Hooks = { callAll: () => {}, on: () => 0, off: () => {} };

const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { SocketManager, SOCKET_EVENTS } = await import('../scripts/core/SocketManager.js');
const { BeetleRaceGame } = await import('../scripts/games/beetlerace/BeetleRaceGame.js');
const { BeetleRaceTable } = await import('../scripts/games/beetlerace/BeetleRaceTable.js');
const { BeetleRaceLibrary } = await import('../scripts/games/beetlerace/BeetleRaceLibrary.js');
const {
    buildBeetleRaceCheats,
    buildBeetleRaceHud,
    buildBeetleRaceLanes,
    buildBeetleRaceSeatEntries,
    buildBeetleRaceStatus
} = await import('../scripts/games/beetlerace/BeetleRacePresenterData.js');

const PLAYER = 'actor:alice';
const OTHER = 'actor:bob';

function makeGame() {
    const race = { ...BeetleRaceLibrary.resolveRace('preset:ravencup'), parade: false };
    let seed = 7;
    return new BeetleRaceGame({
        sessionId: 'br-presenter',
        participants: [
            { id: PLAYER, type: 'user', name: 'Alice', controllerId: 'u1' },
            { id: OTHER, type: 'user', name: 'Bob', controllerId: 'u2' }
        ],
        gameOptions: { race },
        beetleRaceRng: () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    });
}

function helpersFor({ controlled = [PLAYER], isGM = false, requests = [] } = {}) {
    return {
        t: (key, data) => (data ? format(key, data) : lookup(key)),
        getParticipantName: (_state, id) => ({ [PLAYER]: 'Alice', [OTHER]: 'Bob' })[id] || id,
        getDisplayParticipant: (_state, id) => ({ name: id, avatarHtml: '', isSelf: controlled.includes(id) }),
        getControlledParticipantIds: () => controlled,
        resolveSelectedParticipantId: () => controlled[0] || '',
        isGM: () => isGM,
        getBalance: () => 500,
        isActionPending: () => false,
        actionCategory: (id) => (id === 'dash' ? 'boost' : 'stall'),
        isMagicAction: (id) => id === 'haste',
        requestAction: (action, data) => {
            requests.push({ action, data });
            return Promise.resolve({ ok: true });
        }
    };
}

function runUntil(gameInstance, phase, limitMs = 200000) {
    let spent = 0;
    while (gameInstance.phase !== phase && spent < limitMs) {
        mock.timers.tick(100);
        spent += 100;
    }
}

describe('甲虫赛跑 Presenter 数据', () => {
    beforeEach(() => {
        store = { beetles: [], bubbles: [], moves: [], races: [], stats: {} };
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
        mock.method(SettlementManager, 'getBalance', () => 1000);
        mock.method(SettlementManager, 'applyDeltas', async () => true);
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it('lanes：名牌带战力文字、赔率、押它的人（大注在前，自己的标出来）', async () => {
        const g = makeGame();
        await g.start();
        runUntil(g, 'BETTING');
        await g.handlePlayerAction(OTHER, 'placeBet', { lane: 2, amount: 80 });
        await g.handlePlayerAction(PLAYER, 'placeBet', { lane: 2, amount: 20 });
        const lanes = buildBeetleRaceLanes(g.getState(), helpersFor());
        assert.equal(lanes.length, 6);
        assert.match(lanes[0].powerText, /^[★☆]{5}$/u);
        assert.equal(lanes[2].multiplierText, `×${Number(g.getState().race.lanes[2].multiplier).toFixed(1)}`);
        assert.deepEqual(lanes[2].backers.map(b => [b.id, b.amount, b.isSelf]), [[OTHER, 80, false], [PLAYER, 20, true]]);
        assert.equal(lanes[2].pool, 100);
    });

    it('hud：观众（非 GM 且名下没有席位）拿到 null；下注阶段 bet 动作把 lane/amount 原样交出去', async () => {
        const g = makeGame();
        await g.start();
        runUntil(g, 'BETTING');
        assert.equal(buildBeetleRaceHud(g.getState(), helpersFor({ controlled: [] })), null);

        const requests = [];
        const hud = buildBeetleRaceHud(g.getState(), helpersFor({ requests }));
        const bet = hud.actions.find(a => a.kind === 'bet');
        const withdraw = hud.actions.find(a => a.kind === 'withdraw');
        assert.ok(bet && withdraw);
        assert.equal(withdraw.disabled, true, '没押的时候全部撤回是灰的');
        await bet.onClick(null, { lane: 3, amount: '42.9' });
        assert.deepEqual(requests, [{ action: 'placeBet', data: { participantId: PLAYER, lane: 3, amount: 42 } }]);
        assert.equal(hud.limits.min, g.getState().race.minBet);
        assert.equal(hud.canBet, true);
    });

    it('hud：GM 在入场/下注阶段各有一个推进按钮，结算阶段显示输赢', async () => {
        const g = makeGame();
        await g.start();
        runUntil(g, 'BETTING');
        const gmHud = buildBeetleRaceHud(g.getState(), helpersFor({ controlled: [], isGM: true }));
        assert.deepEqual(gmHud.actions.map(a => a.kind), ['gm']);
        assert.equal(gmHud.canBet, false);

        await g.handlePlayerAction(PLAYER, 'placeBet', { lane: 0, amount: 50 });
        await g.handleGMAction('closeBetting');
        runUntil(g, 'RESOLVING');
        const hud = buildBeetleRaceHud(g.getState(), helpersFor());
        assert.ok(hud.result);
        assert.equal(hud.result.staked, 50);
        assert.equal(hud.actions.length, 0, '结算按钮在本体弹窗里，HUD 不重复');
        const seats = buildBeetleRaceSeatEntries(g.getState(), helpersFor());
        const alice = seats.find(s => s.id === PLAYER);
        assert.equal(alice.net, hud.result.net);
        assert.match(alice.statusClass, /is-(win|lose|push)/u);
        const status = buildBeetleRaceStatus(g.getState(), helpersFor());
        assert.ok(status.sub.length > 0, '结算时副标题报冠军');
    });

    it('cheats：只给 GM；明招和自然动作分组，回调带 lane', async () => {
        const g = makeGame();
        await g.start();
        assert.equal(buildBeetleRaceCheats(g.getState(), helpersFor()), null);
        const requests = [];
        const cheats = buildBeetleRaceCheats(g.getState(), helpersFor({ isGM: true, requests }));
        assert.ok(cheats.blatant.length > 0 && cheats.natural.length > 0);
        assert.ok(cheats.blatant.every(m => ['magic', 'boost', 'stall'].includes(m.tone)));
        await cheats.onCheat(4, cheats.blatant[0].id);
        await cheats.onBias(1, 1.35);
        assert.deepEqual(requests, [
            { action: 'cheat', data: { lane: 4, moveId: cheats.blatant[0].id } },
            { action: 'bias', data: { lane: 1, mul: 1.35 } }
        ]);
    });
});

describe('甲虫赛跑桌的呈现器接口', () => {
    let calls;
    beforeEach(() => {
        store = { beetles: [], bubbles: [], moves: [], races: [], stats: {} };
        mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
        mock.method(SettlementManager, 'getBalance', () => 1000);
        mock.method(SettlementManager, 'applyDeltas', async () => true);
        calls = [];
        mock.method(SocketManager, 'requestGM', async (event, payload) => {
            calls.push({ event, payload });
            return { ok: true };
        });
    });
    afterEach(() => {
        mock.timers.reset();
        mock.restoreAll();
    });

    it('动作路由：下注保留 lane/amount，作弊/暗调走 GM 通道并保留参数', async () => {
        const g = makeGame();
        const table = new BeetleRaceTable({ gameInstance: g });
        const api = table._createPresenterGameApi();
        const pending = [
            api.requestAction('placeBet', { participantId: PLAYER, lane: 2, amount: 30, button: {} }),
            api.requestAction('cheat', { lane: 1, moveId: 'preset:haste', participantId: PLAYER }),
            api.requestAction('bias', { lane: 3, mul: 0.6 })
        ];
        mock.timers.tick(1000);
        await Promise.all(pending);
        assert.deepEqual(calls.map(c => c.event), [SOCKET_EVENTS.PLAYER_ACTION, SOCKET_EVENTS.GM_ACTION, SOCKET_EVENTS.GM_ACTION]);
        assert.deepEqual(calls[0].payload, { sessionId: 'br-presenter', userId: PLAYER, action: 'placeBet', data: { lane: 2, amount: 30 } });
        assert.deepEqual(calls[1].payload.data, { lane: 1, moveId: 'preset:haste' });
        assert.deepEqual(calls[2].payload.data, { lane: 3, mul: 0.6 });
    });

    it('gameApi：比赛中 getRaceFrame 跟着主机时钟推进，结算前能跑完', async () => {
        const g = makeGame();
        const table = new BeetleRaceTable({ gameInstance: g });
        const api = table._createPresenterGameApi();
        for (const key of ['getState', 'getClock', 'getSeats', 'getStatus', 'getHud', 'getLanes', 'getCheats', 'getRaceFrame', 'requestAction', 'requestClose', 't']) {
            assert.equal(typeof api[key], 'function', key);
        }
        assert.equal(typeof api.beetles.createActor, 'function');
        assert.equal(api.beetles.trackLength, 1000);

        await g.start();
        runUntil(g, 'BETTING');
        assert.equal(api.getRaceFrame(0.016), null, '没开跑就没有画面');
        await g.handleGMAction('closeBetting');
        runUntil(g, 'RACING');
        mock.timers.tick(5000);
        const frame = api.getRaceFrame(0.016);
        assert.equal(frame.lanes.length, 6);
        assert.ok(frame.step > 200, `跑了 5 秒应该推进了几百步，实际 ${frame.step}`);
        assert.ok(frame.lanes.every(lane => lane.x > 0));
        runUntil(g, 'RESOLVING');
        let guard = 2000;
        let last = api.getRaceFrame(0.05);
        while (!last.settled && guard-- > 0) last = api.getRaceFrame(0.05);
        assert.equal(last.settled, true);
        assert.deepEqual(last.order.slice(0, 1), [g.getState().result.winnerLane], '本地跑出来的冠军跟主机一致');
    });
});
