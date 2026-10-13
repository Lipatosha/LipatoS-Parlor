import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getUpcomingZonkTurns } from '../scripts/games/zonk/ZonkRoundTurns.js';

const seats = ['alice', 'bob', 'cleo', 'dora'];

describe('Farkle remaining-turn indicator', () => {
    it('shows all numbered seats at the beginning of a round', () => {
        const order = getUpcomingZonkTurns({ phase: 'PLAYER_TURNS', turnOrder: seats, currentPlayerId: 'alice', round: 1 });
        assert.deepEqual([...order], [['alice',1], ['bob',2], ['cleo',3], ['dora',4]]);
    });
    it('hides completed seats and preserves original round order, not score ranking', () => {
        const order = getUpcomingZonkTurns({
            phase: 'PLAYER_TURNS', turnOrder: seats, currentPlayerId: 'cleo', round: 2,
            playerStates: { bob: { score: 9999 }, dora: { score: 100 } }
        });
        assert.deepEqual([...order], [['cleo',3], ['dora',4]]);
        assert.equal(order.has('alice'), false);
        assert.equal(order.has('bob'), false);
    });
    it('resets next round and disappears when the match ends', () => {
        assert.deepEqual([...getUpcomingZonkTurns({ phase: 'PLAYER_TURNS', turnOrder: seats, currentPlayerId: 'alice', round: 3 })].map(x=>x[1]),[1,2,3,4]);
        assert.equal(getUpcomingZonkTurns({ phase: 'FINISHED', turnOrder: seats, currentPlayerId: '' }).size, 0);
        assert.equal(getUpcomingZonkTurns({ phase: 'PLAYER_TURNS', turnOrder: seats, currentPlayerId: 'missing' }).size, 0);
    });
});
