import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const settingsStore = new Map();

globalThis.foundry = {
    utils: {
        randomID: () => 'texas-plan-token',
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
        settings: settingsStore,
        get: (moduleId, key) => settingsStore.get(`${moduleId}.${key}`) ?? null
    },
    i18n: {
        localize: key => key,
        format: key => key
    }
};

globalThis.ui = { notifications: { warn: () => {} } };

const {
    DEFAULT_TEXAS_CANDIDATE_COUNT,
    planTexasDeal,
    validateTexasDealPlan
} = await import('../scripts/games/texasholdem/TexasDealPlanner.js');
const { scoreTexasStartingHand } = await import('../scripts/games/texasholdem/TexasStartingHand.js');
const { TexasHoldemGame } = await import('../scripts/games/texasholdem/TexasHoldemGame.js');
const { OutcomeInfluence } = await import('../scripts/core/OutcomeInfluence.js');

function seededRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function fullDeck() {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return suits.flatMap(suit => ranks.map(rank => ({ rank, suit })));
}

function cardKey(card) {
    return `${card.rank}:${card.suit}`;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

describe('Texas joint deal planner', () => {
    it('默认使用集中常量 96 个候选，无牌运时保留原始快速路径', () => {
        assert.equal(DEFAULT_TEXAS_CANDIDATE_COUNT, 96);

        const cards = fullDeck();
        const before = structuredClone(cards);
        const plan = planTexasDeal({
            cards,
            participantIds: ['p1', 'p2'],
            luckByParticipantId: {},
            rng: seededRng(1)
        });

        assert.equal(plan, null);
        assert.deepEqual(cards, before);
    });

    it('2 到 6 人混合牌运始终守恒 52 张牌且不修改输入', () => {
        for (let playerCount = 2; playerCount <= 6; playerCount++) {
            const participantIds = Array.from({ length: playerCount }, (_, index) => `p${index + 1}`);
            const luckByParticipantId = Object.fromEntries(participantIds.map((id, index) => [
                id,
                index % 2 === 0 ? 'good' : 'bad'
            ]));
            const cards = fullDeck();
            const before = structuredClone(cards);
            const plan = planTexasDeal({
                cards,
                participantIds,
                luckByParticipantId,
                rng: seededRng(100 + playerCount)
            });

            assert.equal(plan.ok, true);
            assert.equal(validateTexasDealPlan(plan, cards, participantIds).ok, true);
            assert.deepEqual(cards, before);
            assert.deepEqual(Object.keys(plan.holeCardsById), participantIds);
            assert.equal(plan.communityCards.length, 5);
            assert.equal(plan.remainingCards.length, 52 - (playerCount * 2) - 5);

            const allCards = [
                ...Object.values(plan.holeCardsById).flat(),
                ...plan.communityCards,
                ...plan.remainingCards
            ];
            assert.equal(allCards.length, 52);
            assert.equal(new Set(allCards.map(cardKey)).size, 52);
        }
    });

    it('10,000 手的起手质量均值与中位数满足 good > normal > bad', () => {
        const values = { good: [], normal: [], bad: [] };
        const rng = seededRng(9081);

        for (let handIndex = 0; handIndex < 10000; handIndex++) {
            const plan = planTexasDeal({
                cards: fullDeck(),
                participantIds: ['good', 'normal', 'bad'],
                luckByParticipantId: { good: 'good', bad: 'bad' },
                candidateCount: 24,
                rng
            });

            for (const id of Object.keys(values)) {
                values[id].push(scoreTexasStartingHand(plan.holeCardsById[id]));
            }
        }

        const mean = list => list.reduce((sum, value) => sum + value, 0) / list.length;
        assert.ok(mean(values.good) > mean(values.normal));
        assert.ok(mean(values.normal) > mean(values.bad));
        assert.ok(median(values.good) > median(values.normal));
        assert.ok(median(values.normal) > median(values.bad));
    });

    it('相同牌运在不同席位没有固定先手优势', () => {
        const participantIds = ['p1', 'p2', 'p3', 'p4'];
        const luckByParticipantId = Object.fromEntries(participantIds.map(id => [id, 'good']));
        const sums = Object.fromEntries(participantIds.map(id => [id, 0]));
        const rng = seededRng(4412);
        const handCount = 2500;

        for (let index = 0; index < handCount; index++) {
            const plan = planTexasDeal({
                cards: fullDeck(),
                participantIds,
                luckByParticipantId,
                candidateCount: 16,
                rng
            });
            for (const id of participantIds) {
                sums[id] += scoreTexasStartingHand(plan.holeCardsById[id]);
            }
        }

        const means = participantIds.map(id => sums[id] / handCount);
        assert.ok(Math.max(...means) - Math.min(...means) < 0.025);
    });

    it('同一配置会产生大量不同底牌和公共牌，不退化成模板', () => {
        const variants = new Set();
        const rng = seededRng(8301);

        for (let index = 0; index < 250; index++) {
            const plan = planTexasDeal({
                cards: fullDeck(),
                participantIds: ['p1', 'p2', 'p3'],
                luckByParticipantId: { p1: 'good', p2: 'bad' },
                candidateCount: 24,
                rng
            });
            variants.add([
                ...Object.values(plan.holeCardsById).flat(),
                ...plan.communityCards
            ].map(cardKey).join('|'));
        }

        assert.ok(variants.size >= 240);
    });

    it('非法输入返回失败且不污染原始牌组', () => {
        const cards = fullDeck();
        cards[10] = { ...cards[0] };
        const before = structuredClone(cards);
        const plan = planTexasDeal({
            cards,
            participantIds: ['p1', 'p2'],
            luckByParticipantId: { p1: 'good' },
            rng: seededRng(2)
        });

        assert.deepEqual(plan, { ok: false, reason: 'invalid-deck' });
        assert.deepEqual(cards, before);
    });
});

describe('TexasHoldemGame atomic deal integration', () => {
    it('DM 牌运和定制牌型优先，属性只补 normal 的初始底牌', () => {
        const config = OutcomeInfluence.getDefaultConfig();
        config.games.texasholdem.baseWinRate = 95;
        settingsStore.set('parlor.outcomeInfluenceConfig', config);

        try {
            const table = new TexasHoldemGame({
                sessionId: 'texas-attribute-priority',
                playerIds: ['p1', 'p2', 'p3'],
                participants: [
                    { id: 'p1', type: 'user', name: 'P1' },
                    { id: 'p2', type: 'user', name: 'P2' },
                    { id: 'p3', type: 'user', name: 'P3' }
                ],
                gmOnlyOptions: {
                    cardLuckPlan: {
                        luckByParticipantId: { p1: 'bad' },
                        customHand: {
                            participantId: 'p3',
                            gameType: 'texasholdem',
                            handType: 'flush',
                            pending: true
                        }
                    }
                },
                texasDealRng: () => 0
            });

            assert.deepEqual(table._buildDealLuck(['p1', 'p2', 'p3']), {
                p1: 'bad',
                p2: 'good'
            });
        } finally {
            settingsStore.delete('parlor.outcomeInfluenceConfig');
        }
    });

    it('一次提交完整底牌、公共牌与剩余牌堆', async () => {
        const table = new TexasHoldemGame({
            sessionId: 'texas-plan-session',
            playerIds: ['p1', 'p2'],
            participants: [
                { id: 'p1', type: 'user', name: 'P1' },
                { id: 'p2', type: 'user', name: 'P2' }
            ],
            gmOnlyOptions: {
                cardLuckPlan: {
                    luckByParticipantId: { p1: 'good', p2: 'bad' }
                }
            },
            texasDealRng: seededRng(702)
        });
        table.tableStacks = { p1: 200, p2: 200 };
        table._phase = 'BUY_IN';
        table._broadcastState = async () => {};

        await table._beginHand();

        const plan = table._texasDealPlan;
        assert.equal(plan?.ok, true);
        assert.equal(validateTexasDealPlan(plan, fullDeck(), ['p1', 'p2']).ok, true);
        assert.equal(table.deck.cards.length, plan.remainingCards.length);
        assert.deepEqual(table.getAuthoritativeHoleCards('p1'), plan.holeCardsById.p1);
        assert.deepEqual(table.getAuthoritativeHoleCards('p2'), plan.holeCardsById.p2);

        table._dealCommunityTo(5);
        assert.deepEqual(table.communityCards, plan.communityCards);

        const allCards = [
            ...table.getAuthoritativeHoleCards('p1'),
            ...table.getAuthoritativeHoleCards('p2'),
            ...table.communityCards,
            ...table.deck.cards
        ];
        assert.equal(allCards.length, 52);
        assert.equal(new Set(allCards.map(cardKey)).size, 52);
    });
});
