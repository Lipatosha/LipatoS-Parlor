/**
 * 21 点主流程
 *
 * 这一版默认由主持人控庄。
 * 玩家补牌会先落到桌面区，玩家停牌或爆牌时再一起收回手牌。
 */
import { GameBase } from '../GameBase.js';
import { CardDeck } from '../shared/CardDeck.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';
import { CardLuckPlan } from '../../core/CardLuckPlan.js';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
import {
    buildBlackjackNatural,
    takeWeightedBlackjackCard
} from './BlackjackCardLuck.js';
import {
    DEFAULT_BLACKJACK_RULES,
    getBlackjackTotal,
    isNaturalHand,
    sanitizeBlackjackRules
} from './BlackjackRules.js';

function allCards(hand) {
    return [...(hand.handCards || []), ...(hand.tableCards || [])];
}

const INITIAL_DEAL_HOLD_MS = 1180;
const PLAYER_DEAL_HOLD_MS = 1180;
const PLAYER_BUST_ADVANCE_MS = 760;
const DEALER_DEAL_HOLD_MS = 780;

export class BlackjackGame extends GameBase {
    static get gameType() { return 'blackjack'; }

    constructor(config) {
        super(config);
        this.rules = sanitizeBlackjackRules(config.rules || DEFAULT_BLACKJACK_RULES);
        this.deck = new CardDeck(this.rules.deckCount);
        this.playerHands = {};
        this.dealerHand = { handCards: [], tableCards: [], status: 'idle' };
        this.dealerProfile = config.dealerProfile || null;
        this.payouts = {};
        this.settlementApplied = false;
        this.turnOrder = [];       // 这里只记玩家席位
        this.currentTurnIndex = -1;
        this.pendingAction = null; // 玩家先提请求，再等庄家发牌
        this._openingDealTimer = null;
        this._playerDealTimer = null;
        this._dealerDealTimer = null;
        this._advanceTurnTimer = null;
        this._cardLuckRng = typeof config.cardLuckRng === 'function' ? config.cardLuckRng : Math.random;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'READY', 'DEALING', 'PLAYER_TURNS', 'DEALER_TURN', 'SETTLE', 'RESOLVING'];
    }
    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['READY'],
            READY: ['DEALING'],
            DEALING: ['PLAYER_TURNS'],
            PLAYER_TURNS: ['DEALER_TURN'],
            DEALER_TURN: ['SETTLE'],
            SETTLE: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    /** 开新一轮 */
    start() {
        this._clearFlowTimers();
        this._ensureDealerProfile();
        if (this.deck.numDecks !== this.rules.deckCount) {
            this.deck = new CardDeck(this.rules.deckCount);
        } else {
            this.deck.shuffle();
        }
        this.bets = [];
        this.playerHands = {};
        this.dealerHand = { handCards: [], tableCards: [], status: 'idle' };
        this.payouts = {};
        this.settlementApplied = false;
        this.turnOrder = [];
        this.currentTurnIndex = -1;
        this.pendingAction = null;
        this.round++;
        this._transition('BETTING');
    }

    getState() {
        const currentPlayerId = this.turnOrder[this.currentTurnIndex] || null;
        return {
            ...super.getState(),
            playerHands: this.playerHands,
            dealerHand: this.dealerHand,
            dealerProfile: this.dealerProfile,
            turnOrder: this.turnOrder,
            currentTurnIndex: this.currentTurnIndex,
            currentPlayerId,
            pendingAction: this.pendingAction,
            payouts: this.payouts,
            settlementApplied: this.settlementApplied,
            bettingPlayerIds: this._getBettingPlayerIds(),
            sittingOutPlayerIds: this._getSittingOutPlayerIds(),
            rules: this.rules
        };
    }

    setState(state) {
        super.setState(state);
        if (state.playerHands) this.playerHands = state.playerHands;
        if (state.dealerHand) this.dealerHand = state.dealerHand;
        if (state.dealerProfile !== undefined) this.dealerProfile = state.dealerProfile;
        if (state.turnOrder) this.turnOrder = state.turnOrder;
        if (state.currentTurnIndex != null) this.currentTurnIndex = state.currentTurnIndex;
        if (state.pendingAction !== undefined) this.pendingAction = state.pendingAction;
        if (state.payouts) this.payouts = state.payouts;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
        if (state.rules) this.rules = sanitizeBlackjackRules(state.rules);
    }

    handlePlayerAction(userId, action, data) {
        switch (action) {
            case 'placeBet':
                if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
                if (!this._getActivePlayerIds().includes(userId)) return { ok: false, reason: 'not-player' };
                {
                    const amount = Math.floor(Number(data?.amount));
                    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'invalid-amount' };
                    const limitCheck = this._validateBetAmount(amount);
                    if (!limitCheck.ok) return limitCheck;
                    if (!ChipManager.canAfford(userId, amount)) return { ok: false, reason: 'chips' };

                    const existingBet = this.bets.find(bet => bet.userId === userId);
                    if (existingBet) {
                        existingBet.amount = amount;
                    } else {
                        this.bets.push({ userId, amount });
                    }
                }
                this._broadcastState();
                this._checkAllBets();
                return { ok: true };

            case 'requestHit':
                if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
                if (this.turnOrder[this.currentTurnIndex] !== userId) return { ok: false, reason: 'turn' };
                if (!this._canRequestHit(this.playerHands[userId])) return { ok: false, reason: 'not-allowed' };
                this.pendingAction = { userId, action: 'hit', stage: 'requested', requestedAt: Date.now() };
                this.playerHands[userId].status = 'awaiting_deal';
                this._broadcastState();
                return { ok: true };

            case 'confirmCollect':
                if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
                if (this.turnOrder[this.currentTurnIndex] !== userId) return { ok: false, reason: 'turn' };
                if (!this._canCollectHand(this.playerHands[userId])) return { ok: false, reason: 'not-allowed' };
                this._collectPlayerCards(userId);
                return { ok: true };

            case 'requestStand':
                if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
                if (this.turnOrder[this.currentTurnIndex] !== userId) return { ok: false, reason: 'turn' };
                if (!this._canStand(this.playerHands[userId])) return { ok: false, reason: 'not-allowed' };
                this._doStand(userId);
                return { ok: true };

            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action, data) {
        switch (action) {
            case 'startDeal':
                if (this._phase !== 'READY') return { ok: false, reason: 'phase' };
                await this._dealInitialCards();
                return { ok: true };

            case 'confirmDeal':
                if (!this.pendingAction) return { ok: false, reason: 'missing-action' };
                if (this.pendingAction.action !== 'hit') return { ok: false, reason: 'invalid-action' };
                if (this.pendingAction.stage && this.pendingAction.stage !== 'requested') return { ok: false, reason: 'not-ready' };
                await this._confirmDealToPlayer(this.pendingAction.userId);
                return { ok: true };

            case 'dealerHit':
                if (this._phase !== 'DEALER_TURN') return { ok: false, reason: 'phase' };
                if (this.dealerHand.status === 'dealing') return { ok: false, reason: 'not-ready' };
                await this._dealerHit();
                return { ok: true };

            case 'dealerStand':
                if (this._phase !== 'DEALER_TURN') return { ok: false, reason: 'phase' };
                if (this.dealerHand.status === 'dealing') return { ok: false, reason: 'not-ready' };
                this._dealerStand();
                return { ok: true };

            case 'settle':
                if (this._phase !== 'SETTLE') return { ok: false, reason: 'phase' };
                this._resolve();
                return { ok: true };

            case 'updateRules':
                if (!['BETTING', 'READY'].includes(this._phase)) return { ok: false, reason: 'phase' };
                this._updateRules(data?.rules);
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

    _checkAllBets() {
        const bettedIds = new Set(this.bets.map(b => b.userId));
        const activePlayers = this._getBettingPlayerIds();
        if (activePlayers.length > 0 && activePlayers.every(id => bettedIds.has(id))) {
            this._transition('READY');
            this._broadcastState();
        }
    }

    async _dealInitialCards() {
        this._transition('DEALING');

        const roundPlayers = this._getRoundPlayerIds();
        const activePlayers = new Set(roundPlayers);
        this.turnOrder = roundPlayers;

        // 庄家先从正常牌堆保留两张，玩家的牌运选择不会反过来改写庄家起手。
        this.dealerHand = {
            handCards: [this.deck.deal(), this.deck.deal()],
            tableCards: [],
            status: 'dealing'
        };

        const customHand = this.cardLuckPlan?.customHand;
        let customOpening = null;
        if (
            customHand?.pending
            && customHand.handType === 'natural-blackjack'
            && activePlayers.has(customHand.participantId)
        ) {
            const built = buildBlackjackNatural(this.deck, { rng: this._cardLuckRng });
            if (built.ok) {
                customOpening = { participantId: customHand.participantId, cards: built.cards };
            } else {
                this._warnCustomHandDeferred(customHand);
            }
        }

        for (const bet of this.bets) {
            if (!activePlayers.has(bet.userId)) continue;
            const customCards = customOpening?.participantId === bet.userId
                ? customOpening.cards
                : null;
            const firstCard = customCards?.[0] || this._takePlayerCard(bet.userId, []);
            const secondCard = customCards?.[1] || this._takePlayerCard(bet.userId, [firstCard]);
            this.playerHands[bet.userId] = {
                handCards: [firstCard, secondCard],
                tableCards: [],
                bet: bet.amount,
                status: 'dealing',
                total: 0
            };
            const h = this.playerHands[bet.userId];
            h.total = this._handValue(h.handCards);
        }

        if (customOpening) {
            this.cardLuckPlan = CardLuckPlan.consumeCustomHand(this.cardLuckPlan, {
                committed: true,
                participantId: customOpening.participantId
            });
        }

        this.currentTurnIndex = -1;
        await this._broadcastState();

        await new Promise(resolve => {
            clearTimeout(this._openingDealTimer);
            this._openingDealTimer = setTimeout(() => {
                this._openingDealTimer = null;

                for (const hand of Object.values(this.playerHands)) {
                    hand.total = this._handValue(hand.handCards);
                    hand.status = isNaturalHand(hand.handCards, this.rules) ? 'blackjack' : 'playing';
                }

                this.dealerHand.status = 'waiting';
                this.currentTurnIndex = 0;
                this._transition('PLAYER_TURNS');
                this._skipFinishedPlayers();

                Promise.resolve(this._broadcastState()).finally(resolve);
            }, INITIAL_DEAL_HOLD_MS);
        });
    }

    async _confirmDealToPlayer(userId) {
        const hand = this.playerHands[userId];
        if (!hand) return;

        this.pendingAction = {
            ...this.pendingAction,
            stage: 'dealing',
            dealtAt: Date.now()
        };
        hand.status = 'dealing';

        // 补牌先放桌上，后面再自动并回去，这样旁观视角的发牌和收牌动画都还能保留。
        const card = this._takePlayerCard(userId, allCards(hand));
        hand.tableCards.push(card);
        await this._broadcastState();

        await new Promise(resolve => {
            clearTimeout(this._playerDealTimer);
            this._playerDealTimer = setTimeout(() => {
                this._playerDealTimer = null;

                const latestHand = this.playerHands[userId];
                if (!latestHand) {
                    resolve();
                    return;
                }

                latestHand.total = this._visibleHandTotal(latestHand);
                this.pendingAction = null;

                if (this._isBusted(latestHand.total)) {
                    Promise.resolve(this._collectPlayerCards(userId)).finally(resolve);
                    return;
                }

                latestHand.status = 'awaiting_collect';
                Promise.resolve(this._broadcastState()).finally(resolve);
            }, PLAYER_DEAL_HOLD_MS);
        });
    }

    _collectPlayerCards(userId, { broadcast = true, advanceOnBust = true } = {}) {
        const hand = this.playerHands[userId];
        if (!hand || !hand.tableCards?.length) return { collected: false, busted: false };

        hand.handCards.push(...hand.tableCards);
        hand.tableCards = [];
        hand.total = this._handValue(hand.handCards);

        const busted = this._isBusted(hand.total);
        hand.status = busted ? 'bust' : 'playing';
        this.pendingAction = null;
        if (broadcast) this._broadcastState();
        if (busted && advanceOnBust) this._scheduleBustAdvance(userId);
        return { collected: true, busted };
    }

    _scheduleBustAdvance(userId) {
        clearTimeout(this._advanceTurnTimer);
        this._advanceTurnTimer = setTimeout(() => {
            const currentId = this.turnOrder[this.currentTurnIndex];
            if (currentId !== userId) return;
            if (this.playerHands[userId]?.status !== 'bust') return;
            this._advanceTurn();
            this._broadcastState();
        }, PLAYER_BUST_ADVANCE_MS);
    }

    _doStand(userId) {
        const hand = this.playerHands[userId];
        if (!hand) return;

        // 停牌才是玩家回合的收束点；桌心补牌在这里统一并回手牌，飞牌也只会播这一轮。
        if (hand.tableCards?.length) {
            this._collectPlayerCards(userId, { broadcast: false, advanceOnBust: false });
        }

        hand.total = this._handValue(hand.handCards);
        hand.status = 'stand';
        this.pendingAction = null;

        this._advanceTurn();
        this._broadcastState();
    }

    _advanceTurn() {
        this.currentTurnIndex++;
        this._skipFinishedPlayers();

        if (this.currentTurnIndex >= this.turnOrder.length && this._phase !== 'DEALER_TURN') {
            this.dealerHand.status = 'playing';
            this._transition('DEALER_TURN');
            this._broadcastState();
        }
    }

    _skipFinishedPlayers() {
        while (this.currentTurnIndex < this.turnOrder.length) {
            const uid = this.turnOrder[this.currentTurnIndex];
            const hand = this.playerHands[uid];
            if (hand && (hand.status === 'blackjack' || hand.status === 'bust')) {
                this.currentTurnIndex++;
            } else {
                break;
            }
        }
        if (this.currentTurnIndex >= this.turnOrder.length && this._phase !== 'DEALER_TURN') {
            this.dealerHand.status = 'playing';
            this._transition('DEALER_TURN');
        }
    }

    async _dealerHit() {
        if (this.dealerHand.status === 'dealing') return;

        const card = this.deck.deal();
        this.dealerHand.status = 'dealing';
        this.dealerHand.tableCards.push(card);
        await this._broadcastState();

        await new Promise(resolve => {
            clearTimeout(this._dealerDealTimer);
            this._dealerDealTimer = setTimeout(() => {
                this._dealerDealTimer = null;
                this.dealerHand.handCards.push(...this.dealerHand.tableCards);
                this.dealerHand.tableCards = [];

                const total = this._handValue(this.dealerHand.handCards);
                if (this._isBusted(total)) {
                    // 爆牌时先停一拍，桌上最后那张还能看清。
                    this.dealerHand.status = 'bust';
                    this._transition('SETTLE');
                } else {
                    this.dealerHand.status = 'playing';
                }
                Promise.resolve(this._broadcastState()).finally(resolve);
            }, DEALER_DEAL_HOLD_MS);
        });
    }

    _dealerStand() {
        if (this.dealerHand.status === 'dealing') return;
        this.dealerHand.handCards.push(...this.dealerHand.tableCards);
        this.dealerHand.tableCards = [];
        this.dealerHand.status = 'stand';
        this._transition('SETTLE');
        this._broadcastState();
    }

    _resolve() {
        this._transition('RESOLVING');

        const dealerTotal = this._handValue(this.dealerHand.handCards);
        const dealerBust = this._isBusted(dealerTotal);
        const dealerNatural = isNaturalHand(this.dealerHand.handCards, this.rules);

        this.payouts = {};
        for (const [userId, hand] of Object.entries(this.playerHands)) {
            const pTotal = this._handValue(allCards(hand));
            let payout = 0;

            if (hand.status === 'bust') {
                payout = 0;
            } else if (hand.status === 'blackjack') {
                payout = dealerNatural ? hand.bet : (hand.bet * this.rules.naturalPayout);
            } else if (dealerBust) {
                payout = hand.bet * 2;
            } else if (pTotal > dealerTotal) {
                payout = hand.bet * 2;
            } else if (pTotal === dealerTotal) {
                payout = hand.bet;
            }

            this.payouts[userId] = payout;
        }
        this._broadcastState();
    }

    _findActiveGMUser() {
        if (typeof game !== 'undefined') {
            const gm = game.users?.find(u => u.isGM && u.active);
            if (gm) return gm;
        }
        return null;
    }

    _ensureDealerProfile() {
        const safeName = t('PARLOR.Common.Dealer');
        if (this.dealerProfile?.controllerId) {
            this.dealerProfile = {
                ...this.dealerProfile,
                type: this.dealerProfile.type || 'gm',
                participantId: null,
                actorId: null,
                name: safeName
            };
            return;
        }

        const gm = this._findActiveGMUser();
        this.dealerProfile = {
            type: 'gm',
            participantId: null,
            actorId: null,
            userId: gm?.id || null,
            controllerId: gm?.id || null,
            name: safeName,
            avatar: null,
            ownerName: gm?.name || t('PARLOR.Common.DM')
        };
    }

    _getDealerProfile() {
        this._ensureDealerProfile();
        return this.dealerProfile;
    }

    _getActivePlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    _getBettingPlayerIds() {
        return this._getActivePlayerIds()
            .filter(userId => ChipManager.canAfford(userId, this.betLimits.min));
    }

    _getSittingOutPlayerIds() {
        const bettingIds = new Set(this._getBettingPlayerIds());
        return this._getActivePlayerIds().filter(userId => !bettingIds.has(userId));
    }

    _getRoundPlayerIds() {
        const activeIds = new Set(this._getActivePlayerIds());
        return this.bets
            .map(bet => bet.userId)
            .filter(userId => activeIds.has(userId));
    }

    _updateRules(nextRules) {
        const safeRules = sanitizeBlackjackRules(nextRules || {});
        const changed = Object.keys(safeRules).some(key => safeRules[key] !== this.rules[key]);
        if (!changed) return;

        this.rules = safeRules;

        if (this.deck.numDecks !== safeRules.deckCount) {
            this.deck = new CardDeck(safeRules.deckCount);
        }

        this._broadcastState();
    }

    _canRequestHit(hand) {
        if (!hand || this.pendingAction) return false;
        if (!['playing', 'awaiting_collect'].includes(hand.status)) return false;
        return this._visibleHandTotal(hand) < this.rules.bustThreshold;
    }

    _canCollectHand(hand) {
        if (!hand || this.pendingAction) return false;
        if (!['playing', 'awaiting_collect'].includes(hand.status)) return false;
        return (hand.tableCards?.length || 0) > 0;
    }

    _canStand(hand) {
        if (!hand || this.pendingAction) return false;
        if (!['playing', 'awaiting_collect'].includes(hand.status)) return false;
        return !this._isBusted(this._visibleHandTotal(hand));
    }

    _visibleHandTotal(hand) {
        return this._handValue(allCards(hand));
    }

    async _commitPayouts() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const chipDeltas = [];
        for (const [userId, hand] of Object.entries(this.playerHands)) {
            const payout = Number(this.payouts[userId] || 0);
            const bet = Number(hand?.bet || 0);
            const delta = payout - bet;

            if (delta !== 0) chipDeltas.push({ userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _takePlayerCard(participantId, currentCards = []) {
        const luck = CardLuckPlan.getLuck(this.cardLuckPlan, participantId);
        if (luck !== 'normal') {
            return takeWeightedBlackjackCard(this.deck, currentCards, {
                mode: luck,
                rules: this.rules,
                rng: this._cardLuckRng
            });
        }

        return OutcomeInfluence.pickBlackjackCard(
            this, this.deck, participantId, currentCards, this.rules
        );
    }

    _warnCustomHandDeferred(customHand) {
        console.warn('parlor | Blackjack custom hand deferred for ' + (customHand?.participantId || 'unknown'));
        globalThis.ui?.notifications?.warn(t('PARLOR.CardLuck.CustomDeferred'));
    }

    _handValue(cards) {
        return getBlackjackTotal(cards, this.rules);
    }

    _isBusted(total) {
        return total > this.rules.bustThreshold;
    }

    _clearFlowTimers() {
        clearTimeout(this._openingDealTimer);
        clearTimeout(this._playerDealTimer);
        clearTimeout(this._dealerDealTimer);
        clearTimeout(this._advanceTurnTimer);
        this._openingDealTimer = null;
        this._playerDealTimer = null;
        this._dealerDealTimer = null;
        this._advanceTurnTimer = null;
    }
}
