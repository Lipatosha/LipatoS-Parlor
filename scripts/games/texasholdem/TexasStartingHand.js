const RANK_VALUES = Object.freeze({
    A: 14,
    K: 13,
    Q: 12,
    J: 11
});

function rankValue(card) {
    if (!card?.rank) return 0;
    return RANK_VALUES[card.rank] || Number(card.rank) || 0;
}

function clampScore(value) {
    return Math.max(0, Math.min(1, value));
}

export function scoreTexasStartingHand(cards = []) {
    const safeCards = cards.filter(card => card?.rank && card?.suit).slice(0, 2);
    if (safeCards.length !== 2) return 0;

    const ranks = safeCards.map(rankValue).sort((left, right) => right - left);
    const [high, low] = ranks;
    const pair = high === low;
    const suited = safeCards[0].suit === safeCards[1].suit;
    const gap = Math.max(0, high - low - 1);

    let score = (high * 0.025) + (low * 0.012);

    if (pair) {
        score += 0.28 + (high * 0.014);
    } else {
        if (suited) score += 0.075;
        if (gap === 0) score += 0.075;
        else if (gap === 1) score += 0.045;
        else if (gap === 2) score += 0.015;
        else if (gap === 3) score -= 0.025;
        else score -= 0.075;

        if (high >= 10 && low >= 10) score += 0.06;
        if (high === 14) score += 0.025;
        if (high <= 7 && gap >= 2) score -= 0.04;

        // A2345 方向也保留一点可玩性，但仍明显弱于高张连牌。
        if (high === 14 && low <= 5) score += Math.max(0, 0.035 - ((5 - low) * 0.008));
    }

    return clampScore(score);
}
