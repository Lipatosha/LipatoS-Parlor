import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'host-authority-id',
        escapeHTML: value => String(value),
        getProperty: () => null
    }
};

const users = new Map();
globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm-host', isGM: true, active: true },
    users: { get: id => users.get(id) || null },
    actors: { get: () => null },
    i18n: {
        localize: key => key,
        format: key => key
    }
};

const { SocketManager, SOCKET_EVENTS } = await import('../scripts/core/SocketManager.js');
const { ParlorManager } = await import('../scripts/core/ParlorManager.js');

const originalSendTo = SocketManager.sendTo;

function createGameStub() {
    const calls = [];
    return {
        calls,
        playerIds: new Set(),
        handlePlayerAction: async (...args) => {
            calls.push({ type: 'player', args });
            return { ok: true, handledBy: game.user.id };
        },
        handleGMAction: async (...args) => {
            calls.push({ type: 'gm', args });
            return { ok: true, handledBy: game.user.id };
        }
    };
}

describe('SocketManager targeted return value', () => {
    afterEach(() => {
        SocketManager._socket = null;
    });

    it('把 executeAsUser 的结果返回给调用方', async () => {
        SocketManager._socket = {
            executeAsUser: async () => ({ ok: true, from: 'host' })
        };

        const result = await SocketManager.sendTo('event', 'gm-host', { value: 1 });
        assert.deepEqual(result, { ok: true, from: 'host' });
    });
});

describe('ParlorManager host GM authority', () => {
    beforeEach(() => {
        users.clear();
        users.set('gm-host', { id: 'gm-host', isGM: true, active: true });
        users.set('gm-other', { id: 'gm-other', isGM: true, active: true });
        game.user = users.get('gm-host');
        ParlorManager._sessions.clear();
        ParlorManager._botTimers.clear();
        SocketManager.sendTo = originalSendTo;
    });

    afterEach(() => {
        SocketManager.sendTo = originalSendTo;
    });

    it('host GM 在本地处理玩家动作', async () => {
        const table = createGameStub();
        ParlorManager._sessions.set('session-1', {
            game: table,
            ui: null,
            isHostGM: true,
            hostGMUserId: 'gm-host'
        });

        const result = await ParlorManager._onPlayerAction({
            sessionId: 'session-1',
            userId: 'p1',
            action: 'hit',
            data: { source: 'test' }
        });

        assert.deepEqual(result, { ok: true, handledBy: 'gm-host' });
        assert.equal(table.calls.length, 1);
        assert.equal(table.calls[0].type, 'player');
    });

    it('非 host GM 只把玩家动作定向转发给 host', async () => {
        game.user = users.get('gm-other');
        const table = createGameStub();
        ParlorManager._sessions.set('session-1', {
            game: table,
            ui: null,
            isHostGM: false,
            hostGMUserId: 'gm-host'
        });

        let forwarded = null;
        SocketManager.sendTo = async (...args) => {
            forwarded = args;
            return { ok: true, handledBy: 'gm-host' };
        };

        const payload = {
            sessionId: 'session-1',
            userId: 'p1',
            action: 'hit',
            data: { source: 'test' }
        };
        const result = await ParlorManager._onPlayerAction(payload);

        assert.deepEqual(result, { ok: true, handledBy: 'gm-host' });
        assert.deepEqual(forwarded, [SOCKET_EVENTS.PLAYER_ACTION, 'gm-host', payload]);
        assert.equal(table.calls.length, 0);
    });

    it('非 host GM 的桌面动作也只在 host 执行', async () => {
        game.user = users.get('gm-other');
        const table = createGameStub();
        ParlorManager._sessions.set('session-1', {
            game: table,
            ui: null,
            isHostGM: false,
            hostGMUserId: 'gm-host'
        });

        let forwarded = null;
        SocketManager.sendTo = async (...args) => {
            forwarded = args;
            return { ok: true, handledBy: 'gm-host' };
        };

        const payload = {
            sessionId: 'session-1',
            action: 'deal',
            data: { source: 'test' }
        };
        const result = await ParlorManager._onGMAction(payload);

        assert.deepEqual(result, { ok: true, handledBy: 'gm-host' });
        assert.deepEqual(forwarded, [SOCKET_EVENTS.GM_ACTION, 'gm-host', payload]);
        assert.equal(table.calls.length, 0);
    });

    it('host 离线时拒绝动作且不修改本地游戏', async () => {
        game.user = users.get('gm-other');
        users.get('gm-host').active = false;
        const table = createGameStub();
        ParlorManager._sessions.set('session-1', {
            game: table,
            ui: null,
            isHostGM: false,
            hostGMUserId: 'gm-host'
        });

        let forwarded = false;
        SocketManager.sendTo = async () => {
            forwarded = true;
            return { ok: true };
        };

        const result = await ParlorManager._onPlayerAction({
            sessionId: 'session-1',
            userId: 'p1',
            action: 'hit',
            data: {}
        });

        assert.deepEqual(result, { ok: false, reason: 'host-unavailable' });
        assert.equal(forwarded, false);
        assert.equal(table.calls.length, 0);
    });
});
