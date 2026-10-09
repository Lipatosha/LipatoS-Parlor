import { scoreTexasStartingHand } from './TexasStartingHand.js';
import {
    buildTexasCustomSkeleton,
    TEXAS_CUSTOM_HAND_TYPES
} from './TexasCustomHand.js';

export const DEFAULT_TEXAS_CANDIDATE_COUNT = 96;

function cardKey(card) {
    return `${card?.rank || ''}:${card?.suit || ''}`;
}

function safeRandom(rng) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
}

function sanitizeParticipantIds(participantIds) {
    const ids = Array.isArray(participantIds)
        ? participantIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
    if (ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length) return [];
    return ids;
}

function sanitizeLuck(participantIds, luckByParticipantId) {
    const activeIds = new Set(participantIds);
    return Object.fromEntries(Object.entries(luckByParticipantId || {})
        .filter(([id, mode]) => activeIds.has(id) && ['good', 'bad'].includes(mode)));
}

function sanitizeCustomHand(participantIds, customHand) {
    if (!customHand || customHand.pending === false) return null;
    const participantId = String(customHand.participantId || '').trim();
    const handType = String(customHand.handType || '').trim().toLowerCase();
    if (
        !participantId
        || !participantIds.includes(participantId)
        || !TEXAS_CUSTOM_HAND_TYPES.includes(handType)
    ) return null;

    return {
        participantId,
        handType,
        pending: true
    };
}

function hasValidDeck(cards) {
    if (!Array.isArray(cards) || cards.length !== 52) return false;
    const keys = cards.map(cardKey);
    return keys.every(key => !key.startsWith(':')) && new Set(keys).size === cards.length;
}

function shuffledCopy(cards, rng) {
    const shuffled = [...cards];
    for (let index = shuffled.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(safeRandom(rng) * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
}

function scoreSatisfaction(holeCardsById, luckByParticipantId) {
    const satisfaction = [];
    for (const [participantId, mode] of Object.entries(luckByParticipantId)) {
        const handScore = scoreTexasStartingHand(holeCardsById[participantId]);
        satisfaction.push(mode === 'good' ? handScore : 1 - handScore);
    }
    if (!satisfaction.length) return 0.5;
    const average = satisfaction.reduce((sum, score) => sum + score, 0) / satisfaction.length;
    const minimum = Math.min(...satisfaction);
    return (average * 0.7) + (minimum * 0.3);
}

function buildCandidate(cards, participantIds, luckByParticipantId, rng) {
    const shuffled = shuffledCopy(cards, rng);
    const holeCardsById = {};
    let cursor = 0;

    for (const participantId of participantIds) {
        holeCardsById[participantId] = shuffled.slice(cursor, cursor + 2);
        cursor += 2;
    }

    const communityCards = shuffled.slice(cursor, cursor + 5);
    cursor += 5;
    const remainingCards = shuffled.slice(cursor);
    return {
        ok: true,
        holeCardsById,
        communityCards,
        remainingCards,
        score: scoreSatisfaction(holeCardsById, luckByParticipantId)
    };
}

function buildCustomCandidate(cards, participantIds, luckByParticipantId, customHand, rng) {
    const skeleton = buildTexasCustomSkeleton({
        handType: customHand.handType,
        cards,
        targetId: customHand.participantId,
        rng
    });
    if (!skeleton.ok) return null;

    const shuffled = shuffledCopy(skeleton.remainingCards, rng);
    const holeCardsById = { ...skeleton.holeCardsById };
    let cursor = 0;
    for (const participantId of participantIds) {
        if (participantId === customHand.participantId) continue;
        holeCardsById[participantId] = shuffled.slice(cursor, cursor + 2);
        cursor += 2;
    }

    return {
        ok: true,
        holeCardsById,
        communityCards: skeleton.communityCards,
        remainingCards: shuffled.slice(cursor),
        score: scoreSatisfaction(holeCardsById, luckByParticipantId),
        customHandCommitted: true
    };
}

function pickCandidate(candidates, rng) {
    const sorted = [...candidates].sort((left, right) => right.score - left.score);
    const poolSize = Math.max(1, Math.ceil(sorted.length * 0.2));
    const pool = sorted.slice(0, poolSize);
    const floor = pool.at(-1)?.score || 0;
    const weighted = pool.map(candidate => ({
        candidate,
        weight: 1 + (Math.max(0, candidate.score - floor) * 12)
    }));
    const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let cursor = safeRandom(rng) * totalWeight;

    for (const entry of weighted) {
        cursor -= entry.weight;
        if (cursor <= 0) return entry.candidate;
    }
    return weighted.at(-1)?.candidate || null;
}

export function validateTexasDealPlan(plan, sourceCards, participantIds) {
    const safeIds = sanitizeParticipantIds(participantIds);
    if (!plan?.ok || !safeIds.length || !Array.isArray(sourceCards)) {
        return { ok: false, reason: 'invalid-plan' };
    }

    const holeCards = [];
    for (const participantId of safeIds) {
        const cards = plan.holeCardsById?.[participantId];
        if (!Array.isArray(cards) || cards.length !== 2) {
            return { ok: false, reason: 'invalid-hole-cards' };
        }
        holeCards.push(...cards);
    }

    if (!Array.isArray(plan.communityCards) || plan.communityCards.length !== 5) {
        return { ok: false, reason: 'invalid-community-cards' };
    }
    if (!Array.isArray(plan.remainingCards)) {
        return { ok: false, reason: 'invalid-remaining-cards' };
    }

    const plannedCards = [...holeCards, ...plan.communityCards, ...plan.remainingCards];
    const sourceKeys = sourceCards.map(cardKey).sort();
    const plannedKeys = plannedCards.map(cardKey).sort();
    if (
        plannedCards.length !== sourceCards.length
        || new Set(plannedKeys).size !== plannedKeys.length
        || sourceKeys.some((key, index) => key !== plannedKeys[index])
    ) {
        return { ok: false, reason: 'card-conservation' };
    }

    return { ok: true };
}

export function planTexasDeal({
    cards,
    participantIds,
    luckByParticipantId = {},
    customHand = null,
    candidateCount = DEFAULT_TEXAS_CANDIDATE_COUNT,
    rng = Math.random
} = {}) {
    const safeIds = sanitizeParticipantIds(participantIds);
    if (!safeIds.length) return { ok: false, reason: 'invalid-participants' };

    const safeLuck = sanitizeLuck(safeIds, luckByParticipantId);
    const safeCustomHand = sanitizeCustomHand(safeIds, customHand);
    if (!Object.keys(safeLuck).length && !safeCustomHand) return null;
    if (!hasValidDeck(cards)) return { ok: false, reason: 'invalid-deck' };
    if (safeCustomHand) delete safeLuck[safeCustomHand.participantId];

    const sourceCards = cards.map(card => ({ ...card }));
    const safeCandidateCount = Math.max(1, Math.min(512, Math.floor(Number(candidateCount) || DEFAULT_TEXAS_CANDIDATE_COUNT)));
    const candidates = [];
    for (let index = 0; index < safeCandidateCount; index++) {
        const candidate = safeCustomHand
            ? buildCustomCandidate(sourceCards, safeIds, safeLuck, safeCustomHand, rng)
            : buildCandidate(sourceCards, safeIds, safeLuck, rng);
        if (candidate) candidates.push(candidate);
    }

    const selected = pickCandidate(candidates, rng);
    if (!selected) {
        return {
            ok: false,
            reason: safeCustomHand ? 'custom-generation-failed' : 'candidate-generation-failed',
            customHandCommitted: false
        };
    }

    const validation = validateTexasDealPlan(selected, sourceCards, safeIds);
    return validation.ok ? selected : validation;
}
