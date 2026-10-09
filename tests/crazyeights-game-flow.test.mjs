import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => `ce-round-${Math.random().toString(36).slice(2, 8)}`,
        deepClone: value => structuredClone(value),
        getProperty: () => null
    }
};

globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: {
        get: () => null,
        find: () => null
    },
    actors: { get: () => null },
    settings: {
        settings: new Map(),
        get: () => null
    },
    i18n: {
        localize: key => key,
        format: key => key
    }
};

globalThis.ui = { notifications: { warn: () => {} } };

const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { CrazyEightsGame } = await import('../scripts/games/crazyeights/CrazyEightsGame.js');
const { sortHand, cardKey } = await import('../scripts/games/crazyeights/CrazyEightsRules.js');

const c = (rank, suit) => ({ rank, suit });

function lcg(seed = 7) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

const applied = [];
let affordable = () => true;

SettlementManager.canAfford = id => affordable(id);
SettlementManager.getBalance = () => 1000;
SettlementManager.applyDeltas = async entries => { applied.push(entries); return true; };

function makeGame({ ids = ['p1', 'p2', 'p3'], options = {}, participants = null, seed = 7 } = {}) {
    const table = new CrazyEightsGame({
        sessionId: 'ce-flow',
        playerIds: ids,
        participants: participants || ids.map(id => ({ id, type: 'user', name: id.toUpperCase() })),
        gameOptions: options,
        crazyEightsRng: lcg(seed)
    });
    table._broadcastState = () => {};
    table._scheduleTurnStart = () => {};
    return table;
}

/** 直接摆桌：绕过发牌，把手牌/牌堆/顶牌按测试需要放好 */
function rig(table, { hands, stock = [], discard, current, direction = 1, pendingDraw = 0, turnOrder = null, currentSuit = '' }) {
    const ids = Object.keys(hands);
    table.round = table.round || 1;
    table.roundToken = 'tok';
    table.roundPlayerIds = ids;
    table.sittingOutPlayerIds = [];
    table.turnOrder = turnOrder || ids;
    table.bets = ids.map(userId => ({ userId, amount: table.options.ante }));
    table.pot = table.options.ante * ids.length;
    table._privateHands = new Map(ids.map(id => [id, { roundToken: 'tok', version: 1, cards: sortHand(hands[id]) }]));
    table._stock = [...stock];
    table._discard = [...discard];
    table.currentSuit = currentSuit || discard[discard.length - 1]?.suit || '';
    table.direction = direction;
    table.currentPlayerId = current || table.turnOrder[0];
    table.turn = { mustChooseSuit: false, pendingDraw, drawnThisTurn: false, drawCountThisTurn: 0 };
    table.passStreak = 0;
    table.lastActions = [];
    table.winnerIds = [];
    table.roundResult = null;
    table.settlementApplied = false;
    table._phase = 'PLAYER_TURNS';
    table._syncCounts();
    return table;
}

const hand = (table, id) => table.getAuthoritativeHand(id).map(cardKey);
const types = table => table.lastActions.map(entry => entry.type);

beforeEach(() => {
    applied.length = 0;
    affordable = () => true;
});

describe('疯狂八：开局发牌', () => {
    it('3 人一副牌各 5 张，起底不是 8，手牌已排序', () => {
        const table = makeGame();
        table.start();

        assert.equal(table.phase, 'DEALING');
        assert.equal(table.deckCount, 1);
        assert.equal(table.handSize, 5);
        assert.equal(table.roundPlayerIds.length, 3);
        assert.deepEqual(table.bets.map(entry => entry.amount), [10, 10, 10]);
        assert.equal(table.pot, 30);
        for (const id of ['p1', 'p2', 'p3']) {
            const cards = table.getAuthoritativeHand(id);
            assert.equal(cards.length, 5);
            assert.deepEqual(cards.map(cardKey), sortHand(cards).map(cardKey));
            assert.equal(table.handCounts[id], 5);
        }
        assert.notEqual(table.discardTop.rank, '8');
        assert.equal(table.discardCount, 1);
        assert.equal(table.stockCount, 52 - 15 - 1);
        assert.equal(table.currentSuit, table.discardTop.suit);
        assert.equal(table.currentPlayerId, table.turnOrder[0]);
        assert.deepEqual(types(table), ['deal']);

        table._enterTurnPhase();
        assert.equal(table.phase, 'PLAYER_TURNS');
    });

    it('6 人两副牌', () => {
        const table = makeGame({ ids: ['a', 'b', 'c', 'd', 'e', 'f'] });
        table.start();
        assert.equal(table.deckCount, 2);
        assert.equal(table.handSize, 5);
        assert.equal(table.stockCount, 104 - 30 - 1);
    });

    it('2 人各 7 张', () => {
        const table = makeGame({ ids: ['a', 'b'] });
        table.start();
        assert.equal(table.handSize, 7);
        assert.equal(table.stockCount, 52 - 14 - 1);
    });

    it('付不起底注的席位本局旁观；不足两人直接流产', () => {
        affordable = id => id !== 'p3';
        const table = makeGame();
        table.start();
        assert.deepEqual(table.sittingOutPlayerIds, ['p3']);
        assert.deepEqual(table.roundPlayerIds, ['p1', 'p2']);
        assert.equal(table.turnOrder.includes('p3'), false);
        assert.equal(table.handSize, 7);

        affordable = id => id === 'p1';
        const aborted = makeGame();
        aborted.start();
        assert.equal(aborted.phase, 'RESOLVING');
        assert.equal(aborted.roundResult.kind, 'aborted');
        assert.deepEqual(aborted.bets, []);
        assert.equal(aborted.settlementApplied, true);
    });

    it('豁免席位（自测局的 DM）付不起底注也入座，结算时不动账', async () => {
        affordable = id => id !== 'p1';
        const table = makeGame({ options: { exemptParticipantIds: ['p1'] } });
        table.start();
        assert.deepEqual(table.roundPlayerIds, ['p1', 'p2', 'p3']);
        assert.deepEqual(table.sittingOutPlayerIds, []);

        rig(table, {
            hands: { p1: [c('7', 'hearts')], p2: [c('K', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.exemptParticipantIds = ['p1'];
        table.handlePlayerAction('p1', 'playCard', c('7', 'hearts'));
        assert.equal(table.phase, 'RESOLVING');
        assert.equal(table.payouts.p1, 30);
        await table.handleGMAction('finishGame');
        assert.deepEqual(applied[0].map(entry => entry.userId).sort(), ['p2', 'p3']);
    });

    it('首家随局数轮转', () => {
        const table = makeGame();
        table.start();
        assert.equal(table.turnOrder[0], 'p1');
        table._phase = 'RESOLVING';
        table.roundResult = { rows: [] };
        return table.handleGMAction('newRound').then(result => {
            assert.deepEqual(result, { ok: true });
            assert.equal(table.round, 2);
            assert.equal(table.turnOrder[0], 'p2');
            assert.equal(table.phase, 'DEALING');
        });
    });

    it('本地控制的席位直接收到私牌，旧版本包不会顶掉新手牌', () => {
        const table = makeGame({
            participants: [
                { id: 'p1', type: 'user', name: 'P1', controllerId: 'gm1' },
                { id: 'p2', type: 'user', name: 'P2', controllerId: 'other' }
            ],
            ids: ['p1', 'p2']
        });
        table.start();
        const visible = table.getVisibleHand('p1');
        assert.ok(Array.isArray(visible));
        assert.equal(visible.length, 7);
        assert.equal(table.getVisibleHand('p2'), null);

        table.handlePrivateUpdate({
            sessionId: 'ce-flow', type: 'crazyeights.hand', participantId: 'p1',
            round: table.round, roundToken: table.roundToken, version: 0, cards: [c('A', 'clubs')]
        });
        assert.equal(table.getVisibleHand('p1').length, 7);
    });
});

describe('疯狂八：出牌与选花色', () => {
    it('花色或点数对上就能出，出完轮到下家', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('7', 'hearts'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });

        assert.deepEqual(table.handlePlayerAction('p2', 'playCard', c('3', 'clubs')), { ok: false, reason: 'not-current' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('K', 'clubs')), { ok: false, reason: 'card-not-playable' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('9', 'clubs')), { ok: false, reason: 'card-not-in-hand' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', { rank: 'Z', suit: 'x' }), { ok: false, reason: 'invalid-card' });

        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('7', 'hearts')), { ok: true });
        assert.equal(cardKey(table.discardTop), '7-hearts');
        assert.equal(table.currentSuit, 'hearts');
        assert.equal(table.currentPlayerId, 'p2');
        assert.deepEqual(hand(table, 'p1'), ['K-clubs']);
        assert.equal(table.handCounts.p1, 1);
        assert.deepEqual(types(table), ['play']);
        assert.equal(table.lastActions[0].participantId, 'p1');
        assert.equal(table.turnStep, 1);
    });

    it('出 8 后先选花色再轮下家', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('8', 'clubs'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });

        assert.deepEqual(table.handlePlayerAction('p1', 'chooseSuit', { suit: 'hearts' }), { ok: false, reason: 'no-suit-needed' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('8', 'clubs')), { ok: true });
        assert.equal(table.turn.mustChooseSuit, true);
        assert.equal(table.currentPlayerId, 'p1');
        assert.deepEqual(types(table), ['wild']);

        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: false, reason: 'must-choose-suit' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('K', 'clubs')), { ok: false, reason: 'must-choose-suit' });
        assert.deepEqual(table.handlePlayerAction('p1', 'chooseSuit', { suit: 'stars' }), { ok: false, reason: 'invalid-suit' });
        assert.deepEqual(table.handlePlayerAction('p1', 'chooseSuit', { suit: 'diamonds' }), { ok: true });
        assert.equal(table.currentSuit, 'diamonds');
        assert.equal(table.turn.mustChooseSuit, false);
        assert.equal(table.currentPlayerId, 'p2');
        assert.deepEqual(types(table), ['chooseSuit']);
    });

    it('最后一张是 8 直接赢，不用选花色', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('8', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('8', 'clubs')), { ok: true });
        assert.equal(table.phase, 'RESOLVING');
        assert.deepEqual(table.winnerIds, ['p1']);
        assert.equal(table.roundResult.kind, 'win');
    });
});

describe('疯狂八：抽牌与过', () => {
    it('抽一张规则：抽到不能出自动过；抽到能出可以出也可以留', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'clubs'), c('7', 'diamonds'), c('3', 'diamonds')],
            discard: [c('7', 'spades')]
        });

        assert.deepEqual(table.handlePlayerAction('p1', 'pass'), { ok: false, reason: 'cannot-pass' });
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.deepEqual(hand(table, 'p1'), ['K-hearts', '3-diamonds']);
        assert.deepEqual(types(table), ['draw', 'pass']);
        assert.equal(table.lastActions[1].autoPass, true);
        assert.equal(table.currentPlayerId, 'p2');
        assert.equal(table.passStreak, 1);

        // 回到 p1：这次抽到 7♦ 能出
        table.currentPlayerId = 'p1';
        table.turn = { mustChooseSuit: false, pendingDraw: 0, drawnThisTurn: false, drawCountThisTurn: 0 };
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.equal(table.currentPlayerId, 'p1');
        assert.deepEqual(types(table), ['draw']);
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: false, reason: 'cannot-draw' });
        assert.deepEqual(table.handlePlayerAction('p1', 'pass'), { ok: true });
        assert.equal(table.passStreak, 0);
        assert.equal(table.currentPlayerId, 'p2');
    });

    it('抽到能出规则：抽到能出必须出，三张后仍无自动过', () => {
        const table = rig(makeGame({ options: { drawRule: 'untilPlayable' } }), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('5', 'clubs'), c('7', 'diamonds'), c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });

        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.equal(table.currentPlayerId, 'p1');
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.deepEqual(hand(table, 'p1'), ['K-hearts', '7-diamonds', '9-diamonds']);
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: false, reason: 'cannot-draw' });
        assert.deepEqual(table.handlePlayerAction('p1', 'pass'), { ok: false, reason: 'cannot-pass' });
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('7', 'diamonds')), { ok: true });
        assert.equal(table.currentPlayerId, 'p2');

        const capped = rig(makeGame({ options: { drawRule: 'untilPlayable' } }), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('5', 'clubs'), c('9', 'diamonds'), c('10', 'diamonds'), c('J', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        capped.handlePlayerAction('p1', 'draw');
        capped.handlePlayerAction('p1', 'draw');
        assert.equal(capped.currentPlayerId, 'p1');
        capped.handlePlayerAction('p1', 'draw');
        assert.equal(capped.currentPlayerId, 'p2');
        assert.deepEqual(types(capped), ['draw', 'pass']);
        assert.equal(hand(capped, 'p1').length, 4);
    });

    it('牌堆抽空洗弃牌堆，顶牌留下', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [],
            discard: [c('5', 'clubs'), c('6', 'clubs'), c('9', 'diamonds'), c('7', 'spades')]
        });
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.equal(hand(table, 'p1').length, 2);
        assert.equal(cardKey(table.discardTop), '7-spades');
        assert.equal(table.discardCount, 1);
        assert.equal(table.stockCount, 2);
        assert.ok(types(table).includes('reshuffle'));
    });
});

describe('疯狂八：功能牌', () => {
    it('J 跳过下家', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('J', 'spades'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'playCard', c('J', 'spades'));
        assert.equal(table.currentPlayerId, 'p3');
        assert.deepEqual(types(table), ['play', 'skip']);
        assert.equal(table.lastActions[1].targetId, 'p2');
    });

    it('Q 反转方向；2 人局当跳过', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('Q', 'spades'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'playCard', c('Q', 'spades'));
        assert.equal(table.direction, -1);
        assert.equal(table.currentPlayerId, 'p3');
        assert.deepEqual(types(table), ['play', 'reverse']);

        const duel = rig(makeGame({ ids: ['p1', 'p2'] }), {
            hands: { p1: [c('Q', 'spades'), c('K', 'clubs')], p2: [c('3', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        duel.handlePlayerAction('p1', 'playCard', c('Q', 'spades'));
        assert.equal(duel.direction, 1);
        assert.equal(duel.currentPlayerId, 'p1');
        assert.deepEqual(types(duel), ['play', 'skip']);
    });

    it('2 罚抽可叠加，下家没 2 自动罚抽并跳过', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('2', 'spades'), c('K', 'clubs')], p2: [c('2', 'hearts'), c('9', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('A', 'diamonds'), c('3', 'diamonds'), c('5', 'diamonds'), c('6', 'diamonds'), c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'playCard', c('2', 'spades'));
        assert.equal(table.currentPlayerId, 'p2');
        assert.equal(table.turn.pendingDraw, 2);
        assert.deepEqual(table.handlePlayerAction('p2', 'playCard', c('9', 'clubs')), { ok: false, reason: 'pending-draw' });

        table.handlePlayerAction('p2', 'playCard', c('2', 'hearts'));
        // p3 没 2：自动吃 4 张并跳过，轮回 p1
        assert.equal(table.currentPlayerId, 'p1');
        assert.equal(table.turn.pendingDraw, 0);
        assert.equal(hand(table, 'p3').length, 5);
        assert.equal(table.stockCount, 1);
        assert.deepEqual(types(table), ['play', 'penalty']);
        assert.equal(table.lastActions[1].participantId, 'p3');
        assert.equal(table.lastActions[1].count, 4);
    });

    it('手里有 2 也可以选择接罚', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('2', 'spades'), c('K', 'clubs')], p2: [c('2', 'hearts'), c('9', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('A', 'diamonds'), c('3', 'diamonds'), c('5', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'playCard', c('2', 'spades'));
        assert.deepEqual(table.handlePlayerAction('p2', 'pass'), { ok: false, reason: 'cannot-pass' });
        assert.deepEqual(table.handlePlayerAction('p2', 'draw'), { ok: true });
        assert.equal(hand(table, 'p2').length, 4);
        assert.equal(table.currentPlayerId, 'p3');
        assert.deepEqual(types(table), ['penalty']);
    });

    it('经典预设下 2/J/Q 都是普通牌', () => {
        const table = rig(makeGame({ options: { actionCards: 'classic' } }), {
            hands: { p1: [c('2', 'spades'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'playCard', c('2', 'spades'));
        assert.equal(table.currentPlayerId, 'p2');
        assert.equal(table.turn.pendingDraw, 0);
        assert.deepEqual(types(table), ['play']);
    });
});

describe('疯狂八：结算', () => {
    it('出完即赢：底注入池 + 尾牌罚金，结算只提交一次', async () => {
        const table = rig(makeGame({ options: { penaltyPerPoint: 1 } }), {
            hands: { p1: [c('7', 'hearts')], p2: [c('8', 'spades')], p3: [c('K', 'clubs'), c('A', 'clubs')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });

        assert.deepEqual(await table.handleGMAction('finishGame'), { ok: false, reason: 'phase' });
        assert.equal(applied.length, 0);

        table.handlePlayerAction('p1', 'playCard', c('7', 'hearts'));
        assert.equal(table.phase, 'RESOLVING');
        assert.deepEqual(table.winnerIds, ['p1']);
        assert.equal(table.roundResult.kind, 'win');
        assert.equal(table.currentPlayerId, '');
        assert.deepEqual(table.revealedHands.p2.map(cardKey), ['8-spades']);
        assert.deepEqual(table.getVisibleHand('p2').map(cardKey), ['8-spades']);
        assert.equal(table.payouts.p1, 30 + 50 + 11);
        assert.equal(table.settlementApplied, false);

        assert.deepEqual(await table.handleGMAction('finishGame'), { ok: true });
        assert.deepEqual(await table.handleGMAction('finishGame'), { ok: true });
        assert.equal(applied.length, 1);
        const deltas = Object.fromEntries(applied[0].map(entry => [entry.userId, entry.delta]));
        assert.deepEqual(deltas, { p1: 81, p2: -60, p3: -21 });

        await table.handleGMAction('newRound');
        assert.equal(applied.length, 1);
        assert.equal(table.round, 2);
        assert.equal(table.settlementApplied, false);
    });

    it('流局：最低点数赢，同分平分，不算罚金', () => {
        const dead = rig(makeGame({ ids: ['p1', 'p2'], options: { penaltyPerPoint: 3 } }), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'diamonds')] },
            stock: [],
            discard: [c('7', 'spades')]
        });
        assert.deepEqual(dead.handlePlayerAction('p1', 'draw'), { ok: false, reason: 'cannot-draw' });
        assert.deepEqual(dead.handlePlayerAction('p1', 'pass'), { ok: true });
        // p2 也动不了，自动过后一整圈没人出牌 → 流局
        assert.equal(dead.phase, 'RESOLVING');
        assert.equal(dead.roundResult.kind, 'dead');
        assert.deepEqual(dead.winnerIds, ['p2']);
        assert.equal(dead.payouts.p2, 20);
        assert.equal(dead.roundResult.rows.find(row => row.id === 'p1').penalty, 0);
        assert.deepEqual(types(dead), ['pass', 'pass', 'dead']);

        const split = rig(makeGame({ ids: ['p1', 'p2'] }), {
            hands: { p1: [c('K', 'hearts')], p2: [c('K', 'diamonds')] },
            stock: [],
            discard: [c('7', 'spades')]
        });
        split.handlePlayerAction('p1', 'pass');
        assert.equal(split.roundResult.kind, 'split');
        assert.deepEqual(split.winnerIds, ['p1', 'p2']);
        assert.equal(split.payouts.p1, 10);
    });

    it('抽完自动过也计入流局连击', () => {
        const table = rig(makeGame({ ids: ['p1', 'p2'] }), {
            hands: { p1: [c('K', 'hearts')], p2: [c('3', 'diamonds')] },
            stock: [c('9', 'diamonds')],
            discard: [c('7', 'spades')]
        });
        table.handlePlayerAction('p1', 'draw');
        assert.equal(table.stockCount, 0);
        // p1 抽完自动过（连击 1），p2 无牌可出无牌可抽也自动过（连击 2）→ 流局
        assert.equal(table.passStreak, 2);
        assert.deepEqual(types(table), ['draw', 'pass', 'pass', 'dead']);
        assert.equal(table.phase, 'RESOLVING');
        assert.equal(table.roundResult.kind, 'dead');
        assert.deepEqual(table.winnerIds, ['p2']);
    });
});

describe('疯狂八：保留 8 与抽牌的选择时机', () => {
    it('出 8 前可以抽牌，出 8 后只能指定花色', () => {
        const table = rig(makeGame(), {
            hands: { p1: [c('8', 'clubs'), c('K', 'clubs')], p2: [c('3', 'clubs')], p3: [c('4', 'clubs')] },
            stock: [c('9', 'diamonds')], discard: [c('7', 'spades')]
        });
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: true });
        assert.ok(hand(table, 'p1').includes('8-clubs'));
        assert.equal(table.turn.mustChooseSuit, false);
        assert.deepEqual(table.handlePlayerAction('p1', 'playCard', c('8', 'clubs')), { ok: true });
        assert.equal(table.turn.mustChooseSuit, true);
        assert.deepEqual(table.handlePlayerAction('p1', 'draw'), { ok: false, reason: 'must-choose-suit' });
        assert.deepEqual(table.handlePlayerAction('p1', 'chooseSuit', { suit: 'hearts' }), { ok: true });
        assert.equal(table.currentPlayerId, 'p2');
    });
});
