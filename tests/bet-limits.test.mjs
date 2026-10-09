import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    CARD_BET_LIMIT_GAME_IDS,
    normalizeBetLimits,
    supportsCardBetLimits,
    validateBetAmount
} from '../scripts/core/BetLimits.js';

describe('BetLimits', () => {
    it('keeps card bet limits predictable for table setup', () => {
        assert.deepEqual(normalizeBetLimits(), { min: 1, max: 0 });
        assert.deepEqual(normalizeBetLimits({ min: 12, max: 0 }), { min: 12, max: 0 });
        assert.deepEqual(normalizeBetLimits({ min: 20, max: 5 }), { min: 20, max: 20 });
    });

    it('validates lower and upper bounds while keeping zero max unlimited', () => {
        assert.deepEqual(validateBetAmount(4, { min: 5, max: 10 }), {
            ok: false,
            reason: 'bet-too-low',
            amount: 4,
            min: 5,
            max: 10
        });
        assert.deepEqual(validateBetAmount(11, { min: 5, max: 10 }), {
            ok: false,
            reason: 'bet-too-high',
            amount: 11,
            min: 5,
            max: 10
        });
        assert.deepEqual(validateBetAmount(999, { min: 5, max: 0 }), {
            ok: true,
            amount: 999,
            min: 5,
            max: 0
        });
    });

    it('only opts regular card betting games into the shared limit control', () => {
        assert.deepEqual([...CARD_BET_LIMIT_GAME_IDS].sort(), [
            'baccarat',
            'blackjack',
            'casinowar',
            'dragontiger',
            'threecardpoker'
        ]);
        assert.equal(supportsCardBetLimits('blackjack'), true);
        assert.equal(supportsCardBetLimits('texasholdem'), false);
        assert.equal(supportsCardBetLimits('roulette'), false);
        assert.equal(supportsCardBetLimits('bone21'), false);
    });
});
