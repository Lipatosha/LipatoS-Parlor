/**
 * Display-only Farkle turn order for the CURRENT round.
 * Scoreboard sorting is deliberately ignored: turnOrder is GM authoritative.
 * Completed players do not receive a badge. Once the seat index wraps to zero
 * in the next round, all seat badges appear again.
 */
export function getUpcomingZonkTurns(state = {}) {
    const turnOrder = Array.isArray(state.turnOrder) ? state.turnOrder : [];
    if (state.phase !== 'PLAYER_TURNS') return new Map();
    const currentIndex = turnOrder.indexOf(state.currentPlayerId);
    if (currentIndex < 0) return new Map();
    return new Map(turnOrder.slice(currentIndex)
        .map((participantId, offset) => [participantId, currentIndex + offset + 1]));
}
