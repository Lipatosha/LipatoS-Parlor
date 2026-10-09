import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'ce-luck-round',
        deepClone: value => structuredClone(value),
        getProperty: () => null
    }
};

globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: { get: () => null, find: () => null },
    actors: { get: () => null },
    settings: { settings: new Map(), get: () => null },
    i18n: { localize: key => key, format: key => key }
};

globalThis.ui = { notifications: { warn: () => {} } };

const { OutcomeInfluence, DEFAULT_OUTCOME_INFLUENCE_CONFIG } = await import('../scripts/core/OutcomeInfluence.js');
const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { CrazyEightsGame } = await import('../scripts/games/crazyeights/CrazyEightsGame.js');
const { buildStock, sanitizeCrazyEightsOptions, handPoints, canPlayCard, cardKey } = await import('../scripts/games/crazyeights/CrazyEightsRules.js');

const c = (rank, suit) => ({ rank, suit });
const rules = sanitizeCrazyEightsOptions({}).rules;
const source = { participants: [] };

function lcg(seed = 3) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

function configWithRate(rate) {
    const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
    config.games.crazyeights.baseWinRate = rate;
    return config;
}

SettlementManager.canAfford = () => true;
SettlementManager.getBalance = () => 1000;
SettlementManager.applyDeltas = async () => true;

describe('疯狂八发牌运', () => {
    it('中性率与普通发牌逐张一致', () => {
        const stock = buildStock(1, lcg(11));
        const plain = [...stock];
        const expected = [];
        for (let i = 0; i < 5; i++) expected.push(plain.pop());

        const dealt = OutcomeInfluence.pickCrazyEightsHand(source, stock, 'actor:hero', 5, { config: configWithRate(50), rng: lcg(1), rules });
        assert.deepEqual(dealt.map(cardKey), expected.map(cardKey));
        assert.equal(stock.length, 47);
    });

    it('高率起手更常带 8、点数更低；低率相反；每次都恰好拿走 handSize 张', () => {
        const trials = 40;
        const stats = rate => {
            let eights = 0;
            let points = 0;
            const rng = lcg(rate);
            for (let i = 0; i < trials; i++) {
                const stock = buildStock(1, lcg(100 + i));
                const cards = OutcomeInfluence.pickCrazyEightsHand(source, stock, 'actor:hero', 5, { config: configWithRate(rate), rng, rules });
                assert.equal(cards.length, 5);
                assert.equal(stock.length, 47);
                eights += cards.filter(card => card.rank === '8').length;
                points += handPoints(cards, rules);
            }
            return { eights, points };
        };
        const good = stats(95);
        const bad = stats(5);
        assert.ok(good.eights > bad.eights, `good ${good.eights} vs bad ${bad.eights}`);
        assert.ok(good.points - good.eights * 50 < bad.points - bad.eights * 50);
    });
});

describe('疯狂八抽牌运', () => {
    const top = c('7', 'spades');
    const ctx = { topCard: top, currentSuit: 'spades', rules };

    it('高率抽到能出的牌，低率抽到不能出的，中性拿栈顶；每次只拿走一张', () => {
        const build = () => [c('K', 'hearts'), c('7', 'diamonds'), c('4', 'clubs'), c('9', 'hearts')];

        const goodStock = build();
        const good = OutcomeInfluence.pickCrazyEightsDraw(source, goodStock, 'actor:hero', { ...ctx, config: configWithRate(95), rng: lcg(2) });
        assert.ok(canPlayCard(good, ctx));
        assert.equal(goodStock.length, 3);

        const badStock = build();
        const bad = OutcomeInfluence.pickCrazyEightsDraw(source, badStock, 'actor:hero', { ...ctx, config: configWithRate(5), rng: lcg(2) });
        assert.equal(canPlayCard(bad, ctx), false);
        assert.equal(badStock.length, 3);

        const neutralStock = build();
        const neutral = OutcomeInfluence.pickCrazyEightsDraw(source, neutralStock, 'actor:hero', { ...ctx, config: configWithRate(50), rng: lcg(2) });
        assert.equal(cardKey(neutral), '9-hearts');
        assert.equal(neutralStock.length, 3);
    });

    it('牌堆里没有想要的牌就退回栈顶', () => {
        const stock = [c('K', 'hearts'), c('4', 'clubs')];
        const card = OutcomeInfluence.pickCrazyEightsDraw(source, stock, 'actor:hero', { ...ctx, config: configWithRate(95), rng: lcg(2) });
        assert.equal(cardKey(card), '4-clubs');
        assert.equal(OutcomeInfluence.pickCrazyEightsDraw(source, [], 'actor:hero', { ...ctx, config: configWithRate(95) }), null);
    });
});

describe('疯狂八牌运接入引擎', () => {
    it('发牌每人调一次，主动抽牌调抽牌运，罚抽不调', () => {
        const originalHand = OutcomeInfluence.pickCrazyEightsHand;
        const originalDraw = OutcomeInfluence.pickCrazyEightsDraw;
        const handCalls = [];
        let drawCalls = 0;
        OutcomeInfluence.pickCrazyEightsHand = (_source, stock, participantId, handSize) => {
            handCalls.push([participantId, handSize]);
            return stock.splice(-handSize, handSize);
        };
        OutcomeInfluence.pickCrazyEightsDraw = (_source, stock) => {
            drawCalls += 1;
            return stock.pop();
        };

        try {
            const table = new CrazyEightsGame({
                sessionId: 'ce-luck',
                playerIds: ['p1', 'p2', 'p3'],
                participants: ['p1', 'p2', 'p3'].map(id => ({ id, type: 'user', name: id })),
                crazyEightsRng: lcg(9)
            });
            table._broadcastState = () => {};
            table._scheduleTurnStart = () => {};
            table.start();
            assert.deepEqual(handCalls, [['p1', 5], ['p2', 5], ['p3', 5]]);

            table._enterTurnPhase();
            const current = table.currentPlayerId;
            // 手里换成一张肯定出不了的牌，逼一次主动抽
            table._privateHands.get(current).cards = [c('8', 'hearts')];
            table._discard = [c('7', 'spades')];
            table.currentSuit = 'spades';
            table._privateHands.get(current).cards = [c('K', 'hearts')].filter(card => card.rank !== '7');
            table._syncCounts();
            assert.deepEqual(table.handlePlayerAction(current, 'draw'), { ok: true });
            assert.equal(drawCalls, 1);

            // 罚抽走普通 pop
            const victim = table.currentPlayerId;
            table.turn.pendingDraw = 2;
            table._privateHands.get(victim).cards = [c('K', 'diamonds')];
            table._syncCounts();
            assert.deepEqual(table.handlePlayerAction(victim, 'draw'), { ok: true });
            assert.equal(drawCalls, 1);
            assert.equal(table.lastActions[0].type, 'penalty');
        } finally {
            OutcomeInfluence.pickCrazyEightsHand = originalHand;
            OutcomeInfluence.pickCrazyEightsDraw = originalDraw;
        }
    });
});
