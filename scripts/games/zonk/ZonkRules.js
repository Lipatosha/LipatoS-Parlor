/** Farkle: scoring according to the illustrated rules reference.
 * Every die in a kept selection must belong to a complete scoring combination.
 * Pure functions are shared by players, the GM referee and the bot.
 */
export const ZONK_DICE = 6;
export const ZONK_DEFAULT_TARGET = 5000;
export const ZONK_MIN_BANK = 300;

export const FARKLE_SCORE = Object.freeze({
    singleOne: 50,
    singleFive: 100,
    fourKind: 1000,
    fiveKind: 2000,
    sixKind: 3000,
    partialStraight: 750,
    straight: 1500,
    threePairs: 1500,
    doubleTriple: 2500,
    fourPlusPair: 1500
});

const equalsShape = (counts, shape) =>
    counts.filter(count => count > 0).sort((a, b) => b - a)
        .every((value, index, values) => values.length === shape.length && value === shape[index]);

/** Full-hand exclusive combinations. We do not count their dice a second time. */
function specialScore(counts, total) {
    if (total === 6) {
        if ([1, 2, 3, 4, 5, 6].every(face => counts[face] === 1)) return FARKLE_SCORE.straight;
        if (equalsShape(counts, [3, 3])) return FARKLE_SCORE.doubleTriple;
        if (equalsShape(counts, [4, 2])) return FARKLE_SCORE.fourPlusPair;
        if (equalsShape(counts, [2, 2, 2])) return FARKLE_SCORE.threePairs;
    }
    return 0;
}

export function scoreZonkDice(dice) {
    if (!Array.isArray(dice) || dice.length < 1 || dice.length > ZONK_DICE) return 0;
    if (!dice.every(face => Number.isInteger(face) && face >= 1 && face <= 6)) return 0;
    const counts = Array(7).fill(0);
    for (const face of dice) counts[face]++;

    // Search scoring partitions: partial straights can coexist with a scoring extra die.
    // At most six dice, so the state space is tiny (<= 2^6 masks).
    const memo = new Map();
    const visit = remaining => {
        const key = remaining.join('');
        if (memo.has(key)) return memo.get(key);
        const total = remaining.reduce((sum, count) => sum + count, 0);
        if (total === 0) return 0;
        let best = -Infinity;
        const candidate = (taken, points) => {
            const next = remaining.map((count, face) => count - (taken[face] || 0));
            if (next.some(count => count < 0)) return;
            const rest = visit(next);
            if (Number.isFinite(rest)) best = Math.max(best, points + rest);
        };
        const special = specialScore(remaining, total);
        if (special) best = Math.max(best, special);
        for (let face = 1; face <= 6; face++) {
            if (!remaining[face]) continue;
            if ((face === 1 || face === 5) && remaining[face] < 3) {
                const taken = Array(7).fill(0);
                taken[face] = 1;
                candidate(taken, face === 1 ? FARKLE_SCORE.singleOne : FARKLE_SCORE.singleFive);
            }
            if (remaining[face] >= 3) {
                const taken = Array(7).fill(0);
                // A four/five/six-of-a-kind is one fixed-value combination,
                // never a triple plus loose singles from the same matching group.
                for (let length = remaining[face] >= 4 ? remaining[face] : 3;
                    length <= remaining[face]; length++) {
                    taken[face] = length;
                    const points = length === 3 ? (face === 1 ? 1000 : face * 100)
                        : length === 4 ? FARKLE_SCORE.fourKind
                        : length === 5 ? FARKLE_SCORE.fiveKind : FARKLE_SCORE.sixKind;
                    candidate(taken, points);
                }
            }
        }
        if ([1, 2, 3, 4, 5].every(face => remaining[face] > 0)) {
            const taken = Array(7).fill(0);
            for (let face = 1; face <= 5; face++) taken[face] = 1;
            candidate(taken, FARKLE_SCORE.partialStraight);
        }
        memo.set(key, best);
        return best;
    };
    const points = visit(counts);
    return Number.isFinite(points) ? points : 0;
}

export function getZonkKeepOptions(dice) {
    if (!Array.isArray(dice) || !dice.length || dice.length > ZONK_DICE) return [];
    const choices = [];
    for (let mask = 1; mask < (1 << dice.length); mask++) {
        const indices = [];
        for (let index = 0; index < dice.length; index++) {
            if (mask & (1 << index)) indices.push(index);
        }
        const points = scoreZonkDice(indices.map(index => dice[index]));
        if (points) choices.push({ indices, points });
    }
    return choices.sort((a, b) => b.points - a.points || b.indices.length - a.indices.length);
}

export function canScoreZonkRoll(dice) {
    return getZonkKeepOptions(dice).length > 0;
}
