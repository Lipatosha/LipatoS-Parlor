import {
    DEFAULT_BLACKJACK_RULES,
    getBlackjackTotal,
    isNaturalHand,
    sanitizeBlackjackRules
} from './BlackjackRules.js';

const MANUAL_LUCK_RATES = Object.freeze({
    normal: 50,
    good: 78,
    bad: 22
});

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function safeRandom(rng) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return clamp(value, 0, 0.9999999999999999);
}

function takeCardAt(deck, index) {
    if (!deck?.cards?.length) return deck?.deal?.() || null;
    if (!Number.isInteger(index) || index < 0 || index >= deck.cards.length) {
        return deck.deal();
    }
    return deck.cards.splice(index, 1)[0] || null;
}

function getRate({ mode = 'normal', rate = null } = {}) {
    const numericRate = Number(rate);
    if (Number.isFinite(numericRate)) return clamp(numericRate, 0, 100);
    return MANUAL_LUCK_RATES[String(mode || 'normal')] ?? MANUAL_LUCK_RATES.normal;
}

export function scoreBlackjackHand(cards = [], rules = DEFAULT_BLACKJACK_RULES) {
    const safeRules = sanitizeBlackjackRules(rules);
    const total = getBlackjackTotal(cards, safeRules);
    const over = total - safeRules.bustThreshold;

    if (over > 0) {
        return clamp(0.12 - (over * 0.025), 0.01, 0.1);
    }

    let quality = total / safeRules.bustThreshold;
    if (cards.length === 2 && isNaturalHand(cards, safeRules)) quality = 1;
    if (cards.some(card => card?.rank === 'A')) quality += 0.015;
    return clamp(quality, 0, 1);
}

export function scoreBlackjackCard(currentCards = [], card = null, rules = DEFAULT_BLACKJACK_RULES) {
    return scoreBlackjackHand([...currentCards, card].filter(Boolean), rules);
}

export function takeWeightedBlackjackCard(deck, currentCards = [], options = {}) {
    if (!deck?.cards?.length) return deck?.deal?.() || null;

    const rate = getRate(options);
    const distance = Math.abs(rate - 50);
    if (distance < 0.5) return deck.deal();

    const direction = rate > 50 ? 1 : -1;
    const strength = clamp(distance / 45, 0, 1);
    const exponent = 1.5 + (strength * 3.5);
    const rules = options.rules || DEFAULT_BLACKJACK_RULES;
    const rng = options.rng || Math.random;
    const weighted = deck.cards.map((card, index) => {
        const quality = scoreBlackjackCard(currentCards, card, rules);
        const satisfaction = direction > 0 ? quality : 1 - quality;
        return {
            index,
            weight: 0.2 + Math.exp(satisfaction * exponent)
        };
    });

    const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
    let cursor = safeRandom(rng) * totalWeight;
    for (const candidate of weighted) {
        cursor -= candidate.weight;
        if (cursor <= 0) return takeCardAt(deck, candidate.index);
    }

    return takeCardAt(deck, weighted.at(-1)?.index);
}

export function buildBlackjackNatural(deck, { rng = Math.random } = {}) {
    if (!deck?.cards?.length) return { ok: false, cards: [] };

    const aceIndices = [];
    const tenValueIndices = [];
    for (const [index, card] of deck.cards.entries()) {
        if (card?.rank === 'A') aceIndices.push(index);
        if (['10', 'J', 'Q', 'K'].includes(card?.rank)) tenValueIndices.push(index);
    }

    if (!aceIndices.length || !tenValueIndices.length) return { ok: false, cards: [] };

    const aceIndex = aceIndices[Math.floor(safeRandom(rng) * aceIndices.length)];
    const tenIndex = tenValueIndices[Math.floor(safeRandom(rng) * tenValueIndices.length)];
    const ace = deck.cards[aceIndex];
    const tenValue = deck.cards[tenIndex];

    for (const index of [aceIndex, tenIndex].sort((left, right) => right - left)) {
        deck.cards.splice(index, 1);
    }

    return {
        ok: true,
        cards: [ace, tenValue]
    };
}
