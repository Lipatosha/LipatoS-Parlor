const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Foundry 模块通道只负责转发；这里补齐本地执行、定向请求和结果返回。
 * 接收者通过服务器的 recipients 参数限制，私有手牌不能靠客户端过滤广播。
 */
export class NativeSocket {
    constructor({ socket, moduleId, user, users, eventNames, dispatch, timeoutMs = REQUEST_TIMEOUT_MS }) {
        this.socket = socket;
        this.channel = `module.${moduleId}`;
        this.user = user;
        this.users = users;
        this.eventNames = new Set(eventNames);
        this.dispatch = dispatch;
        this.timeoutMs = timeoutMs;
        this.pending = new Map();
        this._listener = (message, senderId) => {
            this._receive(message, senderId).catch(error => {
                console.error(`${moduleId} | Socket message failed:`, error);
            });
        };
        this._onDisconnect = () => {
            for (const id of this.pending.keys()) {
                this._settle(id, new Error('Parlor socket disconnected; the action result is unknown.'));
            }
        };
        socket.on(this.channel, this._listener);
        socket.on('disconnect', this._onDisconnect);
    }

    async executeForEveryone(eventName, ...args) {
        this._validateEvent(eventName);
        this._requireConnection();
        this.socket.emit(this.channel, { version: PROTOCOL_VERSION, type: 'broadcast', eventName, args });
        // Foundry 广播不回送给发件连接；本地必须执行一次，开桌才能初始化主持端。
        return this.dispatch(eventName, ...args);
    }

    async executeAsGM(eventName, ...args) {
        const gm = this.user.isGM ? this.user : this.users.activeGM;
        if (!gm?.isGM || gm.active === false) throw new Error('Parlor requires an active GM for this action.');
        return this.executeAsUser(eventName, gm.id, ...args);
    }

    async executeAsUser(eventName, userId, ...args) {
        this._validateEvent(eventName);
        this._requireConnection();
        if (userId === this.user.id) return this.dispatch(eventName, ...args);
        if (!this.users.get(userId)?.active) throw new Error(`Parlor recipient '${userId}' is not connected.`);

        const id = foundry.utils.randomID(24);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // 不自动重发：超时可能发生在筹码已结算、但回执尚未到达之后。
                this._settle(id, new Error(`Parlor action '${eventName}' timed out; its result is unknown.`));
            }, this.timeoutMs);
            this.pending.set(id, { userId, resolve, reject, timer });
            try {
                this.socket.emit(this.channel, {
                    version: PROTOCOL_VERSION, type: 'request', id, targetId: userId, eventName, args
                }, { recipients: [userId] });
            } catch (error) {
                this._settle(id, error);
            }
        });
    }

    async _receive(message, senderId) {
        if (!message || message.version !== PROTOCOL_VERSION || !this.users.get(senderId)) return;
        if (message.type === 'response') {
            const request = this.pending.get(message.id);
            // senderId 来自 Foundry 服务器的第二个回调参数，不能信任消息里自报的身份。
            if (!request || request.userId !== senderId || message.targetId !== this.user.id) return;
            const error = typeof message.error === 'string' ? new Error(message.error) : null;
            this._settle(message.id, error, message.result);
            return;
        }
        if (!this.eventNames.has(message.eventName) || !Array.isArray(message.args)) return;
        if (message.type === 'broadcast') {
            if (senderId !== this.user.id) await this.dispatch(message.eventName, ...message.args);
            return;
        }
        if (message.type !== 'request' || message.targetId !== this.user.id || typeof message.id !== 'string') return;

        const response = { version: PROTOCOL_VERSION, type: 'response', id: message.id, targetId: senderId };
        try {
            response.result = await this.dispatch(message.eventName, ...message.args);
        } catch (error) {
            response.error = error instanceof Error ? error.message : String(error);
        }
        // 断线后不缓存回执，避免重新连接时发送已经失效的结果。
        if (this.socket.connected !== false) this.socket.emit(this.channel, response, { recipients: [senderId] });
    }

    _settle(id, error, result) {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        if (error) request.reject(error);
        else request.resolve(result);
    }

    _validateEvent(eventName) {
        if (!this.eventNames.has(eventName)) throw new Error(`Unknown Parlor socket event '${eventName}'.`);
    }

    _requireConnection() {
        if (this.socket.connected === false) throw new Error('Parlor socket is disconnected.');
    }
}
