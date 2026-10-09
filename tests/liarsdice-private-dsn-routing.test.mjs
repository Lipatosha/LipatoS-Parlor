import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'liarsdice-private-dsn-routing'
    }
};

globalThis.game = {
    user: { id: 'gm-user', isGM: true },
    users: { get: () => null },
    actors: { get: () => null },
    i18n: {
        localize: key => key,
        format: key => key
    },
    settings: {
        get: () => null
    }
};

const { LiarsDiceGame } = await import('../scripts/games/liarsdice/LiarsDiceGame.js');
const { ParlorManager } = await import('../scripts/core/ParlorManager.js');
const { SocketManager } = await import('../scripts/core/SocketManager.js');

const originalSendTo = SocketManager.sendTo;

function makeBotGame({ participantId = 'bot_0', actorId = null } = {}) {
    const gameInstance = Object.create(LiarsDiceGame.prototype);
    gameInstance.sessionId = 'liarsdice-session';
    gameInstance.round = 1;
    gameInstance.roundToken = 'round-one';
    gameInstance.participants = [{
        id: participantId,
        type: 'bot',
        actorId,
        userId: null,
        controllerId: null,
        name: 'Test Bot Alice'
    }];
    gameInstance._privateHands = new Map([[participantId, {
        round: 1,
        roundToken: 'round-one',
        dice: [1, 2, 3, 4, 5],
        rolledAt: 1
    }]]);
    gameInstance._knownPrivateHands = new Map();
    return gameInstance;
}

describe('Liars Dice bot private-dice routing', () => {
    beforeEach(() => {
        ParlorManager._sessions.clear();
        SocketManager.sendTo = async () => {
            throw new Error('Uncontrolled bot dice must not be sent to a nonexistent user');
        };
    });

    afterEach(() => {
        ParlorManager._sessions.clear();
        SocketManager.sendTo = originalSendTo;
    });

    it('delivers an uncontrolled bot hand to the host GM UI so DSN can play it', async () => {
        const gameInstance = makeBotGame();
        const privateUpdates = [];
        ParlorManager._sessions.set(gameInstance.sessionId, {
            game: gameInstance,
            isHostGM: true,
            ui: {
                handlePrivateUpdate: payload => privateUpdates.push(payload)
            }
        });

        await gameInstance._dispatchPrivateHands(['bot_0']);

        assert.equal(privateUpdates.length, 1);
        assert.equal(privateUpdates[0].type, 'liarsdice.hand');
        assert.equal(privateUpdates[0].participantId, 'bot_0');
        assert.deepEqual(privateUpdates[0].dice, [1, 2, 3, 4, 5]);
    });

    it('Actor NPC 的私骰也只在主持端本地交给桌面', async () => {
        const gameInstance = makeBotGame({ participantId: 'bot:goblin', actorId: 'goblin' });
        const privateUpdates = [];
        ParlorManager._sessions.set(gameInstance.sessionId, {
            game: gameInstance,
            isHostGM: true,
            ui: {
                handlePrivateUpdate: payload => privateUpdates.push(payload)
            }
        });

        await gameInstance._dispatchPrivateHands(['bot:goblin']);

        assert.equal(privateUpdates.length, 1);
        assert.equal(privateUpdates[0].participantId, 'bot:goblin');
        assert.deepEqual(privateUpdates[0].dice, [1, 2, 3, 4, 5]);
    });
});
