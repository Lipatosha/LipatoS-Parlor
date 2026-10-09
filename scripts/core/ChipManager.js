/**
 * ChipManager — 虚拟筹码管理器
 * 
 * 管理每位玩家的虚拟筹码余额。数据持久化存储在模组的 world settings 中。
 * 提供发放、扣除、查询余额等操作，并在变更时通过 SocketManager 广播更新。
 * 
 * @module ChipManager
 */

import { SocketManager, SOCKET_EVENTS } from './SocketManager.js';
import {
    getParticipant,
    getParticipantLabel,
    getPlayerCharacterParticipants,
    isBotParticipantId,
    isNpcParticipantId,
    migrateChipOwnerId,
    reviveParticipantFromId
} from './ParticipantRoster.js';

const MODULE_ID = 'parlor';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

/**
 * 筹码面额定义
 * @type {number[]}
 */
export const CHIP_DENOMINATIONS = Object.freeze([1, 5, 10, 25, 50, 100]);

/**
 * 筹码颜色映射（宝石主题）
 * @type {Object<number, {name: string, color: string, borderColor: string}>}
 */
export const CHIP_STYLES = Object.freeze({
    1: { name: 'Pearl', color: '#e8e0d0', borderColor: '#b8a88a' },
    5: { name: 'Ruby', color: '#c62828', borderColor: '#8e0000' },
    10: { name: 'Sapphire', color: '#1565c0', borderColor: '#003c8f' },
    25: { name: 'Emerald', color: '#2e7d32', borderColor: '#005005' },
    50: { name: 'Topaz', color: '#e65100', borderColor: '#ac1900' },
    100: { name: 'Amethyst', color: '#6a1b9a', borderColor: '#38006b' }
});

/**
 * @class ChipManager
 * @description 单例筹码管理器
 */
export class ChipManager {

    /** @type {boolean} 是否已初始化 */
    static _initialized = false;
    static _chipWriteQueue = Promise.resolve();
    static _chipDataCache = null;

    /** 调试开关：默认关掉，免得正式流程看着能跑其实没结算 */
    static DEBUG_INFINITE_CHIPS = false;

    /**
     * 初始化筹码管理器
     */
    static initialize() {
        if (this._initialized) return;

        this._refreshChipDataCache();

        // 注册 Socket 事件监听
        SocketManager.on(SOCKET_EVENTS.UPDATE_CHIPS, (data) => this._onChipsUpdated(data));

        this._initialized = true;
        console.log(`${MODULE_ID} | ChipManager initialized`);
    }

    /**
     * 获取指定玩家的筹码余额
     * @param {string} userId - 用户 ID
     * @returns {number} 筹码余额
     */
    static getBalance(userId) {
        const ownerId = migrateChipOwnerId(userId);
        if (this.isUnlimitedUser(ownerId)) return Number.POSITIVE_INFINITY;
        if (this.DEBUG_INFINITE_CHIPS) return 999999;
        const chipData = this._getChipData();
        if (chipData[ownerId] === undefined) {
            return game.settings.get(MODULE_ID, 'defaultChips');
        }
        return chipData[ownerId];
    }

    static getDisplayBalance(userId) {
        return this.isUnlimitedUser(userId) ? '∞' : this.getBalance(userId);
    }

    /**
     * 获取所有玩家的筹码数据
     * @returns {Object<string, number>} userId → balance 映射
     */
    static getAllBalances() {
        const chipData = this._getChipData();
        const result = {};
        for (const participant of getPlayerCharacterParticipants({ includeGM: true })) {
            result[participant.id] = chipData[participant.id] ?? game.settings.get(MODULE_ID, 'defaultChips');
        }
        return result;
    }

    /**
     * 设置指定玩家的筹码余额（仅 GM 可调用）
     * @param {string} userId  - 用户 ID
     * @param {number} amount  - 新余额
     * @returns {Promise<boolean>} 是否成功
     */
    static async setBalance(userId, amount) {
        const ownerId = migrateChipOwnerId(userId);
        if (this.isUnlimitedUser(ownerId)) return true;
        if (!game.user.isGM) {
            console.warn(`${MODULE_ID} | Only GM can set chip balances`);
            return false;
        }

        if (typeof amount !== 'number' || amount < 0) {
            console.warn(`${MODULE_ID} | Invalid chip amount: ${amount}`);
            return false;
        }

        const safeAmount = Math.round(amount * 100) / 100;
        return this._updateChipData((chipData) => {
            chipData[ownerId] = safeAmount;
            return {
                changed: true,
                broadcast: {
                    userId: ownerId,
                    balance: safeAmount
                }
            };
        });
    }

    /**
     * 发放筹码（仅 GM）
     * @param {string} userId - 用户 ID
     * @param {number} amount - 发放数量
     * @returns {Promise<boolean>}
     */
    static async grant(userId, amount) {
        const safeAmount = Number(amount);
        if (!Number.isFinite(safeAmount) || safeAmount < 0) return false;
        return this.applyDeltas([{ userId, delta: safeAmount }]);
    }

    /**
     * 扣除筹码（仅 GM）
     * @param {string} userId - 用户 ID
     * @param {number} amount - 扣除数量
     * @returns {Promise<boolean>}
     */
    static async deduct(userId, amount) {
        const safeAmount = Number(amount);
        if (!Number.isFinite(safeAmount) || safeAmount < 0) return false;
        return this.applyDeltas([{ userId, delta: -safeAmount }]);
    }

    static async applyDeltas(entries) {
        if (!game.user.isGM) return false;
        if (!Array.isArray(entries) || !entries.length) return true;

        return this._updateChipData((chipData) => {
            let changed = false;
            for (const entry of entries) {
                const ownerId = migrateChipOwnerId(entry?.userId ?? entry?.id);
                const delta = Math.round(Number(entry?.delta || 0) * 100) / 100;
                if (!ownerId || !Number.isFinite(delta) || delta === 0) continue;
                if (this.isUnlimitedUser(ownerId)) continue;

                const current = Number(chipData[ownerId] ?? game.settings.get(MODULE_ID, 'defaultChips') ?? 0);
                const safeCurrent = Number.isFinite(current) ? current : 0;
                const next = Math.max(0, Math.round((safeCurrent + delta) * 100) / 100);
                if (chipData[ownerId] === next) continue;

                chipData[ownerId] = next;
                changed = true;
            }

            return {
                changed,
                broadcast: {
                    userId: null,
                    balance: null,
                    all: chipData
                }
            };
        });
    }

    static async _updateChipData(mutator) {
        if (!game.user.isGM) return false;

        // chipData 是整份 world setting 写回，多人同时结算时必须排队，不然最后一次写入会盖掉前面的玩家。
        const run = async () => {
            const chipData = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'chipData') || {});
            const result = mutator(chipData) || {};
            if (!result.changed) return true;

            await game.settings.set(MODULE_ID, 'chipData', chipData);
            this._setChipDataCache(chipData);
            await SocketManager.broadcast(SOCKET_EVENTS.UPDATE_CHIPS, result.broadcast || {
                userId: null,
                balance: null,
                all: chipData
            });
            return true;
        };

        const next = this._chipWriteQueue.then(run, run);
        this._chipWriteQueue = next.catch(() => {});
        return next;
    }

    static _getChipData() {
        if (!this._chipDataCache) this._refreshChipDataCache();
        return this._chipDataCache || {};
    }

    static _refreshChipDataCache() {
        this._chipDataCache = foundry.utils.deepClone(game.settings.get(MODULE_ID, 'chipData') || {});
        return this._chipDataCache;
    }

    static _setChipDataCache(chipData) {
        this._chipDataCache = foundry.utils.deepClone(chipData || {});
        return this._chipDataCache;
    }

    /**
     * 检查玩家是否有足够筹码
     * @param {string} userId - 用户 ID
     * @param {number} amount - 需要的数量
     * @returns {boolean}
     */
    static canAfford(userId, amount) {
        if (this.isUnlimitedUser(userId)) return true;
        if (this.DEBUG_INFINITE_CHIPS) return true;
        return this.getBalance(userId) >= amount;
    }

    /**
     * 将一个金额分解为最优的筹码面额组合（用于视觉展示）
     * @param {number} amount - 金额
     * @returns {Object<number, number>} denomination → count 映射
     */
    static decompose(amount) {
        if (!Number.isFinite(amount)) return {};
        const result = {};
        let remaining = Math.floor(amount);

        // 从大到小分解
        const sorted = [...CHIP_DENOMINATIONS].sort((a, b) => b - a);
        for (const denom of sorted) {
            if (remaining >= denom) {
                result[denom] = Math.floor(remaining / denom);
                remaining %= denom;
            }
        }

        return result;
    }

    /**
     * Socket 事件处理：筹码更新通知
     * @private
     * @param {object} data
     * @param {string} data.userId  - 更新的用户 ID
     * @param {number} data.balance - 新余额
     */
    static _onChipsUpdated(data) {
        if (data?.all && typeof data.all === 'object') {
            this._setChipDataCache(data.all);
        } else if (data?.userId) {
            const chipData = foundry.utils.deepClone(this._getChipData());
            if (data.balance == null) {
                delete chipData[data.userId];
            } else {
                chipData[data.userId] = data.balance;
            }
            this._setChipDataCache(chipData);
        } else {
            this._refreshChipDataCache();
        }

        console.log(`${MODULE_ID} | Chips updated for ${data?.userId || 'all'}: ${data?.balance ?? ''}`);
        // 触发自定义 Hook 供 UI 监听
        Hooks.callAll('parlor.chipsUpdated', data);
    }

    static isUnlimitedUser(userId) {
        const id = String(migrateChipOwnerId(userId) || '');
        return isBotParticipantId(id) || isNpcParticipantId(id);
    }

    static getChipUsers({ includeGM = true, includeInactiveTracked = true } = {}) {
        const chipData = this._getChipData();
        const trackedIds = new Set(Object.keys(chipData));
        const activeParticipants = getPlayerCharacterParticipants({ includeGM, includeInactive: true });
        const mapped = new Map(activeParticipants.map(entry => [entry.id, entry]));

        if (includeInactiveTracked) {
            for (const trackedId of trackedIds) {
                if (mapped.has(trackedId)) continue;
                const entry = reviveParticipantFromId(trackedId) || getParticipant({ participants: activeParticipants }, trackedId);
                if (entry) mapped.set(trackedId, entry);
            }
        }

        return [...mapped.values()].filter(entry => {
            const user = entry.userId ? game.users.get(entry.userId) : null;
            if (!includeGM && user?.isGM) return false;
            return user?.active || (includeInactiveTracked && trackedIds.has(entry.id));
        });
    }

    static getChipRows(options = {}) {
        return this.getChipUsers(options).map(entry => ({
            id: entry.id,
            name: getParticipantLabel(entry),
            avatar: entry.avatar,
            isGM: !!entry.userId && !!game.users.get(entry.userId)?.isGM,
            balance: this.getBalance(entry.id),
            balanceLabel: this.getDisplayBalance(entry.id)
        }));
    }

    static async applyAllocation(userIds, mode, amount) {
        if (!game.user.isGM) return false;

        const safeAmount = Math.floor(Number(amount));
        if (!Array.isArray(userIds) || !userIds.length) return false;
        if (!Number.isFinite(safeAmount) || safeAmount < 0) return false;

        return this._updateChipData((chipData) => {
            let changed = false;

            for (const rawUserId of userIds) {
                const userId = migrateChipOwnerId(rawUserId);
                if (!userId || this.isUnlimitedUser(userId)) continue;

                const current = Number(chipData[userId] ?? game.settings.get(MODULE_ID, 'defaultChips') ?? 0);
                let next = current;
                if (mode === 'grant') {
                    next = current + safeAmount;
                } else if (mode === 'deduct') {
                    next = Math.max(0, current - safeAmount);
                } else if (mode === 'set') {
                    next = safeAmount;
                }

                if (chipData[userId] === next) continue;
                chipData[userId] = next;
                changed = true;
            }

            return {
                changed,
                broadcast: {
                    userId: null,
                    balance: null,
                    all: chipData
                }
            };
        });
    }

    static async settleAllPlayerChips({ includeGM = true } = {}) {
        if (!game.user.isGM) return [];

        const rows = this.getChipRows({ includeGM, includeInactiveTracked: true })
            .filter(row => Number.isFinite(row.balance))
            .map(row => ({
                id: row.id,
                name: row.name,
                balance: Number(row.balance || 0)
            }))
            .filter(row => row.balance > 0 || row.id in this._getChipData());

        await this._updateChipData((chipData) => {
            let changed = false;
            for (const row of rows) {
                if (chipData[row.id] === 0) continue;
                chipData[row.id] = 0;
                changed = true;
            }

            return {
                changed,
                broadcast: {
                    userId: null,
                    balance: null,
                    all: chipData
                }
            };
        });

        if (rows.length) {
            const content = `
                <div class="parlor-chip-settlement-chat">
                    <h2 style="margin:0 0 8px;">${t('PARLOR.ChipSettlementChat.Title')}</h2>
                    <p style="margin:0 0 12px;color:#666;">${t('PARLOR.ChipSettlementChat.Sub')}</p>
                    <table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr>
                                <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #ccc;">${t('PARLOR.ChipSettlementChat.Player')}</th>
                                <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #ccc;">${t('PARLOR.ChipSettlementChat.FinalChips')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map(row => `
                                <tr>
                                    <td style="padding:6px 8px;border-bottom:1px solid rgba(0,0,0,0.08);">${row.name}</td>
                                    <td style="padding:6px 8px;text-align:right;border-bottom:1px solid rgba(0,0,0,0.08);">${row.balance}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;

            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ user: game.user }),
                content
            });
        }

        return rows;
    }
}
