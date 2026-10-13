/** Pure scoring rules for the six-dice tavern game Zonk (Farkle).
 * Selection must be fully scoreable: no inert dice can be kept.
 */
export const ZONK_DICE = 6;
export const ZONK_DEFAULT_TARGET = 5000;
export const ZONK_MIN_BANK = 300;

export function scoreZonkDice(dice) {
    if (!Array.isArray(dice) || !dice.length || dice.length > ZONK_DICE) return 0;
    if (!dice.every(value => Number.isInteger(value) && value >= 1 && value <= 6)) return 0;

    const counts = Array(7).fill(0);
    for (const value of dice) counts[value]++;

    if (dice.length === 6) {
        if ([1, 2, 3, 4, 5, 6].every(face => counts[face] === 1)) return 1500;
        if (counts.filter(count => count === 2).length === 3) return 750;
    }

    let points = 0;
    for (let face = 1; face <= 6; face++) {
        const count = counts[face];
        if (!count) continue;
        if (count >= 3) {
            const triple = face === 1 ? 1000 : face * 100;
            // Each die after the third adds one more triple's worth of points.
            points += triple * (count - 2);
        } else if (face === 1) {
            points += 100 * count;
        } else if (face === 5) {
            points += 50 * count;
        } else {
            return 0;
        }
    }
    return points;
}

export function getZonkKeepOptions(dice) {
    if (!Array.isArray(dice) || !dice.length || dice.length > 6) return [];
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
