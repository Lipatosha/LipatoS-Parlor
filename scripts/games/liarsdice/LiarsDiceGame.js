/**
 * 说谎骰桌逻辑
 *
 * 这一版按更传统的淘汰制来跑：
 * - 当前玩家必须在自己回合里叫出“几个几”
 * - 下一位玩家只能继续加叫，或直接开盅
 * - 开盅后系统自动判断真假，输家减 1 颗骰子
 * - 最后一位还有骰子的玩家获胜
 */

import { GameBase } from '../GameBase.js';
import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { getParticipant } from '../../core/ParticipantRoster.js';
import { OutcomeInfluence } from '../../core/OutcomeInfluence.js';

const STARTING_DICE = 5;
const ROLLING_TO_TURN_DELAY_MS = 1500;
function createFaceCounts() {
    return {
        1: 0,
        2: 0,
        3: 0,
        4: 0,
        5: 0,
        6: 0
    };
}

function sanitizeDice(dice) {
    if (!Array.isArray(dice)) return [];
    return dice
        .map(value => Math.max(1, Math.min(6, Math.floor(Number(value) || 0))))
        .filter(value => value >= 1 && value <= 6);
}

function sanitizeClaim(data, { withMeta = false } = {}) {
    const quantity = Math.max(1, Math.floor(Number(data?.quantity || 0)));
    const face = Math.max(1, Math.min(6, Math.floor(Number(data?.face || 0))));
    if (!quantity || !face) return null;

    const claim = { quantity, face };
    if (!withMeta) return claim;

    claim.userId = data?.userId || '';
    claim.turnStep = Number(data?.turnStep || 0);
    claim.calledAt = Number(data?.calledAt || 0);
    return claim;
}

function isClaimHigher(nextClaim, previousClaim) {
    if (!nextClaim) return false;
    if (!previousClaim) return true;
    if (nextClaim.quantity > previousClaim.quantity) return true;
    if (nextClaim.quantity < previousClaim.quantity) return false;
    return nextClaim.face > previousClaim.face;
}

function getClaimActualCount(faceCounts, claim, onesCalled) {
    if (!claim) return 0;

    const exactCount = Number(faceCounts?.[claim.face] || 0);
    if (claim.face === 1) return exactCount;
    if (onesCalled) return exactCount;

    return exactCount + Number(faceCounts?.[1] || 0);
}

export class LiarsDiceGame extends GameBase {
    static get gameType() { return 'liarsdice'; }

    constructor(config) {
        super(config);
        this.startingDice = Math.max(1, Math.floor(Number(config?.gameOptions?.startingDice || STARTING_DICE)) || STARTING_DICE);
        this.diceCounts = {};
        this.roundStarterId = '';
        this.nextRoundStarterId = '';
        this.currentPlayerId = '';
        this.turnOrder = [];
        this.turnStep = 0;
        this.turnStartedAt = 0;
        this.roundToken = '';
        this.revealed = false;
        this.revealedBy = '';
        this.faceCounts = createFaceCounts();
        this.revealedDice = {};
        this.lastClaim = null;
        this.onesCalled = false;
        this.actualClaimCount = 0;
        this.claimWasTrue = null;
        this.roundLoserId = '';
        this.matchWinnerId = '';
        this._rollingTimer = null;
        this._privateHands = new Map();
        this._knownPrivateHands = new Map();
    }

    get phases() {
        return ['IDLE', 'ROLLING', 'PLAYER_TURNS', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['ROLLING', 'RESOLVING'],
            ROLLING: ['PLAYER_TURNS'],
            PLAYER_TURNS: ['RESOLVING'],
            RESOLVING: ['ROLLING']
        };
    }

    start() {
        this._clearTimers();
        this._resetMatch();
        this._beginRound();
    }

    getState() {
        return {
            ...super.getState(),
            startingDice: this.startingDice,
            diceCounts: this.diceCounts,
            roundStarterId: this.roundStarterId,
            nextRoundStarterId: this.nextRoundStarterId,
            currentPlayerId: this.currentPlayerId,
            turnOrder: this.turnOrder,
            turnStep: this.turnStep,
            turnStartedAt: this.turnStartedAt,
            roundToken: this.roundToken,
            revealed: this.revealed,
            revealedBy: this.revealedBy,
            faceCounts: this.faceCounts,
            revealedDice: this.revealedDice,
            lastClaim: this.lastClaim,
            onesCalled: this.onesCalled,
            actualClaimCount: this.actualClaimCount,
            claimWasTrue: this.claimWasTrue,
            roundLoserId: this.roundLoserId,
            matchWinnerId: this.matchWinnerId
        };
    }

    setState(state) {
        super.setState(state);
        if (state.startingDice != null) this.startingDice = Math.max(1, Number(state.startingDice) || STARTING_DICE);
        if (state.diceCounts) this.diceCounts = state.diceCounts;
        if (state.roundStarterId !== undefined) this.roundStarterId = state.roundStarterId || '';
        if (state.nextRoundStarterId !== undefined) this.nextRoundStarterId = state.nextRoundStarterId || '';
        if (state.currentPlayerId !== undefined) this.currentPlayerId = state.currentPlayerId || '';
        if (state.turnOrder) this.turnOrder = state.turnOrder;
        if (state.turnStep != null) this.turnStep = Number(state.turnStep || 0);
        if (state.turnStartedAt != null) this.turnStartedAt = Number(state.turnStartedAt || 0);
        if (state.roundToken !== undefined) this.roundToken = state.roundToken || '';
        if (state.revealed !== undefined) this.revealed = !!state.revealed;
        if (state.revealedBy !== undefined) this.revealedBy = state.revealedBy || '';
        if (state.faceCounts) this.faceCounts = state.faceCounts;
        if (state.revealedDice) this.revealedDice = state.revealedDice;
        if (state.lastClaim !== undefined) this.lastClaim = sanitizeClaim(state.lastClaim, { withMeta: true });
        if (state.onesCalled !== undefined) this.onesCalled = !!state.onesCalled;
        if (state.actualClaimCount != null) this.actualClaimCount = Number(state.actualClaimCount || 0);
        if (state.claimWasTrue !== undefined) {
            this.claimWasTrue = state.claimWasTrue == null ? null : !!state.claimWasTrue;
        }
        if (state.roundLoserId !== undefined) this.roundLoserId = state.roundLoserId || '';
        if (state.matchWinnerId !== undefined) this.matchWinnerId = state.matchWinnerId || '';
    }

    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== 'liarsdice.hand') return;

        this._knownPrivateHands.set(data.participantId, {
            round: Number(data.round || 0),
            roundToken: data.roundToken || '',
            dice: sanitizeDice(data.dice),
            rolledAt: Number(data.rolledAt || Date.now())
        });
    }

    getPrivateDice(participantId) {
        if (!participantId) return null;

        if (game.user.isGM) {
            const gmEntry = this._privateHands.get(participantId);
            if (gmEntry?.roundToken === this.roundToken) return [...gmEntry.dice];
        }

        const known = this._knownPrivateHands.get(participantId);
        if (known?.roundToken !== this.roundToken) return null;
        return [...known.dice];
    }

    getVisibleDice(participantId) {
        const revealed = this.revealedDice?.[participantId];
        if (Array.isArray(revealed) && revealed.length) return [...revealed];
        return this.getPrivateDice(participantId);
    }

    handlePlayerAction(userId, action, data) {
        switch (action) {
            case 'makeClaim':
                return this._handleMakeClaim(userId, data);
            case 'open':
                return this._handleOpen(userId);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action) {
        switch (action) {
            case 'newRound':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                if (this.matchWinnerId) return { ok: false, reason: 'match-over' };
                this._beginRound();
                await this._broadcastState();
                return { ok: true };
            case 'newMatch':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                this._resetMatch();
                this._beginRound();
                await this._broadcastState();
                return { ok: true };
            case 'finishGame':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                return { ok: true };
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _handleMakeClaim(userId, data) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };
        if (!this._isActivePlayer(userId)) return { ok: false, reason: 'not-player' };

        const nextClaim = sanitizeClaim(data);
        if (!nextClaim) return { ok: false, reason: 'invalid-claim' };
        if (!isClaimHigher(nextClaim, this.lastClaim)) return { ok: false, reason: 'claim-too-low' };

        this.lastClaim = {
            ...nextClaim,
            userId,
            turnStep: Number(this.turnStep || 0),
            calledAt: Date.now()
        };

        if (nextClaim.face === 1) {
            this.onesCalled = true;
        }

        this._advanceTurn();
        this._broadcastState();
        return { ok: true };
    }

    _handleOpen(userId) {
        if (this._phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (userId !== this.currentPlayerId) return { ok: false, reason: 'not-current' };
        if (!this._isActivePlayer(userId)) return { ok: false, reason: 'not-player' };
        if (!this.lastClaim) return { ok: false, reason: 'no-claim' };
        if (userId === this.lastClaim.userId) return { ok: false, reason: 'self-open' };

        const revealedIds = this._getActivePlayerIds();
        this._revealAllDice(userId, revealedIds);
        this._resolveOpen(userId);
        this._broadcastState();
        return { ok: true };
    }

    _resetMatch() {
        this._clearTimers();
        this.bets = [];
        this.round = 0;
        this.roundStarterId = '';
        this.nextRoundStarterId = '';
        this.currentPlayerId = '';
        this.turnOrder = [];
        this.turnStep = 0;
        this.turnStartedAt = 0;
        this.roundToken = '';
        this.revealed = false;
        this.revealedBy = '';
        this.faceCounts = createFaceCounts();
        this.revealedDice = {};
        this.lastClaim = null;
        this.onesCalled = false;
        this.actualClaimCount = 0;
        this.claimWasTrue = null;
        this.roundLoserId = '';
        this.matchWinnerId = '';
        this.diceCounts = {};
        this._knownPrivateHands.clear();

        for (const userId of this._getAllPlayerIds()) {
            this.diceCounts[userId] = this.startingDice;
        }

        this._privateHands.clear();
    }

    _beginRound() {
        const activeIds = this._getActivePlayerIds();

        this.revealed = false;
        this.revealedBy = '';
        this.faceCounts = createFaceCounts();
        this.revealedDice = {};
        this.lastClaim = null;
        this.onesCalled = false;
        this.actualClaimCount = 0;
        this.claimWasTrue = null;
        this.roundLoserId = '';
        this.matchWinnerId = activeIds.length === 1 ? activeIds[0] : '';
        this.turnStep = 0;
        this.turnStartedAt = 0;

        if (activeIds.length <= 1) {
            this.currentPlayerId = '';
            this.turnOrder = [];
            this.roundStarterId = activeIds[0] || '';
            if (this._phase !== 'RESOLVING') {
                this._transition('RESOLVING');
            }
            return;
        }

        if (this._phase !== 'ROLLING') {
            this._transition('ROLLING');
        }

        this.round += 1;
        this.turnStartedAt = Date.now();
        this.roundToken = foundry.utils.randomID();
        this.roundStarterId = this._pickRoundStarter(activeIds);
        this.turnOrder = this._buildTurnOrder(this.roundStarterId, activeIds);
        this.currentPlayerId = this.turnOrder[0] || activeIds[0] || '';

        this._rollHands(activeIds);
        this._scheduleTurnStart();
        void this._dispatchPrivateHands(activeIds);
    }

    _scheduleTurnStart() {
        clearTimeout(this._rollingTimer);
        this._rollingTimer = setTimeout(() => this._enterTurnPhase(), ROLLING_TO_TURN_DELAY_MS);
    }

    _enterTurnPhase() {
        if (this._phase !== 'ROLLING') return;

        this._transition('PLAYER_TURNS');
        this.turnStartedAt = Date.now();
        this._broadcastState();
    }

    _rollHands(activeIds) {
        const activeSet = new Set(activeIds);
        this._privateHands.clear();

        for (const userId of activeIds) {
            const diceCount = Math.max(0, Number(this.diceCounts?.[userId] || 0));
            this._privateHands.set(userId, {
                round: this.round,
                roundToken: this.roundToken,
                dice: OutcomeInfluence.rollLiarsDice(this, userId, diceCount),
                rolledAt: Date.now()
            });
        }

        for (const userId of this._getAllPlayerIds()) {
            if (activeSet.has(userId)) continue;
            this._knownPrivateHands.delete(userId);
        }
    }

    async _dispatchPrivateHands(activeIds = this._getActivePlayerIds()) {
        const rolledAt = Date.now();
        const jobs = [];

        for (const userId of activeIds) {
            const hand = this._privateHands.get(userId);
            if (!hand) continue;

            hand.rolledAt = rolledAt;

            const payload = {
                sessionId: this.sessionId,
                type: 'liarsdice.hand',
                participantId: userId,
                round: this.round,
                roundToken: this.roundToken,
                dice: [...hand.dice],
                rolledAt
            };

            const participant = getParticipant(this, userId);
            const targetUserId = participant?.controllerId || null;
            const hostPreviewsBot = !targetUserId
                && participant?.type === 'bot'
                && game.user.isGM;

            if (targetUserId === game.user.id || hostPreviewsBot) {
                // 自分发只手动调 game + ui 两层，**不**走 ParlorManager._onPrivateUpdate——
                // 那条路在 socketlib 把 executeAsUser 回送给自己时会造成 ui 二次触发，
                // 直接表现就是开盅后自己的骰子又飞了一遍
                // 自动机器人没有 controllerId。这里若继续按真人私信规则走，主持端 UI 就收不到
                // liarsdice.hand，DSN 的播放入口也永远不会触发。机器人局只在主持端本地接住，
                // 不把私骰广播给其他旁观者。
                this._deliverPrivateHandLocally(payload);
                continue;
            }

            if (!targetUserId) continue;
            jobs.push(SocketManager.sendTo(SOCKET_EVENTS.GAME_PRIVATE_UPDATE, targetUserId, payload));
        }

        if (jobs.length) {
            await Promise.allSettled(jobs);
        }
    }

    _deliverPrivateHandLocally(payload) {
        this.handlePrivateUpdate(payload);
        const session = ParlorManager._sessions?.get?.(this.sessionId);
        if (!session?.ui) return;

        session.ui.gameInstance = session.game;
        session.ui.handlePrivateUpdate?.(payload);
    }

    _advanceTurn() {
        const activeIds = this._getActivePlayerIds();
        if (!activeIds.length) {
            this.currentPlayerId = '';
            this.turnOrder = [];
            return;
        }

        if (!this.turnOrder?.length) {
            this.turnOrder = this._buildTurnOrder(this.currentPlayerId || activeIds[0], activeIds);
        }

        const currentIndex = this.turnOrder.indexOf(this.currentPlayerId);
        const nextIndex = currentIndex >= 0
            ? (currentIndex + 1) % this.turnOrder.length
            : 0;

        this.currentPlayerId = this.turnOrder[nextIndex] || activeIds[0] || '';
        this.turnStep = Number(this.turnStep || 0) + 1;
        this.turnStartedAt = Date.now();
    }

    _revealAllDice(openedBy, participantIds = this._getActivePlayerIds()) {
        this._clearTimers();

        if (this._phase !== 'RESOLVING') {
            this._transition('RESOLVING');
        }

        this.revealed = true;
        this.revealedBy = openedBy || '';
        this.faceCounts = createFaceCounts();
        this.revealedDice = {};
        this.currentPlayerId = '';
        this.turnOrder = [];
        this.turnStep = 0;
        this.turnStartedAt = 0;

        for (const userId of participantIds) {
            const hand = this._privateHands.get(userId);
            const dice = hand?.roundToken === this.roundToken ? hand.dice : [];
            this.revealedDice[userId] = [...dice];

            for (const face of dice) {
                this.faceCounts[face] = Number(this.faceCounts[face] || 0) + 1;
            }
        }
    }

    _resolveOpen(openedBy) {
        const claim = this.lastClaim;
        if (!claim) return;

        const actualCount = getClaimActualCount(this.faceCounts, claim, this.onesCalled);
        const claimWasTrue = actualCount >= Number(claim.quantity || 0);
        const loserId = claimWasTrue ? openedBy : claim.userId;

        this.actualClaimCount = actualCount;
        this.claimWasTrue = claimWasTrue;
        this.roundLoserId = loserId || '';

        if (loserId) {
            const currentDice = Math.max(0, Number(this.diceCounts?.[loserId] || 0));
            this.diceCounts[loserId] = Math.max(0, currentDice - 1);
        }

        const remainingIds = this._getActivePlayerIds();
        this.matchWinnerId = remainingIds.length === 1 ? remainingIds[0] : '';
        this.nextRoundStarterId = this.matchWinnerId ? '' : this._pickNextRoundStarter(loserId);
    }

    _pickRoundStarter(activeIds) {
        if (!activeIds.length) return '';

        if (this.nextRoundStarterId && activeIds.includes(this.nextRoundStarterId)) {
            const starterId = this.nextRoundStarterId;
            this.nextRoundStarterId = '';
            return starterId;
        }

        this.nextRoundStarterId = '';
        return activeIds[Math.floor(Math.random() * activeIds.length)] || activeIds[0];
    }

    _pickNextRoundStarter(loserId) {
        const activeIds = this._getActivePlayerIds();
        if (!activeIds.length) return '';
        if (activeIds.includes(loserId)) return loserId;

        const baseOrder = this._getAllPlayerIds();
        const loserIndex = baseOrder.indexOf(loserId);
        if (loserIndex < 0) return activeIds[0] || '';

        for (let offset = 1; offset <= baseOrder.length; offset += 1) {
            const candidate = baseOrder[(loserIndex + offset) % baseOrder.length];
            if (activeIds.includes(candidate)) return candidate;
        }

        return activeIds[0] || '';
    }

    _buildTurnOrder(starterId, activeIds = this._getActivePlayerIds()) {
        const baseOrder = this.participants
            .map(entry => entry.id)
            .filter(id => activeIds.includes(id));

        const order = baseOrder.length ? baseOrder : activeIds.slice();
        const startIndex = order.indexOf(starterId);
        if (startIndex < 0) return order;
        return [...order.slice(startIndex), ...order.slice(0, startIndex)];
    }

    _getAllPlayerIds() {
        return [...this.playerIds].filter(Boolean);
    }

    _getActivePlayerIds() {
        return this._getAllPlayerIds().filter(userId => Number(this.diceCounts?.[userId] || 0) > 0);
    }

    _isActivePlayer(userId) {
        return this._getActivePlayerIds().includes(userId);
    }

    _clearTimers() {
        clearTimeout(this._rollingTimer);
        this._rollingTimer = null;
    }
}
