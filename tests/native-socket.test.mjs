import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NativeSocket } from '../scripts/core/NativeSocket.js';

globalThis.foundry = { utils: { randomID: () => randomUUID() } };
const flush = () => new Promise(resolve => setImmediate(resolve));

function createWorld({ timeoutMs = 1000 } = {}) {
    const users = new Map([
        ['gm', { id: 'gm', active: true, isGM: true }],
        ['host', { id: 'host', active: true, isGM: true }],
        ['player', { id: 'player', active: true, isGM: false }],
        ['observer', { id: 'observer', active: true, isGM: false }]
    ]);
    users.activeGM = users.get('gm');
    const clients = new Map();
    const packets = [];
    for (const user of users.values()) {
        const listeners = new Map();
        const client = { calls: [], received: [], handler: async (...args) => args };
        client.socket = {
            connected: true,
            on: (event, handler) => listeners.set(event, handler),
            emit: (channel, message, options = {}) => {
                const wire = JSON.parse(JSON.stringify(message));
                packets.push({ senderId: user.id, message: wire, options });
                for (const [id, target] of clients) {
                    const receives = options.recipients
                        ? options.recipients.includes(id)
                        : id !== user.id;
                    if (!receives || !target.socket.connected) continue;
                    target.received.push(wire);
                    queueMicrotask(() => target.listeners.get(channel)?.(wire, user.id));
                }
            }
        };
        client.listeners = listeners;
        client.transport = new NativeSocket({
            socket: client.socket, moduleId: 'parlor', user, users, timeoutMs,
            eventNames: ['state', 'private', 'action', 'start'],
            dispatch: async (eventName, ...args) => {
                client.calls.push({ eventName, args });
                return client.handler(eventName, ...args);
            }
        });
        clients.set(user.id, client);
    }
    return { clients, users, packets };
}

describe('Foundry native module transport', () => {
    it('广播在每个客户端执行一次，本地执行会被等待', async () => {
        const { clients, packets } = createWorld();
        const gm = clients.get('gm');
        let finish;
        gm.handler = () => new Promise(resolve => { finish = resolve; });
        let completed = false;
        const broadcast = gm.transport.executeForEveryone('start', { round: 1 }).then(() => { completed = true; });
        await flush();
        assert.equal(completed, false);
        for (const client of clients.values()) assert.equal(client.calls.length, 1);
        assert.equal(packets.length, 1);
        finish();
        await broadcast;
        assert.equal(completed, true);
    });

    it('私有手牌和回执只到指定用户，旁观者不会收到数据包', async () => {
        const { clients, packets } = createWorld();
        clients.get('player').handler = async (event, payload) => ({ received: payload.hand.length });
        const result = await clients.get('gm').transport.executeAsUser('private', 'player', { hand: ['8S'] });
        assert.deepEqual(result, { received: 1 });
        assert.equal(clients.get('observer').received.length, 0);
        assert.equal(clients.get('host').received.length, 0);
        assert.deepEqual(packets.map(packet => packet.options.recipients), [['player'], ['gm']]);
    });

    it('发给自己时本地执行并返回结果，不经过网络', async () => {
        const { clients, packets } = createWorld();
        clients.get('player').handler = async () => 7;
        assert.equal(await clients.get('player').transport.executeAsUser('action', 'player'), 7);
        assert.equal(packets.length, 0);
        assert.equal(clients.get('player').calls.length, 1);
    });

    it('玩家请求只选一个在线 GM，GM 自己的请求留在本机', async () => {
        const { clients } = createWorld();
        clients.get('gm').handler = async () => 'gm';
        clients.get('host').handler = async () => 'host';
        assert.equal(await clients.get('player').transport.executeAsGM('action'), 'gm');
        assert.equal(clients.get('host').calls.length, 0);
        assert.equal(await clients.get('host').transport.executeAsGM('action'), 'host');
        assert.equal(clients.get('gm').calls.length, 1);
    });

    it('非主持 GM 转发给主持人后，原玩家能收到最终返回值', async () => {
        const { clients } = createWorld();
        clients.get('gm').handler = (event, payload) => clients.get('gm').transport.executeAsUser(event, 'host', payload);
        clients.get('host').handler = async (event, payload) => ({ ok: true, action: payload.action });
        assert.deepEqual(
            await clients.get('player').transport.executeAsGM('action', { action: 'draw' }),
            { ok: true, action: 'draw' }
        );
        assert.equal(clients.get('host').calls.length, 1);
    });

    it('远端异常会拒绝原请求，清除待返回记录', async () => {
        const { clients } = createWorld();
        clients.get('gm').handler = async () => { throw new Error('Settlement failed'); };
        await assert.rejects(clients.get('player').transport.executeAsGM('action'), /Settlement failed/);
        assert.equal(clients.get('player').transport.pending.size, 0);
    });

    it('无 GM、目标不存在或离线时直接报错，不发送消息', async () => {
        const { clients, users, packets } = createWorld();
        const player = clients.get('player').transport;
        users.activeGM = null;
        await assert.rejects(player.executeAsGM('action'), /active GM/);
        await assert.rejects(player.executeAsUser('action', 'missing'), /not connected/);
        users.get('gm').active = false;
        await assert.rejects(player.executeAsUser('action', 'gm'), /not connected/);
        assert.equal(packets.length, 0);
    });

    it('超时会结束等待且不重发动作，迟到回执被忽略', async () => {
        const { clients, packets } = createWorld({ timeoutMs: 20 });
        let finish;
        clients.get('gm').handler = () => new Promise(resolve => { finish = resolve; });
        const player = clients.get('player').transport;
        await assert.rejects(player.executeAsGM('action'), /timed out/);
        assert.equal(player.pending.size, 0);
        assert.equal(packets.length, 1);
        finish({ ok: true });
        await flush();
        assert.equal(player.pending.size, 0);
        assert.equal(clients.get('gm').calls.length, 1);
    });

    it('断线会结束所有等待，断线期间拒绝新请求，重连不会重发旧动作', async () => {
        const { clients, packets } = createWorld();
        const player = clients.get('player');
        clients.get('gm').handler = () => new Promise(() => {});
        const pending = player.transport.executeAsGM('action');
        const rejection = assert.rejects(pending, /disconnected/);
        player.socket.connected = false;
        player.listeners.get('disconnect')();
        await rejection;
        await assert.rejects(player.transport.executeAsGM('action'), /disconnected/);
        await assert.rejects(player.transport.executeForEveryone('state'), /disconnected/);
        assert.equal(player.transport.pending.size, 0);
        player.socket.connected = true;
        assert.equal(packets.length, 1);
    });

    it('只接受目标客户端的服务器身份，不接受伪造或发给别人的回执', async () => {
        const { clients, packets } = createWorld();
        const player = clients.get('player');
        let finish;
        clients.get('gm').handler = () => new Promise(resolve => { finish = resolve; });
        const pending = player.transport.executeAsGM('action');
        await flush();
        const id = packets[0].message.id;
        const forged = { version: 1, type: 'response', id, targetId: 'player', result: 'forged', senderId: 'gm' };
        clients.get('observer').socket.emit('module.parlor', forged, { recipients: ['player'] });
        clients.get('gm').socket.emit('module.parlor', { ...forged, targetId: 'observer' }, { recipients: ['player'] });
        await flush();
        assert.equal(player.transport.pending.size, 1);
        finish('verified');
        assert.equal(await pending, 'verified');
    });

    it('忽略陌生发件人、错误协议、错误接收者和未注册事件', async () => {
        const { clients, packets } = createWorld();
        const gm = clients.get('gm');
        const valid = { version: 1, type: 'request', id: 'request', targetId: 'gm', eventName: 'action', args: [] };
        await gm.transport._receive(valid, 'unknown');
        await gm.transport._receive({ ...valid, version: 2 }, 'player');
        await gm.transport._receive({ ...valid, targetId: 'host' }, 'player');
        await gm.transport._receive({ ...valid, eventName: 'unknown' }, 'player');
        await gm.transport._receive({ ...valid, args: null }, 'player');
        assert.equal(gm.calls.length, 0);
        assert.equal(packets.length, 0);
        await assert.rejects(gm.transport.executeAsGM('unknown'), /Unknown Parlor/);
    });

    it('同步发送失败也会清除请求计时器', async () => {
        const { clients } = createWorld();
        const player = clients.get('player');
        player.socket.emit = () => { throw new Error('Emit failed'); };
        await assert.rejects(player.transport.executeAsGM('action'), /Emit failed/);
        assert.equal(player.transport.pending.size, 0);
    });

    it('空返回值正常完成，不会等到超时', async () => {
        const { clients } = createWorld();
        clients.get('gm').handler = async () => undefined;
        assert.equal(await clients.get('player').transport.executeAsGM('action'), undefined);
    });
});

describe('Parlor without socketlib', () => {
    it('SocketManager 可以在没有 socketlib 时初始化并通过现有接口工作', async t => {
        const { SocketManager, SOCKET_EVENTS } = await import('../scripts/core/SocketManager.js');
        const { clients, users } = createWorld();
        const gm = clients.get('gm');
        globalThis.game = { socket: gm.socket, user: users.get('gm'), users };
        assert.equal(globalThis.socketlib, undefined);
        SocketManager.initialize('parlor');
        const original = SocketManager._socket;
        SocketManager.initialize('parlor');
        assert.equal(SocketManager._socket, original);
        SocketManager.on(SOCKET_EVENTS.GM_ACTION, async payload => ({ ok: true, action: payload.action }));
        assert.deepEqual(await SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { action: 'deal' }), { ok: true, action: 'deal' });
        SocketManager.off(SOCKET_EVENTS.GM_ACTION);
        t.mock.method(console, 'error', () => {});
        SocketManager.on(SOCKET_EVENTS.GM_ACTION, async () => { throw new Error('Handler failed'); });
        await assert.rejects(SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {}), /Handler failed/);
        SocketManager.off(SOCKET_EVENTS.GM_ACTION);
        SocketManager._socket = null;
        delete globalThis.game;
    });

    it('清单移除了 socketlib 必需依赖，酒馆主题已内置', () => {
        const manifest = JSON.parse(readFileSync(new URL('../module.json', import.meta.url)));
        assert.equal(manifest.socket, true);
        assert.equal(manifest.relationships?.requires?.some(entry => entry.id === 'socketlib') ?? false, false);
        assert.equal(manifest.relationships?.recommends?.some(entry => entry.id === 'parlor-themes-tavern') ?? false, false);
        assert.ok(manifest.styles.includes('styles/tavern.css'));
    });
});
