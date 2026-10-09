import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'bone21-attribute-round',
        deepClone: value => structuredClone(value),
        getProperty: () => null
    }
};

globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: {
        get: () => null,
        find: () => null
    },
    actors: { get: () => null },
    settings: {
        settings: new Map(),
        get: () => null
    },
    i18n: {
        localize: key => key,
        format: key => key
    }
};

globalThis.ui = {
    notifications: {
        warn: () => {}
    }
};

const { OutcomeInfluence } = await import('../scripts/core/OutcomeInfluence.js');
const { Bone21Game } = await import('../scripts/games/bone21/Bone21Game.js');

describe('Bone21 outcome influence integration', () => {
    it('属性只生成初始三颗私骰，后续主动加骰保持普通随机', () => {
        const originalRollInitialDice = OutcomeInfluence.rollBone21InitialDice;
        let initialRollCalls = 0;
        OutcomeInfluence.rollBone21InitialDice = (_source, participantId, count) => {
            initialRollCalls += 1;
            assert.equal(participantId, 'p1');
            assert.equal(count, 3);
            return [6, 5, 4];
        };

        try {
            const table = new Bone21Game({
                sessionId: 'bone21-attribute-integration',
                playerIds: ['p1'],
                participants: [{ id: 'p1', type: 'user', name: 'P1' }],
                bone21Rng: () => 0
            });
            table._phase = 'BETTING';
            table.round = 1;
            table.roundAnte = 10;
            table.bets = [{ userId: 'p1', amount: 10 }];
            table._scheduleTurnStart = () => {};
            table._dispatchPrivateInitialDice = async () => {};
            table._broadcastState = () => {};

            table._beginRoll();

            assert.equal(initialRollCalls, 1);
            assert.deepEqual(table._privateInitialDice.get('p1')?.dice, [6, 5, 4]);

            table._phase = 'PLAYER_TURNS';
            table.currentPlayerId = 'p1';
            const result = table._handleRoll('p1');

            assert.deepEqual(result, { ok: true });
            assert.deepEqual(table.playerStates.p1.dice, [1]);
            assert.equal(initialRollCalls, 1);
        } finally {
            OutcomeInfluence.rollBone21InitialDice = originalRollInitialDice;
        }
    });
});
