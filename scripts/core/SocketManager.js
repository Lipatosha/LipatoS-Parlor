/**
 * SocketManager — 多人通信管理器
 * 封装 Foundry 原生模块通道，提供事件注册和消息传递。
 */

import { NativeSocket } from './NativeSocket.js';

const MODULE_ID = 'parlor';

export const SOCKET_EVENTS = Object.freeze({
    /** 游戏状态完整更新 */
    GAME_STATE_UPDATE: 'gameStateUpdate',
    /** 仅发给指定用户的私有游戏信息 */
    GAME_PRIVATE_UPDATE: 'gamePrivateUpdate',
    /** 筹码余额更新 */
    UPDATE_CHIPS: 'updateChips',
    /** 打开玩家自助金币/筹码兑换窗口 */
    OPEN_GOLD_CHIP_EXCHANGE: 'openGoldChipExchange',
    /** 由 GM 端执行金币/筹码兑换 */
    APPLY_GOLD_CHIP_EXCHANGE: 'applyGoldChipExchange',
    /** 通用玩家操作（下注/要牌/停牌等） */
    PLAYER_ACTION: 'playerAction',
    /** GM 开始游戏 */
    START_GAME: 'startGame',
    /** GM 结束游戏 */
    END_GAME: 'endGame',
    /** GM 执行游戏操作（旋转/发牌等） */
    GM_ACTION: 'gmAction'
});

export class SocketManager {
    static _socket = null;
    static _handlers = new Map();

    static initialize(moduleId) {
        if (this._socket) return;
        this._socket = new NativeSocket({
            socket: game.socket,
            moduleId,
            user: game.user,
            users: game.users,
            eventNames: Object.values(SOCKET_EVENTS),
            dispatch: (eventName, ...args) => this._dispatch(eventName, ...args)
        });
        console.log(`${MODULE_ID} | SocketManager initialized`);
    }

    static on(eventName, handler) {
        const key = `${eventName}_${foundry.utils.randomID()}`;
        this._handlers.set(key, { eventName, handler });
    }

    static off(eventName) {
        for (const [key, entry] of this._handlers) {
            if (entry.eventName === eventName) this._handlers.delete(key);
        }
    }

    static async broadcast(eventName, ...args) {
        if (!this._socket) return;
        await this._socket.executeForEveryone(eventName, ...args);
    }

    static async requestGM(eventName, ...args) {
        if (!this._socket) return;
        return await this._socket.executeAsGM(eventName, ...args);
    }

    static async sendTo(eventName, userId, ...args) {
        if (!this._socket) return;
        return await this._socket.executeAsUser(eventName, userId, ...args);
    }

    static async _dispatch(eventName, ...args) {
        let result;
        for (const [, entry] of this._handlers) {
            if (entry.eventName === eventName) {
                try {
                    const value = await entry.handler(...args);
                    if (value !== undefined) result = value;
                }
                catch (err) {
                    console.error(`${MODULE_ID} | Socket handler error '${eventName}':`, err);
                    throw err;
                }
            }
        }
        return result;
    }
}
