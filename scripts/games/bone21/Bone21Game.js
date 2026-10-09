/**
 * 骨骰二十一
 *
 * 这是无庄家的酒馆骰子桌：大家先进同一个奖池，再轮流决定补骰或停手。
 * 结算只看“未爆且最接近 21”，所以这里不要引入庄家手牌或额外倍率。
 *
 * 私骰 / 公骰拆分：
 * - 初始的 3 颗 = 私骰，只通过 socket 派发给该 seat 的 controller；
 *   playerStates[id].dice 里**不**包含它们
 * - 后续每一次加骰 = 公骰，进 playerStates[id].dice，所有客户端可见
 * - RESOLVING 阶段把私骰塞进 revealedInitialDice 一并公开
 * - bust 判定走 GM 端 _getRealTotal（含私骰），其他客户端 status 公开即可
 */

import { GameBase } from '../GameBase.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';
import { getParticipant } from '../../core/ParticipantRoster.js';

const STARTING_DICE = 3;
const BUST_LIMIT = 21;
const MINIMUM_ANTE = 1;
const DEFAULT_ANTE = 10;
const ROLLING_TO_TURN_DELAY_MS = 900;

function normalizeAnte(amount) {
    const value = Math.floor(Number(amount));
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function rollDie(rng = Math.random) {
    const value = Number(rng?.());
    const safe = Number.isFinite(value)
        ? Math.max(0, Math.min(0.9999999999999999, value))
        : Math.random();
    return Math.floor(safe * 6) + 1;
}

function getTotal(dice = []) {
    return dice.reduce((sum, value) => sum + Math.max(1, Math.min(6, Number(value) || 0)), 0);
}

function roundChipAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function sanitizeDice(dice) {
    if (!Array.isArray(dice)) return [];
    return dice
        .map(value => Math.max(1, Math.min(6, Math.floor(Number(value) || 0))))
        .filter(value => value >= 1 && value <= 6);
}

export class Bone21Game extends GameBase {
    static get gameType() { return 'bone21'; }

    constructor(config) {
        super(config);
        // 开桌时 DM 在大厅弹窗里就定了——这桌每一轮都按这个金额扣
        this.startingAnte = normalizeAnte(config?.gameOptions?.ante) || DEFAULT_ANTE;
        this.roundAnte = 0;
        this.playerStates = {};
        this.turnOrder = [];
        this.currentPlayerId = '';
        this.winnerIds = [];
        this.payouts = {};
        this.roundResult = null;
        this.settlementApplied = false;
        // 私骰公开后塞这里——key 是 participantId，value 是 dice 数组
        this.revealedInitialDice = {};
        // 每轮重置，用来去重旧 round 的私骰快照
        this.roundToken = '';
        // start() 时如果有人筹码不够，记下来给 UI 提示
        this.lastSetAnteShortIds = [];
        this._rollingTimer = null;
        // GM 端持有的私骰真值
        this._privateInitialDice = new Map();
        // 所有客户端持有的本机能看见的私骰快照
        this._knownPrivateInitialDice = new Map();
        this._bone21Rng = typeof config?.bone21Rng === 'function' ? config.bone21Rng : Math.random;
    }

    get phases() {
        return ['IDLE', 'BETTING', 'ROLLING', 'PLAYER_TURNS', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['BETTING'],
            BETTING: ['ROLLING'],
            ROLLING: ['PLAYER_TURNS', 'RESOLVING'],
            PLAYER_TURNS: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    start() {
        this._clearTimers();
        this.bets = [];
        this.roundAnte = 0;
        this.playerStates = {};
        this.turnOrder = [];
        this.currentPlayerId = '';
        this.winnerIds = [];
        this.payouts = {};
        this.roundResult = null;
        this.settlementApplied = false;
        this.revealedInitialDice = {};
        this.roundToken = '';
        this.lastSetAnteShortIds = [];
        this._privateInitialDice.clear();
        this._knownPrivateInitialDice.clear();
        this.round += 1;
        this._transition('BETTING');

        // 大厅开桌就定下了本桌金额——这里自动按它扣一遍直接进 ROLLING
        // 失败的话（中途破产）就停在 BETTING，DM 可以在桌面手动调金额重试
        const result = this._handleSetAnte({ amount: this.startingAnte });
        if (!result.ok && result.reason === 'chips-insufficient') {
            this.lastSetAnteShortIds = result.shortIds || [];
            this._broadcastState();
        }
    }

    getState() {
        return {
            ...super.getState(),
            roundAnte: this.roundAnte,
            playerStates: this.playerStates,
            turnOrder: this.turnOrder,
            currentPlayerId: this.currentPlayerId,
            winnerIds: this.winnerIds,
            payouts: this.payouts,
            roundResult: this.roundResult,
            settlementApplied: this.settlementApplied,
            revealedInitialDice: this.revealedInitialDice,
            roundToken: this.roundToken,
            initialDiceCount: STARTING_DICE,
            startingAnte: this.startingAnte,
            lastSetAnteShortIds: this.lastSetAnteShortIds,
            bettingPlayerIds: this._getBettingPlayerIds(),
            sittingOutPlayerIds: this._getSittingOutPlayerIds()
        };
    }

    setState(state) {
        super.setState(state);
        if (state.roundAnte != null) this.roundAnte = normalizeAnte(state.roundAnte);
        if (state.playerStates) this.playerStates = state.playerStates;
        if (state.turnOrder) this.turnOrder = state.turnOrder;
        if (state.currentPlayerId !== undefined) this.currentPlayerId = state.currentPlayerId || '';
        if (state.winnerIds) this.winnerIds = state.winnerIds;
        if (state.payouts) this.payouts = state.payouts;
        if (state.roundResult !== undefined) this.roundResult = state.roundResult || null;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
        if (state.revealedInitialDice) this.revealedInitialDice = state.revealedInitialDice;
        if (state.roundToken !== undefined) this.roundToken = state.roundToken || '';
        if (state.startingAnte != null) this.startingAnte = normalizeAnte(state.startingAnte) || DEFAULT_ANTE;
        if (state.lastSetAnteShortIds) this.lastSetAnteShortIds = state.lastSetAnteShortIds;
    }

    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== 'bone21.initial') return;

        this._knownPrivateInitialDice.set(data.participantId, {
            round: Number(data.round || 0),
            roundToken: data.roundToken || '',
            dice: sanitizeDice(data.dice),
            rolledAt: Number(data.rolledAt || Date.now())
        });
    }

    /**
     * 拿到 participantId 的私骰；本机看不到（不是控制者）就返回 null。
     * GM 也走 _knownPrivateInitialDice——只能看到自己代管的角色，不开"上帝视角"。
     * _privateInitialDice 仍是 GM 端的真值，只用于 _getRealTotal / _resolveRound，不暴露给 UI。
     */
    getPrivateInitialDice(participantId) {
        if (!participantId) return null;
        const known = this._knownPrivateInitialDice.get(participantId);
        if (known?.roundToken !== this.roundToken) return null;
        return [...known.dice];
    }

    /** UI 渲染用：返回本机能看到的全部骰子（私骰 + 公开加骰） */
    getVisibleDice(participantId) {
        const seat = this.playerStates?.[participantId] || null;
        const addOn = Array.isArray(seat?.dice) ? seat.dice : [];

        // RESOLVING：私骰已公开，直接拿 revealed
        const revealed = this.revealedInitialDice?.[participantId];
        if (Array.isArray(revealed) && revealed.length) {
            return [...revealed, ...addOn];
        }

        // 私密阶段：能看到才拼上
        const priv = this.getPrivateInitialDice(participantId);
        if (priv) return [...priv, ...addOn];

        // 看不到私骰 → 只返回加骰
        return [...addOn];
    }

    /** UI 渲染用：私骰看不全时返回 null（让 UI 显示"?"） */
    getVisibleTotal(participantId) {
        const seat = this.playerStates?.[participantId] || null;
        if (!seat) return 0;
        const addOnTotal = Number(seat.total || 0);

        const revealed = this.revealedInitialDice?.[participantId];
        if (Array.isArray(revealed)) {
            return addOnTotal + getTotal(revealed);
        }

        const priv = this.getPrivateInitialDice(participantId);
        if (priv) return addOnTotal + getTotal(priv);

        return null;
    }

    /** 是否本机能看到 participantId 的初始私骰（用于 UI 决定是否显示占位） */
    isInitialDiceVisible(participantId) {
        const revealed = this.revealedInitialDice?.[participantId];
        if (Array.isArray(revealed) && revealed.length) return true;
        return !!this.getPrivateInitialDice(participantId);
    }

    handlePlayerAction(userId, action) {
        switch (action) {
            case 'roll':
                return this._handleRoll(userId);
            case 'stand':
                return this._handleStand(userId);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action, data) {
        switch (action) {
            case 'setAnte':
                return this._handleSetAnte(data);
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

    _handleSetAnte(data) {
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };

        const amount = normalizeAnte(data?.amount);
        if (!amount) return { ok: false, reason: 'invalid-amount' };

        const activeIds = this._getActivePlayerIds();
        if (!activeIds.length) return { ok: false, reason: 'no-players' };

        // DM 一刀切：所有 active 都按这个金额扣
        // NPC（bot/npc 类型）不进真实结算账户，金币和筹码模式都按自动放行处理。
        // 只要某真实玩家不够就拒绝，并把缺的人列出来给 UI 提示
        const shortIds = activeIds.filter(id => !ChipManager.canAfford(id, amount));
        if (shortIds.length) return { ok: false, reason: 'chips-insufficient', shortIds };

        this.roundAnte = amount;
        this.startingAnte = amount;          // DM 在桌面手动调过的话，后续轮也跟着
        this.lastSetAnteShortIds = [];        // 这次过了，清掉上次缺筹码的提示
        this.bets = activeIds.map(userId => ({ userId, amount }));
        this._beginRoll();
        return { ok: true };
    }

    _handleRoll(userId) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };

        const seat = this.playerStates[userId];
        if (!seat || seat.status !== 'playing') return { ok: false, reason: 'not-active' };

        const die = rollDie(this._bone21Rng);
        // seat.dice 只存加骰部分，初始 3 颗在 _privateInitialDice 里
        seat.dice = [...(seat.dice || []), die];
        seat.total = getTotal(seat.dice);   // 公开总和（只含加骰）
        seat.lastRoll = die;
        seat.updatedAt = Date.now();

        // bust 判断走真实总和（含私骰），但只把 status 公开，dice 列还是只展示加骰
        if (this._getRealTotal(userId) > BUST_LIMIT) {
            seat.status = 'bust';
            seat.result = 'bust';
            this._advanceTurnOrResolve();
        }

        this._broadcastState();
        return { ok: true };
    }

    /** GM 端用：私骰 + 加骰 的真实总和，用于 bust / 胜负判定 */
    _getRealTotal(participantId) {
        const seat = this.playerStates?.[participantId];
        const addOnTotal = Number(seat?.total || 0);
        const initial = this._privateInitialDice.get(participantId);
        const initialTotal = initial?.roundToken === this.roundToken ? getTotal(initial.dice) : 0;
        return addOnTotal + initialTotal;
    }

    _handleStand(userId) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };

        const seat = this.playerStates[userId];
        if (!seat || seat.status !== 'playing') return { ok: false, reason: 'not-active' };

        seat.status = 'stand';
        seat.result = 'stand';
        seat.updatedAt = Date.now();
        this._advanceTurnOrResolve();
        this._broadcastState();
        return { ok: true };
    }

    _beginRoll() {
        this._transition('ROLLING');
        this.winnerIds = [];
        this.payouts = {};
        this.roundResult = null;
        this.settlementApplied = false;
        this.revealedInitialDice = {};
        this.roundToken = foundry.utils.randomID();
        this._privateInitialDice.clear();
        this._knownPrivateInitialDice.clear();

        const roundPlayers = this._getRoundPlayerIds();
        this.playerStates = {};
        const rolledAt = Date.now();
        const outcomeConfig = OutcomeInfluence.getConfig();
        for (const userId of roundPlayers) {
            // 属性只碰初始私骰，玩家后续主动加骰继续走普通随机。
            const initialDice = OutcomeInfluence.rollBone21InitialDice(
                this,
                userId,
                STARTING_DICE,
                {
                    config: outcomeConfig,
                    rng: this._bone21Rng
                }
            );
            this._privateInitialDice.set(userId, {
                round: this.round,
                roundToken: this.roundToken,
                dice: initialDice,
                rolledAt
            });
            this.playerStates[userId] = {
                dice: [],                // 公开加骰列表，初始为空
                total: 0,                // 公开总和（只算加骰）
                status: 'playing',
                result: 'playing',
                lastRoll: 0,
                bet: this.roundAnte || DEFAULT_ANTE,
                updatedAt: rolledAt
            };
        }

        this.turnOrder = this._buildTurnOrder(roundPlayers);
        this.currentPlayerId = this.turnOrder[0] || '';
        this._scheduleTurnStart();
        // 先把私骰 sendTo 出去再广播公开 state——
        // 不然客户端可能先收到 phase=ROLLING、_maybePlayDsn 的入场判断过完了，
        // 再收到私骰就来不及触发动画
        void (async () => {
            try {
                await this._dispatchPrivateInitialDice(roundPlayers);
            } finally {
                this._broadcastState();
            }
        })();
    }

    async _dispatchPrivateInitialDice(roundPlayers = []) {
        const rolledAt = Date.now();
        const jobs = [];

        for (const userId of roundPlayers) {
            const hand = this._privateInitialDice.get(userId);
            if (!hand) continue;
            hand.rolledAt = rolledAt;

            const payload = {
                sessionId: this.sessionId,
                type: 'bone21.initial',
                participantId: userId,
                round: this.round,
                roundToken: this.roundToken,
                dice: [...hand.dice],
                rolledAt
            };

            const participant = getParticipant(this, userId);
            const targetUserId = participant?.controllerId || null;

            if (targetUserId === game.user.id) {
                // 自分发：手动通知 game + ui 两层，**不**走 _onPrivateUpdate 防双发（参见说谎骰同款修复）
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

    _scheduleTurnStart() {
        clearTimeout(this._rollingTimer);
        this._rollingTimer = setTimeout(() => this._enterTurnPhase(), ROLLING_TO_TURN_DELAY_MS);
    }

    _enterTurnPhase() {
        if (this._phase !== 'ROLLING') return;
        if (!this.currentPlayerId) {
            this._resolveRound();
            this._broadcastState();
            return;
        }

        this._transition('PLAYER_TURNS');
        this._broadcastState();
    }

    _advanceTurnOrResolve() {
        const nextPlayer = this.turnOrder.find(userId => this.playerStates[userId]?.status === 'playing');
        if (nextPlayer) {
            this.currentPlayerId = nextPlayer;
            return;
        }

        this._resolveRound();
    }

    _resolveRound() {
        this._clearTimers();
        if (this._phase !== 'RESOLVING') this._transition('RESOLVING');

        const roundPlayers = this._getRoundPlayerIds();

        // 一次性把私骰塞进 revealedInitialDice 公开（broadcast 之后所有客户端可见）
        this.revealedInitialDice = {};
        for (const userId of roundPlayers) {
            const priv = this._privateInitialDice.get(userId);
            this.revealedInitialDice[userId] = priv?.roundToken === this.roundToken
                ? [...priv.dice]
                : [];
        }

        const pot = roundPlayers.reduce((sum, userId) => {
            const bet = this.bets.find(entry => entry.userId === userId);
            return sum + Number(bet?.amount || 0);
        }, 0);
        // 胜负走真实总和（私骰 + 加骰）
        const liveSeats = roundPlayers
            .map(userId => ({ userId, total: this._getRealTotal(userId) }))
            .filter(entry => entry.total <= BUST_LIMIT);

        this.currentPlayerId = '';
        this.winnerIds = [];
        this.payouts = {};

        if (!liveSeats.length) {
            for (const userId of roundPlayers) {
                const bet = this.bets.find(entry => entry.userId === userId);
                this.payouts[userId] = Number(bet?.amount || 0);
            }
            this.roundResult = {
                kind: 'push',
                pot: roundChipAmount(pot),
                maxTotal: 0,
                payoutPerWinner: 0
            };
            return;
        }

        const maxTotal = Math.max(...liveSeats.map(entry => entry.total));
        this.winnerIds = liveSeats
            .filter(entry => entry.total === maxTotal)
            .map(entry => entry.userId);
        const payoutPerWinner = roundChipAmount(pot / Math.max(1, this.winnerIds.length));

        for (const userId of roundPlayers) {
            this.payouts[userId] = this.winnerIds.includes(userId) ? payoutPerWinner : 0;
        }

        this.roundResult = {
            kind: this.winnerIds.length > 1 ? 'split' : 'win',
            pot: roundChipAmount(pot),
            maxTotal,
            payoutPerWinner
        };
    }

    _buildTurnOrder(roundPlayers) {
        const order = this.participants
            .map(entry => entry.id)
            .filter(id => roundPlayers.includes(id));
        const baseOrder = order.length ? order : roundPlayers.slice();
        const gmIds = new Set(this.participants
            .filter(entry => entry.userId && game.users?.get(entry.userId)?.isGM)
            .map(entry => entry.id));

        // 原玩法里的 host 最后行动；这里把“GM 参局”映射成最后行动，不再多加一层桌主设置。
        return [
            ...baseOrder.filter(id => !gmIds.has(id)),
            ...baseOrder.filter(id => gmIds.has(id))
        ];
    }

    _getActivePlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    _getBettingPlayerIds() {
        const requiredAmount = this.roundAnte || MINIMUM_ANTE;
        return this._getActivePlayerIds()
            .filter(userId => ChipManager.canAfford(userId, requiredAmount));
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

    async _commitPayouts() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;

        const chipDeltas = [];
        for (const bet of this.bets) {
            const userId = bet.userId;
            const payout = Number(this.payouts[userId] || 0);
            const delta = roundChipAmount(payout - Number(bet.amount || 0));
            if (delta !== 0) chipDeltas.push({ userId, delta });
        }

        await ChipManager.applyDeltas(chipDeltas);
        await this._broadcastState();
    }

    _clearTimers() {
        clearTimeout(this._rollingTimer);
        this._rollingTimer = null;
    }
}
