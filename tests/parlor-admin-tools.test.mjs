import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isVisibleInLobby } from '../scripts/core/GameVisibility.js';
import { DND_GOLD_CHIP_RATE, planGoldChipExchange } from '../scripts/core/GoldChipExchange.js';

describe('GameVisibility', () => {
    it('keeps hidden games out of the lobby while shipped card tables stay visible', () => {
        assert.equal(isVisibleInLobby('roulette'), false);
        assert.equal(isVisibleInLobby('texasholdem'), true);
        assert.equal(isVisibleInLobby('blackjack'), true);
    });
});

describe('GoldChipExchange', () => {
    it('lets granted gold count toward the same gold-to-chip purchase batch', () => {
        const plan = planGoldChipExchange({
            rows: [{ id: 'actor:a1', actorId: 'a1', gold: 5, chips: 2 }],
            grants: [{ participantId: 'actor:a1', amount: 10 }],
            goldToChip: [{ participantId: 'actor:a1', amount: 12 }]
        });

        assert.equal(DND_GOLD_CHIP_RATE, 1);
        assert.deepEqual(plan.actorUpdates, [{
            participantId: 'actor:a1',
            actorId: 'a1',
            nextGold: 3,
            grantAmount: 10,
            goldToChip: 12,
            chipToGold: 0,
            chipDelta: 12
        }]);
        assert.deepEqual(plan.chipDeltas, [{ userId: 'actor:a1', delta: 12 }]);
        assert.equal(plan.totalGranted, 10);
        assert.equal(plan.totalGoldToChip, 12);
        assert.equal(plan.totalChipToGold, 0);
    });

    it('does not silently cap gold-to-chip purchases that exceed available gold', () => {
        const plan = planGoldChipExchange({
            rows: [{ id: 'actor:a1', actorId: 'a1', gold: 4, chips: 0 }],
            grants: [{ participantId: 'actor:a1', amount: 3 }],
            goldToChip: [{ participantId: 'actor:a1', amount: 9 }]
        });

        assert.deepEqual(plan.actorUpdates, [{
            participantId: 'actor:a1',
            actorId: 'a1',
            nextGold: 7,
            grantAmount: 3,
            goldToChip: 0,
            chipToGold: 0,
            chipDelta: 0
        }]);
        assert.deepEqual(plan.chipDeltas, []);
        assert.deepEqual(plan.shortGoldRows, [{
            participantId: 'actor:a1',
            requested: 9,
            available: 7
        }]);
    });

    it('lets players redeem chips back into gold when they have enough chips', () => {
        const plan = planGoldChipExchange({
            rows: [{ id: 'actor:a1', actorId: 'a1', gold: 4, chips: 18 }],
            chipToGold: [{ participantId: 'actor:a1', amount: 7 }]
        });

        assert.deepEqual(plan.actorUpdates, [{
            participantId: 'actor:a1',
            actorId: 'a1',
            nextGold: 11,
            grantAmount: 0,
            goldToChip: 0,
            chipToGold: 7,
            chipDelta: -7
        }]);
        assert.deepEqual(plan.chipDeltas, [{ userId: 'actor:a1', delta: -7 }]);
        assert.equal(plan.totalChipToGold, 7);
    });

    it('does not silently cap chip-to-gold redemptions that exceed available chips', () => {
        const plan = planGoldChipExchange({
            rows: [{ id: 'actor:a1', actorId: 'a1', gold: 4, chips: 3 }],
            chipToGold: [{ participantId: 'actor:a1', amount: 5 }]
        });

        assert.deepEqual(plan.actorUpdates, []);
        assert.deepEqual(plan.chipDeltas, []);
        assert.deepEqual(plan.shortChipRows, [{
            participantId: 'actor:a1',
            requested: 5,
            available: 3
        }]);
    });
});
