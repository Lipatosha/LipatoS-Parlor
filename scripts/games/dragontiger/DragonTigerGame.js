/**
 * DragonTigerGame — 龙虎斗游戏逻辑
 *
 * 这边后续维护默认按 Foundry V14 兼容优先来写。
 * 先做最稳的一版：每位参与者一轮一注，押龙 / 押虎 / 押和。
 */

import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';

const DRAGON_TIGER_DECKS = 8;
const DEAL_TO_SHOWDOWN_DELAY_MS = 760;
const SHOWDOWN_TO_SETTLE_DELAY_MS = 1800;
const MAIN_WIN_MULTIPLIER = 2;     // 含本金，等于 1:1
const TIE_WIN_MULTIPLIER = 12;     // 含本金，等于 11:1
const TIE_MAIN_REFUND_RATIO = 0.5; // 和局时龙 / 虎主注退半

function normalizeSide(side) {
    if (typeof side !== 'string') return null;
    const safeSide = side.trim().toLowerCase();
    return ['dragon', 'tiger', 'tie'].includes(safeSide) ? safeSide : null;
}

function normalizeAmount(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function getDragonTigerRank(card) {
    if (!card) return 0;
    if (card.rank === 'A') return 1;
    if (card.rank === 'J') return 11;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'K') return 13;
    return Number(card.rank) || 0;
}

function getWinnerSide(dragonCard, tigerCard) {
    const dragonValue = getDragonTigerRank(dragonCard);
    const tigerValue = getDragonTigerRank(tigerCard);
    if (dragonValue === tigerValue) return 'tie';
    return dragonValue > tigerValue ? 'dragon' : 'tiger';
}

export class DragonTigerGame extends GameBase {
    static get gameType() { return 'dragontiger'; }

    constructor(config) {
        super(config);
        this.deck = new CardDeck(DRAGON_TIGER_DECKS);
        this.dragonCard = null;
        this.tigerCard = null;
        this.winner = null;
        this.payouts = {};
        this.settlementApplied = false;
        this._dealTimer = null;
        this._showdownTimer = null;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'READY', 'DEALING', 'SHOWDOWN', 'SETTLE', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['READY'],
            READY: ['DEALING'],
            DEALING: ['SHOWDOWN'],
            SHOWDOWN: ['SETTLE'],
            SETTLE: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        if (this.deck.numDecks !== DRAGON_TIGER_DECKS) {
            this.deck = new CardDeck(DRAGON_TIGER_DECKS);
        } else if (this.deck.remaining < 30) {
            this.deck.shuffle();
        }

        this.bets = [];
        this.dragonCard = null;
        this.tigerCard = null;
        this.winner = null;
        this.payouts = {};
        this.settlementApplied = false;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        return {
            ...super.getState(),
            dragonCard: this.dragonCard,
            tigerCard: this.tigerCard,
            winner: this.winner,
            payouts: this.payouts,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.dragonCard !== undefined) this.dragonCard = state.dragonCard;
        if (state.tigerCard !== undefined) this.tigerCard = state.tigerCard;
        if (state.winner !== undefined) this.winner = state.winner;
        if (state.payouts) this.payouts = state.payouts;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    handlePlayerAction(userId, action, data) {
        if (action !== 'placeBet') return { ok: false, reason: 'unknown-action' };
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
        if (!this.playerIds.has(userId)) return { ok: false, reason: 'not-player' };

        const side = normalizeSide(data?.side);
        const amount = normalizeAmount(data?.amount);
        if (!side) return { ok: false, reason: 'invalid-side' };
        if (!amount) return { ok: false, reason: 'invalid-amount' };
        const limitCheck = this._validateBetAmount(amount);
        if (!limitCheck.ok) return limitCheck;
        if (!ChipManager.canAfford(userId, amount)) return { ok: false, reason: 'chips' };

        const currentBet = this.bets.find(bet => bet.userId === userId);
        if (currentBet) {
            currentBet.side = side;
            currentBet.amount = amount;
            currentBet.updatedAt = Date.now();
        } else {
            this.bets.push({
                userId,
                side,
                amount,
                placedAt: Date.now()
            });
        }

        this._broadcastState();
        this._checkAllBets();
        return { ok: true };
    }

    async handleGMAction(action, data) {
        switch (action) {
            case 'deal':
                if (this._phase !== 'READY') return;
                this._dealCards();
                break;

            case 'settle':
                if (this._phase !== 'SETTLE') return;
                this._openSettlement();
                break;

            case 'newRound':
                if (this._phase !== 'RESOLVING') return;
                await this._commitPayouts();
                this.start();
                await this._broadcastState();
                break;

            case 'finishGame':
                if (this._phase !== 'RESOLVING') return;
                await this._commitPayouts();
                break;
        }
    }

    _checkAllBets() {
        const activePlayers = this._getBettingPlayerIds();
        if (!activePlayers.length) return;

        const bettedIds = new Set(this.bets.map(bet => bet.userId));
        if (!activePlayers.every(userId => bettedIds.has(userId))) return;

        this._transition('READY');
        this._broadcastState();
    }

    _dealCards() {
        this._transition('DEALING');
        this.dragonCard = this.deck.deal();
        this.tigerCard = this.deck.deal();
        this.winner = null;
        this.payouts = {};
        this._broadcastState();

        clearTimeout(this._dealTimer);
        this._dealTimer = setTimeout(() => this._enterShowdown(), DEAL_TO_SHOWDOWN_DELAY_MS);
    }

    _enterShowdown() {
        if (this._phase !== 'DEALING') return;

        // V14 兼容优先：亮牌先停一拍，再交给 DM 点结算。
        this._transition('SHOWDOWN');
        this.winner = getWinnerSide(this.dragonCard, this.tigerCard);
        this.payouts = {};

        for (const bet of this.bets) {
            this.payouts[bet.userId] = this._calculatePayout(bet);
        }

        this._broadcastState();

        clearTimeout(this._showdownTimer);
        this._showdownTimer = setTimeout(() => this._enterSettle(), SHOWDOWN_TO_SETTLE_DELAY_MS);
    }

    _enterSettle() {
        if (this._phase !== 'SHOWDOWN') return;
        this._transition('SETTLE');
        this._broadcastState();
    }

    _openSettlement() {
        if (this._phase !== 'SETTLE') return;
        this._transition('RESOLVING');
        this._broadcastState();
    }

    _calculatePayout(bet) {
        if (!bet) return 0;

        if (bet.side === this.winner) {
            return bet.side === 'tie'
                ? bet.amount * TIE_WIN_MULTIPLIER
                : bet.amount * MAIN_WIN_MULTIPLIER;
        }

        if (this.winner === 'tie' && (bet.side === 'dragon' || bet.side === 'tiger')) {
            return Math.floor(bet.amount * TIE_MAIN_REFUND_RATIO);
        }

        return 0;
    }

    _getActivePlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    _getBettingPlayerIds() {
        return this._getActivePlayerIds()
            .filter(userId => ChipManager.canAfford(userId, this.betLimits.min));
    }

    async _commitPayouts() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const chipDeltas = [];
        for (const bet of this.bets) {
            const payout = Number(this.payouts?.[bet.userId] || 0);
            const delta = payout - Number(bet.amount || 0);

            if (delta !== 0) chipDeltas.push({ userId: bet.userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _clearTimers() {
        clearTimeout(this._dealTimer);
        clearTimeout(this._showdownTimer);
        this._dealTimer = null;
        this._showdownTimer = null;
    }
}

export { getDragonTigerRank, getWinnerSide };
