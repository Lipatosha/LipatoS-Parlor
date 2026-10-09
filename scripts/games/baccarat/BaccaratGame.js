/**
 * BaccaratGame — 百家乐
 *
 * V14 兼容优先：先做标准庄 / 闲 / 和三下注区，
 * 流程拆成首轮亮牌、补牌说明、补牌执行、结果展示、结算。
 */

import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';

const BACCARAT_DECKS = 8;
const DEAL_TO_SHOWDOWN_DELAY_MS = 1120;
const SHOWDOWN_TO_DRAW_RULES_DELAY_MS = 1600;
const DRAWING_BASE_DELAY_MS = 760;
const DRAWING_PER_CARD_DELAY_MS = 260;
const FINAL_SHOWDOWN_TO_SETTLE_DELAY_MS = 1800;
const PLAYER_WIN_MULTIPLIER = 2;
const BANKER_WIN_MULTIPLIER = 1.95;
const TIE_WIN_MULTIPLIER = 9;

function reasonToken(key, data = {}) {
    return { key, data };
}

function normalizeSide(side) {
    if (typeof side !== 'string') return null;
    const safeSide = side.trim().toLowerCase();
    return ['player', 'banker', 'tie'].includes(safeSide) ? safeSide : null;
}

function normalizeAmount(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function roundChipAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function getBaccaratCardValue(card) {
    if (!card) return 0;
    if (card.rank === 'A') return 1;
    if (['10', 'J', 'Q', 'K'].includes(card.rank)) return 0;
    return Number(card.rank) || 0;
}

function getBaccaratTotal(cards = []) {
    return cards.reduce((sum, card) => sum + getBaccaratCardValue(card), 0) % 10;
}

function shouldBankerDraw(bankerTotal, playerThirdValue = null) {
    if (playerThirdValue == null) return bankerTotal <= 5;
    if (bankerTotal <= 2) return true;
    if (bankerTotal === 3) return playerThirdValue !== 8;
    if (bankerTotal === 4) return playerThirdValue >= 2 && playerThirdValue <= 7;
    if (bankerTotal === 5) return playerThirdValue >= 4 && playerThirdValue <= 7;
    if (bankerTotal === 6) return playerThirdValue === 6 || playerThirdValue === 7;
    return false;
}

function getWinnerSide(playerTotal, bankerTotal) {
    if (playerTotal === bankerTotal) return 'tie';
    return playerTotal > bankerTotal ? 'player' : 'banker';
}

function getBankerPlanForInitialReveal(bankerTotal, playerShouldDraw) {
    if (!playerShouldDraw) {
        const shouldDraw = shouldBankerDraw(bankerTotal, null);
        return shouldDraw
            ? {
                action: 'draw',
                reason: reasonToken('PARLOR.Baccarat.Reason.BankerDrawWhenPlayerStands', { bankerTotal })
            }
            : {
                action: 'stand',
                reason: reasonToken('PARLOR.Baccarat.Reason.BankerStandWhenPlayerStands', { bankerTotal })
            };
    }

    if (bankerTotal <= 2) {
        return {
            action: 'draw',
            reason: reasonToken('PARLOR.Baccarat.Reason.BankerDraw012', { bankerTotal })
        };
    }

    if (bankerTotal === 7) {
        return {
            action: 'stand',
            reason: reasonToken('PARLOR.Baccarat.Reason.BankerStand7')
        };
    }

    const conditionalText = {
        3: reasonToken('PARLOR.Baccarat.Reason.BankerConditional3'),
        4: reasonToken('PARLOR.Baccarat.Reason.BankerConditional4'),
        5: reasonToken('PARLOR.Baccarat.Reason.BankerConditional5'),
        6: reasonToken('PARLOR.Baccarat.Reason.BankerConditional6')
    };

    return {
        action: 'conditional',
        reason: conditionalText[bankerTotal] || reasonToken('PARLOR.Baccarat.Reason.BankerConditionalFallback', { bankerTotal })
    };
}

function buildInitialRoundSummary(playerHand, bankerHand) {
    const initialPlayerTotal = getBaccaratTotal(playerHand);
    const initialBankerTotal = getBaccaratTotal(bankerHand);
    const natural = initialPlayerTotal >= 8 || initialBankerTotal >= 8;
    const playerShouldDraw = !natural && initialPlayerTotal <= 5;
    const bankerPlan = natural
        ? { action: 'stand', reason: reasonToken('PARLOR.Baccarat.Reason.NaturalNoDraw') }
        : getBankerPlanForInitialReveal(initialBankerTotal, playerShouldDraw);

    return {
        stage: 'initial',
        natural,
        initialPlayerTotal,
        initialBankerTotal,
        finalPlayerTotal: initialPlayerTotal,
        finalBankerTotal: initialBankerTotal,
        playerShouldDraw,
        playerReason: natural
            ? reasonToken('PARLOR.Baccarat.Reason.PlayerNaturalStand', { total: initialPlayerTotal })
            : (playerShouldDraw
                ? reasonToken('PARLOR.Baccarat.Reason.PlayerDraw05', { total: initialPlayerTotal })
                : reasonToken('PARLOR.Baccarat.Reason.PlayerStand67', { total: initialPlayerTotal })),
        bankerPlan: bankerPlan.action,
        bankerReason: bankerPlan.reason,
        playerDrew: false,
        bankerDrew: false,
        playerThirdValue: null,
        bankerThirdValue: null,
        resolvedBankerReason: '',
        drawResolved: false
    };
}

function resolveBankerDecision(initialBankerTotal, playerShouldDraw, playerThirdValue) {
    if (!playerShouldDraw) {
        const shouldDraw = shouldBankerDraw(initialBankerTotal, null);
        return {
            shouldDraw,
            reason: shouldDraw
                ? reasonToken('PARLOR.Baccarat.Reason.ResolvedBankerDrawWhenPlayerStands', { bankerTotal: initialBankerTotal })
                : reasonToken('PARLOR.Baccarat.Reason.ResolvedBankerStandWhenPlayerStands', { bankerTotal: initialBankerTotal })
        };
    }

    const shouldDraw = shouldBankerDraw(initialBankerTotal, playerThirdValue);
    return {
        shouldDraw,
        reason: shouldDraw
            ? reasonToken('PARLOR.Baccarat.Reason.ResolvedBankerDrawAfterPlayerThird', { playerThirdValue, bankerTotal: initialBankerTotal })
            : reasonToken('PARLOR.Baccarat.Reason.ResolvedBankerStandAfterPlayerThird', { playerThirdValue, bankerTotal: initialBankerTotal })
    };
}

function applyBaccaratDrawStage(deck, playerHand, bankerHand, summary) {
    const nextPlayerHand = [...playerHand];
    const nextBankerHand = [...bankerHand];
    let playerThirdCard = null;
    let bankerThirdCard = null;

    if (!summary.natural && summary.playerShouldDraw) {
        playerThirdCard = deck.deal();
        nextPlayerHand.push(playerThirdCard);
    }

    const playerThirdValue = playerThirdCard ? getBaccaratCardValue(playerThirdCard) : null;
    const bankerDecision = summary.natural
        ? { shouldDraw: false, reason: reasonToken('PARLOR.Baccarat.Reason.NaturalNoDraw') }
        : resolveBankerDecision(summary.initialBankerTotal, summary.playerShouldDraw, playerThirdValue);

    if (bankerDecision.shouldDraw) {
        bankerThirdCard = deck.deal();
        nextBankerHand.push(bankerThirdCard);
    }

    const playerTotal = getBaccaratTotal(nextPlayerHand);
    const bankerTotal = getBaccaratTotal(nextBankerHand);

    return {
        playerHand: nextPlayerHand,
        bankerHand: nextBankerHand,
        playerTotal,
        bankerTotal,
        winner: getWinnerSide(playerTotal, bankerTotal),
        roundSummary: {
            ...summary,
            stage: 'final',
            finalPlayerTotal: playerTotal,
            finalBankerTotal: bankerTotal,
            playerDrew: !!playerThirdCard,
            bankerDrew: !!bankerThirdCard,
            playerThirdValue,
            bankerThirdValue: bankerThirdCard ? getBaccaratCardValue(bankerThirdCard) : null,
            resolvedBankerReason: bankerDecision.reason,
            drawResolved: true
        }
    };
}

function dealBaccaratRound(deck) {
    const playerHand = [deck.deal(), deck.deal()];
    const bankerHand = [deck.deal(), deck.deal()];
    const roundSummary = buildInitialRoundSummary(playerHand, bankerHand);
    return applyBaccaratDrawStage(deck, playerHand, bankerHand, roundSummary);
}

export class BaccaratGame extends GameBase {
    static get gameType() { return 'baccarat'; }

    constructor(config) {
        super(config);
        this.deck = new CardDeck(BACCARAT_DECKS);
        this.playerHand = [];
        this.bankerHand = [];
        this.playerTotal = 0;
        this.bankerTotal = 0;
        this.winner = null;
        this.payouts = {};
        this.roundSummary = null;
        this.settlementApplied = false;
        this._dealTimer = null;
        this._phaseTimer = null;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'READY', 'DEALING', 'SHOWDOWN', 'DRAW_RULES', 'DRAWING', 'FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['READY'],
            READY: ['DEALING'],
            DEALING: ['SHOWDOWN'],
            SHOWDOWN: ['DRAW_RULES'],
            DRAW_RULES: ['DRAWING', 'FINAL_SHOWDOWN'],
            DRAWING: ['FINAL_SHOWDOWN'],
            FINAL_SHOWDOWN: ['SETTLE'],
            SETTLE: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        if (this.deck.numDecks !== BACCARAT_DECKS) {
            this.deck = new CardDeck(BACCARAT_DECKS);
        } else if (this.deck.remaining < 52) {
            this.deck.shuffle();
        }

        this.bets = [];
        this.playerHand = [];
        this.bankerHand = [];
        this.playerTotal = 0;
        this.bankerTotal = 0;
        this.winner = null;
        this.payouts = {};
        this.roundSummary = null;
        this.settlementApplied = false;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        return {
            ...super.getState(),
            playerHand: this.playerHand,
            bankerHand: this.bankerHand,
            playerTotal: this.playerTotal,
            bankerTotal: this.bankerTotal,
            winner: this.winner,
            payouts: this.payouts,
            roundSummary: this.roundSummary,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.playerHand) this.playerHand = state.playerHand;
        if (state.bankerHand) this.bankerHand = state.bankerHand;
        if (state.playerTotal != null) this.playerTotal = Number(state.playerTotal || 0);
        if (state.bankerTotal != null) this.bankerTotal = Number(state.bankerTotal || 0);
        if (state.winner !== undefined) this.winner = state.winner;
        if (state.payouts) this.payouts = state.payouts;
        if (state.roundSummary !== undefined) this.roundSummary = state.roundSummary || null;
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
                this._dealRound();
                break;

            case 'draw':
                if (this._phase !== 'DRAW_RULES') return;
                this._runDrawStage();
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

    _dealRound() {
        this._transition('DEALING');
        this.playerHand = [this.deck.deal(), this.deck.deal()];
        this.bankerHand = [this.deck.deal(), this.deck.deal()];
        this.playerTotal = getBaccaratTotal(this.playerHand);
        this.bankerTotal = getBaccaratTotal(this.bankerHand);
        this.winner = null;
        this.payouts = {};
        this.roundSummary = buildInitialRoundSummary(this.playerHand, this.bankerHand);
        this._broadcastState();

        clearTimeout(this._dealTimer);
        this._dealTimer = setTimeout(() => this._enterShowdown(), DEAL_TO_SHOWDOWN_DELAY_MS);
    }

    _enterShowdown() {
        if (this._phase !== 'DEALING') return;

        this._transition('SHOWDOWN');
        this._broadcastState();

        clearTimeout(this._phaseTimer);
        this._phaseTimer = setTimeout(() => this._enterDrawRules(), SHOWDOWN_TO_DRAW_RULES_DELAY_MS);
    }

    _enterDrawRules() {
        if (this._phase !== 'SHOWDOWN') return;
        this._transition('DRAW_RULES');
        this._broadcastState();
    }

    _runDrawStage() {
        if (this._phase !== 'DRAW_RULES') return;

        const summary = this.roundSummary || buildInitialRoundSummary(this.playerHand, this.bankerHand);
        const previousCardCount = this.playerHand.length + this.bankerHand.length;
        const result = applyBaccaratDrawStage(this.deck, this.playerHand, this.bankerHand, summary);
        const nextCardCount = result.playerHand.length + result.bankerHand.length;
        const addedCardCount = Math.max(0, nextCardCount - previousCardCount);

        this.playerHand = result.playerHand;
        this.bankerHand = result.bankerHand;
        this.playerTotal = result.playerTotal;
        this.bankerTotal = result.bankerTotal;
        this.roundSummary = result.roundSummary;
        this.winner = null;
        this.payouts = {};

        if (addedCardCount <= 0) {
            this._enterFinalShowdown();
            return;
        }

        this._transition('DRAWING');
        this._broadcastState();

        clearTimeout(this._phaseTimer);
        this._phaseTimer = setTimeout(
            () => this._enterFinalShowdown(),
            DRAWING_BASE_DELAY_MS + (addedCardCount * DRAWING_PER_CARD_DELAY_MS)
        );
    }

    _enterFinalShowdown() {
        if (!['DRAW_RULES', 'DRAWING'].includes(this._phase)) return;

        this._transition('FINAL_SHOWDOWN');
        this.winner = getWinnerSide(this.playerTotal, this.bankerTotal);
        this.payouts = {};

        for (const bet of this.bets) {
            const payout = this._calculatePayout(bet);
            this.payouts[bet.userId] = OutcomeInfluence.adjustBaccaratPayout(this, bet.userId, bet.amount, payout);
        }

        this._broadcastState();

        clearTimeout(this._phaseTimer);
        this._phaseTimer = setTimeout(() => this._enterSettle(), FINAL_SHOWDOWN_TO_SETTLE_DELAY_MS);
    }

    _enterSettle() {
        if (this._phase !== 'FINAL_SHOWDOWN') return;
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
            if (bet.side === 'player') return roundChipAmount(bet.amount * PLAYER_WIN_MULTIPLIER);
            if (bet.side === 'banker') return roundChipAmount(bet.amount * BANKER_WIN_MULTIPLIER);
            return roundChipAmount(bet.amount * TIE_WIN_MULTIPLIER);
        }

        if (this.winner === 'tie' && ['player', 'banker'].includes(bet.side)) {
            return roundChipAmount(bet.amount);
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
            const delta = roundChipAmount(payout - Number(bet.amount || 0));

            if (delta !== 0) chipDeltas.push({ userId: bet.userId, delta });
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
    buildInitialRoundSummary,
    dealBaccaratRound,
    getBaccaratCardValue,
    getBaccaratTotal,
    getWinnerSide,
    shouldBankerDraw
};
