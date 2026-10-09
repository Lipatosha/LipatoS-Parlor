/**
 * SlotMachineGame — 单人水果老虎机
 *
 * 这版改回真正的机台流程：
 * - 整局只保留一位操作者
 * - DM 开局时设好每转成本
 * - 玩家自己按 Spin
 * - 转停后自动结算，马上回待机
 */

import { GameBase } from '../GameBase.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { SlotMachineConfig } from '../../core/SlotMachineConfig.js';
import {
    SLOT_BET_STEP,
    calculateSlotPayoutFromTotalBet,
    createEmptyBoard,
    createSlotSpin,
    roundChip
} from './SlotMachineRules.js';

const SPIN_RESOLVE_DELAY_MS = 3200;

function sanitizeSpinCost(amount, fallback = SLOT_BET_STEP) {
    const raw = Math.floor(Number(amount || 0));
    const safeFallback = Math.max(SLOT_BET_STEP, Math.floor(Number(fallback || 0)) || SLOT_BET_STEP);
    const value = Number.isFinite(raw) && raw > 0 ? raw : safeFallback;
    return Math.max(SLOT_BET_STEP, Math.ceil(value / SLOT_BET_STEP) * SLOT_BET_STEP);
}

export class SlotMachineGame extends GameBase {
    static get gameType() { return 'slotmachine'; }

    constructor(config) {
        super(config);
        this.spinCost = sanitizeSpinCost(config?.gameOptions?.spinCost);
        this.board = createEmptyBoard();
        this.spinSummary = null;
        this.playerResults = {};
        this.payouts = {};
        this.spinId = 0;
        this.lastResult = null;
        this.lastSpinnerId = '';
        this.settlementApplied = false;
        this._resolveTimer = null;
    }

    get phases() {
        return ['IDLE', 'READY', 'SPINNING'];
    }

    get transitions() {
        return {
            IDLE: ['READY'],
            READY: ['SPINNING'],
            SPINNING: ['READY']
        };
    }

    start() {
        this._clearTimers();
        this.board = createEmptyBoard();
        this.spinSummary = null;
        this.playerResults = {};
        this.payouts = {};
        this.spinId = 0;
        this.round = 0;
        this.lastResult = null;
        this.lastSpinnerId = '';
        this.settlementApplied = false;
        this._transition('READY');
    }

    getState() {
        return {
            ...super.getState(),
            board: this.board,
            spinSummary: this.spinSummary,
            playerResults: this.playerResults,
            payouts: this.payouts,
            spinId: this.spinId,
            spinCost: this.spinCost,
            lastResult: this.lastResult,
            lastSpinnerId: this.lastSpinnerId,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.board) this.board = state.board;
        if (state.spinSummary !== undefined) this.spinSummary = state.spinSummary || null;
        if (state.playerResults) this.playerResults = state.playerResults;
        if (state.payouts) this.payouts = state.payouts;
        if (state.spinId !== undefined) this.spinId = Number(state.spinId || 0);
        if (state.spinCost !== undefined) this.spinCost = sanitizeSpinCost(state.spinCost);
        if (state.lastResult !== undefined) this.lastResult = state.lastResult || null;
        if (state.lastSpinnerId !== undefined) this.lastSpinnerId = state.lastSpinnerId || '';
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    handlePlayerAction(userId, action, data = {}) {
        switch (action) {
            case 'spin':
                return this._handleSpin(userId, data);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action) {
        switch (action) {
            case 'finishGame':
                if (this._phase === 'SPINNING') {
                    await this._finishSpin();
                }
                return { ok: true };
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _handleSpin(userId, data = {}) {
        if (this._phase !== 'READY') return { ok: false, reason: 'phase' };

        const operatorId = this._getOperatorId();
        if (!operatorId || operatorId !== userId) {
            return { ok: false, reason: 'not-player' };
        }

        const spinCost = sanitizeSpinCost(data?.spinCost, this.spinCost);
        if (!ChipManager.canAfford(userId, spinCost)) {
            return { ok: false, reason: 'chips' };
        }

        this._spinRound(userId, spinCost);
        return { ok: true };
    }

    _spinRound(userId, spinCost) {
        const slotConfig = SlotMachineConfig.getConfig();
        const spin = createSlotSpin({
            prizeRates: SlotMachineConfig.getPrizeRates(slotConfig),
            paytable: SlotMachineConfig.getPaytable(slotConfig)
        });
        const stake = sanitizeSpinCost(spinCost, this.spinCost);
        const result = calculateSlotPayoutFromTotalBet(spin.summary, stake);

        this._transition('SPINNING');
        this.round += 1;
        this.spinId += 1;
        this.spinCost = stake;
        this.board = spin.board;
        this.spinSummary = spin.summary;
        this.playerResults = { [userId]: result };
        this.payouts = { [userId]: result.totalPayout };
        this.lastResult = null;
        this.lastSpinnerId = userId;
        this.settlementApplied = false;
        this._broadcastState();

        clearTimeout(this._resolveTimer);
        this._resolveTimer = setTimeout(() => {
            this._finishSpin().catch(error => {
                console.error('parlor | Slot Machine resolve failed:', error);
            });
        }, SPIN_RESOLVE_DELAY_MS);
    }

    async _finishSpin() {
        if (this._phase !== 'SPINNING') return;

        const operatorId = this.lastSpinnerId || this._getOperatorId();
        const result = operatorId ? (this.playerResults?.[operatorId] || null) : null;

        await this._applySpinResult(operatorId, result);
        this.lastResult = result;
        this._transition('READY');
        await this._broadcastState();
    }

    async _applySpinResult(userId, result) {
        if (this.settlementApplied || !userId || !result) return;
        this.settlementApplied = true;

        const totalBet = Number(result.totalBet || this.spinCost || 0);
        const delta = roundChip(Number(result.totalPayout || 0) - totalBet);
        if (delta > 0) {
            await ChipManager.grant(userId, delta);
            return;
        }

        if (delta < 0) {
            await ChipManager.deduct(userId, Math.abs(delta));
        }
    }

    _getOperatorId() {
        return [...this.playerIds].find(Boolean) || '';
    }

    _clearTimers() {
        clearTimeout(this._resolveTimer);
        this._resolveTimer = null;
    }
}
