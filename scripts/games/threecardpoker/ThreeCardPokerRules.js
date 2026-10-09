/**
 * Three Card Poker 规则辅助
 *
 * 先把牌型比较和赔率都收在一处，免得桌面和逻辑各写一遍。
 */

const CATEGORY_VALUE = Object.freeze({
    'high-card': 0,
    pair: 1,
    flush: 2,
    straight: 3,
    'three-kind': 4,
    'straight-flush': 5
});

export const THREE_CARD_POKER_HAND_LABEL_KEYS = Object.freeze({
    'high-card': 'PARLOR.ThreeCardPoker.Hand.HighCard',
    pair: 'PARLOR.ThreeCardPoker.Hand.Pair',
    flush: 'PARLOR.ThreeCardPoker.Hand.Flush',
    straight: 'PARLOR.ThreeCardPoker.Hand.Straight',
    'three-kind': 'PARLOR.ThreeCardPoker.Hand.ThreeKind',
    'straight-flush': 'PARLOR.ThreeCardPoker.Hand.StraightFlush',
    'mini-royal': 'PARLOR.ThreeCardPoker.Hand.MiniRoyal'
});

export const THREE_CARD_POKER_PAIR_PLUS_PAYTABLE = Object.freeze({
    miniRoyal: 50,
    straightFlush: 40,
    threeKind: 30,
    straight: 6,
    flush: 3,
    pair: 1
});

export const THREE_CARD_POKER_ANTE_BONUS_PAYTABLE = Object.freeze({
    straightFlush: 5,
    threeKind: 4,
    straight: 1
});

function getRankValue(card) {
    if (!card?.rank) return 0;
    if (card.rank === 'A') return 14;
    if (card.rank === 'K') return 13;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'J') return 11;
    return Number(card.rank) || 0;
}

function getSortedRanks(cards) {
    return (cards || [])
        .map(getRankValue)
        .sort((a, b) => b - a);
}

function getStraightHigh(ranksDesc = []) {
    const ranksAsc = [...ranksDesc].sort((a, b) => a - b);
    if (ranksAsc.length !== 3) return 0;
    if ((new Set(ranksAsc)).size !== 3) return 0;

    if (ranksAsc[0] + 1 === ranksAsc[1] && ranksAsc[1] + 1 === ranksAsc[2]) {
        return ranksAsc[2];
    }

    // A-2-3 在这桌要认作顺子，但按最小顺来比。
    if (ranksAsc[0] === 2 && ranksAsc[1] === 3 && ranksAsc[2] === 14) {
        return 3;
    }

    return 0;
}

function buildRankCountMap(ranksDesc = []) {
    const counts = new Map();
    for (const rank of ranksDesc) {
        counts.set(rank, Number(counts.get(rank) || 0) + 1);
    }
    return counts;
}

function buildResult(category, compare = [], extra = {}) {
    return {
        category,
        categoryValue: CATEGORY_VALUE[category] ?? 0,
        compare,
        ...extra
    };
}

export function isMiniRoyal(cards = []) {
    const ranks = getSortedRanks(cards);
    if (ranks.length !== 3) return false;
    const suits = new Set(cards.map(card => card?.suit || ''));
    return suits.size === 1 && ranks[0] === 14 && ranks[1] === 13 && ranks[2] === 12;
}

export function evaluateThreeCardPokerHand(cards = []) {
    const safeCards = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const ranksDesc = getSortedRanks(safeCards);
    const rankCounts = buildRankCountMap(ranksDesc);
    const countEntries = [...rankCounts.entries()]
        .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
    const isFlush = (new Set(safeCards.map(card => card?.suit || ''))).size === 1;
    const straightHigh = getStraightHigh(ranksDesc);

    if (isFlush && straightHigh) {
        return buildResult('straight-flush', [straightHigh], {
            isMiniRoyal: isMiniRoyal(safeCards),
            ranks: ranksDesc
        });
    }

    if (countEntries[0]?.[1] === 3) {
        return buildResult('three-kind', [countEntries[0][0]], { ranks: ranksDesc });
    }

    if (straightHigh) {
        return buildResult('straight', [straightHigh], { ranks: ranksDesc });
    }

    if (isFlush) {
        return buildResult('flush', ranksDesc, { ranks: ranksDesc });
    }

    if (countEntries[0]?.[1] === 2) {
        const pairRank = countEntries[0][0];
        const kicker = countEntries[1]?.[0] || 0;
        return buildResult('pair', [pairRank, kicker], { ranks: ranksDesc });
    }

    return buildResult('high-card', ranksDesc, { ranks: ranksDesc });
}

export function compareThreeCardPokerHands(left, right) {
    const leftValue = Number(left?.categoryValue ?? -1);
    const rightValue = Number(right?.categoryValue ?? -1);

    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;

    const leftCompare = Array.isArray(left?.compare) ? left.compare : [];
    const rightCompare = Array.isArray(right?.compare) ? right.compare : [];
    const length = Math.max(leftCompare.length, rightCompare.length);

    for (let i = 0; i < length; i++) {
        const leftPart = Number(leftCompare[i] || 0);
        const rightPart = Number(rightCompare[i] || 0);
        if (leftPart === rightPart) continue;
        return leftPart > rightPart ? 1 : -1;
    }

    return 0;
}

export function dealerQualifies(handRank) {
    if (!handRank) return false;
    if (handRank.categoryValue > CATEGORY_VALUE['high-card']) return true;
    return Number(handRank.compare?.[0] || 0) >= 12;
}

export function getThreeCardPokerHandLabelKey(handRank, { preferMiniRoyal = false } = {}) {
    if (!handRank) return THREE_CARD_POKER_HAND_LABEL_KEYS['high-card'];
    if (preferMiniRoyal && handRank.isMiniRoyal) return THREE_CARD_POKER_HAND_LABEL_KEYS['mini-royal'];
    return THREE_CARD_POKER_HAND_LABEL_KEYS[handRank.category] || THREE_CARD_POKER_HAND_LABEL_KEYS['high-card'];
}

export function getPairPlusOdds(handRank) {
    if (!handRank) return 0;
    if (handRank.isMiniRoyal) return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.miniRoyal;

    switch (handRank.category) {
        case 'straight-flush': return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.straightFlush;
        case 'three-kind': return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.threeKind;
        case 'straight': return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.straight;
        case 'flush': return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.flush;
        case 'pair': return THREE_CARD_POKER_PAIR_PLUS_PAYTABLE.pair;
        default: return 0;
    }
}

export function getAnteBonusOdds(handRank) {
    if (!handRank) return 0;
    switch (handRank.category) {
        case 'straight-flush': return THREE_CARD_POKER_ANTE_BONUS_PAYTABLE.straightFlush;
        case 'three-kind': return THREE_CARD_POKER_ANTE_BONUS_PAYTABLE.threeKind;
        case 'straight': return THREE_CARD_POKER_ANTE_BONUS_PAYTABLE.straight;
        default: return 0;
    }
}

export function shouldPlayThreeCardPokerHand(handRank) {
    if (!handRank) return false;
    if (handRank.categoryValue > CATEGORY_VALUE['high-card']) return true;

    const highCards = Array.isArray(handRank.compare) ? handRank.compare : [];
    const threshold = [12, 6, 4]; // Q-6-4
    for (let i = 0; i < threshold.length; i++) {
        const current = Number(highCards[i] || 0);
        if (current === threshold[i]) continue;
        return current > threshold[i];
    }
    return true;
}

export { CATEGORY_VALUE };
