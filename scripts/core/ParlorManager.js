/**
 * ParlorManager — 游戏 Session 管理器（MVP 版）
 * 管理活跃游戏实例，路由 Socket 事件，驱动测试机器人。
 */

import { SocketManager, SOCKET_EVENTS } from './SocketManager.js';
import { createGameInstance, createGameUI, getGameConfig } from './GameRegistry.js';
import { BotManager } from './BotManager.js';
import { getParticipants } from './ParticipantRoster.js';

const MODULE_ID = 'parlor';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export class ParlorManager {
    /** @type {Map<string, {game, ui, isHostGM, hostGMUserId}>} */
    static _sessions = new Map();
    static _initialized = false;
    static _pendingStateUpdates = new Map();
    static _pendingPrivateUpdates = new Map();
    static _pendingPrivateStartOptions = new Map();
    static _hiddenSessionIds = new Set();
    static _returnDockNodes = new Map();

    static initialize() {
        if (this._initialized) return;
        SocketManager.on(SOCKET_EVENTS.START_GAME, (data) => this._onStartGame(data));
        SocketManager.on(SOCKET_EVENTS.END_GAME, (data) => this._onEndGame(data));
        SocketManager.on(SOCKET_EVENTS.GAME_STATE_UPDATE, (data) => this._onStateUpdate(data));
        SocketManager.on(SOCKET_EVENTS.GAME_PRIVATE_UPDATE, (data) => this._onPrivateUpdate(data));
        SocketManager.on(SOCKET_EVENTS.PLAYER_ACTION, (data) => this._onPlayerAction(data));
        SocketManager.on(SOCKET_EVENTS.GM_ACTION, (data) => this._onGMAction(data));
        this._initialized = true;
        console.log(`${MODULE_ID} | ParlorManager initialized`);
    }

    /**
     * GM 开始新游戏
     */
    static async startGame(gameType, participants = [], isPublic = false, dealerProfile = null, gameOptions = null, gmOnlyOptions = null) {
        if (!game.user.isGM) return;

        if (this.hasActiveSessions()) {
            this.notifyActiveSessionRunning();
            return false;
        }

        const sessionId = foundry.utils.randomID();
        const safeParticipants = getParticipants(participants);
        if (gmOnlyOptions && Object.keys(gmOnlyOptions).length) {
            this._pendingPrivateStartOptions.set(sessionId, gmOnlyOptions);
        }
        await SocketManager.broadcast(SOCKET_EVENTS.START_GAME, {
            sessionId, gameType,
            playerIds: safeParticipants.map(entry => entry.id),
            participants: safeParticipants,
            dealerProfile,
            gameOptions,
            isPublic,
            hostGMUserId: game.user.id
        });
        return true;
    }

    /** 所有客户端收到 START_GAME 时 */
    static async _onStartGame(data) {
        const { sessionId, gameType, playerIds, participants = [], dealerProfile = null, gameOptions = null, isPublic, hostGMUserId = null } = data;
        const isHostGM = game.user.isGM && (!hostGMUserId || game.user.id === hostGMUserId);
        const gmOnlyOptions = isHostGM
            ? (this._pendingPrivateStartOptions.get(sessionId) || null)
            : null;
        this._pendingPrivateStartOptions.delete(sessionId);

        for (const existingSessionId of [...this._sessions.keys()]) {
            if (existingSessionId === sessionId) continue;
            this._onEndGame({ sessionId: existingSessionId });
        }

        const gameInstance = await createGameInstance(gameType, {
            sessionId, playerIds, participants, dealerProfile, gameOptions, isPublic, gmOnlyOptions
        });

        const myId = game.user.id;
        const isPlayer = participants.some(entry => entry.controllerId === myId);
        const isGM = game.user.isGM;
        const shouldShowUI = isPlayer || isGM || isPublic;

        // 先把 session 占上，别让开局第一包状态在 UI import 期间直接丢了。
        const session = { game: gameInstance, ui: null, isHostGM, hostGMUserId };
        this._sessions.set(sessionId, session);
        this._replayPendingSessionUpdates(sessionId, session);

        if (shouldShowUI) {
            const ui = await createGameUI(gameType, gameInstance);
            ui._requestParlorClose = () => this.requestSessionClose(sessionId);
            ui._requestParlorLocalLeave = () => this.leaveSessionTemporarily(sessionId);
            session.ui = ui;
            ui.render(true);
        }

        // 主持人这边收到开局后，直接把第一轮带起来。
        if (isHostGM) {
            await gameInstance.start();
            await gameInstance._broadcastState();
            // 开局后如果桌上有测试机器人，这里顺手点火。
            this._triggerBots(sessionId);
        }
    }

    /** GM 结束游戏 */
    static async endGame(sessionId, { settleBeforeEnd = true } = {}) {
        if (!game.user.isGM) return;
        if (settleBeforeEnd) {
            await this._settleGameBeforeEnd(sessionId);
        }
        await SocketManager.broadcast(SOCKET_EVENTS.END_GAME, { sessionId });
    }

    static async _settleGameBeforeEnd(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session?.game || typeof session.game.handleGMAction !== 'function') return;

        try {
            await session.game.handleGMAction('finishGame', { reason: 'end-game' });
        } catch (err) {
            console.warn(`${MODULE_ID} | Failed to settle game before end`, err);
        }
    }

    static async requestSessionClose(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session?.ui) return false;

        const isGM = game.user.isGM;
        const action = await foundry.applications.api.DialogV2.wait({
            window: {
                title: t('PARLOR.ClosePrompt.Title')
            },
            content: `
                <div class="parlor-confirm-text">
                    ${isGM ? t('PARLOR.ClosePrompt.GMBody') : t('PARLOR.ClosePrompt.PlayerBody')}
                </div>
            `,
            render: (_event, dialog) => this._liftDialogAboveTables(dialog),
            buttons: isGM
                ? [
                    {
                        action: 'leave',
                        label: t('PARLOR.ClosePrompt.GMLeave'),
                        icon: 'fas fa-door-open',
                        default: true,
                        callback: () => 'leave'
                    },
                    {
                        action: 'disband',
                        label: t('PARLOR.ClosePrompt.GMDisband'),
                        icon: 'fas fa-ban',
                        callback: () => 'disband'
                    },
                    {
                        action: 'cancel',
                        label: t('PARLOR.Common.Cancel'),
                        callback: () => false
                    }
                ]
                : [
                    {
                        action: 'leave',
                        label: t('PARLOR.ClosePrompt.PlayerConfirm'),
                        icon: 'fas fa-door-open',
                        default: true,
                        callback: () => 'leave'
                    },
                    {
                        action: 'cancel',
                        label: t('PARLOR.Common.Cancel'),
                        callback: () => false
                    }
                ],
            rejectClose: false
        });

        if (!action) return false;

        if (action === 'disband') {
            await this.endGame(sessionId);
            return true;
        }

        if (action === 'leave') {
            return this.leaveSessionTemporarily(sessionId);
        }

        return false;
    }

    static _liftDialogAboveTables(dialog) {
        const root = dialog?.element ?? dialog;
        if (!root) return;

        const apply = () => {
            root.classList?.add('parlor-overlay-dialog');
            root.style.zIndex = '3200';
        };

        apply();
        requestAnimationFrame(apply);
        window.setTimeout(apply, 60);
    }

    static leaveSessionTemporarily(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session?.ui) return false;

        this._hiddenSessionIds.add(sessionId);
        session.ui.close?.();
        this._renderReturnDock(sessionId);
        return true;
    }

    static restoreSession(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session?.ui) return false;

        this._hiddenSessionIds.delete(sessionId);
        this._removeReturnDock(sessionId);
        session.ui.gameInstance = session.game;
        session.ui.render?.(true);
        return true;
    }

    static hasActiveSessions() {
        return this._sessions.size > 0;
    }

    static notifyActiveSessionRunning() {
        if (!this.hasActiveSessions()) return false;

        ui.notifications?.warn(t('PARLOR.Session.AlreadyRunning'));
        for (const sessionId of this._hiddenSessionIds) {
            this._renderReturnDock(sessionId);
        }
        return true;
    }

    static _renderReturnDock(sessionId) {
        const session = this._sessions.get(sessionId);
        if (!session?.ui || !this._hiddenSessionIds.has(sessionId)) {
            this._removeReturnDock(sessionId);
            return;
        }

        const state = session.game.getState?.() || {};
        const gameLabel = this._getSessionGameLabel(state);
        const round = Math.max(0, Number(state.round || 0));
        const escape = (value) => foundry.utils.escapeHTML(String(value ?? ''));
        let dock = this._returnDockNodes.get(sessionId);

        if (!dock) {
            dock = document.createElement('button');
            dock.type = 'button';
            dock.className = 'parlor-return-dock';
            dock.dataset.sessionId = sessionId;
            dock.addEventListener('click', () => this.restoreSession(sessionId));
            document.body.appendChild(dock);
            this._returnDockNodes.set(sessionId, dock);
        }

        const offsetIndex = Math.max(0, [...this._hiddenSessionIds].indexOf(sessionId));
        dock.style.bottom = `${24 + (offsetIndex * 86)}px`;
        dock.innerHTML = `
            <span class="parlor-return-dock-icon"><i class="fas fa-dice"></i></span>
            <span class="parlor-return-dock-copy">
                <strong>${escape(t('PARLOR.SessionDock.Title'))}</strong>
                <span>${escape(t('PARLOR.SessionDock.Subtitle', { game: gameLabel, round }))}</span>
            </span>
            <span class="parlor-return-dock-action">${escape(t('PARLOR.SessionDock.Return'))}</span>
        `;
    }

    static _getSessionGameLabel(state) {
        const gameType = state?.gameType || '';
        return getGameConfig(gameType)?.nameText || gameType || t('PARLOR.SessionDock.UnknownGame');
    }

    static _removeReturnDock(sessionId) {
        this._returnDockNodes.get(sessionId)?.remove();
        this._returnDockNodes.delete(sessionId);
    }

    static _onEndGame({ sessionId }) {
        const session = this._sessions.get(sessionId);
        if (!session) {
            this._hiddenSessionIds.delete(sessionId);
            this._removeReturnDock(sessionId);
            return;
        }
        session.ui?.close();
        this._sessions.delete(sessionId);
        this._hiddenSessionIds.delete(sessionId);
        this._removeReturnDock(sessionId);
        this._pendingStateUpdates.delete(sessionId);
        this._pendingPrivateUpdates.delete(sessionId);
        this._pendingPrivateStartOptions.delete(sessionId);
        const timer = this._botTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this._botTimers.delete(sessionId);
        this._botRunning.delete(sessionId);
    }

    /** 状态更新 */
    static _onStateUpdate({ sessionId, state }) {
        const session = this._sessions.get(sessionId);
        if (!session) {
            this._pendingStateUpdates.set(sessionId, state);
            return;
        }

        const previousPhase = session.game.phase;
        session.game.setState(state);

        if (session.ui) {
            session.ui.gameInstance = session.game;
            session.ui.render();
        }

        if (this._hiddenSessionIds.has(sessionId)) {
            this._renderReturnDock(sessionId);
        } else {
            this._removeReturnDock(sessionId);
        }

        // 阶段一变，或者轮到测试机器人，就补一次调度。
        if (session.isHostGM) {
            const phaseChanged = state.phase !== previousPhase;
            const isBotTurn = state.phase === 'PLAYER_TURNS'
                && state.currentPlayerId && BotManager.isBot(state.currentPlayerId);
            const hasPendingBotWork = this._hasPendingBotWork(state);
            if (phaseChanged || isBotTurn || hasPendingBotWork) {
                this._triggerBots(sessionId);
            }
        }
    }

    /** 私有状态更新 */
    static _onPrivateUpdate(data) {
        const sessionId = data?.sessionId;
        if (!sessionId) return;

        const session = this._sessions.get(sessionId);
        if (!session) {
            this._rememberPendingPrivateUpdate(sessionId, data);
            return;
        }

        session.game.handlePrivateUpdate?.(data);

        if (session.ui) {
            session.ui.gameInstance = session.game;
            session.ui.handlePrivateUpdate?.(data);
            session.ui.render?.();
        }
    }

    static _rememberPendingPrivateUpdate(sessionId, data) {
        let bucket = this._pendingPrivateUpdates.get(sessionId);
        if (!bucket) {
            bucket = new Map();
            this._pendingPrivateUpdates.set(sessionId, bucket);
        }

        const key = `${data?.type || 'private'}:${data?.participantId || 'all'}`;
        bucket.set(key, data);
    }

    static _replayPendingSessionUpdates(sessionId, session) {
        if (!session?.game) return;

        const pendingState = this._pendingStateUpdates.get(sessionId);
        if (pendingState) {
            session.game.setState(pendingState);
            this._pendingStateUpdates.delete(sessionId);
        }

        const privateBucket = this._pendingPrivateUpdates.get(sessionId);
        if (!privateBucket?.size) return;

        for (const data of privateBucket.values()) {
            session.game.handlePrivateUpdate?.(data);
        }

        this._pendingPrivateUpdates.delete(sessionId);
    }

    static _resolveHostAuthority(session) {
        const fallbackHostId = session?.isHostGM ? game.user.id : '';
        const hostGMUserId = String(session?.hostGMUserId || fallbackHostId || '').trim();
        if (!hostGMUserId) return { ok: false, reason: 'host-unavailable' };

        const hostUser = hostGMUserId === game.user.id
            ? game.user
            : game.users?.get(hostGMUserId);
        if (!hostUser?.isGM || hostUser.active === false) {
            return { ok: false, reason: 'host-unavailable' };
        }

        return {
            ok: true,
            hostGMUserId,
            isHost: hostGMUserId === game.user.id
        };
    }

    /** 玩家操作（路由到开桌 host GM） */
    static async _onPlayerAction(payload) {
        if (!game.user.isGM) return { ok: false, reason: 'not-gm' };
        const { sessionId, userId, action, data } = payload;
        const session = this._sessions.get(sessionId);
        if (!session) return { ok: false, reason: 'session-missing' };

        const authority = this._resolveHostAuthority(session);
        if (!authority.ok) return authority;
        if (!authority.isHost) {
            return await SocketManager.sendTo(
                SOCKET_EVENTS.PLAYER_ACTION,
                authority.hostGMUserId,
                payload
            );
        }

        return session.game.handlePlayerAction(userId, action, data);
    }

    /** GM 操作同样只允许开桌 host 修改牌局 */
    static async _onGMAction(payload) {
        if (!game.user.isGM) return { ok: false, reason: 'not-gm' };
        const { sessionId, action, data } = payload;
        const session = this._sessions.get(sessionId);
        if (!session) return { ok: false, reason: 'session-missing' };

        const authority = this._resolveHostAuthority(session);
        if (!authority.ok) return authority;
        if (!authority.isHost) {
            return await SocketManager.sendTo(
                SOCKET_EVENTS.GM_ACTION,
                authority.hostGMUserId,
                payload
            );
        }

        const result = await session.game.handleGMAction(action, data);

        if (action === 'finishGame') {
            await this.endGame(sessionId, { settleBeforeEnd: false });
            return result;
        }

        // 主持人手动推进后，测试机器人可能也能继续走了。
        this._triggerBots(sessionId);
        return result;
    }

    /**
     * 触发机器人席位动作，顺手做一层防抖。
     */
    static _botTimers = new Map();
    static _botRunning = new Set();

    static _triggerBots(sessionId, delay = 800) {
        const currentTimer = this._botTimers.get(sessionId);
        if (currentTimer) clearTimeout(currentTimer);

        const timer = setTimeout(async () => {
            this._botTimers.delete(sessionId);
            const session = this._sessions.get(sessionId);
            if (!session) return;
            if (this._botRunning.has(sessionId)) {
                // 同一桌别并发跑两次；真还有事，稍后再补一轮。
                if (this._hasPendingBotWork(session.game)) {
                    this._triggerBots(sessionId, 260);
                }
                return;
            }

            const hasBots = [...session.game.playerIds].some(id => BotManager.isBot(id));
            if (!hasBots) return;
            if (!this._hasPendingBotWork(session.game)) return;

            try {
                this._botRunning.add(sessionId);
                await BotManager.executeBotActions(session.game);
                await session.game._broadcastState();
            } catch (e) {
                console.warn(`${MODULE_ID} | Bot execution error:`, e);
            } finally {
                this._botRunning.delete(sessionId);
            }

            // 有些桌一轮只推进一步，这里留个短延迟续上。
            if (this._hasPendingBotWork(session.game)) {
                this._triggerBots(sessionId, 320);
            }
        }, delay);

        this._botTimers.set(sessionId, timer);
    }

    static _hasPendingBotWork(gameOrState) {
        const state = typeof gameOrState?.getState === 'function'
            ? gameOrState.getState()
            : gameOrState;
        if (!state) return false;

        const botIds = (state.playerIds || []).filter(id => BotManager.isBot(id));
        if (!botIds.length) return false;

        if (state.phase === 'BETTING') {
            const bettedIds = new Set((state.bets || []).map(entry => entry.userId));
            return botIds.some(id => !bettedIds.has(id));
        }

        if (state.phase === 'DECISION') {
            return botIds.some(id => state.playerStates?.[id]?.decision === 'pending');
        }

        if (state.phase === 'PLAYER_TURNS') {
            const currentId = state.currentPlayerId;
            if (!currentId || !BotManager.isBot(currentId)) return false;

            if (state.gameType === 'liarsdice') {
                return !state.revealed && Number(state.diceCounts?.[currentId] || 0) > 0;
            }

            if (state.gameType === 'blackjack') {
                const handStatus = state.playerHands?.[currentId]?.status;
                // 要牌后得等主持人真的把牌发下来，这期间不能让调度器空转刷状态。
                return ['playing', 'awaiting_collect'].includes(handStatus);
            }

            if (state.gameType === 'bone21') {
                return state.playerStates?.[currentId]?.status === 'playing';
            }

            if (state.gameType === 'texasholdem') {
                return state.playerStates?.[currentId]?.status === 'active';
            }

            return true;
        }

        return false;
    }

    static getSession(sessionId) {
        return this._sessions.get(sessionId);
    }

    static refreshOpenTables({ rebuild = false } = {}) {
        for (const { ui } of this._sessions.values()) {
            if (!ui) continue;

            const isOverlayUi = Object.prototype.hasOwnProperty.call(ui, '_overlay');
            const isOpen = isOverlayUi
                ? !!ui._overlay
                : !!(ui.rendered || ui.element?.isConnected);
            if (!isOpen) continue;

            try {
                // V14 兼容优先：SVG 里的贴图路径是写死在 DOM 里的，换材质时得整桌重建。
                if (rebuild && isOverlayUi && typeof ui.close === 'function') {
                    ui.close({ dismiss: false });
                }
                ui.render?.(true);
            } catch (err) {
                console.warn(`${MODULE_ID} | Failed to refresh open table`, err);
            }
        }
    }
}
