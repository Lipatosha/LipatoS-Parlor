/** Farkle's six-tier display, stored bottom-up.
 * Every keep action starts a NEW tier (6, 5, 4, 3, 2, 1).
 * If more dice were kept than that tier holds, overflow continues above it.
 * When the six tiers are exhausted, start a fresh display without changing
 * the player's actual unbanked points or the match history.
 */
export const FARKLE_RACK_CAPACITIES = Object.freeze([6, 5, 4, 3, 2, 1]);

export function appendFarkleRackRow(rows, dice) {
    const prior = Array.isArray(rows)
        ? rows.slice(0, 6).map((row, i) =>
            Array.isArray(row) ? row.slice(0, FARKLE_RACK_CAPACITIES[i]) : [])
        : [];
    const selected = Array.isArray(dice)
        ? dice.filter(face => Number.isInteger(face) && face >= 1 && face <= 6).slice(0, 6)
        : [];
    if (!selected.length) return prior;

    // Every keep is its own new row, even if the preceding row has empty cells.
    let index = prior.length;
    // The remaining upper tiers must have room for the ENTIRE chosen scoring
    // combination; otherwise roll over to a new rack rather than hiding dice.
    const available = FARKLE_RACK_CAPACITIES.slice(index).reduce((sum, cap) => sum + cap, 0);
    let result = available >= selected.length ? prior : [];
    if (result !== prior) index = 0;

    let offset = 0;
    while (offset < selected.length && index < FARKLE_RACK_CAPACITIES.length) {
        const size = FARKLE_RACK_CAPACITIES[index];
        result.push(selected.slice(offset, offset + size));
        offset += size;
        index++;
    }
    return result;
}

/** Visible rows in top-to-bottom order with their physical slot indexes.
 * The bottom row starts at cell 15; rows above it start at 10, 6, 3, 1, 0.
 */
export function getFarkleRackDisplay(rows) {
    const prior = Array.isArray(rows) ? rows : [];
    const topCapacities = [...FARKLE_RACK_CAPACITIES].reverse();
    return topCapacities.map((capacity, rowIndex) => {
        const bottomIndex = FARKLE_RACK_CAPACITIES.length - rowIndex - 1;
        const values = Array.isArray(prior[bottomIndex]) ? prior[bottomIndex].slice(0, capacity) : [];
        return { capacity, rowIndex, values };
    });
}
