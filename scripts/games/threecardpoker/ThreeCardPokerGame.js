/**
 * ThreeCardPokerGame — 三张扑克
 *
 * 完整版先上核心桌：
 * - Ante
 * - Play / Fold
 * - Pair Plus
 * - Ante Bonus
 * - 庄家资格（Q high）
 */

import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';
import {
    compareThreeCardPokerHands,
    dealerQualifies,
    evaluateThreeCardPokerHand,
    getAnteBonusOdds,
    getPairPlusOdds,
    getThreeCardPokerHandLabelKey
} from './ThreeCardPokerRules.js';

const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

const THREE_CARD_POKER_DECKS = 1;
const DEAL_TO_DECISION_DELAY_MS = 920;
const SHOWDOWN_TO_SETTLE_DELAY_MS = 1800;

function normalizeAnteAmount(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeBonusAmount(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeDecision(decision) {
    if (typeof decision !== 'string') return null;
    const safeDecision = decision.trim().toLowerCase();
    return ['play', 'fold'].includes(safeDecision) ? safeDecision : null;
}

function roundChipAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function createRoundResult({ handRank, dealerRank, dealerQualified: dealerIsQualified, decision, anteAmount, pairPlusAmount, playAmount }) {
    const safeAnte = Number(anteAmount || 0);
    const safePairPlus = Number(pairPlusAmount || 0);
    const safePlay = Number(playAmount || 0);
    const totalStake = roundChipAmount(safeAnte + safePairPlus + safePlay);
    const pairPlusOdds = getPairPlusOdds(handRank);
    const anteBonusOdds = decision === 'play' ? getAnteBonusOdds(handRank) : 0;
    const handLabelKey = getThreeCardPokerHandLabelKey(handRank, { preferMiniRoyal: true });
    const dealerHandLabelKey = getThreeCardPokerHandLabelKey(dealerRank, { preferMiniRoyal: true });

    const result = {
        decision,
        handLabelKey,
        dealerHandLabelKey,
        dealerQualified: !!dealerIsQualified,
        compareResult: 'none',
        mainResult: decision === 'fold' ? 'fold' : 'pending',
        pairPlusOdds,
        anteBonusOdds,
        anteReturn: 0,
        playReturn: 0,
        pairPlusReturn: 0,
        anteBonusReturn: 0,
        totalStake,
        totalReturn: 0,
        net: -totalStake
    };

    if (safePairPlus > 0 && pairPlusOdds > 0) {
        result.pairPlusReturn = roundChipAmount(safePairPlus * (pairPlusOdds + 1));
    }

    if (decision === 'fold') {
        result.totalReturn = roundChipAmount(result.pairPlusReturn);
        result.net = roundChipAmount(result.totalReturn - totalStake);
        return result;
    }

    if (anteBonusOdds > 0) {
        // Ante bonus 是纯奖金，不额外返一次本金。
        result.anteBonusReturn = roundChipAmount(safeAnte * anteBonusOdds);
    }

    if (!dealerIsQualified) {
        result.mainResult = 'dealer-no-qualify';
        result.compareResult = 'push';
        result.anteReturn = roundChipAmount(safeAnte * 2);
        result.playReturn = roundChipAmount(safePlay);
        result.totalReturn = roundChipAmount(result.anteReturn + result.playReturn + result.pairPlusReturn + result.anteBonusReturn);
        result.net = roundChipAmount(result.totalReturn - totalStake);
        return result;
    }

    const compareResult = compareThreeCardPokerHands(handRank, dealerRank);
    if (compareResult > 0) {
        result.mainResult = 'win';
        result.compareResult = 'win';
        result.anteReturn = roundChipAmount(safeAnte * 2);
        result.playReturn = roundChipAmount(safePlay * 2);
    } else if (compareResult < 0) {
        result.mainResult = 'lose';
        result.compareResult = 'lose';
    } else {
        result.mainResult = 'push';
        result.compareResult = 'push';
        result.anteReturn = roundChipAmount(safeAnte);
        result.playReturn = roundChipAmount(safePlay);
    }

    result.totalReturn = roundChipAmount(result.anteReturn + result.playReturn + result.pairPlusReturn + result.anteBonusReturn);
    result.net = roundChipAmount(result.totalReturn - totalStake);
    return result;
}

export class ThreeCardPokerGame extends GameBase {
    static get gameType() { return 'threecardpoker'; }

    constructor(config) {
        super(config);
        this.deck = new CardDeck(THREE_CARD_POKER_DECKS);
        this.dealerHand = [];
        this.dealerRank = null;
        this.dealerQualified = false;
        this.dealerProfile = config.dealerProfile || null;
        this.playerStates = {};
        this.payouts = {};
        this.settlementApplied = false;
        this._dealTimer = null;
        this._phaseTimer = null;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'READY', 'DEALING', 'DECISION', 'REVEAL_READY', 'SHOWDOWN', 'SETTLE', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['READY'],
            READY: ['DEALING'],
            DEALING: ['DECISION'],
            DECISION: ['REVEAL_READY'],
            REVEAL_READY: ['SHOWDOWN'],
            SHOWDOWN: ['SETTLE'],
            SETTLE: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        this._ensureDealerProfile();

        if (this.deck.numDecks !== THREE_CARD_POKER_DECKS) {
            this.deck = new CardDeck(THREE_CARD_POKER_DECKS);
        } else if (this.deck.remaining < 16) {
            this.deck.shuffle();
        }

        this.bets = [];
        this.playerStates = {};
        this.dealerHand = [];
        this.dealerRank = null;
        this.dealerQualified = false;
        this.payouts = {};
        this.settlementApplied = false;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        return {
            ...super.getState(),
            dealerHand: this.dealerHand,
            dealerRank: this.dealerRank,
            dealerQualified: this.dealerQualified,
            dealerProfile: this.dealerProfile,
            playerStates: this.playerStates,
            payouts: this.payouts,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.dealerHand) this.dealerHand = state.dealerHand;
        if (state.dealerRank !== undefined) this.dealerRank = state.dealerRank || null;
        if (state.dealerQualified !== undefined) this.dealerQualified = !!state.dealerQualified;
        if (state.dealerProfile !== undefined) this.dealerProfile = state.dealerProfile;
        if (state.playerStates) this.playerStates = state.playerStates;
        if (state.payouts) this.payouts = state.payouts;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    handlePlayerAction(userId, action, data) {
        switch (action) {
            case 'placeBet':
                return this._handlePlaceBet(userId, data);
            case 'makeDecision':
                return this._handleDecision(userId, data);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action) {
        switch (action) {
            case 'deal':
                if (this._phase !== 'READY') return { ok: false, reason: 'phase' };
                this._dealHands();
                return { ok: true };

            case 'reveal':
                if (this._phase !== 'REVEAL_READY') return { ok: false, reason: 'phase' };
                this._openShowdown();
                return { ok: true };

            case 'settle':
                if (this._phase !== 'SETTLE') return { ok: false, reason: 'phase' };
                this._openSettlement();
                return { ok: true };

            case 'newRound':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitPayouts();
                this.start();
                await this._broadcastState();
                return { ok: true };

            case 'finishGame':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitPayouts();
                return { ok: true };

            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _handlePlaceBet(userId, data) {
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
        if (!this._getActivePlayerIds().includes(userId)) return { ok: false, reason: 'not-player' };

        const anteAmount = normalizeAnteAmount(data?.anteAmount);
        const pairPlusAmount = normalizeBonusAmount(data?.pairPlusAmount);
        if (!anteAmount) return { ok: false, reason: 'invalid-ante' };
        if (pairPlusAmount < 0) return { ok: false, reason: 'invalid-pairplus' };

        const anteLimitCheck = this._validateBetAmount(anteAmount);
        if (!anteLimitCheck.ok) return anteLimitCheck;
        const pairPlusLimitCheck = this._validateBetAmount(pairPlusAmount, { optional: true });
        if (!pairPlusLimitCheck.ok) return pairPlusLimitCheck;

        const openingStake = anteAmount + pairPlusAmount;
        if (!ChipManager.canAfford(userId, openingStake)) return { ok: false, reason: 'chips' };

        const currentBet = this.bets.find(entry => entry.userId === userId);
        if (currentBet) {
            currentBet.anteAmount = anteAmount;
            currentBet.pairPlusAmount = pairPlusAmount;
            currentBet.playAmount = 0;
            currentBet.decision = 'pending';
            currentBet.updatedAt = Date.now();
        } else {
            this.bets.push({
                userId,
                anteAmount,
                pairPlusAmount,
                playAmount: 0,
                decision: 'pending',
                placedAt: Date.now()
            });
        }

        this._broadcastState();
        this._checkAllBets();
        return { ok: true };
    }

    _handleDecision(userId, data) {
        if (this._phase !== 'DECISION') return { ok: false, reason: 'phase' };

        const seatState = this.playerStates?.[userId];
        const bet = this._getBetForUser(userId);
        if (!seatState || !bet) return { ok: false, reason: 'not-player' };
        if (seatState.decision && seatState.decision !== 'pending') return { ok: false, reason: 'locked' };

        const decision = normalizeDecision(data?.decision);
        if (!decision) return { ok: false, reason: 'invalid-decision' };

        if (decision === 'play') {
            const totalStake = Number(bet.anteAmount || 0) * 2 + Number(bet.pairPlusAmount || 0);
            if (!ChipManager.canAfford(userId, totalStake)) return { ok: false, reason: 'chips' };
            seatState.playAmount = Number(bet.anteAmount || 0);
        } else {
            seatState.playAmount = 0;
        }

        seatState.decision = decision;
        seatState.roundResult = null;
        bet.decision = decision;
        bet.playAmount = seatState.playAmount;
        bet.updatedAt = Date.now();

        this._broadcastState();
        this._checkAllDecisions();
        return { ok: true };
    }

    _checkAllBets() {
        const activePlayers = this._getBettingPlayerIds();
        if (!activePlayers.length) return;

        const bettedIds = new Set(this.bets.map(entry => entry.userId));
        if (!activePlayers.every(userId => bettedIds.has(userId))) return;

        this._transition('READY');
        this._broadcastState();
    }

    _dealHands() {
        this._transition('DEALING');
        this.playerStates = {};
        this.payouts = {};
        this.dealerQualified = false;
        this.dealerRank = null;
        this.dealerHand = this.deck.dealMany(3);

        for (const bet of this.bets) {
            const hand = OutcomeInfluence.pickThreeCardHand(this, this.deck, bet.userId);
            this.playerStates[bet.userId] = {
                anteAmount: Number(bet.anteAmount || 0),
                pairPlusAmount: Number(bet.pairPlusAmount || 0),
                playAmount: 0,
                decision: 'pending',
                hand,
                handRank: evaluateThreeCardPokerHand(hand),
                roundResult: null
            };
        }

        this._broadcastState();

        clearTimeout(this._dealTimer);
        this._dealTimer = setTimeout(() => this._openDecision(), DEAL_TO_DECISION_DELAY_MS);
    }

    _openDecision() {
        if (this._phase !== 'DEALING') return;
        this._transition('DECISION');
        this._broadcastState();
    }

    _checkAllDecisions() {
        const activePlayers = Object.keys(this.playerStates || {});
        if (!activePlayers.length) return;

        const allLocked = activePlayers.every(userId => {
            const seat = this.playerStates?.[userId];
            return seat && seat.decision && seat.decision !== 'pending';
        });
        if (!allLocked) return;

        this._transition('REVEAL_READY');
        this._broadcastState();
    }

    _openShowdown() {
        if (this._phase !== 'REVEAL_READY') return;

        this._transition('SHOWDOWN');
        this.dealerRank = evaluateThreeCardPokerHand(this.dealerHand);
        this.dealerQualified = dealerQualifies(this.dealerRank);
        this.payouts = {};

        for (const userId of this._getActivePlayerIds()) {
            const seatState = this.playerStates?.[userId];
            if (!seatState) continue;

            const roundResult = createRoundResult({
                handRank: seatState.handRank,
                dealerRank: this.dealerRank,
                dealerQualified: this.dealerQualified,
                decision: seatState.decision,
                anteAmount: seatState.anteAmount,
                pairPlusAmount: seatState.pairPlusAmount,
                playAmount: seatState.playAmount
            });

            seatState.roundResult = roundResult;
            this.payouts[userId] = roundResult.totalReturn;
        }

        this._broadcastState();

        clearTimeout(this._phaseTimer);
        this._phaseTimer = setTimeout(() => this._enterSettle(), SHOWDOWN_TO_SETTLE_DELAY_MS);
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

    _getBetForUser(userId) {
        return this.bets.find(entry => entry.userId === userId) || null;
    }

    _getActivePlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    _getBettingPlayerIds() {
        return this._getActivePlayerIds()
            .filter(userId => ChipManager.canAfford(userId, this.betLimits.min));
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
            avatar: null,
            ownerName: gm?.name || t('PARLOR.Common.DM')
        };
    }

    async _commitPayouts() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const chipDeltas = [];
        for (const userId of this._getActivePlayerIds()) {
            const seatState = this.playerStates?.[userId];
            if (!seatState) continue;

            const payout = Number(this.payouts?.[userId] || 0);
            const totalStake = Number(seatState.roundResult?.totalStake || 0);
            const delta = roundChipAmount(payout - totalStake);

            if (delta !== 0) chipDeltas.push({ userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _clearTimers() {
        clearTimeout(this._dealTimer);
        clearTimeout(this._phaseTimer);
        this._dealTimer = null;
        this._phaseTimer = null;
    }
}

export {
    createRoundResult,
    roundChipAmount
};
