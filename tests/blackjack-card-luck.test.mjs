import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function seededRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

function card(rank, suit = 'clubs') {
    return { rank: String(rank), suit };
}

function fullDeck() {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    return suits.flatMap(suit => ranks.map(rank => card(rank, suit)));
}

function shuffle(cards, rng) {
    const result = cards.map(entry => ({ ...entry }));
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function deckFrom(cards) {
    return {
        cards: cards.map(entry => ({ ...entry })),
        deal() {
            return this.cards.pop() || null;
        }
    };
}

globalThis.foundry = {
    utils: {
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

globalThis.ui = {
    notifications: {
        warn: () => {}
    }
};

const {
    buildBlackjackNatural,
    scoreBlackjackHand,
    takeWeightedBlackjackCard
} = await import('../scripts/games/blackjack/BlackjackCardLuck.js');
const { BlackjackGame } = await import('../scripts/games/blackjack/BlackjackGame.js');

async function withImmediateTimers(callback) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = fn => {
        fn();
        return 1;
    };
    globalThis.clearTimeout = () => {};
    try {
        return await callback();
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
}

async function dealOnePlayer({ luck = 'normal', customHand = null, cards = fullDeck(), seed = 1 } = {}) {
    const table = new BlackjackGame({
        sessionId: `session-${luck}`,
        playerIds: ['p1'],
        participants: [{ id: 'p1', type: 'user', name: 'P1' }],
        gmOnlyOptions: {
            cardLuckPlan: {
                luckByParticipantId: { p1: luck },
                customHand
            }
        }
    });
    table._phase = 'READY';
    table.bets = [{ userId: 'p1', amount: 10 }];
    table.deck = deckFrom(cards);
    table._cardLuckRng = seededRng(seed);
    table._broadcastState = async () => {};
    await withImmediateTimers(() => table._dealInitialCards());
    return table;
}

describe('Blackjack weighted card luck', () => {
    it('10,000 手的牌面质量满足 good > normal > bad 且分布仍有重叠', () => {
        const modes = ['good', 'normal', 'bad'];
        const totals = Object.fromEntries(modes.map(mode => [mode, []]));

        for (const [modeIndex, mode] of modes.entries()) {
            const rng = seededRng(700 + modeIndex);
            for (let handIndex = 0; handIndex < 10000; handIndex++) {
                const deck = deckFrom(shuffle(fullDeck(), rng));
                const first = takeWeightedBlackjackCard(deck, [], { mode, rng });
                const second = takeWeightedBlackjackCard(deck, [first], { mode, rng });
                totals[mode].push(scoreBlackjackHand([first, second]));
            }
        }

        const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
        assert.ok(mean(totals.good) > mean(totals.normal));
        assert.ok(mean(totals.normal) > mean(totals.bad));

        const rounded = mode => new Set(totals[mode].map(value => value.toFixed(2)));
        const overlap = [...rounded('good')].filter(value => rounded('bad').has(value));
        assert.ok(overlap.length >= 3);
    });

    it('差牌模式是加权倾向，不会把补牌退化成固定爆牌', () => {
        let safe = 0;
        let bust = 0;
        const rng = seededRng(991);

        for (let i = 0; i < 1000; i++) {
            const deck = deckFrom([card('K'), card('2')]);
            const picked = takeWeightedBlackjackCard(deck, [card('10'), card('6')], {
                mode: 'bad',
                rng
            });
            if (picked.rank === '2') safe++;
            if (picked.rank === 'K') bust++;
        }

        assert.ok(safe > 0);
        assert.ok(bust > 0);
    });

    it('自然 Blackjack 随机取 Ace 与十点牌且失败时不污染牌堆', () => {
        const variants = new Set();
        for (let seed = 1; seed <= 24; seed++) {
            const deck = deckFrom(fullDeck());
            const result = buildBlackjackNatural(deck, { rng: seededRng(seed) });
            assert.equal(result.ok, true);
            assert.equal(result.cards.some(entry => entry.rank === 'A'), true);
            assert.equal(result.cards.some(entry => ['10', 'J', 'Q', 'K'].includes(entry.rank)), true);
            variants.add(result.cards.map(entry => `${entry.rank}:${entry.suit}`).join('|'));
        }
        assert.ok(variants.size >= 8);

        const impossible = deckFrom([card('2'), card('3')]);
        const before = structuredClone(impossible.cards);
        const failed = buildBlackjackNatural(impossible, { rng: seededRng(1) });
        assert.equal(failed.ok, false);
        assert.deepEqual(impossible.cards, before);
    });
});

describe('BlackjackGame card luck integration', () => {
    it('相同牌堆下玩家牌运不会改变庄家起手牌', async () => {
        const cards = shuffle(fullDeck(), seededRng(77));
        for (let seed = 1; seed <= 8; seed++) {
            const good = await dealOnePlayer({ luck: 'good', cards, seed });
            const bad = await dealOnePlayer({ luck: 'bad', cards, seed });

            assert.deepEqual(good.dealerHand.handCards, bad.dealerHand.handCards);
        }
    });

    it('成功发出一次性自然牌后消费定制，但保留长期牌运', async () => {
        const table = await dealOnePlayer({
            luck: 'bad',
            customHand: {
                participantId: 'p1',
                gameType: 'blackjack',
                handType: 'natural-blackjack',
                pending: true
            },
            seed: 18
        });

        assert.equal(scoreBlackjackHand(table.playerHands.p1.handCards, { naturalBonus: false }), 1);
        assert.equal(table.cardLuckPlan.customHand, null);
        assert.equal(table.cardLuckPlan.luckByParticipantId.p1, 'bad');
    });

    it('定制生成失败时保留 pending，普通发牌仍能继续', async () => {
        const table = await dealOnePlayer({
            luck: 'bad',
            customHand: {
                participantId: 'p1',
                gameType: 'blackjack',
                handType: 'natural-blackjack',
                pending: true
            },
            cards: [card('2'), card('3'), card('4'), card('5'), card('6'), card('7')],
            seed: 4
        });

        assert.equal(table.playerHands.p1.handCards.length, 2);
        assert.equal(table.cardLuckPlan.customHand.pending, true);
    });
});
