/**
 * 疯狂八（Crazy Eights）
 *
 * 甩牌桌：每人一手私牌，轮流往弃牌堆上出花色或点数对上的牌，8 万能，先出完的赢底注池。
 *
 * 权威与私牌：
 * - 主机 GM 持有真值 _privateHands / _stock / _discard，公开 state 只带张数、弃牌顶牌、当前花色
 * - 每位席位的手牌只 sendTo 给它的 controllerId；机器人没有控制者，主机上直接读 getAuthoritativeHand
 * - GM 不开上帝视角（跟骨骰 21 一致），自己代管的席位才看得见
 * - RESOLVING 时把所有手牌塞进 revealedHands 一并公开
 *
 * 结算：底注开局记进 bets[]，钱只在 _commitSettlement 里一次 applyDeltas（newRound / finishGame 各调一次，
 * settlementApplied 兜幂等）；局中被强制结束不动钱。
 */

import { GameBase } from '../GameBase.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';
import { getParticipant, isBotParticipantId, isNpcParticipantId } from '../../core/ParticipantRoster.js';
import {
    SUITS,
    CRAZY_EIGHTS_MIN_PLAYERS,
    sanitizeCrazyEightsOptions,
    getDeckCount,
    getHandSize,
    buildStock,
    sortHand,
    sameCard,
    normalizeCard,
    isWild,
    canPlayCard,
    getLegalActions,
    resolvePlayEffect,
    getNextIndex,
    reshuffleDiscardIntoStock,
    isDeadRound,
    rankLowestHands,
    computeSettlement
} from './CrazyEightsRules.js';

const PRIVATE_UPDATE_TYPE = 'crazyeights.hand';
const DEALING_TO_TURN_DELAY_MS = 900;
// 起底翻 8 埋回去重翻，理论上翻不完，这里只是别让坏数据把主机卡死
const STARTER_FLIP_GUARD = 30;

function freshTurn(pendingDraw = 0) {
    return {
        mustChooseSuit: false,
        pendingDraw: Math.max(0, Number(pendingDraw) || 0),
        drawnThisTurn: false,
        drawCountThisTurn: 0
    };
}

function randomUnit(rng = Math.random) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
}

function cloneCards(cards) {
    return (Array.isArray(cards) ? cards : []).map(card => ({ ...card }));
}

export class CrazyEightsGame extends GameBase {
    static get gameType() { return 'crazyeights'; }

    constructor(config) {
        super(config);
        this.options = sanitizeCrazyEightsOptions(config?.gameOptions);
        this.rules = this.options.rules;
        // 不动账的席位(DM 自测局里的 DM):底注不查、结算不扣,跟机器人一个待遇
        this.exemptParticipantIds = (Array.isArray(config?.gameOptions?.exemptParticipantIds) ? config.gameOptions.exemptParticipantIds : [])
            .map(id => String(id || ''))
            .filter(Boolean);
        this._rng = typeof config?.crazyEightsRng === 'function' ? config.crazyEightsRng : Math.random;
        this._resetRoundFields();
        this._stock = [];
        this._discard = [];
        // 主机真值：participantId -> { roundToken, version, cards }
        this._privateHands = new Map();
        // 本机收到的私牌快照（自己控制的席位）
        this._knownPrivateHands = new Map();
        this._actionSeq = 0;
        this._dealingTimer = null;
    }

    get phases() {
        return ['IDLE', 'DEALING', 'PLAYER_TURNS', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['DEALING'],
            DEALING: ['PLAYER_TURNS', 'RESOLVING'],
            PLAYER_TURNS: ['RESOLVING'],
            RESOLVING: ['DEALING']
        };
    }

    _resetRoundFields() {
        this.deckCount = 1;
        this.handSize = 0;
        this.roundToken = '';
        this.roundPlayerIds = [];
        this.sittingOutPlayerIds = [];
        this.turnOrder = [];
        this.direction = 1;
        this.currentPlayerId = '';
        this.turnStep = 0;
        this.turn = freshTurn();
        this.handCounts = {};
        this.discardTop = null;
        this.discardCount = 0;
        this.currentSuit = '';
        this.stockCount = 0;
        this.passStreak = 0;
        this.lastActions = [];
        this.winnerIds = [];
        this.roundResult = null;
        this.revealedHands = {};
        this.payouts = {};
        this.pot = 0;
        this.settlementApplied = false;
    }

    start() {
        this._clearTimers();
        this._resetRoundFields();
        this._privateHands.clear();
        this._knownPrivateHands.clear();
        this._stock = [];
        this._discard = [];
        this.round += 1;
        this.roundToken = foundry.utils.randomID();

        const activeIds = this._getActivePlayerIds();
        this.roundPlayerIds = activeIds.filter(id => this._isExempt(id) || SettlementManager.canAfford(id, this.options.ante));
        this.sittingOutPlayerIds = activeIds.filter(id => !this.roundPlayerIds.includes(id));
        this.bets = this.roundPlayerIds.map(userId => ({ userId, amount: this.options.ante }));
        this.pot = this.options.ante * this.roundPlayerIds.length;
        this._transition('DEALING');

        if (this.roundPlayerIds.length < CRAZY_EIGHTS_MIN_PLAYERS) {
            // 凑不齐两个人就流产：不记底注、不结账，停在 RESOLVING 等 DM 处理
            this.bets = [];
            this.pot = 0;
            this.roundResult = { kind: 'aborted', reason: 'not-enough-players', winnerIds: [], pot: 0, payoutPerWinner: 0, rows: [] };
            this.settlementApplied = true;
            this._transition('RESOLVING');
            return;
        }

        this._dealRound();
        this._scheduleTurnStart();
        void this._dispatchPrivateHands(this.roundPlayerIds);
    }

    getState() {
        return {
            ...super.getState(),
            options: {
                ante: this.options.ante,
                penaltyPerPoint: this.options.penaltyPerPoint,
                drawRule: this.options.drawRule,
                actionCards: this.options.actionCards
            },
            rules: { ...this.rules },
            exemptParticipantIds: [...this.exemptParticipantIds],
            deckCount: this.deckCount,
            handSize: this.handSize,
            roundToken: this.roundToken,
            roundPlayerIds: [...this.roundPlayerIds],
            sittingOutPlayerIds: [...this.sittingOutPlayerIds],
            turnOrder: [...this.turnOrder],
            direction: this.direction,
            currentPlayerId: this.currentPlayerId,
            turnStep: this.turnStep,
            turn: { ...this.turn },
            handCounts: { ...this.handCounts },
            discardTop: this.discardTop ? { ...this.discardTop } : null,
            discardCount: this.discardCount,
            currentSuit: this.currentSuit,
            stockCount: this.stockCount,
            passStreak: this.passStreak,
            lastActions: this.lastActions.map(entry => ({ ...entry })),
            lastAction: this.lastActions.length ? { ...this.lastActions[this.lastActions.length - 1] } : null,
            winnerIds: [...this.winnerIds],
            roundResult: this.roundResult,
            revealedHands: this.revealedHands,
            payouts: { ...this.payouts },
            pot: this.pot,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.options) this.options = { ...this.options, ...sanitizeCrazyEightsOptions({ ...this.options, ...state.options }) };
        if (state.rules) this.rules = { ...state.rules };
        if (state.exemptParticipantIds) this.exemptParticipantIds = [...state.exemptParticipantIds];
        if (state.deckCount != null) this.deckCount = Number(state.deckCount) || 1;
        if (state.handSize != null) this.handSize = Number(state.handSize) || 0;
        if (state.roundToken !== undefined) this.roundToken = state.roundToken || '';
        if (state.roundPlayerIds) this.roundPlayerIds = [...state.roundPlayerIds];
        if (state.sittingOutPlayerIds) this.sittingOutPlayerIds = [...state.sittingOutPlayerIds];
        if (state.turnOrder) this.turnOrder = [...state.turnOrder];
        if (state.direction != null) this.direction = Number(state.direction) < 0 ? -1 : 1;
        if (state.currentPlayerId !== undefined) this.currentPlayerId = state.currentPlayerId || '';
        if (state.turnStep != null) this.turnStep = Number(state.turnStep) || 0;
        if (state.turn) this.turn = { ...freshTurn(), ...state.turn };
        if (state.handCounts) this.handCounts = { ...state.handCounts };
        if (state.discardTop !== undefined) this.discardTop = state.discardTop ? { ...state.discardTop } : null;
        if (state.discardCount != null) this.discardCount = Number(state.discardCount) || 0;
        if (state.currentSuit !== undefined) this.currentSuit = state.currentSuit || '';
        if (state.stockCount != null) this.stockCount = Number(state.stockCount) || 0;
        if (state.passStreak != null) this.passStreak = Number(state.passStreak) || 0;
        if (state.lastActions) this.lastActions = state.lastActions.map(entry => ({ ...entry }));
        if (state.winnerIds) this.winnerIds = [...state.winnerIds];
        if (state.roundResult !== undefined) this.roundResult = state.roundResult || null;
        if (state.revealedHands) this.revealedHands = state.revealedHands;
        if (state.payouts) this.payouts = { ...state.payouts };
        if (state.pot != null) this.pot = Number(state.pot) || 0;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
    }

    // ───────── 私牌 ─────────

    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== PRIVATE_UPDATE_TYPE) return;

        const version = Number(data.version || 0);
        const known = this._knownPrivateHands.get(data.participantId);
        // 同一局里旧版本的包晚到了，别把新手牌顶掉
        if (known && known.roundToken === data.roundToken && Number(known.version) > version) return;

        const cards = (Array.isArray(data.cards) ? data.cards : []).map(normalizeCard).filter(Boolean);
        this._knownPrivateHands.set(data.participantId, {
            round: Number(data.round || 0),
            roundToken: data.roundToken || '',
            version,
            cards: sortHand(cards)
        });
    }

    /** UI 用：本机看得见的手牌；看不见返回 null（让 UI 画牌背/张数） */
    getVisibleHand(participantId) {
        if (!participantId) return null;
        if (this._phase === 'RESOLVING') {
            const revealed = this.revealedHands?.[participantId];
            if (Array.isArray(revealed)) return cloneCards(revealed);
        }
        const known = this._knownPrivateHands.get(participantId);
        if (!known || known.roundToken !== this.roundToken) return null;
        return cloneCards(known.cards);
    }

    /** 主机用（机器人决策 / 结算）：真值手牌的副本 */
    getAuthoritativeHand(participantId) {
        return cloneCards(this._authoritative(participantId));
    }

    _authoritative(participantId) {
        const entry = this._privateHands.get(participantId);
        if (!entry || entry.roundToken !== this.roundToken) return [];
        return entry.cards;
    }

    async _dispatchPrivateHands(participantIds = this.roundPlayerIds) {
        const jobs = [];
        for (const participantId of participantIds) {
            const entry = this._privateHands.get(participantId);
            if (!entry) continue;

            const payload = {
                sessionId: this.sessionId,
                type: PRIVATE_UPDATE_TYPE,
                participantId,
                round: this.round,
                roundToken: this.roundToken,
                version: entry.version,
                cards: cloneCards(entry.cards),
                sentAt: Date.now()
            };

            const participant = getParticipant(this, participantId);
            const targetUserId = participant?.controllerId || null;
            if (!targetUserId) continue; // 机器人没有控制者，主机直接读真值

            if (targetUserId === game.user.id) {
                // 自分发只手动通知 game + ui，不走 ParlorManager._onPrivateUpdate：
                // socketlib 把 executeAsUser 回送给自己时会让 UI 二次触发（说谎骰踩过）
                this._deliverPrivateHandLocally(payload);
                continue;
            }
            jobs.push(SocketManager.sendTo(SOCKET_EVENTS.GAME_PRIVATE_UPDATE, targetUserId, payload));
        }
        if (jobs.length) await Promise.allSettled(jobs);
    }

    _deliverPrivateHandLocally(payload) {
        this.handlePrivateUpdate(payload);
        const session = ParlorManager._sessions?.get?.(this.sessionId);
        if (!session?.ui) return;
        session.ui.gameInstance = session.game;
        session.ui.handlePrivateUpdate?.(payload);
    }

    _bumpHand(participantId) {
        const entry = this._privateHands.get(participantId);
        if (!entry) return;
        entry.version += 1;
        void this._dispatchPrivateHands([participantId]);
    }

    // ───────── 动作入口 ─────────

    handlePlayerAction(userId, action, data) {
        switch (action) {
            case 'playCard':
                return this._handlePlayCard(userId, data);
            case 'chooseSuit':
                return this._handleChooseSuit(userId, data);
            case 'draw':
                return this._handleDraw(userId);
            case 'pass':
                return this._handlePass(userId);
            case 'requestHand':
                return this._handleRequestHand(userId);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action) {
        switch (action) {
            case 'newRound':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitSettlement();
                this.start();
                await this._broadcastState();
                return { ok: true };
            case 'finishGame':
                // 局中被强制散桌走这里会拿到 phase：不结账，底注也不扣
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitSettlement();
                return { ok: true };
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _checkTurn(userId) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (!this.roundPlayerIds.includes(userId)) return { ok: false, reason: 'not-player' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };
        return null;
    }

    _legalFor(participantId, hand = this._authoritative(participantId)) {
        return getLegalActions(hand, {
            topCard: this.discardTop,
            currentSuit: this.currentSuit,
            rules: this.rules,
            pendingDraw: this.turn.pendingDraw,
            mustChooseSuit: this.turn.mustChooseSuit,
            drawnThisTurn: this.turn.drawnThisTurn,
            drawCountThisTurn: this.turn.drawCountThisTurn,
            stockCount: this._stock.length,
            discardCount: this._discard.length
        });
    }

    _handlePlayCard(userId, data) {
        const blocked = this._checkTurn(userId);
        if (blocked) return blocked;
        if (this.turn.mustChooseSuit) return { ok: false, reason: 'must-choose-suit' };

        const card = normalizeCard(data);
        if (!card) return { ok: false, reason: 'invalid-card' };

        const hand = this._authoritative(userId);
        const index = hand.findIndex(entry => sameCard(entry, card));
        if (index < 0) return { ok: false, reason: 'card-not-in-hand' };

        const playable = canPlayCard(card, {
            topCard: this.discardTop,
            currentSuit: this.currentSuit,
            rules: this.rules,
            pendingDraw: this.turn.pendingDraw
        });
        if (!playable) return { ok: false, reason: this.turn.pendingDraw > 0 ? 'pending-draw' : 'card-not-playable' };

        this._beginAction();
        const [played] = hand.splice(index, 1);
        this._discard.push(played);
        this.currentSuit = played.suit;
        this.passStreak = 0;
        this._syncCounts();

        const effect = resolvePlayEffect(played, { rules: this.rules, playerCount: this.roundPlayerIds.length });
        const type = effect.wild ? 'wild' : 'play';

        if (!hand.length) {
            // 最后一张是 8 也直接赢，不用再选花色
            this._record(type, { participantId: userId, card: { ...played } });
            this._bumpHand(userId);
            this._resolveRound('win', [userId]);
            this._broadcastState();
            return { ok: true };
        }

        if (effect.wild) {
            this.turn.mustChooseSuit = true;
            this._record('wild', { participantId: userId, card: { ...played } });
        } else {
            this._record('play', { participantId: userId, card: { ...played } });
            this._advanceTurn(effect);
        }

        this._bumpHand(userId);
        this._broadcastState();
        return { ok: true };
    }

    _handleChooseSuit(userId, data) {
        const blocked = this._checkTurn(userId);
        if (blocked) return blocked;
        if (!this.turn.mustChooseSuit) return { ok: false, reason: 'no-suit-needed' };

        const suit = String(data?.suit || '');
        if (!SUITS.includes(suit)) return { ok: false, reason: 'invalid-suit' };

        this._beginAction();
        this.currentSuit = suit;
        this.turn.mustChooseSuit = false;
        this._record('chooseSuit', { participantId: userId, suit });
        this._advanceTurn({});
        this._broadcastState();
        return { ok: true };
    }

    _handleDraw(userId) {
        const blocked = this._checkTurn(userId);
        if (blocked) return blocked;
        if (this.turn.mustChooseSuit) return { ok: false, reason: 'must-choose-suit' };

        const hand = this._authoritative(userId);
        const legal = this._legalFor(userId, hand);
        if (!legal.canDraw) return { ok: false, reason: 'cannot-draw' };

        this._beginAction();

        if (this.turn.pendingDraw > 0) {
            // 手里有 2 却选择接罚：吃下罚抽并跳过
            const drawn = this._drawCards(userId, this.turn.pendingDraw, { luck: false });
            this.turn.pendingDraw = 0;
            this._record('penalty', { participantId: userId, count: drawn.length });
            this._bumpHand(userId);
            this._advanceTurn({});
            this._broadcastState();
            return { ok: true };
        }

        const drawn = this._drawCards(userId, 1, { luck: true });
        this.turn.drawnThisTurn = true;
        this.turn.drawCountThisTurn += 1;
        this._record('draw', { participantId: userId, count: drawn.length });
        this._bumpHand(userId);

        // 抽完还是没牌可出、也不能再抽 → 引擎自动过，不逼玩家多点一次
        const after = this._legalFor(userId, hand);
        if (!after.playable.length && !after.canDraw) {
            this.passStreak += 1;
            this._record('pass', { participantId: userId, autoPass: true });
            if (!this._checkDeadRound()) this._advanceTurn({});
        }

        this._broadcastState();
        return { ok: true };
    }

    _handlePass(userId) {
        const blocked = this._checkTurn(userId);
        if (blocked) return blocked;
        if (this.turn.mustChooseSuit) return { ok: false, reason: 'must-choose-suit' };

        const legal = this._legalFor(userId);
        if (!legal.canPass) return { ok: false, reason: 'cannot-pass' };

        this._beginAction();
        // 手里明明有牌能出还选择过，不算"没人能出"，流局计数归零
        this.passStreak = legal.playable.length ? 0 : this.passStreak + 1;
        this._record('pass', { participantId: userId });
        if (!this._checkDeadRound()) this._advanceTurn({});
        this._broadcastState();
        return { ok: true };
    }

    /** 玩家刷新页面后找回手牌：只会发给该席位的控制者，请求方是谁不重要 */
    _handleRequestHand(userId) {
        if (!this.roundPlayerIds.includes(userId)) return { ok: false, reason: 'not-player' };
        if (!this._privateHands.has(userId)) return { ok: false, reason: 'phase' };
        void this._dispatchPrivateHands([userId]);
        return { ok: true };
    }

    // ───────── 发牌 / 回合推进 ─────────

    _dealRound() {
        const playerCount = this.roundPlayerIds.length;
        this.deckCount = getDeckCount(playerCount);
        this.handSize = getHandSize(playerCount);
        this._stock = buildStock(this.deckCount, this._rng);
        this._discard = [];

        const config = OutcomeInfluence.getConfig();
        for (const participantId of this.roundPlayerIds) {
            const cards = OutcomeInfluence.pickCrazyEightsHand(this, this._stock, participantId, this.handSize, {
                config,
                rng: this._rng,
                rules: this.rules
            });
            this._privateHands.set(participantId, {
                roundToken: this.roundToken,
                version: 1,
                cards: sortHand(cards)
            });
        }

        // 起底翻到 8 就埋回牌堆随机位置再翻一张
        let starter = null;
        for (let i = 0; i < STARTER_FLIP_GUARD && this._stock.length; i++) {
            const card = this._stock.pop();
            if (!isWild(card, this.rules) || i === STARTER_FLIP_GUARD - 1) {
                starter = card;
                break;
            }
            const slot = Math.floor(randomUnit(this._rng) * (this._stock.length + 1));
            this._stock.splice(slot, 0, card);
        }
        if (starter) this._discard.push(starter);
        this.currentSuit = starter?.suit || '';

        this.turnOrder = this._buildTurnOrder(this.roundPlayerIds);
        this.direction = 1;
        this.turnStep = 0;
        this.passStreak = 0;
        this.currentPlayerId = this.turnOrder[0] || '';
        this.turn = freshTurn();
        this._syncCounts();
        this._record('deal', { count: this.handSize });
    }

    _scheduleTurnStart() {
        clearTimeout(this._dealingTimer);
        this._dealingTimer = setTimeout(() => this._enterTurnPhase(), DEALING_TO_TURN_DELAY_MS);
    }

    _enterTurnPhase() {
        this._dealingTimer = null;
        if (this._phase !== 'DEALING') return;
        // 桌子已经散了还在等定时器的话，别对着死会话广播
        const session = ParlorManager._sessions?.get?.(this.sessionId);
        if (session && session.game !== this) return;

        this._transition('PLAYER_TURNS');
        this._beginTurn(this.turnOrder[0] || '');
        this._broadcastState();
    }

    /**
     * 把回合交给 participantId，并处理"到你了但其实没得选"的情况：
     * - 头上有罚抽且手里没 2：自动罚抽并跳过
     * - 没牌可出又没牌可抽：自动过（可能连着过一整圈直到流局）
     */
    _beginTurn(startId) {
        let participantId = startId;
        let guard = this.turnOrder.length + 1;

        while (guard-- > 0 && participantId) {
            this.currentPlayerId = participantId;
            this.turn = freshTurn(this.turn.pendingDraw);
            const hand = this._authoritative(participantId);

            if (this.turn.pendingDraw > 0) {
                const holdsTwo = !!this.rules.drawTwoRank && hand.some(card => card.rank === this.rules.drawTwoRank);
                if (holdsTwo) return;
                const drawn = this._drawCards(participantId, this.turn.pendingDraw, { luck: false });
                this.turn.pendingDraw = 0;
                this._record('penalty', { participantId, count: drawn.length });
                this._bumpHand(participantId);
                participantId = this._nextId(1);
                this.turnStep += 1;
                continue;
            }

            const legal = this._legalFor(participantId, hand);
            if (!legal.playable.length && !legal.canDraw) {
                this.passStreak += 1;
                this._record('pass', { participantId, autoPass: true });
                if (this._checkDeadRound()) return;
                participantId = this._nextId(1);
                this.turnStep += 1;
                continue;
            }
            return;
        }

        // 整圈都动不了却没触发流局判定，理论上到不了，兜一下别让桌子卡死
        if (this._phase === 'PLAYER_TURNS') this._resolveRound('dead');
    }

    _advanceTurn(effect = {}) {
        if (effect.reverse) {
            this.direction = -this.direction;
            this._record('reverse', { participantId: this.currentPlayerId });
        }
        if (effect.addDraw) this.turn.pendingDraw += effect.addDraw;

        let steps = 1;
        if (effect.skipNext && !effect.addDraw) {
            steps = 2;
            this._record('skip', { participantId: this.currentPlayerId, targetId: this._nextId(1) });
        }

        const nextId = this._nextId(steps);
        this.turnStep += 1;
        this._beginTurn(nextId);
    }

    _nextId(steps = 1) {
        if (!this.turnOrder.length) return '';
        const index = this.turnOrder.indexOf(this.currentPlayerId);
        return this.turnOrder[getNextIndex(this.turnOrder.length, index, this.direction, steps)] || '';
    }

    _drawCards(participantId, count, { luck = false } = {}) {
        const hand = this._authoritative(participantId);
        const taken = [];
        const wanted = Math.max(0, Math.floor(Number(count) || 0));
        const config = luck ? OutcomeInfluence.getConfig() : null;

        for (let i = 0; i < wanted; i++) {
            if (!this._stock.length) {
                const result = reshuffleDiscardIntoStock({ stock: this._stock, discard: this._discard }, this._rng);
                this._stock = result.stock;
                this._discard = result.discard;
                if (result.reshuffled) this._record('reshuffle', { count: this._stock.length });
            }
            if (!this._stock.length) break;

            const card = luck
                ? OutcomeInfluence.pickCrazyEightsDraw(this, this._stock, participantId, {
                    topCard: this._discard[this._discard.length - 1] || null,
                    currentSuit: this.currentSuit,
                    rules: this.rules,
                    hand,
                    pendingDraw: this.turn.pendingDraw,
                    config,
                    rng: this._rng
                })
                : this._stock.pop();
            if (!card) break;
            taken.push(card);
        }

        if (taken.length) {
            const sorted = sortHand([...hand, ...taken]);
            hand.splice(0, hand.length, ...sorted);
        }
        this._syncCounts();
        return taken;
    }

    _checkDeadRound() {
        const dead = isDeadRound({
            stockCount: this._stock.length,
            discardCount: this._discard.length,
            passStreak: this.passStreak,
            playerCount: this.roundPlayerIds.length
        });
        if (!dead) return false;
        this._resolveRound('dead');
        return true;
    }

    // ───────── 结算 ─────────

    _resolveRound(kind, winnerIds = []) {
        this._clearTimers();
        if (this._phase !== 'RESOLVING') this._transition('RESOLVING');
        this.currentPlayerId = '';
        this.turn = freshTurn();

        const handsById = {};
        for (const participantId of this.roundPlayerIds) {
            handsById[participantId] = this.getAuthoritativeHand(participantId);
        }
        this.revealedHands = handsById;

        let winners = winnerIds.filter(id => this.roundPlayerIds.includes(id));
        let resultKind = 'win';
        if (kind === 'dead' || !winners.length) {
            winners = rankLowestHands(handsById, this.rules).winnerIds;
            resultKind = winners.length > 1 ? 'split' : 'dead';
        }

        const settlement = computeSettlement({
            kind: resultKind === 'win' ? 'win' : 'dead',
            winnerIds: winners,
            playerIds: this.roundPlayerIds,
            handsById,
            ante: this.options.ante,
            penaltyPerPoint: this.options.penaltyPerPoint,
            rules: this.rules,
            getBalance: id => SettlementManager.getBalance(id),
            isUnlimited: id => this._isExempt(id)
        });

        this.winnerIds = winners;
        this.pot = settlement.pot;
        this.payouts = Object.fromEntries(settlement.rows.map(row => [row.id, row.payout]));
        this.roundResult = {
            kind: resultKind,
            winnerIds: [...winners],
            pot: settlement.pot,
            payoutPerWinner: settlement.payoutPerWinner,
            rows: settlement.rows
        };
        this._record(resultKind === 'win' ? 'win' : 'dead', { participantId: winners[0] || '', winnerIds: [...winners] });
    }

    async _commitSettlement() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const deltas = (this.roundResult?.rows || [])
            .filter(row => Number(row.net) !== 0 && !this._isExempt(row.id))
            .map(row => ({ userId: row.id, delta: Number(row.net) }));
        if (deltas.length) await SettlementManager.applyDeltas(deltas);
        await this._broadcastState();
    }

    // ───────── 杂项 ─────────

    _buildTurnOrder(roundPlayerIds) {
        const base = this.participants
            .map(entry => entry.id)
            .filter(id => roundPlayerIds.includes(id));
        const order = base.length ? base : [...roundPlayerIds];
        const gmIds = new Set(this.participants
            .filter(entry => entry.userId && game.users?.get(entry.userId)?.isGM)
            .map(entry => entry.id));
        // GM 参局照骨骰 21 的习惯排最后；首家随局数往后轮，别每局都同一个人先出
        const seated = [
            ...order.filter(id => !gmIds.has(id)),
            ...order.filter(id => gmIds.has(id))
        ];
        if (!seated.length) return [];
        const start = (Math.max(1, this.round) - 1) % seated.length;
        return [...seated.slice(start), ...seated.slice(0, start)];
    }

    _getActivePlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    /** 机器人 / NPC / 自测局的 DM:不进真实账户 */
    _isExempt(participantId) {
        return isBotParticipantId(participantId)
            || isNpcParticipantId(participantId)
            || this.exemptParticipantIds.includes(String(participantId || ''));
    }

    _syncCounts() {
        const counts = {};
        for (const participantId of this.roundPlayerIds) {
            counts[participantId] = this._authoritative(participantId).length;
        }
        this.handCounts = counts;
        this.discardTop = this._discard.length ? { ...this._discard[this._discard.length - 1] } : null;
        this.discardCount = this._discard.length;
        this.stockCount = this._stock.length;
    }

    _beginAction() {
        this.lastActions = [];
    }

    _record(type, extra = {}) {
        this._actionSeq += 1;
        this.lastActions.push({ type, seq: this._actionSeq, step: this.turnStep, at: Date.now(), ...extra });
    }

    _clearTimers() {
        clearTimeout(this._dealingTimer);
        this._dealingTimer = null;
    }
}
