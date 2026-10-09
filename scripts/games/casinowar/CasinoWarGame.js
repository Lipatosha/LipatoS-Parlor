/**
 * CasinoWarGame — 赌场战争
 *
 * 这边后续维护默认按 Foundry V14 兼容优先来写。
 * 先做一版稳的多人对庄：每人一张明牌，平手自动进入战争。
 */

import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';

const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

const CASINO_WAR_DECKS = 6;
const DEAL_TO_SHOWDOWN_DELAY_MS = 900;
const MAIN_WIN_MULTIPLIER = 2;
const WAR_WIN_MULTIPLIER = 3;
const WAR_PUSH_MULTIPLIER = 2;
const SURRENDER_PAYOUT_RATIO = 0.5;

function normalizeAmount(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function roundChipAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function getCasinoWarRank(card) {
    if (!card) return 0;
    if (card.rank === 'A') return 14;
    if (card.rank === 'K') return 13;
    if (card.rank === 'Q') return 12;
    if (card.rank === 'J') return 11;
    return Number(card.rank) || 0;
}

function compareCards(a, b) {
    return getCasinoWarRank(a) - getCasinoWarRank(b);
}

export class CasinoWarGame extends GameBase {
    static get gameType() { return 'casinowar'; }

    constructor(config) {
        super(config);
        this.deck = new CardDeck(CASINO_WAR_DECKS);
        this.dealerCard = null;
        this.playerStates = {};
        this.dealerWarCards = {};
        this.warParticipants = [];
        this.payouts = {};
        this.settlementApplied = false;
        this.dealerProfile = config.dealerProfile || null;
        this._dealTimer = null;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'READY', 'DEALING', 'SHOWDOWN', 'WAR', 'SETTLE', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['READY'],
            READY: ['DEALING'],
            DEALING: ['SHOWDOWN'],
            SHOWDOWN: ['WAR', 'SETTLE'],
            WAR: ['SETTLE'],
            SETTLE: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        this._ensureDealerProfile();
        if (this.deck.numDecks !== CASINO_WAR_DECKS) {
            this.deck = new CardDeck(CASINO_WAR_DECKS);
        } else if (this.deck.remaining < 52) {
            this.deck.shuffle();
        }

        this.bets = [];
        this.dealerCard = null;
        this.playerStates = {};
        this.dealerWarCards = {};
        this.warParticipants = [];
        this.payouts = {};
        this.settlementApplied = false;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        return {
            ...super.getState(),
            dealerCard: this.dealerCard,
            dealerProfile: this.dealerProfile,
            playerStates: this.playerStates,
            dealerWarCards: this.dealerWarCards,
            warParticipants: this.warParticipants,
            payouts: this.payouts,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.dealerCard !== undefined) this.dealerCard = state.dealerCard;
        if (state.dealerProfile !== undefined) this.dealerProfile = state.dealerProfile;
        if (state.playerStates) this.playerStates = state.playerStates;
        if (state.dealerWarCards) this.dealerWarCards = state.dealerWarCards;
        if (state.warParticipants) this.warParticipants = state.warParticipants;
        if (state.payouts) this.payouts = state.payouts;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    handlePlayerAction(userId, action, data) {
        if (action !== 'placeBet') return { ok: false, reason: 'unknown-action' };
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
        if (!this._getActivePlayerIds().includes(userId)) return { ok: false, reason: 'not-player' };

        const amount = normalizeAmount(data?.amount);
        if (!amount) return { ok: false, reason: 'invalid-amount' };
        const limitCheck = this._validateBetAmount(amount);
        if (!limitCheck.ok) return limitCheck;
        if (!ChipManager.canAfford(userId, amount)) return { ok: false, reason: 'chips' };

        const currentBet = this.bets.find(entry => entry.userId === userId);
        if (currentBet) {
            currentBet.amount = amount;
            currentBet.updatedAt = Date.now();
        } else {
            this.bets.push({
                userId,
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

            case 'resolveWar':
                if (this._phase !== 'SHOWDOWN') return;
                if (!this.warParticipants.length) return;
                this._resolveWar();
                break;

            case 'openSettle':
                if (this._phase === 'SHOWDOWN' && !this.warParticipants.length) {
                    this._transition('SETTLE');
                    this._broadcastState();
                } else if (this._phase === 'WAR') {
                    this._transition('SETTLE');
                    this._broadcastState();
                }
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

        const bettedIds = new Set(this.bets.map(entry => entry.userId));
        if (!activePlayers.every(userId => bettedIds.has(userId))) return;

        this._transition('READY');
        this._broadcastState();
    }

    _dealCards() {
        this._transition('DEALING');
        this.dealerCard = this.deck.deal();
        this.playerStates = {};
        this.dealerWarCards = {};
        this.warParticipants = [];
        this.payouts = {};

        for (const bet of this.bets) {
            this.playerStates[bet.userId] = {
                bet: bet.amount,
                warBet: 0,
                card: this.deck.deal(),
                warCard: null,
                status: 'dealing',
                result: ''
            };
        }

        this._broadcastState();
        clearTimeout(this._dealTimer);
        this._dealTimer = setTimeout(() => this._enterShowdown(), DEAL_TO_SHOWDOWN_DELAY_MS);
    }

    _enterShowdown() {
        if (this._phase !== 'DEALING') return;

        this._transition('SHOWDOWN');
        this.payouts = {};
        this.warParticipants = [];
        this.dealerWarCards = {};

        for (const bet of this.bets) {
            const seatState = this.playerStates[bet.userId];
            if (!seatState) continue;

            const cardDiff = compareCards(seatState.card, this.dealerCard);
            seatState.warBet = 0;
            seatState.warCard = null;

            if (cardDiff > 0) {
                seatState.status = 'win';
                seatState.result = 'win';
                this.payouts[bet.userId] = roundChipAmount(bet.amount * MAIN_WIN_MULTIPLIER);
                continue;
            }

            if (cardDiff < 0) {
                seatState.status = 'lose';
                seatState.result = 'lose';
                this.payouts[bet.userId] = 0;
                continue;
            }

            if (!ChipManager.canAfford(bet.userId, bet.amount * 2)) {
                seatState.status = 'surrender';
                seatState.result = 'surrender';
                this.payouts[bet.userId] = roundChipAmount(bet.amount * SURRENDER_PAYOUT_RATIO);
                continue;
            }

            seatState.status = 'war';
            seatState.result = 'war';
            seatState.warBet = bet.amount;
            this.payouts[bet.userId] = 0;
            this.warParticipants.push(bet.userId);
        }

        this._broadcastState();
    }

    _resolveWar() {
        if (this._phase !== 'SHOWDOWN') return;
        if (!this.warParticipants.length) {
            this._transition('SETTLE');
            this._broadcastState();
            return;
        }

        this._transition('WAR');
        for (const userId of this.warParticipants) {
            const seatState = this.playerStates[userId];
            if (!seatState) continue;

            // 战争阶段默认烧三张，这里先只结算最终亮出的那张。
            const playerWarCard = this.deck.deal();
            const dealerWarCard = this.deck.deal();
            const warDiff = compareCards(playerWarCard, dealerWarCard);

            seatState.warCard = playerWarCard;
            this.dealerWarCards[userId] = dealerWarCard;

            if (warDiff > 0) {
                seatState.status = 'war-win';
                seatState.result = 'war-win';
                this.payouts[userId] = roundChipAmount(seatState.bet + (seatState.warBet * MAIN_WIN_MULTIPLIER));
                continue;
            }

            if (warDiff < 0) {
                seatState.status = 'war-lose';
                seatState.result = 'war-lose';
                this.payouts[userId] = 0;
                continue;
            }

            seatState.status = 'war-push';
            seatState.result = 'war-push';
            this.payouts[userId] = roundChipAmount(seatState.bet * WAR_PUSH_MULTIPLIER);
        }

        this._broadcastState();
    }

    _openSettlement() {
        if (this._phase !== 'SETTLE') return;
        this._transition('RESOLVING');
        this._broadcastState();
    }

    _ensureDealerProfile() {
        const dealerName = t('PARLOR.Common.Dealer');
        if (this.dealerProfile?.controllerId) {
            this.dealerProfile = {
                ...this.dealerProfile,
                type: 'gm',
                participantId: null,
                actorId: null,
                name: dealerName,
                avatar: null
            };
            return;
        }

        const gm = game.users?.find(user => user.isGM && user.active);
        this.dealerProfile = {
            type: 'gm',
            participantId: null,
            actorId: null,
            userId: gm?.id || null,
            controllerId: gm?.id || null,
            name: dealerName,
            avatar: null
        };
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
            const seatState = this.playerStates[bet.userId] || {};
            const payout = Number(this.payouts?.[bet.userId] || 0);
            const totalStake = Number(bet.amount || 0) + Number(seatState.warBet || 0);
            const delta = roundChipAmount(payout - totalStake);

            if (delta !== 0) chipDeltas.push({ userId: bet.userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _clearTimers() {
        clearTimeout(this._dealTimer);
        this._dealTimer = null;
    }
}

export { compareCards, getCasinoWarRank, roundChipAmount };
