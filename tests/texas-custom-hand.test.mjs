import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'texas-custom-token',
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

const {
    buildTexasCustomSkeleton,
    isExpectedTexasCustomHand,
    usesBothTexasHoleCards
} = await import('../scripts/games/texasholdem/TexasCustomHand.js');
const { planTexasDeal, validateTexasDealPlan } = await import('../scripts/games/texasholdem/TexasDealPlanner.js');
const {
    compareTexasHoldemHands,
    evaluateBestTexasHoldemHand
} = await import('../scripts/games/texasholdem/TexasHoldemRules.js');
const { TexasHoldemGame } = await import('../scripts/games/texasholdem/TexasHoldemGame.js');

const HAND_TYPES = [
    'royal-flush',
    'straight-flush',
    'full-house',
    'three-kind',
    'flush'
];

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

function evaluateTarget(plan, targetId) {
    return evaluateBestTexasHoldemHand([
        ...plan.holeCardsById[targetId],
        ...plan.communityCards
    ]);
}

describe('Texas randomized custom hand skeletons', () => {
    for (const handType of HAND_TYPES) {
        it(`${handType} 精确命中且两张底牌都不可替代`, () => {
            const variants = new Set();

            for (let seed = 1; seed <= 24; seed++) {
                const cards = fullDeck();
                const before = structuredClone(cards);
                const skeleton = buildTexasCustomSkeleton({
                    handType,
                    cards,
                    targetId: 'target',
                    rng: seededRng((seed * 37) + HAND_TYPES.indexOf(handType))
                });

                assert.equal(skeleton.ok, true);
                assert.equal(isExpectedTexasCustomHand(skeleton.handRank, handType), true);
                assert.equal(usesBothTexasHoleCards(
                    skeleton.holeCardsById.target,
                    skeleton.communityCards,
                    handType
                ), true);
                assert.deepEqual(cards, before);

                const allCards = [
                    ...skeleton.holeCardsById.target,
                    ...skeleton.communityCards,
                    ...skeleton.remainingCards
                ];
                assert.equal(allCards.length, 52);
                assert.equal(new Set(allCards.map(cardKey)).size, 52);

                variants.add([
                    ...skeleton.holeCardsById.target,
                    ...skeleton.communityCards
                ].map(cardKey).sort().join('|'));
            }

            assert.ok(variants.size >= 12);
        });
    }
});

describe('Texas custom hand complete deals', () => {
    it('所有定制类型在 6 人桌仍保持完整合法牌堆', () => {
        const participantIds = ['target', 'p2', 'p3', 'p4', 'p5', 'p6'];

        for (const [index, handType] of HAND_TYPES.entries()) {
            const cards = fullDeck();
            const plan = planTexasDeal({
                cards,
                participantIds,
                luckByParticipantId: { target: 'bad', p2: 'good', p3: 'bad' },
                customHand: {
                    participantId: 'target',
                    gameType: 'texasholdem',
                    handType,
                    pending: true
                },
                candidateCount: 32,
                rng: seededRng(500 + index)
            });

            assert.equal(plan.ok, true);
            assert.equal(plan.customHandCommitted, true);
            assert.equal(validateTexasDealPlan(plan, cards, participantIds).ok, true);
            assert.equal(isExpectedTexasCustomHand(evaluateTarget(plan, 'target'), handType), true);
            assert.equal(usesBothTexasHoleCards(
                plan.holeCardsById.target,
                plan.communityCards,
                handType
            ), true);
        }
    });

    for (const handType of ['three-kind', 'flush']) {
        it(`${handType} 不会压低对手，存在被自然更强牌型超越的牌局`, () => {
            let foundStrongerOpponent = false;

            for (let seed = 1; seed <= 1200 && !foundStrongerOpponent; seed++) {
                const plan = planTexasDeal({
                    cards: fullDeck(),
                    participantIds: ['target', 'opponent'],
                    luckByParticipantId: {},
                    customHand: {
                        participantId: 'target',
                        gameType: 'texasholdem',
                        handType,
                        pending: true
                    },
                    candidateCount: 1,
                    rng: seededRng((seed * 101) + HAND_TYPES.indexOf(handType))
                });
                if (!plan?.ok) continue;

                const targetHand = evaluateTarget(plan, 'target');
                const opponentHand = evaluateTarget(plan, 'opponent');
                foundStrongerOpponent = compareTexasHoldemHands(opponentHand, targetHand) > 0;
            }

            assert.equal(foundStrongerOpponent, true);
        });
    }
});

describe('TexasHoldemGame custom hand lifecycle', () => {
    it('成功后只消费定制牌型，长期牌运继续保留到下一手', async () => {
        const table = new TexasHoldemGame({
            sessionId: 'custom-lifecycle',
            playerIds: ['target', 'p2'],
            participants: [
                { id: 'target', type: 'user', name: 'Target' },
                { id: 'p2', type: 'user', name: 'P2' }
            ],
            gmOnlyOptions: {
                cardLuckPlan: {
                    luckByParticipantId: { target: 'bad', p2: 'good' },
                    customHand: {
                        participantId: 'target',
                        gameType: 'texasholdem',
                        handType: 'full-house',
                        pending: true
                    }
                }
            },
            texasDealRng: seededRng(991)
        });
        table.tableStacks = { target: 500, p2: 500 };
        table._phase = 'BUY_IN';
        table._broadcastState = async () => {};

        await table._beginHand();
        assert.equal(table._texasDealPlan.customHandCommitted, true);
        assert.equal(table.cardLuckPlan.customHand, null);
        assert.deepEqual(table.cardLuckPlan.luckByParticipantId, { target: 'bad', p2: 'good' });
        assert.equal(isExpectedTexasCustomHand(evaluateTarget(table._texasDealPlan, 'target'), 'full-house'), true);

        await table._beginHand();
        assert.notEqual(table._texasDealPlan?.customHandCommitted, true);
        assert.deepEqual(table.cardLuckPlan.luckByParticipantId, { target: 'bad', p2: 'good' });
    });

    it('规划失败时不消费 pending，也不修改原始牌堆', () => {
        const table = new TexasHoldemGame({
            sessionId: 'custom-failure',
            playerIds: ['target', 'p2'],
            participants: [
                { id: 'target', type: 'user', name: 'Target' },
                { id: 'p2', type: 'user', name: 'P2' }
            ],
            gmOnlyOptions: {
                cardLuckPlan: {
                    customHand: {
                        participantId: 'target',
                        gameType: 'texasholdem',
                        handType: 'royal-flush',
                        pending: true
                    }
                }
            },
            texasDealRng: seededRng(7)
        });
        table.deck.cards[10] = { ...table.deck.cards[0] };
        const before = structuredClone(table.deck.cards);

        const plan = table._buildDealPlan(['target', 'p2']);

        assert.equal(plan, null);
        assert.deepEqual(table.deck.cards, before);
        assert.equal(table.cardLuckPlan.customHand.pending, true);
    });
});
