/**
 * Texas Hold'em 规则辅助
 *
 * 德州和三张扑克的牌型名字相似，但比较规则完全不是一层东西。
 * 这里单独收七张选五张，别把 ThreeCardPokerRules 拉成万能扑克工具。
 */

const HAND_CATEGORY_VALUE = Object.freeze({
    'high-card': 0,
    pair: 1,
    'two-pair': 2,
    'three-kind': 3,
    straight: 4,
    flush: 5,
    'full-house': 6,
    'four-kind': 7,
    'straight-flush': 8
});

export const TEXAS_HOLDEM_HAND_LABEL_KEYS = Object.freeze({
    'high-card': 'PARLOR.TexasHoldem.Hand.HighCard',
    pair: 'PARLOR.TexasHoldem.Hand.Pair',
    'two-pair': 'PARLOR.TexasHoldem.Hand.TwoPair',
    'three-kind': 'PARLOR.TexasHoldem.Hand.ThreeKind',
    straight: 'PARLOR.TexasHoldem.Hand.Straight',
    flush: 'PARLOR.TexasHoldem.Hand.Flush',
    'full-house': 'PARLOR.TexasHoldem.Hand.FullHouse',
    'four-kind': 'PARLOR.TexasHoldem.Hand.FourKind',
    'straight-flush': 'PARLOR.TexasHoldem.Hand.StraightFlush',
    'royal-flush': 'PARLOR.TexasHoldem.Hand.RoyalFlush'
});

function getRankValue(card) {
    if (!card?.rank) return 0;
    if (card.rank === 'A') return 14;
    if (card.rank === 'K') return 13;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'J') return 11;
    return Number(card.rank) || 0;
}

function sortRanksDesc(cards = []) {
    return cards
        .map(getRankValue)
        .filter(value => value > 0)
        .sort((left, right) => right - left);
}

function getStraightHigh(ranksDesc = []) {
    const uniqueAsc = [...new Set(ranksDesc)].sort((left, right) => left - right);
    if (uniqueAsc.length < 5) return 0;

    let best = 0;
    for (let index = 0; index <= uniqueAsc.length - 5; index++) {
        const run = uniqueAsc.slice(index, index + 5);
        if (run[4] - run[0] === 4) best = Math.max(best, run[4]);
    }

    // A-2-3-4-5 是合法顺子，但只按 5 高比较。
    const hasWheel = [2, 3, 4, 5, 14].every(rank => uniqueAsc.includes(rank));
    return hasWheel ? Math.max(best, 5) : best;
}

function countRanks(ranksDesc = []) {
    const counts = new Map();
    for (const rank of ranksDesc) {
        counts.set(rank, Number(counts.get(rank) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => (right[1] - left[1]) || (right[0] - left[0]));
}

function buildHand(category, compare, cards, extra = {}) {
    return {
        category,
        categoryValue: HAND_CATEGORY_VALUE[category] ?? 0,
        compare,
        cards: cards || [],
        labelKey: getTexasHoldemHandLabelKey({ category, compare, ...extra }),
        ...extra
    };
}

function chooseFive(cards = []) {
    const result = [];
    const safeCards = cards.filter(Boolean);

    for (let a = 0; a < safeCards.length - 4; a++) {
        for (let b = a + 1; b < safeCards.length - 3; b++) {
            for (let c = b + 1; c < safeCards.length - 2; c++) {
                for (let d = c + 1; d < safeCards.length - 1; d++) {
                    for (let e = d + 1; e < safeCards.length; e++) {
                        result.push([safeCards[a], safeCards[b], safeCards[c], safeCards[d], safeCards[e]]);
                    }
                }
            }
        }
    }

    return result;
}

export function evaluateFiveCardHand(cards = []) {
    const safeCards = cards.filter(Boolean).slice(0, 5);
    if (safeCards.length !== 5) {
        return buildHand('high-card', [], safeCards);
    }

    const ranksDesc = sortRanksDesc(safeCards);
    const rankCounts = countRanks(ranksDesc);
    const isFlush = new Set(safeCards.map(card => card?.suit || '')).size === 1;
    const straightHigh = getStraightHigh(ranksDesc);

    if (isFlush && straightHigh) {
        return buildHand('straight-flush', [straightHigh], safeCards, {
            isRoyal: straightHigh === 14
        });
    }

    const four = rankCounts.find(([, count]) => count === 4);
    if (four) {
        const kicker = ranksDesc.find(rank => rank !== four[0]) || 0;
        return buildHand('four-kind', [four[0], kicker], safeCards);
    }

    const three = rankCounts.find(([, count]) => count === 3);
    const pair = rankCounts.find(([, count]) => count === 2);
    if (three && pair) {
        return buildHand('full-house', [three[0], pair[0]], safeCards);
    }

    if (isFlush) {
        return buildHand('flush', ranksDesc, safeCards);
    }

    if (straightHigh) {
        return buildHand('straight', [straightHigh], safeCards);
    }

    if (three) {
        const kickers = ranksDesc.filter(rank => rank !== three[0]).slice(0, 2);
        return buildHand('three-kind', [three[0], ...kickers], safeCards);
    }

    const pairs = rankCounts
        .filter(([, count]) => count === 2)
        .map(([rank]) => rank)
        .sort((left, right) => right - left);

    if (pairs.length >= 2) {
        const kicker = ranksDesc.find(rank => !pairs.slice(0, 2).includes(rank)) || 0;
        return buildHand('two-pair', [pairs[0], pairs[1], kicker], safeCards);
    }

    if (pairs.length === 1) {
        const kickers = ranksDesc.filter(rank => rank !== pairs[0]).slice(0, 3);
        return buildHand('pair', [pairs[0], ...kickers], safeCards);
    }

    return buildHand('high-card', ranksDesc, safeCards);
}

export function compareTexasHoldemHands(left, right) {
    const leftValue = Number(left?.categoryValue ?? -1);
    const rightValue = Number(right?.categoryValue ?? -1);
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;

    const leftCompare = Array.isArray(left?.compare) ? left.compare : [];
    const rightCompare = Array.isArray(right?.compare) ? right.compare : [];
    const length = Math.max(leftCompare.length, rightCompare.length);
    for (let index = 0; index < length; index++) {
        const leftPart = Number(leftCompare[index] || 0);
        const rightPart = Number(rightCompare[index] || 0);
        if (leftPart === rightPart) continue;
        return leftPart > rightPart ? 1 : -1;
    }

    return 0;
}

export function evaluateBestTexasHoldemHand(cards = []) {
    const combos = chooseFive(cards);
    if (!combos.length) return evaluateFiveCardHand(cards);

    let best = null;
    for (const combo of combos) {
        const hand = evaluateFiveCardHand(combo);
        if (!best || compareTexasHoldemHands(hand, best) > 0) {
            best = hand;
        }
    }

    return best;
}

export function getTexasHoldemHandLabelKey(handRank) {
    if (!handRank) return TEXAS_HOLDEM_HAND_LABEL_KEYS['high-card'];
    if (handRank.category === 'straight-flush' && handRank.isRoyal) {
        return TEXAS_HOLDEM_HAND_LABEL_KEYS['royal-flush'];
    }
    return TEXAS_HOLDEM_HAND_LABEL_KEYS[handRank.category] || TEXAS_HOLDEM_HAND_LABEL_KEYS['high-card'];
}

export function splitPotAmount(amount, winnerIds = []) {
    const winners = winnerIds.filter(Boolean);
    if (!winners.length) return {};

    const cents = Math.round(Number(amount || 0) * 100);
    const base = Math.floor(cents / winners.length);
    let remainder = cents - (base * winners.length);
    const shares = {};

    for (const winnerId of winners) {
        const extra = remainder > 0 ? 1 : 0;
        shares[winnerId] = roundHoldemAmount((base + extra) / 100);
        remainder -= extra;
    }

    return shares;
}

export function roundHoldemAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

export { HAND_CATEGORY_VALUE };
