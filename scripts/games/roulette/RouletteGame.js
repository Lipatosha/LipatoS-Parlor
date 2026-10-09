/**
 * RouletteGame — 轮盘赌游戏逻辑（MVP 版）
 * 箭头指针，GP 下注，简化流程。
 */

import { GameBase } from '../GameBase.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';

const MODULE_ID = 'parlor';

// 欧式轮盘数字顺序
export const WHEEL_SEQUENCE = [
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36,
    11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9,
    22, 18, 29, 7, 28, 12, 35, 3, 26
];

export function getNumberColor(n) {
    if (n === 0) return 'green';
    const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
    return reds.includes(n) ? 'red' : 'black';
}

/** 赔付计算 */
function calculatePayout(bet, winNumber) {
    const winColor = getNumberColor(winNumber);
    switch (bet.type) {
        case 'straight': return bet.number === winNumber ? bet.amount * 36 : 0;
        case 'red': return winColor === 'red' ? bet.amount * 2 : 0;
        case 'black': return winColor === 'black' ? bet.amount * 2 : 0;
        case 'even': return winNumber > 0 && winNumber % 2 === 0 ? bet.amount * 2 : 0;
        case 'odd': return winNumber > 0 && winNumber % 2 === 1 ? bet.amount * 2 : 0;
        case 'low': return winNumber >= 1 && winNumber <= 18 ? bet.amount * 2 : 0;
        case 'high': return winNumber >= 19 && winNumber <= 36 ? bet.amount * 2 : 0;
        case 'dozen_1': return winNumber >= 1 && winNumber <= 12 ? bet.amount * 3 : 0;
        case 'dozen_2': return winNumber >= 13 && winNumber <= 24 ? bet.amount * 3 : 0;
        case 'dozen_3': return winNumber >= 25 && winNumber <= 36 ? bet.amount * 3 : 0;
        default: return 0;
    }
}

export class RouletteGame extends GameBase {
    static get gameType() { return 'roulette'; }

    constructor(config) {
        super(config);
        this.winningNumber = null;
        this.payouts = {};
        this.settlementApplied = false;
        this._resolveTimer = null;
    }

    get phases() { return ['IDLE', 'BETTING', 'SPINNING', 'RESOLVING']; }
    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['SPINNING'],
            SPINNING: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        this.bets = [];
        this.winningNumber = null;
        this.payouts = {};
        this.settlementApplied = false;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        return {
            ...super.getState(),
            winningNumber: this.winningNumber,
            payouts: this.payouts,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.winningNumber !== undefined) this.winningNumber = state.winningNumber;
        if (state.payouts) this.payouts = state.payouts;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    /** 玩家操作 */
    handlePlayerAction(userId, action, data) {
        if (action === 'placeBet') {
            if (this._phase !== 'BETTING') return;
            if (!this.playerIds.has(userId)) return;
            const amount = Math.floor(Number(data?.amount));
            if (!Number.isFinite(amount) || amount <= 0) return;
            if (!ChipManager.canAfford(userId, this._getPlayerCommittedBet(userId) + amount)) return;
            this.bets.push({
                userId,
                type: data.betType,
                number: data.number,
                amount
            });
            this._broadcastState();
        }
    }

    /** GM 操作 */
    async handleGMAction(action, data) {
        if (action === 'spin') {
            if (this._phase !== 'BETTING') return;
            this._transition('SPINNING');
            // 随机结果
            const idx = Math.floor(Math.random() * WHEEL_SEQUENCE.length);
            this.winningNumber = WHEEL_SEQUENCE[idx];
            this._broadcastState();

            // 延迟后结算
            clearTimeout(this._resolveTimer);
            this._resolveTimer = setTimeout(() => this._resolve(), 7200);
        } else if (action === 'newRound') {
            if (this._phase !== 'RESOLVING') return;
            await this._commitPayouts();
            this.start();
            await this._broadcastState();
        } else if (action === 'finishGame') {
            if (this._phase !== 'RESOLVING') return;
            await this._commitPayouts();
        }
    }

    _resolve() {
        this._transition('RESOLVING');
        this.payouts = {};
        for (const bet of this.bets) {
            const payout = calculatePayout(bet, this.winningNumber);
            if (payout > 0) {
                this.payouts[bet.userId] = (this.payouts[bet.userId] || 0) + payout;
            }
        }
        this._broadcastState();
    }

    _getPlayerCommittedBet(userId) {
        return this.bets
            .filter(bet => bet.userId === userId)
            .reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
    }

    async _commitPayouts() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const totals = new Map();
        for (const bet of this.bets) {
            const entry = totals.get(bet.userId) || { stake: 0, payout: 0 };
            entry.stake += Number(bet.amount || 0);
            entry.payout += Number(calculatePayout(bet, this.winningNumber) || 0);
            totals.set(bet.userId, entry);
        }

        const chipDeltas = [];
        for (const [userId, { stake, payout }] of totals.entries()) {
            const delta = payout - stake;
            if (delta !== 0) chipDeltas.push({ userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _clearTimers() {
        clearTimeout(this._resolveTimer);
        this._resolveTimer = null;
    }
}
