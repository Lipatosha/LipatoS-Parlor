/**
 * 骨骰二十一桌面覆盖层
 *
 * 所有骰子都是公开信息，界面只负责让当前席位补骰或停手。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { BotManager } from '../../core/BotManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantName
} from '../../core/ParticipantRoster.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { Dsn3dBridge } from '../../core/Dsn3dBridge.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import {
    buildBone21Hud,
    buildBone21SeatEntries,
    buildBone21Status
} from './Bone21PresenterData.js';

const ACTION_LOCK_MS = 420;
const MAX_SIDE_SEATS = 5;
const DEFAULT_ANTE = 10;
const BUST_LIMIT = 21;
const DIE_PIPS = Object.freeze({
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
});

export class Bone21Table {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._dismissedByUser = false;
        this._selectedParticipantId = '';
        this._actionRequests = new Map();
        // DM 在中央面板输入的本轮底注，本机暂存
        this._anteDraft = DEFAULT_ANTE;
        // DSN 状态跟踪：第一次拿到状态时只记快照，后续才比对触发动画，避免重连/重开重播旧骰子
        this._dsnInitialized = false;
        this._dsnLastPhase = '';
        this._dsnSeatSignatures = new Map();
        // 每个 seat 在 DSN 没落定前最多展示几颗 HTML 骰子；不在表中 = 不锁
        this._dsnDisplayLimits = new Map();
        // DSN 还有 seat 在锁的时候，currentPlayerId 显示也跟着冻结——
        // 不然爆骰后镜头瞬间切到下家，但上一家的骰子还在飞
        this._displayedCurrentPlayerId = '';
        this._viewportFit = null;
        this._onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
        };
    }

    get sessionId() { return this.gameInstance.sessionId; }

    render(force) {
        if (force) this._dismissedByUser = false;
        if (this._dismissedByUser) return;
        this.open();
    }

    open() {
        if (this._dismissedByUser) return;
        const themeId = ParlorAppearance.getActiveThemeId();
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:bone21');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:bone21')) {
            this._openPresenter(PresenterClass, themeId);
            return;
        }
        this._openNative();
    }

    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) {
            this.refresh();
            return;
        }

        document.querySelectorAll('#parlor-b21-overlay').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-b21-layout'
        });
        this._viewportFit.attach();
        // 把 DSN 画布抬到 overlay 之上，免得 3D 骰子被牌桌挡住
        Dsn3dBridge.attachOverlay(`b21:${this.sessionId}`);
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (this._presenterHost) {
            if (dismiss) this._dismissedByUser = true;
            this._presenterHost.destroy();
            this._presenterHost = null;
            // DSN 跟踪与画布层照原生 close 清干净,下一桌不沿用旧状态
            this._dsnInitialized = false;
            this._dsnLastPhase = '';
            this._dsnSeatSignatures.clear();
            this._dsnDisplayLimits.clear();
            this._displayedCurrentPlayerId = '';
            Dsn3dBridge.detachOverlay(`b21:${this.sessionId}`);
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-b21-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        // 关桌就重置 DSN 跟踪，避免下一桌沿用旧 phase 起手就乱播
        this._dsnInitialized = false;
        this._dsnLastPhase = '';
        this._dsnSeatSignatures.clear();
        this._dsnDisplayLimits.clear();
        this._displayedCurrentPlayerId = '';
        Dsn3dBridge.detachOverlay(`b21:${this.sessionId}`);
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            // DSN 3D 骰子归本体(契约 §6):主题模式下照播,呈现器只画落定后的静态骰
            this._maybePlayDsn(state);
            this._presenterHost.refresh(state);
            // 骨骰21 没有挂在 body 下的本体结算层，所以这里不能照纸牌桌调用 _syncSettlement。
            // 酒馆的遮罩归 presenter 自己管理；遮罩会盖住 HUD，GM 按钮也必须跟着放进遮罩里。
            return;
        }
        this._refreshNative();
    }

    _openPresenter(PresenterClass, themeId) {
        if (this._presenterHost) {
            this._presenterHost.refresh(this.gameInstance.getState());
            return;
        }

        if (this._overlay) this._closeNative({ dismiss: false });

        let host = null;
        host = new PresenterHost({
            surface: 'table:bone21',
            hostId: 'parlor-b21-presenter',
            themeId,
            gameApi: this._createPresenterGameApi(),
            PresenterClass,
            onFallback: () => {
                if (this._presenterHost === host) this._presenterHost = null;
                this._openNative();
            }
        });
        this._presenterHost = host;
        // DSN 画布抬到呈现器之上,3D 骰子在酒馆桌照飞
        Dsn3dBridge.attachOverlay(`b21:${this.sessionId}`);
        host.open(this.gameInstance.getState());
    }

    _createPresenterGameApi() {
        const getState = () => this.gameInstance.getState();
        return Object.freeze({
            getState,
            getSeats: () => buildBone21SeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildBone21Status(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildBone21Hud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => {
                const state = getState();
                const targetId = participantId || this._getSelectedParticipantId(state) || '';
                return { participantId: targetId, dice: targetId ? (this.gameInstance.getVisibleDice?.(targetId) || []) : [] };
            },
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            renderCard: (card, options = {}) => CardRenderer.createCard(card, options),
            playSound: (kind) => ParlorAppearance.playCardSound(kind),
            formatChips: (amount) => `${Number(amount || 0)}`,
            getTableBackdrop: () => ParlorAppearance.getTableBackdrop?.() ?? null,
            getTableDeck: () => TableDecks.getActive(),
            openPopup: () => null,
            // 不能直接拆 presenter root，否则活 session 还占着大厅，下一局会被误判成“已有游戏”。
            requestClose: () => this._requestParlorClose?.() ?? this.close(),
            t: (key, data) => this._t(key, data)
        });
    }

    _getPresenterDataHelpers() {
        return {
            t: (key, data) => this._t(key, data),
            formatChips: (amount) => `${Number(amount || 0)}`,
            getParticipantName: (state, participantId) => getParticipantName(state, participantId),
            getDisplayParticipant: (state, participantId) => getDisplayParticipant(state, participantId),
            // GM 可代操全部活跃玩家(照原生 _getSelectableParticipantIds 的语义)
            getControlledParticipantIds: (state) => this._getSelectableParticipantIds(state),
            resolveSelectedParticipantId: (state) => this._getSelectedParticipantId(state),
            isGM: () => game.user.isGM,
            getBalance: (participantId) => ChipManager.getDisplayBalance(participantId),
            getVisibleDice: (participantId) => this.gameInstance.getVisibleDice?.(participantId) || [],
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    // 动作路由:GM 推进走 _requestGMAction,玩家 roll/stand 走 _requestPlayerAction(复用原生封装)
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['setAnte', 'newRound', 'finishGame']);
        if (gmActions.has(safeAction)) {
            const payload = { ...(data || {}) };
            delete payload.gm;
            delete payload.button;
            delete payload.participantId;
            return this._requestGMAction({ action: safeAction, data: payload });
        }

        const state = this.gameInstance.getState();
        const participantId = String(data?.participantId || this._getSelectedParticipantId(state) || '');
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });
        if (data?.participantId) this._selectedParticipantId = String(data.participantId);

        return this._requestPlayerAction({ userId: participantId, action: safeAction });
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._maybePlayDsn(state);

        // DSN 还有 seat 没落定 → 镜头/footer/turnOrder 全部按上一次稳定状态走；
        // 全部落定再放行——避免"骰子还在飞，下家的回合已经显示出来"的撕裂感
        let effectiveState = state;
        if (this._dsnDisplayLimits.size === 0) {
            this._displayedCurrentPlayerId = state.currentPlayerId || '';
        } else if (this._displayedCurrentPlayerId !== state.currentPlayerId) {
            effectiveState = { ...state, currentPlayerId: this._displayedCurrentPlayerId };
        }

        this._renderCenter(effectiveState);
        this._renderSeats(effectiveState);
        this._renderFooter(effectiveState);
        this._viewportFit?.update();
    }

    /** 本机收到自己/代管角色的初始私骰：直接播 DSN，跟说谎骰一个套路 */
    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== 'bone21.initial') return;

        const dice = Array.isArray(data.dice) ? data.dice : [];
        if (dice.length && Dsn3dBridge.isAvailable()) {
            const state = this.gameInstance.getState();
            const ownerUserId = this._getDsnOwnerUserId(state, data.participantId);
            // lock=0：DSN 飞期间 HTML 私骰先藏住，飞完再揭
            this._dsnDisplayLimits.set(data.participantId, 0);
            const lockedLimit = 0;
            Promise.resolve().then(() => {
                return Dsn3dBridge.rollD6Visuals(dice, { ownerUserId });
            }).finally(() => {
                if (this._dsnDisplayLimits.get(data.participantId) === lockedLimit) {
                    this._dsnDisplayLimits.delete(data.participantId);
                }
                if (this._overlay) this.refresh();
            });
        }

        if (this._overlay) this.refresh();
    }

    _maybePlayDsn(state) {
        // 只管加骰：私骰走 handlePrivateUpdate 直接触发，不靠 refresh 检测
        if (!Dsn3dBridge.isAvailable()) {
            this._captureDsnSignatures(state);
            this._dsnLastPhase = state.phase || '';
            this._dsnInitialized = true;
            return;
        }

        const phase = state.phase || '';
        const wasInitialized = this._dsnInitialized;

        if (wasInitialized && phase === 'PLAYER_TURNS') {
            // 加骰是公骰——所有客户端都飞那一颗；用 playerStates.dice 的 +1 增量识别
            for (const userId of state.playerIds || []) {
                const current = state.playerStates?.[userId]?.dice || [];
                const previous = this._dsnSeatSignatures.get(userId) || [];
                if (current.length === previous.length + 1) {
                    const lastValue = current[current.length - 1];
                    if (!lastValue) continue;
                    // 截断到加骰前的可见长度，藏住新那颗：
                    // 自己控制时 visible 包含私骰 3 颗（已被 handlePrivateUpdate 解锁），别人只有旧加骰
                    const currentVisibleLength = this.gameInstance.getVisibleDice(userId).length;
                    this._playSeatDsn(state, userId, [lastValue], Math.max(0, currentVisibleLength - 1));
                }
            }
        }

        this._captureDsnSignatures(state);
        this._dsnLastPhase = phase;
        this._dsnInitialized = true;
    }

    _playSeatDsn(state, userId, dice, lockedLimit) {
        const ownerUserId = this._getDsnOwnerUserId(state, userId);
        this._dsnDisplayLimits.set(userId, lockedLimit);
        // 立刻刷一遍——把刚收到的那一颗（或那 3 颗）藏起来，等 DSN 落定再揭示
        Promise.resolve().then(() => {
            return Dsn3dBridge.rollD6Visuals(dice, { ownerUserId });
        }).finally(() => {
            // 中途被新一次 lock 改了就别回退；只清自己设过的
            if (this._dsnDisplayLimits.get(userId) === lockedLimit) {
                this._dsnDisplayLimits.delete(userId);
            }
            if (this._overlay) this.refresh();
        });
    }

    _getDsnOwnerUserId(state, participantId) {
        const participant = (state.participants || []).find(entry => entry.id === participantId);
        return participant?.controllerId || participant?.userId || null;
    }

    /** 拿到本机能展示的 dice：先走 game 的可见性判断，再叠上 DSN lock 截断 */
    _getVisibleSeatDice(userId) {
        const dice = this.gameInstance.getVisibleDice(userId);
        if (!this._dsnDisplayLimits.has(userId)) return dice;
        const limit = Math.max(0, Number(this._dsnDisplayLimits.get(userId)) || 0);
        return dice.slice(0, limit);
    }

    /** 本机能展示的 total；null 表示"私骰看不见，整桌总分不可知" */
    _getVisibleSeatTotal(userId) {
        // DSN lock 中，total 按可见 dice 临时算，保持跟画面一致
        if (this._dsnDisplayLimits.has(userId)) {
            const visible = this._getVisibleSeatDice(userId);
            return visible.reduce((sum, value) => sum + Math.max(1, Math.min(6, Number(value) || 0)), 0);
        }
        return this.gameInstance.getVisibleTotal(userId);
    }

    _captureDsnSignatures(state) {
        // 只追加骰部分——它就是 playerStates.dice，私骰不在里面
        this._dsnSeatSignatures.clear();
        for (const userId of state.playerIds || []) {
            const dice = state.playerStates?.[userId]?.dice || [];
            this._dsnSeatSignatures.set(userId, [...dice]);
        }
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-b21-overlay';
        overlay.innerHTML = `
            <div class="parlor-b21-backdrop"></div>
            <div class="parlor-b21-layout">
                <div class="parlor-b21-seat-column seat-column-left" id="b21-seat-left"></div>
                <div class="parlor-b21-scene">
                    <div class="parlor-b21-table">
                        <div class="parlor-b21-table-shell">
                            <div class="parlor-b21-badge"><i class="fas fa-dice-d20"></i> ${this._t('PARLOR.Games.Bone21.Name')}</div>
                            <div class="parlor-b21-center" id="b21-center"></div>
                            <div class="parlor-b21-footer-wrap" id="b21-footer"></div>
                        </div>
                    </div>
                </div>
                <div class="parlor-b21-seat-column seat-column-right" id="b21-seat-right"></div>
            </div>
            <button class="parlor-b21-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-b21-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-b21-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });

        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#b21-center');
        if (!center) return;

        const pot = this._getPot(state);
        const currentName = state.currentPlayerId
            ? this._playerName(state, state.currentPlayerId)
            : this._t('PARLOR.Common.Waiting');
        const phaseLabel = this._getPhaseLabel(state.phase);
        const title = this._getCenterTitle(state, currentName);
        const sub = this._getCenterSub(state, currentName);
        const note = this._getCenterNote(state);
        const actionsHtml = this._buildCenterActions(state);

        center.innerHTML = `
            <div class="parlor-b21-panel">
                <div class="parlor-b21-panel-head">
                    <div class="parlor-b21-panel-phase">${phaseLabel}</div>
                    <div class="parlor-b21-panel-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round || 0 })}</div>
                </div>
                <div class="parlor-b21-score-strip">
                    <div class="parlor-b21-score-goal">
                        <span>${this._t('PARLOR.Bone21.Label.Target')}</span>
                        <strong>${BUST_LIMIT}</strong>
                    </div>
                    ${this._buildTurnOrder(state)}
                </div>
                <div class="parlor-b21-panel-title">${this._escape(title)}</div>
                <div class="parlor-b21-panel-sub">${this._escape(sub)}</div>
                <div class="parlor-b21-panel-stats">
                    <div class="parlor-b21-stat">
                        <span>${this._t('PARLOR.Common.TablePot')}</span>
                        <strong>${pot}</strong>
                    </div>
                    <div class="parlor-b21-stat">
                        <span>${this._t('PARLOR.Bone21.Label.Ante')}</span>
                        <strong>${state.roundAnte || '-'}</strong>
                    </div>
                    <div class="parlor-b21-stat is-current">
                        <span>${this._t('PARLOR.Common.CurrentParticipant')}</span>
                        <strong>${this._escape(currentName)}</strong>
                    </div>
                </div>
                ${state.phase === 'RESOLVING' ? this._buildResolution(state) : ''}
                ${actionsHtml}
                ${note ? `<div class="parlor-b21-panel-note">${this._escape(note)}</div>` : ''}
            </div>
        `;

        center.querySelector('#b21-new-round')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'newRound', button: event.currentTarget });
        });
        center.querySelector('#b21-finish-game')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'finishGame', button: event.currentTarget });
        });
        center.querySelector('#b21-ante-input')?.addEventListener('input', (event) => {
            const value = Math.max(1, Math.floor(Number(event.currentTarget.value || 0)) || DEFAULT_ANTE);
            this._anteDraft = value;
        });
        center.querySelector('#b21-start-round')?.addEventListener('click', (event) => {
            const input = center.querySelector('#b21-ante-input');
            const amount = Math.max(1, Math.floor(Number(input?.value || 0)) || DEFAULT_ANTE);
            this._anteDraft = amount;
            this._requestGMAction({
                action: 'setAnte',
                data: { amount },
                button: event.currentTarget
            });
        });
    }

    _renderSeats(state) {
        const ids = state.playerIds || [];
        const left = this._overlay.querySelector('#b21-seat-left');
        const right = this._overlay.querySelector('#b21-seat-right');
        if (!left || !right) return;

        const visibleIds = ids.slice(0, MAX_SIDE_SEATS * 2);
        const midpoint = Math.ceil(visibleIds.length / 2);
        left.innerHTML = visibleIds.slice(0, midpoint).map(id => this._buildSeat(state, id)).join('');
        right.innerHTML = visibleIds.slice(midpoint).map(id => this._buildSeat(state, id)).join('');
    }

    _buildSeat(state, userId) {
        const participant = this._describeParticipant(state, userId);
        const seat = state.playerStates?.[userId] || null;
        const status = this._getSeatStatus(state, userId);
        const note = this._getSeatNote(state, userId);
        // 可见 dice / total：私骰本机看不见的话会自动隐藏
        const dice = this._getVisibleSeatDice(userId);
        const visibleTotal = this._getVisibleSeatTotal(userId);
        const totalText = seat ? (visibleTotal === null ? '?' : String(visibleTotal)) : '-';
        const diceHtml = dice.length
            ? this._buildDiceRow(dice, { small: true })
            : (seat ? this._buildHiddenDicePlaceholder() : this._buildDicePlaceholder());
        const isCurrent = state.currentPlayerId === userId;
        const classes = [
            'parlor-seat-card',
            'parlor-b21-seat',
            isCurrent ? 'is-current' : '',
            status.className || ''
        ].filter(Boolean).join(' ');

        return `
            <div class="${classes}">
                <div class="parlor-b21-seat-top">
                    <div class="parlor-b21-avatar">${participant.avatarHtml}</div>
                    <div class="parlor-b21-seat-main">
                        <div class="parlor-b21-seat-name">${this._escape(participant.name)}</div>
                        <div class="parlor-b21-seat-owner">${this._escape(participant.ownerName || '')}</div>
                    </div>
                    <div class="parlor-b21-seat-total">${totalText}</div>
                </div>
                <div class="parlor-b21-seat-status">${this._escape(status.text)}</div>
                <div class="parlor-b21-seat-dice">${diceHtml}</div>
                <div class="parlor-b21-seat-note">${this._escape(note)}</div>
            </div>
        `;
    }

    _renderFooter(state) {
        const footer = this._overlay.querySelector('#b21-footer');
        if (!footer) return;

        const selectableIds = this._getSelectableParticipantIds(state);
        const selectedId = this._getSelectedParticipantId(state);
        const selectedName = selectedId ? this._playerName(state, selectedId) : this._t('PARLOR.Common.Spectating');
        const selectedSeat = state.playerStates?.[selectedId] || null;
        const optionsHtml = selectableIds.map(id => `
            <option value="${id}" ${id === selectedId ? 'selected' : ''}>${this._escape(this._playerName(state, id))}</option>
        `).join('');
        const controlsHtml = this._buildFooterControls(state, selectedId, selectedSeat);
        const note = this._getFooterNote(state, selectedId, selectedSeat);

        footer.innerHTML = `
            <div class="parlor-b21-footer">
                <div class="parlor-b21-footer-head">
                    <div>
                        <span>${this._t('PARLOR.Common.CurrentParticipant')}</span>
                        <strong>${this._escape(selectedName)}</strong>
                    </div>
                    ${selectableIds.length > 1 ? `
                        <select id="b21-footer-select">${optionsHtml}</select>
                    ` : ''}
                </div>
                ${selectedSeat ? `<div class="parlor-b21-footer-dice">${(() => {
                    const visible = this._getVisibleSeatDice(selectedId);
                    return visible.length ? this._buildDiceRow(visible) : this._buildHiddenDicePlaceholder();
                })()}</div>` : ''}
                <div class="parlor-b21-footer-actions">${controlsHtml}</div>
                ${note ? `<div class="parlor-b21-footer-note">${this._escape(note)}</div>` : ''}
            </div>
        `;

        footer.querySelector('#b21-footer-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            this.refresh();
        });
        footer.querySelector('#b21-roll')?.addEventListener('click', (event) => {
            this._requestPlayerAction({
                userId: selectedId,
                action: 'roll',
                button: event.currentTarget
            });
        });
        footer.querySelector('#b21-stand')?.addEventListener('click', (event) => {
            this._requestPlayerAction({
                userId: selectedId,
                action: 'stand',
                button: event.currentTarget
            });
        });
    }

    _buildFooterControls(state, selectedId, selectedSeat) {
        if (!selectedId) return '';

        // BETTING 阶段已经改成 DM 单方面定底注（中央面板有输入框 + 按钮），
        // footer 不再给玩家任何下注控件
        if (state.phase === 'BETTING') return '';

        if (state.phase === 'PLAYER_TURNS' && state.currentPlayerId === selectedId && selectedSeat?.status === 'playing') {
            const rollPending = this._isActionPending(this._playerActionKey(selectedId, 'roll'));
            const standPending = this._isActionPending(this._playerActionKey(selectedId, 'stand'));
            return `
                <button class="parlor-hud-action-btn accent" id="b21-roll" ${rollPending ? 'disabled' : ''}>
                    <i class="fas fa-dice"></i> ${this._t('PARLOR.Bone21.Action.Roll')}
                </button>
                <button class="parlor-hud-action-btn" id="b21-stand" ${standPending ? 'disabled' : ''}>
                    <i class="fas fa-hand-paper"></i> ${this._t('PARLOR.Common.Stand')}
                </button>
            `;
        }

        return '';
    }

    _buildCenterActions(state) {
        if (state.phase === 'BETTING') {
            if (!game.user.isGM) return '';
            // DM 在中央定底注 → 系统替所有 active 玩家扣 → 进 ROLLING
            // 大厅开桌时已经定过一次了，这里是中途破产的 fallback——DM 改金额或踢人再开
            const pending = this._isActionPending(this._gmActionKey('setAnte'));
            const seedAnte = Number(state.startingAnte || this._anteDraft || DEFAULT_ANTE);
            const draft = Number(this._anteDraft || seedAnte);
            const shortNames = (state.lastSetAnteShortIds || [])
                .map(id => this._playerName(state, id))
                .filter(Boolean);
            const shortNote = shortNames.length
                ? `<div class="parlor-b21-ante-warn">${this._escape(this._t('PARLOR.Bone21.Error.AnteShort', { names: shortNames.join('、') }))}</div>`
                : '';
            return `
                <div class="parlor-b21-center-actions parlor-b21-ante-row">
                    ${shortNote}
                    <label class="parlor-b21-bet-field">
                        <span>${this._t('PARLOR.Bone21.Label.Ante')}</span>
                        <input type="number" id="b21-ante-input" min="1" step="1" value="${draft}" ${pending ? 'disabled' : ''}>
                    </label>
                    <button class="parlor-hud-action-btn accent" id="b21-start-round" ${pending ? 'disabled' : ''}>
                        <i class="fas fa-play"></i> ${this._t('PARLOR.Bone21.Action.StartRound')}
                    </button>
                </div>
            `;
        }

        if (state.phase !== 'RESOLVING' || !game.user.isGM) return '';

        return `
            <div class="parlor-b21-center-actions">
                <button class="parlor-hud-action-btn" id="b21-finish-game" ${this._actionDisabledAttr(this._gmActionKey('finishGame'))}>
                    <i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}
                </button>
                <button class="parlor-hud-action-btn accent" id="b21-new-round" ${this._actionDisabledAttr(this._gmActionKey('newRound'))}>
                    <i class="fas fa-forward-step"></i> ${this._t('PARLOR.Common.NextRound')}
                </button>
            </div>
        `;
    }

    _buildResolution(state) {
        const result = state.roundResult || {};
        const winnerNames = (state.winnerIds || []).map(id => this._playerName(state, id)).join(' / ');
        const title = result.kind === 'push'
            ? this._t('PARLOR.Bone21.Center.PushTitle')
            : this._t('PARLOR.Bone21.Center.WinnerTitle', { name: winnerNames || this._t('PARLOR.Common.Unknown') });
        const cells = (state.playerIds || []).map(userId => {
            const seat = state.playerStates?.[userId] || null;
            if (!seat) return '';
            const payout = Number(state.payouts?.[userId] || 0);
            const bet = Number((state.bets || []).find(entry => entry.userId === userId)?.amount || 0);
            const net = Math.round((payout - bet) * 100) / 100;
            // RESOLVING 阶段私骰已公开，getVisibleTotal 一定非 null
            const totalView = this._getVisibleSeatTotal(userId);
            return `
                <div class="parlor-b21-result-cell ${state.winnerIds?.includes(userId) ? 'is-winner' : ''}">
                    <span>${this._escape(this._playerName(state, userId))}</span>
                    <strong>${totalView === null ? '?' : totalView}</strong>
                    <em>${net >= 0 ? '+' : ''}${net}</em>
                </div>
            `;
        }).join('');

        return `
            <div class="parlor-b21-resolution">
                <div class="parlor-b21-resolution-title">${this._escape(title)}</div>
                <div class="parlor-b21-resolution-grid">${cells}</div>
            </div>
        `;
    }

    _buildTurnOrder(state) {
        const order = state.turnOrder || [];
        if (!order.length) return `<div class="parlor-b21-order">${this._t('PARLOR.Common.Waiting')}</div>`;

        return `
            <div class="parlor-b21-order">
                ${order.map(userId => {
                    const seat = state.playerStates?.[userId] || null;
                    const classes = [
                        'parlor-b21-order-pill',
                        userId === state.currentPlayerId ? 'is-current' : '',
                        seat?.status === 'bust' ? 'is-bust' : '',
                        seat?.status === 'stand' ? 'is-stand' : ''
                    ].filter(Boolean).join(' ');
                    return `<span class="${classes}">${this._escape(this._playerName(state, userId))}</span>`;
                }).join('')}
            </div>
        `;
    }

    _buildDiceRow(dice, { small = false } = {}) {
        return dice.map(value => this._buildDie(value, { small })).join('');
    }

    _buildDie(value, { small = false } = {}) {
        const pips = DIE_PIPS[value] || [];
        const classes = ['parlor-b21-die', small ? 'is-small' : ''].filter(Boolean).join(' ');
        return `
            <div class="${classes}" data-value="${value}">
                ${Array.from({ length: 9 }, (_, index) => {
                    const pipIndex = index + 1;
                    return `<span class="parlor-b21-pip pip-${pipIndex} ${pips.includes(pipIndex) ? 'is-on' : ''}"></span>`;
                }).join('')}
            </div>
        `;
    }

    _buildDicePlaceholder() {
        return `<div class="parlor-b21-dice-placeholder">${this._t('PARLOR.Bone21.Seat.NoDice')}</div>`;
    }

    /** 私骰隐藏状态的占位——dice 数组为空但 seat 还在玩，比起 NoDice 这里更明确 */
    _buildHiddenDicePlaceholder() {
        return `<div class="parlor-b21-dice-placeholder is-hidden">${this._t('PARLOR.Bone21.Seat.HiddenDice')}</div>`;
    }

    _getPhaseLabel(phase) {
        const key = {
            BETTING: 'Betting',
            ROLLING: 'Rolling',
            PLAYER_TURNS: 'Turns',
            RESOLVING: 'Resolving'
        }[phase] || 'Betting';
        return this._t(`PARLOR.Bone21.Center.Phase.${key}`);
    }

    _getCenterTitle(state, currentName) {
        if (state.phase === 'BETTING') {
            return game.user.isGM
                ? this._t('PARLOR.Bone21.Center.BettingTitleGM')
                : this._t('PARLOR.Bone21.Center.BettingTitlePlayer');
        }
        if (state.phase === 'ROLLING') return this._t('PARLOR.Bone21.Center.RollingTitle');
        if (state.phase === 'PLAYER_TURNS') return this._t('PARLOR.Bone21.Center.TurnTitle', { name: currentName });
        if (state.phase === 'RESOLVING') return this._t('PARLOR.Bone21.Center.ResolvingTitle');
        return this._t('PARLOR.Common.Waiting');
    }

    _getCenterSub(state, currentName) {
        if (state.phase === 'BETTING') {
            return game.user.isGM
                ? this._t('PARLOR.Bone21.Center.BettingSubGM')
                : this._t('PARLOR.Bone21.Center.BettingSubPlayer');
        }
        if (state.phase === 'ROLLING') return this._t('PARLOR.Bone21.Center.RollingSub');
        if (state.phase === 'PLAYER_TURNS') return this._t('PARLOR.Bone21.Center.TurnSub', { name: currentName });
        if (state.phase === 'RESOLVING') return this._getResolutionSub(state);
        return '';
    }

    _getCenterNote(state) {
        if (state.phase === 'BETTING') return this._t('PARLOR.Bone21.Center.BettingNote');
        if (state.phase === 'PLAYER_TURNS') return this._t('PARLOR.Bone21.Center.TurnNote');
        if (state.phase === 'RESOLVING') {
            return game.user.isGM
                ? this._t('PARLOR.Bone21.Center.ResolvingNoteGM')
                : this._t('PARLOR.Bone21.Center.ResolvingNotePlayer');
        }
        return '';
    }

    _getResolutionSub(state) {
        const result = state.roundResult || {};
        if (result.kind === 'push') return this._t('PARLOR.Bone21.Center.PushSub');
        if (result.kind === 'split') {
            return this._t('PARLOR.Bone21.Center.SplitSub', {
                total: result.maxTotal || 0,
                amount: result.payoutPerWinner || 0
            });
        }
        return this._t('PARLOR.Bone21.Center.WinSub', {
            total: result.maxTotal || 0,
            amount: result.payoutPerWinner || 0
        });
    }

    _getFooterNote(state, selectedId, selectedSeat) {
        if (!selectedId) return this._t('PARLOR.Bone21.Footer.Spectating');
        if (state.phase === 'BETTING') return this._t('PARLOR.Bone21.Footer.WaitingForGM');
        if (state.phase === 'ROLLING') return this._t('PARLOR.Bone21.Footer.Rolling');
        if (state.phase === 'PLAYER_TURNS') {
            if (state.currentPlayerId === selectedId && selectedSeat?.status === 'playing') {
                return this._t('PARLOR.Bone21.Footer.YourTurn');
            }
            return this._t('PARLOR.Bone21.Footer.OtherTurn');
        }
        return this._t('PARLOR.Bone21.Footer.Resolving');
    }

    _getSeatStatus(state, userId) {
        const seat = state.playerStates?.[userId] || null;
        if (!seat && state.sittingOutPlayerIds?.includes(userId)) {
            return { text: this._t('PARLOR.Bone21.Seat.StatusSittingOut'), className: 'is-sitting-out' };
        }
        if (!seat) return { text: this._t('PARLOR.Common.WaitingBet'), className: '' };
        if (state.winnerIds?.includes(userId)) return { text: this._t('PARLOR.Bone21.Seat.StatusWinner'), className: 'is-winner' };
        // DSN 还在飞那颗骰子时，先按"还在投"展示——不然爆骰文字会比 3D 骰子先落到屏幕上
        const dsnLocked = this._dsnDisplayLimits.has(userId);
        if (!dsnLocked) {
            if (seat.status === 'bust') return { text: this._t('PARLOR.Common.Bust'), className: 'is-bust' };
            if (seat.status === 'stand') return { text: this._t('PARLOR.Common.Stand'), className: 'is-stand' };
        }
        if (state.currentPlayerId === userId) return { text: this._t('PARLOR.Bone21.Seat.StatusCurrent'), className: 'is-current' };
        return { text: this._t('PARLOR.Bone21.Seat.StatusPlaying'), className: '' };
    }

    _getSeatNote(state, userId) {
        const seat = state.playerStates?.[userId] || null;
        const bet = (state.bets || []).find(entry => entry.userId === userId);
        if (!seat) {
            if (bet) return this._t('PARLOR.Bone21.Seat.NoteBet', { amount: bet.amount });
            if (state.sittingOutPlayerIds?.includes(userId)) return this._t('PARLOR.Bone21.Seat.NoteSittingOut');
            return this._t('PARLOR.Bone21.Seat.NoteWaitingBet');
        }
        const dsnLocked = this._dsnDisplayLimits.has(userId);
        // DSN 飞着的时候 bust/stand note 也压住，等揭示
        if (!dsnLocked && seat.status === 'bust') return this._t('PARLOR.Bone21.Seat.NoteBust');
        // 别人的 total 私骰看不见时显示"?"——避免泄漏 stand/total 信息
        const totalView = this._getVisibleSeatTotal(userId);
        const totalLabel = totalView === null ? '?' : String(totalView);
        if (!dsnLocked && seat.status === 'stand') return this._t('PARLOR.Bone21.Seat.NoteStand', { total: totalLabel });
        if (state.currentPlayerId === userId) return this._t('PARLOR.Bone21.Seat.NoteCurrent');
        return this._t('PARLOR.Bone21.Seat.NoteTotal', { total: totalLabel });
    }

    _getSelectableParticipantIds(state) {
        const activeIds = state.playerIds || [];
        const controlledIds = getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => activeIds.includes(id));
        if (controlledIds.length) return controlledIds;
        if (game.user.isGM) return activeIds;
        return [];
    }

    _getSelectedParticipantId(state) {
        const selectableIds = this._getSelectableParticipantIds(state);
        if (!selectableIds.length) {
            this._selectedParticipantId = '';
            return '';
        }

        if (selectableIds.includes(state.currentPlayerId)) {
            this._selectedParticipantId = state.currentPlayerId;
            return this._selectedParticipantId;
        }

        if (selectableIds.includes(this._selectedParticipantId)) return this._selectedParticipantId;

        const current = getCurrentControlledParticipant(state, state.currentPlayerId);
        if (selectableIds.includes(current?.id)) {
            this._selectedParticipantId = current.id;
            return this._selectedParticipantId;
        }

        this._selectedParticipantId = selectableIds[0] || '';
        return this._selectedParticipantId;
    }

    _getPot(state) {
        return (state.bets || []).reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
    }

    _describeParticipant(state, userId) {
        const info = getDisplayParticipant(state, userId);
        if (BotManager.isBot(userId)) {
            info.name = BotManager.getBotName(userId);
        }
        return info;
    }

    _playerName(state, userId) {
        if (BotManager.isBot(userId)) return BotManager.getBotName(userId);
        return getParticipantName(state, userId);
    }

    _gmActionKey(action) {
        return `gm:${action}`;
    }

    _playerActionKey(userId, action) {
        return `player:${userId || 'none'}:${action}`;
    }

    _isActionPending(actionKey) {
        return !!actionKey && this._actionRequests.has(actionKey);
    }

    _actionDisabledAttr(actionKey) {
        return this._isActionPending(actionKey) ? 'disabled' : '';
    }

    async _runSocketAction(actionKey, button, request) {
        if (!actionKey) return request();

        const running = this._actionRequests.get(actionKey);
        if (button) button.disabled = true;
        if (running) return running;

        const startedAt = Date.now();
        const pending = (async () => {
            try {
                const result = await request();
                if (result?.ok === false) this._showActionError(result);
                return result;
            } catch (error) {
                console.error('parlor | Bone21 socket action failed:', error);
                ui.notifications.error(this._t('PARLOR.Bone21.Error.RequestFailed'));
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest));
                this._actionRequests.delete(actionKey);
                if (button?.isConnected) button.disabled = false;
                if (this._overlay) this.refresh();
            }
        })();

        this._actionRequests.set(actionKey, pending);
        return pending;
    }

    _showActionError(result) {
        switch (result?.reason) {
            case 'chips-insufficient': {
                const state = this.gameInstance.getState();
                const names = (result.shortIds || [])
                    .map(id => this._playerName(state, id))
                    .filter(Boolean)
                    .join('、');
                ui.notifications.warn(this._t('PARLOR.Bone21.Error.AnteShort', {
                    names: names || this._t('PARLOR.Common.Unknown')
                }));
                return;
            }
            case 'invalid-amount':
                ui.notifications.warn(this._t('PARLOR.Common.BetInvalidAmount'));
                return;
            case 'not-current':
                ui.notifications.warn(this._t('PARLOR.Bone21.Error.NotYourTurn'));
                return;
            case 'phase':
                ui.notifications.warn(this._t('PARLOR.Bone21.Error.WrongPhase'));
                return;
            default:
                return;
        }
    }

    _requestGMAction({ action, data = {}, key = this._gmActionKey(action), button = null }) {
        return this._runSocketAction(key, button, () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
            sessionId: this.sessionId,
            action,
            data
        }));
    }

    _requestPlayerAction({ userId, action, data = {}, key = this._playerActionKey(userId, action), button = null }) {
        return this._runSocketAction(key, button, () => SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
            sessionId: this.sessionId,
            userId,
            action,
            data
        }));
    }

    _escape(value) {
        return foundry.utils.escapeHTML(String(value ?? ''));
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
