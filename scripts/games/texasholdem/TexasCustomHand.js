import { compareTexasHoldemHands, evaluateBestTexasHoldemHand } from './TexasHoldemRules.js';

export const TEXAS_CUSTOM_HAND_TYPES = Object.freeze([
    'royal-flush', 'straight-flush', 'full-house', 'three-kind', 'flush'
]);

const SUITS = Object.freeze(['hearts', 'diamonds', 'clubs', 'spades']);
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const STRAIGHTS = Object.freeze([
    ['A', '2', '3', '4', '5'],
    ['2', '3', '4', '5', '6'],
    ['3', '4', '5', '6', '7'],
    ['4', '5', '6', '7', '8'],
    ['5', '6', '7', '8', '9'],
    ['6', '7', '8', '9', '10'],
    ['7', '8', '9', '10', 'J'],
    ['8', '9', '10', 'J', 'Q'],
    ['9', '10', 'J', 'Q', 'K']
]);

function cardKey(card) {
    return `${card?.rank || ''}:${card?.suit || ''}`;
}

function randomValue(rng) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
}

function shuffle(values, rng) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(randomValue(rng) * (index + 1));
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
}

function sample(values, count, rng) {
    return shuffle(values, rng).slice(0, count);
}

function pick(values, rng) {
    return values[Math.floor(randomValue(rng) * values.length)] || values[0] || null;
}

function exactCards(cardMap, specs) {
    const cards = specs.map(({ rank, suit }) => cardMap.get(`${rank}:${suit}`) || null);
    return cards.every(Boolean) ? cards : null;
}

function madeFive(handType, cardMap, rng) {
    if (handType === 'royal-flush') {
        const suit = pick(SUITS, rng);
        return exactCards(cardMap, ['10', 'J', 'Q', 'K', 'A'].map(rank => ({ rank, suit })));
    }
    if (handType === 'straight-flush') {
        const suit = pick(SUITS, rng);
        return exactCards(cardMap, pick(STRAIGHTS, rng).map(rank => ({ rank, suit })));
    }
    if (handType === 'full-house') {
        const [threeRank, pairRank] = sample(RANKS, 2, rng);
        return exactCards(cardMap, [
            ...sample(SUITS, 3, rng).map(suit => ({ rank: threeRank, suit })),
            ...sample(SUITS, 2, rng).map(suit => ({ rank: pairRank, suit }))
        ]);
    }
    if (handType === 'three-kind') {
        const [threeRank, firstKicker, secondKicker] = sample(RANKS, 3, rng);
        return exactCards(cardMap, [
            ...sample(SUITS, 3, rng).map(suit => ({ rank: threeRank, suit })),
            { rank: firstKicker, suit: pick(SUITS, rng) },
            { rank: secondKicker, suit: pick(SUITS, rng) }
        ]);
    }
    if (handType === 'flush') {
        const suit = pick(SUITS, rng);
        return exactCards(cardMap, sample(RANKS, 5, rng).map(rank => ({ rank, suit })));
    }
    return null;
}

export function isExpectedTexasCustomHand(handRank, handType) {
    if (handType === 'royal-flush') {
        return handRank?.category === 'straight-flush' && handRank?.isRoyal === true;
    }
    if (handType === 'straight-flush') {
        return handRank?.category === 'straight-flush' && handRank?.isRoyal !== true;
    }
    return handRank?.category === handType;
}

export function usesBothTexasHoleCards(holeCards, communityCards, handType) {
    if (holeCards?.length !== 2 || communityCards?.length !== 5) return false;
    const best = evaluateBestTexasHoldemHand([...holeCards, ...communityCards]);
    if (!isExpectedTexasCustomHand(best, handType)) return false;

    const bestKeys = new Set((best.cards || []).map(cardKey));
    if (!holeCards.every(card => bestKeys.has(cardKey(card)))) return false;

    for (let index = 0; index < 2; index++) {
        const withoutHole = evaluateBestTexasHoldemHand([holeCards[1 - index], ...communityCards]);
        if (compareTexasHoldemHands(best, withoutHole) <= 0) return false;
    }
    return true;
}

export function buildTexasCustomSkeleton({
    handType,
    cards,
    targetId,
    rng = Math.random,
    maxAttempts = 512
} = {}) {
    const safeTargetId = String(targetId || '').trim();
    const safeHandType = String(handType || '').trim().toLowerCase();
    const sourceCards = Array.isArray(cards) ? cards.map(card => ({ ...card })) : [];
    const sourceKeys = sourceCards.map(cardKey);
    if (
        !safeTargetId
        || !TEXAS_CUSTOM_HAND_TYPES.includes(safeHandType)
        || sourceCards.length !== 52
        || new Set(sourceKeys).size !== sourceCards.length
    ) return { ok: false, reason: 'invalid-custom-input' };

    const cardMap = new Map(sourceCards.map(card => [cardKey(card), card]));
    const attempts = Math.max(1, Math.min(2048, Math.floor(Number(maxAttempts) || 512)));
    for (let attempt = 0; attempt < attempts; attempt++) {
        const targetFive = madeFive(safeHandType, cardMap, rng);
        if (!targetFive) continue;
        if (!isExpectedTexasCustomHand(evaluateBestTexasHoldemHand(targetFive), safeHandType)) continue;

        const holeCards = sample(targetFive, 2, rng);
        const holeKeys = new Set(holeCards.map(cardKey));
        const madeCommunity = targetFive.filter(card => !holeKeys.has(cardKey(card)));
        const targetKeys = new Set(targetFive.map(cardKey));
        const fillers = sample(sourceCards.filter(card => !targetKeys.has(cardKey(card))), 2, rng);
        const communityCards = shuffle([...madeCommunity, ...fillers], rng);
        if (!usesBothTexasHoleCards(holeCards, communityCards, safeHandType)) continue;

        const usedKeys = new Set([...holeCards, ...communityCards].map(cardKey));
        const remainingCards = sourceCards.filter(card => !usedKeys.has(cardKey(card)));
        return {
            ok: true,
            targetId: safeTargetId,
            handType: safeHandType,
            holeCardsById: { [safeTargetId]: holeCards },
            communityCards,
            remainingCards,
            handRank: evaluateBestTexasHoldemHand([...holeCards, ...communityCards])
        };
    }
    return { ok: false, reason: 'custom-generation-failed' };
}
