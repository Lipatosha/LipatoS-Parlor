/**
 * GameBase — 游戏抽象基类（MVP 版）
 * 所有游戏继承此类，提供状态机、下注、广播框架。
 */

import { SocketManager, SOCKET_EVENTS } from '../core/SocketManager.js';
import { getParticipants } from '../core/ParticipantRoster.js';
import { SettlementManager } from '../core/SettlementManager.js';
import { normalizeBetLimits, validateBetAmount } from '../core/BetLimits.js';
import { CardLuckPlan } from '../core/CardLuckPlan.js';

const MODULE_ID = 'parlor';

export class GameBase {
    /**
     * @param {object} config
     * @param {string} config.sessionId  - 游戏 session ID
     * @param {string[]} config.playerIds - 参与玩家 ID 列表
     * @param {object[]} config.participants - 参赛者档案
     * @param {boolean} config.isPublic   - 是否对所有人可见
     */
    constructor({ sessionId, playerIds = [], participants = [], isPublic = false, gameOptions = null, gmOnlyOptions = null }) {
        if (new.target === GameBase) {
            throw new Error('GameBase is abstract');
        }
        this.sessionId = sessionId;
        this.participants = getParticipants(participants);
        const ids = playerIds.length ? playerIds : this.participants.map(entry => entry.id);
        this.playerIds = new Set(ids);
        this.isPublic = isPublic;
        this.gameOptions = gameOptions || {};
        this.settlementMode = SettlementManager.setActiveMode(gameOptions?.settlementMode);
        this.betLimits = normalizeBetLimits(gameOptions?.betLimits);
        const privatePlan = gmOnlyOptions?.cardLuckPlan ?? gmOnlyOptions?.forcedOutcomePlan ?? null;
        this.cardLuckPlan = CardLuckPlan.sanitize(this.gameType, privatePlan, ids);
        this._phase = 'IDLE';
        this.round = 0;
        this.bets = [];
    }

    /** 游戏类型标识（子类必须覆盖） */
    static get gameType() { throw new Error('Subclass must define gameType'); }
    get gameType() { return this.constructor.gameType; }

    /** 阶段列表（子类覆盖） */
    get phases() { throw new Error('Subclass must implement phases'); }

    /** 转换映射（子类覆盖） */
    get transitions() { throw new Error('Subclass must implement transitions'); }

    get phase() { return this._phase; }

    _transition(newPhase) {
        const allowed = this.transitions[this._phase];
        if (!allowed?.includes(newPhase)) {
            console.warn(`${MODULE_ID} | Invalid transition: ${this._phase} → ${newPhase}`);
            return false;
        }
        const old = this._phase;
        this._phase = newPhase;
        this._onPhaseChange(old, newPhase);
        return true;
    }

    _onPhaseChange(oldPhase, newPhase) {
        console.log(`${MODULE_ID} | [${this.sessionId}] ${oldPhase} → ${newPhase}`);
    }

    /** 开始新一轮 */
    start() { throw new Error('Subclass must implement start()'); }

    /** 获取完整状态 */
    getState() {
        return {
            sessionId: this.sessionId,
            gameType: this.gameType,
            phase: this._phase,
            round: this.round,
            bets: this.bets,
            playerIds: [...this.playerIds],
            participants: this.participants,
            settlementMode: this.settlementMode,
            betLimits: this.betLimits,
            isPublic: this.isPublic
        };
    }

    /** 从状态恢复 */
    setState(state) {
        if (state.phase) this._phase = state.phase;
        if (state.round != null) this.round = state.round;
        if (state.bets) this.bets = state.bets;
        if (state.participants) this.participants = getParticipants(state.participants);
        if (state.playerIds) this.playerIds = new Set(state.playerIds);
        if (state.settlementMode) {
            this.settlementMode = SettlementManager.setActiveMode(state.settlementMode);
        }
        if (state.betLimits) this.betLimits = normalizeBetLimits(state.betLimits);
    }

    _validateBetAmount(amount, options = {}) {
        return validateBetAmount(amount, this.betLimits, options);
    }

    /** 处理玩家操作（子类覆盖） */
    handlePlayerAction(userId, action, data) {
        throw new Error('Subclass must implement handlePlayerAction()');
    }

    /** 处理 GM 操作（子类覆盖） */
    handleGMAction(action, data) {
        throw new Error('Subclass must implement handleGMAction()');
    }

    /** 广播状态 */
    async _broadcastState() {
        await SocketManager.broadcast(SOCKET_EVENTS.GAME_STATE_UPDATE, {
            sessionId: this.sessionId,
            state: this.getState()
        });
    }
}
