/**
 * TexasHoldemGame — 德州扑克现金桌
 *
 * 这桌和其他 Parlor 游戏最大的差别是：买入后先进入桌内 stack。
 * 每手只在 stack 之间流转，结束整桌时再把剩余 stack 退回筹码/金币。
 */

import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { CardLuckPlan } from '../../core/CardLuckPlan.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';
import { getParticipant } from '../../core/ParticipantRoster.js';
import { planTexasDeal, validateTexasDealPlan } from './TexasDealPlanner.js';
import {
    compareTexasHoldemHands,
    evaluateBestTexasHoldemHand,
    roundHoldemAmount,
    splitPotAmount
} from './TexasHoldemRules.js';

const DEFAULT_SMALL_BLIND = 5;
const DEFAULT_BIG_BLIND = 10;
const DEFAULT_BUY_IN = 200;
const MAX_PLAYERS = 6;
const PRIVATE_UPDATE_TYPE = 'texasholdem.hole-cards';

function normalizePositiveAmount(value, fallback) {
    const amount = Math.floor(Number(value));
    return Number.isFinite(amount) && amount > 0 ? amount : fallback;
}

function makeRoundToken() {
    return globalThis.foundry?.utils?.randomID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeCards(cards) {
    return Array.isArray(cards) ? cards.filter(card => card?.rank && card?.suit) : [];
}

function now() {
    return Date.now();
}

export class TexasHoldemGame extends GameBase {
    static get gameType() { return 'texasholdem'; }

    constructor(config) {
        super(config);
        const options = config?.gameOptions || {};
        this.smallBlind = normalizePositiveAmount(options.smallBlind, DEFAULT_SMALL_BLIND);
        this.bigBlind = Math.max(this.smallBlind, normalizePositiveAmount(options.bigBlind, DEFAULT_BIG_BLIND));
        this.buyIn = Math.max(this.bigBlind * 10, normalizePositiveAmount(options.buyIn, DEFAULT_BUY_IN));
        this.gmParticipantId = String(options.gmParticipantId || '');
        this.gmBuyIn = this.gmParticipantId
            ? Math.max(this.bigBlind * 10, normalizePositiveAmount(options.gmBuyIn, this.buyIn))
            : 0;
        this.deck = new CardDeck(1);

        this.tableStacks = {};
        this.buyInsApplied = false;
        this.tableSettled = false;
        this.setupError = null;
        this.shortBuyInIds = [];

        this.handNumber = 0;
        this.handToken = '';
        this.street = 'waiting';
        this.dealerButtonIndex = -1;
        this.dealerButtonId = '';
        this.smallBlindId = '';
        this.bigBlindId = '';
        this.communityCards = [];
        this.playerStates = {};
        this.revealedHoleCards = {};
        this.turnOrder = [];
        this.actionOrder = [];
        this.currentPlayerId = '';
        this.currentBet = 0;
        this.minRaise = this.bigBlind;
        this.lastRaiseAmount = this.bigBlind;
        this.lastAggressorId = '';
        this.pots = [];
        this.payouts = {};
        this.roundResult = null;

        this._privateHoleCards = new Map();
        this._knownHoleCards = new Map();
        this._texasDealPlan = null;
        this._texasDealRng = typeof config.texasDealRng === 'function' ? config.texasDealRng : Math.random;
    }

    get phases() {
        return ['IDLE', 'BUY_IN', 'DEALING', 'PLAYER_TURNS', 'SHOWDOWN', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BUY_IN', 'RESOLVING'],
            BUY_IN: ['DEALING', 'RESOLVING'],
            DEALING: ['PLAYER_TURNS', 'SHOWDOWN', 'RESOLVING'],
            PLAYER_TURNS: ['DEALING', 'SHOWDOWN', 'RESOLVING'],
            SHOWDOWN: ['RESOLVING'],
            RESOLVING: ['DEALING', 'RESOLVING']
        };
    }

    async start() {
        this._resetTable();
        this._go('BUY_IN');

        const seatIds = this._getSeatIds();
        if (seatIds.length < 2) {
            this.setupError = { reason: 'not-enough-players' };
            this._go('RESOLVING');
            return { ok: false, reason: 'not-enough-players' };
        }

        // GM 的买入只是本场桌务资金，不查钱包、不扣金币，也不走 Parlor 的持久筹码。
        const settlementSeatIds = this._getSettlementSeatIds(seatIds);
        const shortIds = settlementSeatIds.filter(id => !ChipManager.canAfford(id, this.buyIn, this._settlementContext()));
        if (shortIds.length) {
            this.shortBuyInIds = shortIds;
            this.setupError = { reason: 'buy-in-short', shortIds };
            this._go('RESOLVING');
            return { ok: false, reason: 'buy-in-short', shortIds };
        }

        const deltas = settlementSeatIds.map(userId => ({ userId, delta: -this.buyIn }));
        const paid = await ChipManager.applyDeltas(deltas, this._settlementContext());
        if (!paid) {
            this.setupError = { reason: 'buy-in-failed' };
            this._go('RESOLVING');
            return { ok: false, reason: 'buy-in-failed' };
        }

        for (const userId of seatIds) {
            this.tableStacks[userId] = this._isGMTableSeat(userId) ? this.gmBuyIn : this.buyIn;
        }

        this.buyInsApplied = true;
        await this._beginHand();
        return { ok: true };
    }

    getState() {
        return {
            ...super.getState(),
            smallBlind: this.smallBlind,
            bigBlind: this.bigBlind,
            buyIn: this.buyIn,
            gmParticipantId: this.gmParticipantId,
            gmBuyIn: this.gmBuyIn,
            tableStacks: this.tableStacks,
            buyInsApplied: this.buyInsApplied,
            tableSettled: this.tableSettled,
            setupError: this.setupError,
            shortBuyInIds: this.shortBuyInIds,
            handNumber: this.handNumber,
            handToken: this.handToken,
            street: this.street,
            dealerButtonIndex: this.dealerButtonIndex,
            dealerButtonId: this.dealerButtonId,
            smallBlindId: this.smallBlindId,
            bigBlindId: this.bigBlindId,
            communityCards: this.communityCards,
            playerStates: this.playerStates,
            revealedHoleCards: this.revealedHoleCards,
            turnOrder: this.turnOrder,
            actionOrder: this.actionOrder,
            currentPlayerId: this.currentPlayerId,
            currentBet: this.currentBet,
            minRaise: this.minRaise,
            lastRaiseAmount: this.lastRaiseAmount,
            lastAggressorId: this.lastAggressorId,
            pots: this.pots,
            payouts: this.payouts,
            roundResult: this.roundResult,
            activeSeatIds: this._getPlayableSeatIds(),
            seatIds: this._getSeatIds()
        };
    }

    setState(state) {
        super.setState(state);
        if (state.smallBlind != null) this.smallBlind = normalizePositiveAmount(state.smallBlind, DEFAULT_SMALL_BLIND);
        if (state.bigBlind != null) this.bigBlind = Math.max(this.smallBlind, normalizePositiveAmount(state.bigBlind, DEFAULT_BIG_BLIND));
        if (state.buyIn != null) this.buyIn = Math.max(this.bigBlind * 10, normalizePositiveAmount(state.buyIn, DEFAULT_BUY_IN));
        if (state.gmParticipantId !== undefined) this.gmParticipantId = String(state.gmParticipantId || '');
        if (this.gmParticipantId) {
            this.gmBuyIn = Math.max(this.bigBlind * 10, normalizePositiveAmount(state.gmBuyIn ?? this.gmBuyIn, this.buyIn));
        } else {
            this.gmBuyIn = 0;
        }
        if (state.tableStacks) this.tableStacks = state.tableStacks;
        if (state.buyInsApplied !== undefined) this.buyInsApplied = !!state.buyInsApplied;
        if (state.tableSettled !== undefined) this.tableSettled = !!state.tableSettled;
        if (state.setupError !== undefined) this.setupError = state.setupError || null;
        if (state.shortBuyInIds) this.shortBuyInIds = state.shortBuyInIds;
        if (state.handNumber != null) this.handNumber = Number(state.handNumber || 0);
        if (state.handToken !== undefined) this.handToken = state.handToken || '';
        if (state.street !== undefined) this.street = state.street || 'waiting';
        if (state.dealerButtonIndex != null) this.dealerButtonIndex = Number(state.dealerButtonIndex);
        if (state.dealerButtonId !== undefined) this.dealerButtonId = state.dealerButtonId || '';
        if (state.smallBlindId !== undefined) this.smallBlindId = state.smallBlindId || '';
        if (state.bigBlindId !== undefined) this.bigBlindId = state.bigBlindId || '';
        if (state.communityCards) this.communityCards = state.communityCards;
        if (state.playerStates) this.playerStates = state.playerStates;
        if (state.revealedHoleCards) this.revealedHoleCards = state.revealedHoleCards;
        if (state.turnOrder) this.turnOrder = state.turnOrder;
        if (state.actionOrder) this.actionOrder = state.actionOrder;
        if (state.currentPlayerId !== undefined) this.currentPlayerId = state.currentPlayerId || '';
        if (state.currentBet != null) this.currentBet = Number(state.currentBet || 0);
        if (state.minRaise != null) this.minRaise = Number(state.minRaise || this.bigBlind);
        if (state.lastRaiseAmount != null) this.lastRaiseAmount = Number(state.lastRaiseAmount || this.bigBlind);
        if (state.lastAggressorId !== undefined) this.lastAggressorId = state.lastAggressorId || '';
        if (state.pots) this.pots = state.pots;
        if (state.payouts) this.payouts = state.payouts;
        if (state.roundResult !== undefined) this.roundResult = state.roundResult || null;
    }

    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== PRIVATE_UPDATE_TYPE) return;

        this._knownHoleCards.set(data.participantId, {
            handNumber: Number(data.handNumber || 0),
            handToken: data.handToken || '',
            cards: sanitizeCards(data.cards),
            dealtAt: Number(data.dealtAt || now())
        });
    }

    getVisibleHoleCards(participantId) {
        if (!participantId) return null;

        const revealed = this.revealedHoleCards?.[participantId];
        if (Array.isArray(revealed) && revealed.length) return [...revealed];

        const known = this._knownHoleCards.get(participantId);
        if (known?.handToken !== this.handToken) return null;
        return [...known.cards];
    }

    getAuthoritativeHoleCards(participantId) {
        const entry = this._privateHoleCards.get(participantId);
        if (entry?.handToken !== this.handToken) return [];
        return [...entry.cards];
    }

    handlePlayerAction(userId, action, data = {}) {
        switch (action) {
            case 'check':
                return this._handleCheck(userId);
            case 'call':
                return this._handleCall(userId);
            case 'fold':
                return this._handleFold(userId);
            case 'raiseTo':
                return this._handleRaiseTo(userId, data);
            case 'allIn':
                return this._handleAllIn(userId);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action) {
        switch (action) {
            case 'newHand':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                if (this.tableSettled) return { ok: false, reason: 'table-settled' };
                await this._beginHand();
                await this._broadcastState();
                return { ok: true };
            case 'finishGame':
                await this._returnTableStacks();
                return { ok: true };
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _handleCheck(userId) {
        const guard = this._guardTurn(userId);
        if (!guard.ok) return guard;
        if (this._getCallAmount(userId) > 0) return { ok: false, reason: 'must-call' };

        const seat = this.playerStates[userId];
        seat.acted = true;
        seat.lastAction = 'check';
        seat.updatedAt = now();
        this._advanceAfterAction(userId);
        this._broadcastState();
        return { ok: true };
    }

    _handleCall(userId) {
        const guard = this._guardTurn(userId);
        if (!guard.ok) return guard;

        const callAmount = this._getCallAmount(userId);
        if (callAmount <= 0) return this._handleCheck(userId);

        const committed = this._commitFromStack(userId, callAmount);
        const seat = this.playerStates[userId];
        seat.acted = true;
        seat.lastAction = committed < callAmount ? 'all-in' : 'call';
        seat.updatedAt = now();
        this._advanceAfterAction(userId);
        this._broadcastState();
        return { ok: true };
    }

    _handleFold(userId) {
        const guard = this._guardTurn(userId);
        if (!guard.ok) return guard;

        const seat = this.playerStates[userId];
        seat.status = 'folded';
        seat.acted = true;
        seat.lastAction = 'fold';
        seat.updatedAt = now();
        this._advanceAfterAction(userId);
        this._broadcastState();
        return { ok: true };
    }

    _handleRaiseTo(userId, data) {
        const guard = this._guardTurn(userId);
        if (!guard.ok) return guard;

        const seat = this.playerStates[userId];
        const currentStreet = Number(seat.streetCommitted || 0);
        const maxTarget = roundHoldemAmount(currentStreet + Number(this.tableStacks[userId] || 0));
        const requestedTarget = normalizePositiveAmount(data?.amount, 0);
        const target = Math.min(requestedTarget, maxTarget);
        if (target <= this.currentBet) return { ok: false, reason: 'raise-too-low' };
        if (target <= currentStreet) return { ok: false, reason: 'raise-empty' };

        const fullRaiseTarget = roundHoldemAmount(this.currentBet + this.minRaise);
        const isAllIn = target >= maxTarget;
        if (target < fullRaiseTarget && !isAllIn) {
            return { ok: false, reason: 'min-raise', minRaiseTo: fullRaiseTarget };
        }

        this._applyAggressiveAction(userId, target, {
            fullRaise: target >= fullRaiseTarget,
            action: isAllIn ? 'all-in' : 'raise'
        });
        this._advanceAfterAction(userId);
        this._broadcastState();
        return { ok: true };
    }

    _handleAllIn(userId) {
        const guard = this._guardTurn(userId);
        if (!guard.ok) return guard;

        const seat = this.playerStates[userId];
        const target = roundHoldemAmount(Number(seat.streetCommitted || 0) + Number(this.tableStacks[userId] || 0));
        if (target <= Number(seat.streetCommitted || 0)) return { ok: false, reason: 'no-stack' };

        if (target > this.currentBet) {
            const fullRaiseTarget = roundHoldemAmount(this.currentBet + this.minRaise);
            this._applyAggressiveAction(userId, target, {
                fullRaise: target >= fullRaiseTarget,
                action: 'all-in'
            });
        } else {
            this._commitFromStack(userId, Number(this.tableStacks[userId] || 0));
            seat.acted = true;
            seat.lastAction = 'all-in';
            seat.updatedAt = now();
        }

        this._advanceAfterAction(userId);
        this._broadcastState();
        return { ok: true };
    }

    _guardTurn(userId) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };
        const seat = this.playerStates?.[userId];
        if (!seat || seat.status !== 'active') return { ok: false, reason: 'not-active' };
        if (Number(this.tableStacks[userId] || 0) <= 0) return { ok: false, reason: 'no-stack' };
        return { ok: true };
    }

    _applyAggressiveAction(userId, targetStreetCommitted, { fullRaise, action }) {
        const seat = this.playerStates[userId];
        const previousBet = Number(this.currentBet || 0);
        const commitAmount = roundHoldemAmount(targetStreetCommitted - Number(seat.streetCommitted || 0));
        this._commitFromStack(userId, commitAmount);

        if (targetStreetCommitted > previousBet) {
            this.currentBet = roundHoldemAmount(targetStreetCommitted);
            if (fullRaise) {
                this.lastRaiseAmount = roundHoldemAmount(this.currentBet - previousBet);
                this.minRaise = this.lastRaiseAmount;
                this.lastAggressorId = userId;
                this._resetActionAfterRaise(userId);
            }
        }

        seat.acted = true;
        seat.lastAction = action;
        seat.updatedAt = now();
    }

    async _beginHand() {
        this._resetHand();
        const activeIds = this._getPlayableSeatIds();
        if (activeIds.length < 2) {
            this.street = 'waiting';
            this.roundResult = {
                kind: 'waiting',
                reason: 'not-enough-stacks'
            };
            this._go('RESOLVING');
            return;
        }

        this._go('DEALING');
        this.handNumber += 1;
        this.round = this.handNumber;
        this.handToken = makeRoundToken();
        this.deck = new CardDeck(1);
        this._texasDealPlan = this._buildDealPlan(activeIds);
        this.street = 'preflop';
        this.dealerButtonId = this._advanceDealerButton(activeIds);

        const blindInfo = this._getBlindIds(activeIds);
        this.smallBlindId = blindInfo.smallBlindId;
        this.bigBlindId = blindInfo.bigBlindId;
        this.turnOrder = this._buildOrderAfter(this.dealerButtonId, activeIds);

        for (const userId of activeIds) {
            this.playerStates[userId] = this._createSeatState(userId);
        }

        this._dealHoleCards(activeIds);
        this._postBlind(this.smallBlindId, this.smallBlind, 'small-blind');
        this._postBlind(this.bigBlindId, this.bigBlind, 'big-blind');
        this.currentBet = Math.max(
            Number(this.playerStates[this.smallBlindId]?.streetCommitted || 0),
            Number(this.playerStates[this.bigBlindId]?.streetCommitted || 0)
        );
        this.minRaise = this.bigBlind;
        this.lastRaiseAmount = this.bigBlind;
        this.lastAggressorId = this.bigBlindId;

        await this._dispatchPrivateHoleCards(activeIds);
        this._startBettingStreet('preflop', this.bigBlindId);
    }

    _resetTable() {
        this.tableStacks = {};
        this.buyInsApplied = false;
        this.tableSettled = false;
        this.setupError = null;
        this.shortBuyInIds = [];
        this.handNumber = 0;
        this.handToken = '';
        this.dealerButtonIndex = -1;
        this._resetHand();
    }

    _resetHand() {
        this.communityCards = [];
        this.playerStates = {};
        this.revealedHoleCards = {};
        this.turnOrder = [];
        this.actionOrder = [];
        this.currentPlayerId = '';
        this.currentBet = 0;
        this.minRaise = this.bigBlind;
        this.lastRaiseAmount = this.bigBlind;
        this.lastAggressorId = '';
        this.pots = [];
        this.payouts = {};
        this.roundResult = null;
        this.street = 'waiting';
        this.dealerButtonId = '';
        this.smallBlindId = '';
        this.bigBlindId = '';
        this._privateHoleCards.clear();
        this._knownHoleCards.clear();
        this._texasDealPlan = null;
    }

    _createSeatState(userId) {
        return {
            userId,
            status: 'active',
            stack: roundHoldemAmount(this.tableStacks[userId] || 0),
            committed: 0,
            streetCommitted: 0,
            acted: false,
            lastAction: '',
            holeCardCount: 2,
            handRank: null,
            bestCards: [],
            payout: 0,
            handDelta: 0,
            updatedAt: now()
        };
    }

    _dealHoleCards(activeIds) {
        const dealtAt = now();
        for (const userId of activeIds) {
            const cards = this._texasDealPlan?.holeCardsById?.[userId]?.length === 2
                ? [...this._texasDealPlan.holeCardsById[userId]]
                : this.deck.dealMany(2);
            this._privateHoleCards.set(userId, {
                handNumber: this.handNumber,
                handToken: this.handToken,
                cards,
                dealtAt
            });
        }
    }

    _buildDealLuck(activeIds) {
        const luckByParticipantId = {};
        const outcomeConfig = OutcomeInfluence.getConfig();
        const customTargetId = this.cardLuckPlan?.customHand?.pending
            ? this.cardLuckPlan.customHand.participantId
            : '';

        for (const participantId of activeIds) {
            // DM 的定制牌型和显式牌运都先落定，属性只接管 normal 的空位。
            if (participantId === customTargetId) continue;

            const manualLuck = CardLuckPlan.getLuck(this.cardLuckPlan, participantId);
            if (manualLuck !== 'normal') {
                luckByParticipantId[participantId] = manualLuck;
                continue;
            }

            const attributeLuck = OutcomeInfluence.rollRateLuckMode(
                this,
                'texasholdem',
                participantId,
                {
                    config: outcomeConfig,
                    rng: this._texasDealRng
                }
            );
            if (attributeLuck !== 'normal') {
                luckByParticipantId[participantId] = attributeLuck;
            }
        }

        return luckByParticipantId;
    }

    _buildDealPlan(activeIds) {
        const sourceCards = this.deck.cards.map(card => ({ ...card }));
        const plan = planTexasDeal({
            cards: sourceCards,
            participantIds: activeIds,
            luckByParticipantId: this._buildDealLuck(activeIds),
            customHand: this.cardLuckPlan?.customHand,
            rng: this._texasDealRng
        });
        if (!plan) return null;

        const validation = plan.ok
            ? validateTexasDealPlan(plan, sourceCards, activeIds)
            : plan;
        if (!plan.ok || !validation.ok) {
            const messageKey = this.cardLuckPlan?.customHand?.pending
                ? 'PARLOR.CardLuck.CustomDeferred'
                : 'PARLOR.CardLuck.PlanFallback';
            const message = globalThis.game?.i18n?.localize?.(messageKey)
                || 'Card luck plan failed; using a random deal.';
            globalThis.ui?.notifications?.warn?.(message);
            console.warn('parlor | Texas Holdem card luck plan fell back to random deal', plan, validation);
            return null;
        }

        // 只有完整计划通过守恒检查后才替换真实牌堆，失败路径仍保留原始牌序。
        this.deck.cards = plan.remainingCards.map(card => ({ ...card }));
        if (plan.customHandCommitted) {
            this.cardLuckPlan = CardLuckPlan.consumeCustomHand(this.cardLuckPlan, {
                committed: true,
                participantId: this.cardLuckPlan?.customHand?.participantId
            });
        }
        return plan;
    }

    _dealCommunityTo(targetCount) {
        const target = Math.max(0, Math.min(5, Number(targetCount || 0)));
        const plannedCards = this._texasDealPlan?.communityCards || [];
        while (this.communityCards.length < target) {
            const card = plannedCards[this.communityCards.length] || this.deck.deal();
            if (!card) break;
            this.communityCards.push(card);
        }
    }

    async _dispatchPrivateHoleCards(activeIds = this._getHandPlayerIds()) {
        const jobs = [];
        for (const userId of activeIds) {
            const entry = this._privateHoleCards.get(userId);
            if (!entry) continue;

            const payload = {
                sessionId: this.sessionId,
                type: PRIVATE_UPDATE_TYPE,
                participantId: userId,
                handNumber: this.handNumber,
                handToken: this.handToken,
                cards: [...entry.cards],
                dealtAt: entry.dealtAt
            };
            const participant = getParticipant(this, userId);
            const targetUserId = participant?.controllerId || null;

            if (targetUserId === game.user.id) {
                // 自己发给自己时绕开 socket 回环，避免 HUD 重复收一包底牌动画。
                this.handlePrivateUpdate(payload);
                const session = ParlorManager._sessions?.get?.(this.sessionId);
                if (session?.ui) {
                    session.ui.gameInstance = session.game;
                    session.ui.handlePrivateUpdate?.(payload);
                }
                continue;
            }

            if (!targetUserId) continue;
            jobs.push(SocketManager.sendTo(SOCKET_EVENTS.GAME_PRIVATE_UPDATE, targetUserId, payload));
        }

        if (jobs.length) await Promise.allSettled(jobs);
    }

    _postBlind(userId, amount, action) {
        if (!userId) return 0;
        const paid = this._commitFromStack(userId, amount);
        const seat = this.playerStates[userId];
        if (seat) {
            seat.lastAction = action;
            seat.updatedAt = now();
        }
        return paid;
    }

    _commitFromStack(userId, amount) {
        const seat = this.playerStates[userId];
        if (!seat) return 0;

        const stack = roundHoldemAmount(this.tableStacks[userId] || 0);
        const committed = Math.min(stack, Math.max(0, roundHoldemAmount(amount)));
        this.tableStacks[userId] = roundHoldemAmount(stack - committed);
        seat.stack = this.tableStacks[userId];
        seat.committed = roundHoldemAmount(Number(seat.committed || 0) + committed);
        seat.streetCommitted = roundHoldemAmount(Number(seat.streetCommitted || 0) + committed);

        if (seat.stack <= 0 && seat.status === 'active') {
            seat.status = 'all-in';
        }

        return committed;
    }

    _startBettingStreet(street, startAfterId) {
        this.street = street;
        this.minRaise = this.bigBlind;
        this.lastRaiseAmount = this.bigBlind;
        this.lastAggressorId = '';

        if (street !== 'preflop') {
            this.currentBet = 0;
            for (const seat of Object.values(this.playerStates)) {
                seat.streetCommitted = 0;
                seat.acted = false;
                if (seat.status === 'all-in' && Number(this.tableStacks[seat.userId] || 0) > 0) {
                    seat.status = 'active';
                }
            }
        } else {
            for (const seat of Object.values(this.playerStates)) {
                seat.acted = false;
            }
        }

        if (street === 'preflop') {
            this.currentBet = Math.max(...Object.values(this.playerStates).map(seat => Number(seat.streetCommitted || 0)), 0);
            this.lastAggressorId = this.bigBlindId;
        }

        this.actionOrder = this._buildOrderAfter(startAfterId, this._getRemainingIds());
        this.currentPlayerId = this._findNextActionPlayer(startAfterId);

        if (!this.currentPlayerId) {
            this._finishStreetOrShowdown();
            return;
        }

        this._go('PLAYER_TURNS');
    }

    _advanceAfterAction(userId) {
        if (this._getRemainingIds().length <= 1) {
            this._awardUncontested();
            return;
        }

        if (this._isBettingRoundComplete()) {
            this._finishStreetOrShowdown();
            return;
        }

        const nextPlayer = this._findNextActionPlayer(userId);
        if (nextPlayer) {
            this.currentPlayerId = nextPlayer;
            return;
        }

        this._finishStreetOrShowdown();
    }

    _finishStreetOrShowdown() {
        if (this._getRemainingIds().length <= 1) {
            this._awardUncontested();
            return;
        }

        // 最多只剩一个还能下注的玩家(其余都 all-in),后面几条街没人能再跟,
        // 直接把公共牌发完摊牌,别让这个玩家在每条街空过一次。
        if (this._getPlayersAbleToAct().length <= 1) {
            this._runOutAndShowdown();
            return;
        }

        if (this.street === 'river') {
            this._openShowdown();
            return;
        }

        this._dealNextStreet();
    }

    _dealNextStreet() {
        this._go('DEALING');

        if (this.street === 'preflop') {
            this._dealCommunityTo(3);
            this._startBettingStreet('flop', this.dealerButtonId);
            return;
        }

        if (this.street === 'flop') {
            this._dealCommunityTo(4);
            this._startBettingStreet('turn', this.dealerButtonId);
            return;
        }

        if (this.street === 'turn') {
            this._dealCommunityTo(5);
            this._startBettingStreet('river', this.dealerButtonId);
            return;
        }

        this._openShowdown();
    }

    _runOutAndShowdown() {
        this._go('DEALING');
        this._dealCommunityTo(5);
        this.street = 'showdown';
        this._openShowdown();
    }

    _openShowdown() {
        this.currentPlayerId = '';
        this.actionOrder = [];
        this.street = 'showdown';
        this._go('SHOWDOWN');

        const contenders = this._getRemainingIds();
        this.revealedHoleCards = {};
        for (const userId of contenders) {
            this.revealedHoleCards[userId] = this.getAuthoritativeHoleCards(userId);
            const seat = this.playerStates[userId];
            const handRank = evaluateBestTexasHoldemHand([
                ...this.revealedHoleCards[userId],
                ...this.communityCards
            ]);
            seat.handRank = handRank;
            seat.bestCards = handRank.cards || [];
        }

        this._settlePots(contenders);
        this.roundResult = {
            kind: 'showdown',
            winners: this._getWinningIdsFromPots(),
            pots: this.pots,
            communityCards: this.communityCards
        };
        this._go('RESOLVING');
    }

    _awardUncontested() {
        const winnerId = this._getRemainingIds()[0] || '';
        const potAmount = roundHoldemAmount(Object.values(this.playerStates)
            .reduce((sum, seat) => sum + Number(seat.committed || 0), 0));

        this.currentPlayerId = '';
        this.actionOrder = [];
        this.revealedHoleCards = {};
        this.pots = [{
            amount: potAmount,
            contributorIds: this._getHandPlayerIds().filter(id => Number(this.playerStates[id]?.committed || 0) > 0),
            eligibleIds: winnerId ? [winnerId] : [],
            winnerIds: winnerId ? [winnerId] : [],
            shares: winnerId ? { [winnerId]: potAmount } : {}
        }];
        this.payouts = winnerId ? { [winnerId]: potAmount } : {};

        if (winnerId) {
            this.tableStacks[winnerId] = roundHoldemAmount(Number(this.tableStacks[winnerId] || 0) + potAmount);
        }

        this._syncSeatResults();
        this.roundResult = {
            kind: 'uncontested',
            winnerId,
            pot: potAmount,
            pots: this.pots
        };
        this._go('RESOLVING');
    }

    _settlePots(contenders = this._getRemainingIds()) {
        this.pots = this._buildSidePots();
        this.payouts = {};
        const contenderSet = new Set(contenders);

        for (const pot of this.pots) {
            const eligibleIds = pot.eligibleIds.filter(id => contenderSet.has(id));
            let bestHand = null;
            let winnerIds = [];

            for (const userId of eligibleIds) {
                const handRank = this.playerStates[userId]?.handRank;
                if (!handRank) continue;
                const comparison = bestHand ? compareTexasHoldemHands(handRank, bestHand) : 1;
                if (comparison > 0) {
                    bestHand = handRank;
                    winnerIds = [userId];
                } else if (comparison === 0) {
                    winnerIds.push(userId);
                }
            }

            pot.winnerIds = winnerIds;
            pot.bestHand = bestHand;
            pot.shares = splitPotAmount(pot.amount, winnerIds);
            for (const [userId, share] of Object.entries(pot.shares)) {
                this.payouts[userId] = roundHoldemAmount(Number(this.payouts[userId] || 0) + Number(share || 0));
            }
        }

        for (const [userId, amount] of Object.entries(this.payouts)) {
            this.tableStacks[userId] = roundHoldemAmount(Number(this.tableStacks[userId] || 0) + Number(amount || 0));
        }

        this._syncSeatResults();
    }

    _syncSeatResults() {
        for (const [userId, seat] of Object.entries(this.playerStates)) {
            const payout = roundHoldemAmount(this.payouts[userId] || 0);
            seat.payout = payout;
            seat.handDelta = roundHoldemAmount(payout - Number(seat.committed || 0));
            seat.stack = roundHoldemAmount(this.tableStacks[userId] || 0);
            if (seat.status !== 'folded' && payout > 0) {
                seat.result = 'win';
            } else if (seat.status === 'folded') {
                seat.result = 'fold';
            } else {
                seat.result = 'lose';
            }
        }
    }

    _buildSidePots() {
        const handIds = this._getHandPlayerIds();
        const levels = [...new Set(handIds
            .map(id => roundHoldemAmount(this.playerStates[id]?.committed || 0))
            .filter(amount => amount > 0))]
            .sort((left, right) => left - right);

        const pots = [];
        let previous = 0;
        for (const level of levels) {
            const contributorIds = handIds.filter(id => Number(this.playerStates[id]?.committed || 0) >= level);
            const amount = roundHoldemAmount((level - previous) * contributorIds.length);
            if (amount > 0) {
                pots.push({
                    amount,
                    contributorIds,
                    eligibleIds: contributorIds.filter(id => this.playerStates[id]?.status !== 'folded'),
                    winnerIds: [],
                    shares: {}
                });
            }
            previous = level;
        }

        return pots;
    }

    _refundLiveCommitments() {
        for (const [userId, seat] of Object.entries(this.playerStates)) {
            const committed = roundHoldemAmount(Number(seat.committed || 0));
            if (committed <= 0) continue;
            this.tableStacks[userId] = roundHoldemAmount(Number(this.tableStacks[userId] || 0) + committed);
            seat.committed = 0;
            seat.streetCommitted = 0;
            seat.stack = this.tableStacks[userId];
        }
        this.pots = [];
        this.payouts = {};
        this.currentPlayerId = '';
    }

    async _returnTableStacks() {
        if (this.tableSettled) return true;

        // 一手还没结算就散桌,本手已经投进底池的筹码得先退回各自桌内 stack,
        // 否则这部分钱既没派彩也没退回,会凭空蒸发。
        if (this._phase !== 'RESOLVING') {
            this._refundLiveCommitments();
        }

        // GM 的 stack 到这里直接清空，不能混进返款；否则桌务资金会被写进角色金币或持久筹码。
        const deltas = Object.entries(this.tableStacks)
            .filter(([userId, amount]) => !this._isGMTableSeat(userId) && Number(amount || 0) > 0)
            .map(([userId, amount]) => ({ userId, delta: roundHoldemAmount(amount) }));

        const returned = await ChipManager.applyDeltas(deltas, this._settlementContext());
        if (returned) {
            this.tableSettled = true;
            for (const userId of Object.keys(this.tableStacks)) {
                this.tableStacks[userId] = 0;
            }
            for (const seat of Object.values(this.playerStates)) {
                seat.stack = 0;
            }
            await this._broadcastState();
        }
        return returned;
    }

    _getWinningIdsFromPots() {
        return [...new Set((this.pots || []).flatMap(pot => pot.winnerIds || []))];
    }

    _getCallAmount(userId) {
        const seat = this.playerStates[userId];
        if (!seat) return 0;
        return Math.max(0, roundHoldemAmount(Number(this.currentBet || 0) - Number(seat.streetCommitted || 0)));
    }

    _isBettingRoundComplete() {
        return this._getPlayersAbleToAct().every(userId => !this._needsAction(userId));
    }

    _needsAction(userId) {
        const seat = this.playerStates[userId];
        if (!seat || seat.status !== 'active') return false;
        if (Number(this.tableStacks[userId] || 0) <= 0) return false;
        if (Number(seat.streetCommitted || 0) < Number(this.currentBet || 0)) return true;
        return !seat.acted;
    }

    _findNextActionPlayer(afterId) {
        const order = this.actionOrder?.length ? this.actionOrder : this._getRemainingIds();
        if (!order.length) return '';
        const startIndex = Math.max(-1, order.indexOf(afterId));
        for (let step = 1; step <= order.length; step++) {
            const candidate = order[(startIndex + step + order.length) % order.length];
            if (this._needsAction(candidate)) return candidate;
        }
        return '';
    }

    _resetActionAfterRaise(raiserId) {
        for (const [userId, seat] of Object.entries(this.playerStates)) {
            if (seat.status !== 'active') continue;
            if (Number(this.tableStacks[userId] || 0) <= 0) continue;
            seat.acted = userId === raiserId;
        }
    }

    _advanceDealerButton(activeIds) {
        const seatIds = this._getSeatIds();
        let index = Number.isInteger(this.dealerButtonIndex) ? this.dealerButtonIndex : -1;

        for (let step = 1; step <= seatIds.length; step++) {
            const nextIndex = (index + step + seatIds.length) % seatIds.length;
            if (activeIds.includes(seatIds[nextIndex])) {
                this.dealerButtonIndex = nextIndex;
                return seatIds[nextIndex];
            }
        }

        this.dealerButtonIndex = 0;
        return activeIds[0] || '';
    }

    _getBlindIds(activeIds) {
        if (activeIds.length === 2) {
            return {
                smallBlindId: this.dealerButtonId,
                bigBlindId: this._nextActiveAfter(this.dealerButtonId, activeIds)
            };
        }

        const smallBlindId = this._nextActiveAfter(this.dealerButtonId, activeIds);
        return {
            smallBlindId,
            bigBlindId: this._nextActiveAfter(smallBlindId, activeIds)
        };
    }

    _nextActiveAfter(userId, activeIds) {
        const seatIds = this._getSeatIds();
        const start = Math.max(0, seatIds.indexOf(userId));
        for (let step = 1; step <= seatIds.length; step++) {
            const candidate = seatIds[(start + step) % seatIds.length];
            if (activeIds.includes(candidate)) return candidate;
        }
        return activeIds[0] || '';
    }

    _buildOrderAfter(userId, ids) {
        const source = this._getSeatIds().filter(id => ids.includes(id));
        if (!source.length) return [];
        const index = source.indexOf(userId);
        const start = index >= 0 ? index + 1 : 0;
        return [...source.slice(start), ...source.slice(0, start)];
    }

    _getSeatIds() {
        const playerSet = this.playerIds instanceof Set ? this.playerIds : new Set(this.playerIds || []);
        return this.participants
            .map(entry => entry.id)
            .filter(id => playerSet.has(id))
            .slice(0, MAX_PLAYERS);
    }

    _getPlayableSeatIds() {
        return this._getSeatIds().filter(id => Number(this.tableStacks[id] || 0) > 0);
    }

    _getHandPlayerIds() {
        return Object.keys(this.playerStates || {});
    }

    _getRemainingIds() {
        return this._getHandPlayerIds().filter(id => this.playerStates[id]?.status !== 'folded');
    }

    _getPlayersAbleToAct() {
        return this._getRemainingIds().filter(id => {
            const seat = this.playerStates[id];
            return seat?.status === 'active' && Number(this.tableStacks[id] || 0) > 0;
        });
    }

    _isGMTableSeat(participantId) {
        return !!this.gmParticipantId && participantId === this.gmParticipantId;
    }

    _getSettlementSeatIds(seatIds = this._getSeatIds()) {
        return seatIds.filter(participantId => !this._isGMTableSeat(participantId));
    }

    _settlementContext() {
        return { settlementMode: this.settlementMode };
    }

    _go(newPhase) {
        if (this._phase === newPhase) return true;
        return this._transition(newPhase);
    }
}

export {
    DEFAULT_BIG_BLIND,
    DEFAULT_BUY_IN,
    DEFAULT_SMALL_BLIND
};
