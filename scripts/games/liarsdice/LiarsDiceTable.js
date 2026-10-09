/**
 * 说谎骰桌面覆盖层
 *
 * 这版把叫点也放回桌面里：
 * - 中间显示当前叫点、万能 1 状态和开盅结果
 * - 当前玩家在底部直接录入“几个几”
 * - 输家减骰和最终胜利都在这一桌里完成
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { BotManager } from '../../core/BotManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantName,
    getSelfParticipant
} from '../../core/ParticipantRoster.js';
import { Dsn3dBridge } from '../../core/Dsn3dBridge.js';
import {
    buildLiarsDiceHud,
    buildLiarsDiceSeatEntries,
    buildLiarsDiceStatus
} from './LiarsDicePresenterData.js';

const ACTION_LOCK_MS = 420;
const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;
const DIE_PIPS = Object.freeze({
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
});

export class LiarsDiceTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._dismissedByUser = false;
        this._selectedParticipantId = '';
        this._claimDraftQuantity = 1;
        this._claimDraftRoundToken = '';
        this._claimDraftClaimKey = '';
        this._actionRequests = new Map();
        this._lastRolledAtByParticipant = new Map();
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:liarsdice');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:liarsdice')) {
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

        document.querySelectorAll('#parlor-ld-overlay').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-ld-layout'
        });
        this._viewportFit.attach();
        // 把 DSN 画布抬到 overlay 之上，免得 3D 骰子被牌桌挡住
        Dsn3dBridge.attachOverlay(`ld:${this.sessionId}`);
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (this._presenterHost) {
            if (dismiss) this._dismissedByUser = true;
            this._presenterHost.destroy();
            this._presenterHost = null;
            Dsn3dBridge.detachOverlay(`ld:${this.sessionId}`);
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-ld-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        Dsn3dBridge.detachOverlay(`ld:${this.sessionId}`);
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._syncClaimDraft(state);
            this._presenterHost.refresh(state);
            return;
        }
        this._refreshNative();
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncClaimDraft(state);
        // 开盅阶段不再播 DSN（产品决策：reveal 直接静态展示，飞骰子打断节奏）
        // 私密阶段的 DSN 仍由 handlePrivateUpdate 自己触发
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderFooter(state);
        this._viewportFit?.update();
    }

    _openPresenter(PresenterClass, themeId) {
        if (this._presenterHost) {
            this._presenterHost.refresh(this.gameInstance.getState());
            return;
        }

        if (this._overlay) this._closeNative({ dismiss: false });

        let host = null;
        host = new PresenterHost({
            surface: 'table:liarsdice',
            hostId: 'parlor-ld-presenter',
            themeId,
            gameApi: this._createPresenterGameApi(),
            PresenterClass,
            onFallback: () => {
                if (this._presenterHost === host) this._presenterHost = null;
                this._openNative();
            }
        });
        this._presenterHost = host;
        // DSN 画布抬到呈现器(z3000)之上,3D 骰在酒馆桌照飞——漏了这句骰子全被盖住
        Dsn3dBridge.attachOverlay(`ld:${this.sessionId}`);
        host.open(this.gameInstance.getState());
    }

    _createPresenterGameApi() {
        const getState = () => this.gameInstance.getState();
        return Object.freeze({
            getState: () => getState(),
            getSeats: () => buildLiarsDiceSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildLiarsDiceStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildLiarsDiceHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => this._getPresenterPrivate(participantId),
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            renderCard: (card, options = {}) => CardRenderer.createCard(card, options),
            playSound: (kind) => ParlorAppearance.playCardSound(kind),
            formatChips: (amount) => `${Number(amount || 0)}`,
            getTableBackdrop: () => ParlorAppearance.getTableBackdrop?.() ?? null,
            getTableDeck: () => TableDecks.getActive(),
            openPopup: (id) => this._openPresenterPopup(id),
            requestClose: () => this._requestParlorClose?.() ?? this.close(),
            t: (key, data) => this._t(key, data)
        });
    }

    _getPresenterDataHelpers() {
        return {
            t: (key, data) => this._t(key, data),
            getParticipantName: (state, participantId) => this._playerName(state, participantId),
            getDisplayParticipant: (state, participantId) => this._describeParticipant(state, participantId),
            getSelfSeatParticipantId: (state) => this._getSelfSeatParticipantId(state),
            getActivePlayerIds: (state) => this._getActivePlayerIds(state),
            getSelectableParticipantIds: (state) => this._getSelectableParticipantIds(state),
            resolveSelectedParticipantId: (state) => this._getSelectedParticipantId(state),
            getVisibleDice: (participantId) => this.gameInstance.getVisibleDice?.(participantId) || [],
            getSeatStatus: (state, participantId) => this._getSeatStatus(state, participantId),
            getSeatNote: (state, participantId) => this._getSeatNote(state, participantId),
            formatClaim: (quantity, face) => this._formatClaim(quantity, face),
            getSuggestedClaimQuantity: (state) => this._getSuggestedClaimQuantity(state),
            isClaimAvailable: (state, claim) => this._isClaimAvailable(state, claim),
            isActionPending: (actionKey) => this._isActionPending(actionKey),
            requestAction: (action, data) => this._requestPresenterAction(action, data),
            isGM: () => game.user.isGM
        };
    }

    _getPresenterPrivate(participantId = null) {
        const state = this.gameInstance.getState();
        const targetId = participantId || this._getSelectedParticipantId(state);
        if (!targetId) return { participantId: '', dice: [] };

        return {
            participantId: targetId,
            dice: this.gameInstance.getVisibleDice?.(targetId) || []
        };
    }

    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const payload = { ...(data || {}) };
        const button = payload.button || null;
        delete payload.button;
        const gm = !!payload.gm;
        delete payload.gm;

        const gmActions = new Set(['finishGame', 'newRound', 'newMatch']);
        if (gm || gmActions.has(safeAction)) {
            delete payload.participantId;
            return this._requestGMAction({
                action: safeAction,
                data: payload,
                button
            });
        }

        const state = this.gameInstance.getState();
        const userId = String(payload.participantId || this._getSelectedParticipantId(state) || '');
        delete payload.participantId;
        if (!userId) return Promise.resolve({ ok: false, reason: 'missing-participant' });

        if (safeAction === 'claim') {
            return this._requestClaim({
                userId,
                quantity: payload.quantity,
                face: payload.face,
                button
            });
        }

        return this._requestPlayerAction({
            userId,
            action: safeAction,
            data: payload,
            button
        });
    }

    _openPresenterPopup(id = 'popup') {
        const hostRoot = this._presenterHost?.root;
        if (!hostRoot?.isConnected) return null;

        const safeId = String(id || 'popup').trim().replace(/[^a-z0-9_-]/giu, '-') || 'popup';
        hostRoot.querySelectorAll('[data-parlor-popup-id]').forEach(node => {
            if (node.dataset.parlorPopupId === safeId) node.remove();
        });

        const popup = document.createElement('div');
        popup.dataset.parlorPopupId = safeId;
        popup.destroy = () => popup.remove();
        hostRoot.appendChild(popup);
        return popup;
    }

    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== 'liarsdice.hand') return;

        const rolledAt = Number(data.rolledAt || 0);
        const lastRolledAt = Number(this._lastRolledAtByParticipant.get(data.participantId) || 0);
        if (rolledAt && rolledAt <= lastRolledAt) return;

        this._lastRolledAtByParticipant.set(data.participantId, rolledAt);

        // 私密阶段：只在收到自己（或自己代管的角色）骰子的客户端播 DSN，皮肤用该角色主人的
        const dice = Array.isArray(data.dice) ? data.dice : [];
        if (dice.length && Dsn3dBridge.isAvailable()) {
            const state = this.gameInstance.getState();
            const ownerUserId = this._getDsnOwnerUserId(state, data.participantId);
            void Dsn3dBridge.rollD6Visuals(dice, { ownerUserId });
        }

        if (this._overlay) {
            this.refresh();
        }
    }

    _getDsnOwnerUserId(state, participantId) {
        const participant = (state.participants || []).find(entry => entry.id === participantId);
        return participant?.controllerId || participant?.userId || null;
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-ld-overlay';
        overlay.innerHTML = `
            <div class="parlor-ld-backdrop"></div>
            <div class="parlor-ld-layout">
                <div class="parlor-seat-column seat-column-left" id="ld-seat-left"></div>
                <div class="parlor-ld-scene">
                    <div class="parlor-ld-table">
                        <div class="parlor-ld-table-shell">
                            <div class="parlor-ld-badge"><i class="fas fa-dice-five"></i> ${this._t('PARLOR.Games.LiarsDice.Name')}</div>
                            <div class="parlor-ld-center" id="ld-center"></div>
                            <div class="parlor-ld-footer-wrap" id="ld-footer"></div>
                        </div>
                    </div>
                </div>
                <div class="parlor-seat-column seat-column-right" id="ld-seat-right"></div>
            </div>
            <button class="parlor-ld-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-ld-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-ld-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });

        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#ld-center');
        if (!center) return;

        const activeIds = this._getActivePlayerIds(state);
        const currentName = state.currentPlayerId
            ? this._playerName(state, state.currentPlayerId)
            : this._t('PARLOR.Common.Waiting');
        const starterName = state.roundStarterId
            ? this._playerName(state, state.roundStarterId)
            : this._t('PARLOR.Common.Waiting');
        const tableDice = activeIds.reduce((sum, userId) => sum + Number(state.diceCounts?.[userId] || 0), 0);
        const claimSummaryHtml = this._buildCenterClaimSummary(state);

        let phaseLabel = this._t('PARLOR.Common.Waiting');
        let title = this._t('PARLOR.Common.Waiting');
        let sub = '';
        let note = '';
        let actionsHtml = '';
        let extraHtml = '';

        if (state.phase === 'ROLLING') {
            phaseLabel = this._t('PARLOR.LiarsDice.Center.Phase.Rolling');
            title = this._t('PARLOR.LiarsDice.Center.RollingTitle');
            sub = this._t('PARLOR.LiarsDice.Center.RollingSub');
            note = this._t('PARLOR.LiarsDice.Footer.Rolling');
        } else if (state.phase === 'PLAYER_TURNS') {
            phaseLabel = this._t('PARLOR.LiarsDice.Center.Phase.Turns');
            title = state.lastClaim
                ? this._t('PARLOR.LiarsDice.Center.TurnsTitleRespond', { name: currentName })
                : this._t('PARLOR.LiarsDice.Center.TurnsTitleFirst', { name: currentName });
            sub = state.lastClaim
                ? this._t('PARLOR.LiarsDice.Center.TurnsSubRespond')
                : this._t('PARLOR.LiarsDice.Center.TurnsSubFirst');
            note = state.lastClaim
                ? this._t('PARLOR.LiarsDice.Footer.CurrentTurnRespond')
                : this._t('PARLOR.LiarsDice.Footer.CurrentTurnFirst');
        } else if (state.phase === 'RESOLVING') {
            phaseLabel = this._t('PARLOR.LiarsDice.Center.Phase.Resolving');
            title = this._buildResolutionHeadline(state);
            sub = state.matchWinnerId
                ? this._t('PARLOR.LiarsDice.Center.MatchWinnerSub')
                : this._t('PARLOR.LiarsDice.Center.ResolvingSub');
            note = game.user.isGM
                ? (state.matchWinnerId
                    ? this._t('PARLOR.LiarsDice.Center.MatchWinnerNoteGM')
                    : this._t('PARLOR.LiarsDice.Center.ResolvingNoteGM'))
                : (state.matchWinnerId
                    ? this._t('PARLOR.LiarsDice.Center.MatchWinnerNotePlayer')
                    : this._t('PARLOR.LiarsDice.Center.ResolvingNotePlayer'));
            extraHtml = `
                ${this._buildResolutionSummary(state)}
                ${this._buildRevealCounts(state)}
            `;
            if (game.user.isGM) {
                actionsHtml = `
                    <div class="parlor-ld-center-actions">
                        <button class="parlor-hud-action-btn" id="ld-finish-game" ${this._actionDisabledAttr(this._gmActionKey('finishGame'))}>
                            <i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}
                        </button>
                        ${state.matchWinnerId
                            ? `
                                <button class="parlor-hud-action-btn accent" id="ld-new-match" ${this._actionDisabledAttr(this._gmActionKey('newMatch'))}>
                                    <i class="fas fa-dice"></i> ${this._t('PARLOR.LiarsDice.Action.NewMatch')}
                                </button>
                            `
                            : `
                                <button class="parlor-hud-action-btn accent" id="ld-new-round" ${this._actionDisabledAttr(this._gmActionKey('newRound'))}>
                                    <i class="fas fa-forward-step"></i> ${this._t('PARLOR.Common.NextRound')}
                                </button>
                            `}
                    </div>
                `;
            }
        }

        center.innerHTML = `
            <div class="parlor-ld-panel">
                <div class="parlor-ld-panel-head">
                    <div class="parlor-ld-panel-phase">${phaseLabel}</div>
                    <div class="parlor-ld-panel-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round || 0 })}</div>
                </div>
                <div class="parlor-ld-panel-title">${title}</div>
                ${sub ? `<div class="parlor-ld-panel-sub">${sub}</div>` : ''}
                <div class="parlor-ld-panel-stats">
                    <div class="parlor-ld-stat">
                        <span>${this._t('PARLOR.LiarsDice.Label.Starter')}</span>
                        <strong>${starterName}</strong>
                    </div>
                    <div class="parlor-ld-stat">
                        <span>${this._t('PARLOR.LiarsDice.Label.TableDice')}</span>
                        <strong>${tableDice}</strong>
                    </div>
                    <div class="parlor-ld-stat">
                        <span>${this._t('PARLOR.LiarsDice.Label.ActivePlayers')}</span>
                        <strong>${activeIds.length}</strong>
                    </div>
                </div>
                ${this._buildOnesBanner(state)}
                ${claimSummaryHtml}
                <div class="parlor-ld-turn-order">${this._buildTurnOrder(state)}</div>
                ${extraHtml}
                ${note ? `<div class="parlor-ld-panel-note">${note}</div>` : ''}
                ${actionsHtml}
            </div>
        `;

        center.querySelector('#ld-finish-game')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'finishGame', button: event.currentTarget });
        });
        center.querySelector('#ld-new-round')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'newRound', button: event.currentTarget });
        });
        center.querySelector('#ld-new-match')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'newMatch', button: event.currentTarget });
        });
    }

    _buildResolutionHeadline(state) {
        const claimOwner = state.lastClaim?.userId
            ? this._playerName(state, state.lastClaim.userId)
            : this._t('PARLOR.Common.Waiting');

        if (state.claimWasTrue === true) {
            return this._t('PARLOR.LiarsDice.Center.ClaimantWasTruthful', { name: claimOwner });
        }

        if (state.claimWasTrue === false) {
            return this._t('PARLOR.LiarsDice.Center.ClaimantWasLying', { name: claimOwner });
        }

        return this._t('PARLOR.LiarsDice.Center.ResolvingTitle');
    }

    _buildOnesBanner(state) {
        if (!state.onesCalled) return '';
        return `<div class="parlor-ld-rule-banner"><i class="fas fa-exclamation-circle"></i> ${this._t('PARLOR.LiarsDice.Center.OnesLockedBanner')}</div>`;
    }

    _buildCenterClaimSummary(state) {
        if (!state.lastClaim) {
            return `
                <div class="parlor-ld-claim-card is-empty">
                    <span>${this._t('PARLOR.LiarsDice.Label.CurrentClaim')}</span>
                    <strong>${this._t('PARLOR.LiarsDice.Center.NoClaimYet')}</strong>
                </div>
            `;
        }

        return `
            <div class="parlor-ld-claim-card">
                <span>${this._t('PARLOR.LiarsDice.Label.CurrentClaim')}</span>
                <strong>${this._formatClaim(state.lastClaim.quantity, state.lastClaim.face)}</strong>
                <em>${this._t('PARLOR.LiarsDice.Center.ClaimedBy', {
                    name: this._playerName(state, state.lastClaim.userId)
                })}</em>
            </div>
        `;
    }

    _buildResolutionSummary(state) {
        if (!state.lastClaim) return '';

        const openedBy = state.revealedBy
            ? this._playerName(state, state.revealedBy)
            : this._t('PARLOR.Common.Waiting');
        const claimOwner = state.lastClaim.userId
            ? this._playerName(state, state.lastClaim.userId)
            : this._t('PARLOR.Common.Waiting');
        const loserName = state.roundLoserId
            ? this._playerName(state, state.roundLoserId)
            : this._t('PARLOR.Common.Waiting');
        const claimResultText = state.claimWasTrue
            ? this._t('PARLOR.LiarsDice.Center.ClaimHeld', { count: Number(state.actualClaimCount || 0) })
            : this._t('PARLOR.LiarsDice.Center.ClaimFailed', { count: Number(state.actualClaimCount || 0) });

        return `
            <div class="parlor-ld-resolution-grid">
                <div class="parlor-ld-resolution-cell">
                    <span>${this._t('PARLOR.LiarsDice.Label.CurrentClaim')}</span>
                    <strong>${this._formatClaim(state.lastClaim.quantity, state.lastClaim.face)}</strong>
                </div>
                <div class="parlor-ld-resolution-cell">
                    <span>${this._t('PARLOR.LiarsDice.Label.Claimant')}</span>
                    <strong>${claimOwner}</strong>
                </div>
                <div class="parlor-ld-resolution-cell">
                    <span>${this._t('PARLOR.LiarsDice.Label.OpenedBy')}</span>
                    <strong>${openedBy}</strong>
                </div>
                <div class="parlor-ld-resolution-cell">
                    <span>${this._t('PARLOR.LiarsDice.Label.Result')}</span>
                    <strong>${claimResultText}</strong>
                </div>
                <div class="parlor-ld-resolution-cell">
                    <span>${this._t('PARLOR.LiarsDice.Label.RoundLoser')}</span>
                    <strong>${loserName}</strong>
                </div>
            </div>
        `;
    }

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#ld-seat-left');
        const rightColumn = this._overlay.querySelector('#ld-seat-right');
        if (!leftColumn || !rightColumn) return;

        leftColumn.innerHTML = '';
        rightColumn.innerHTML = '';

        const myId = this._getSelfSeatParticipantId(state);
        const allSeatIds = (state.playerIds || []).filter(Boolean);
        const hasMe = allSeatIds.includes(myId);
        const otherSeatIds = allSeatIds
            .filter(userId => userId !== myId)
            .slice(0, hasMe ? MAX_VISIBLE_SEATS - 1 : MAX_VISIBLE_SEATS);

        let leftSeatIds = [];
        let rightSeatIds = [];

        if (hasMe) {
            const leftCount = Math.min(MAX_SIDE_SEATS, Math.ceil(otherSeatIds.length / 2));
            leftSeatIds = otherSeatIds.slice(0, leftCount);
            rightSeatIds = [myId, ...otherSeatIds.slice(leftCount, leftCount + (MAX_SIDE_SEATS - 1))];
        } else {
            const leftCount = Math.min(MAX_SIDE_SEATS, Math.ceil(otherSeatIds.length / 2));
            leftSeatIds = otherSeatIds.slice(0, leftCount);
            rightSeatIds = otherSeatIds.slice(leftCount, leftCount + MAX_SIDE_SEATS);
        }

        leftColumn.classList.toggle('is-empty', leftSeatIds.length < 1);
        rightColumn.classList.toggle('is-empty', rightSeatIds.length < 1);

        leftSeatIds.forEach(userId => leftColumn.appendChild(this._buildSeatCard(state, userId)));
        rightSeatIds.forEach(userId => rightColumn.appendChild(this._buildSeatCard(state, userId)));
    }

    _buildSeatCard(state, userId) {
        const info = this._describeParticipant(state, userId);
        const diceCount = Number(state.diceCounts?.[userId] || 0);
        const isSelectable = this._getSelectableParticipantIds(state).includes(userId);
        const isSelected = userId === this._getSelectedParticipantId(state);
        const isCurrent = state.currentPlayerId === userId;
        const status = this._getSeatStatus(state, userId);
        const note = this._getSeatNote(state, userId);
        const revealedDice = Array.isArray(state.revealedDice?.[userId]) ? state.revealedDice[userId] : [];

        const seat = document.createElement('div');
        seat.className = [
            'parlor-seat-card',
            'parlor-ld-seat',
            isSelectable ? 'is-selectable' : '',
            isSelected ? 'is-selected' : '',
            isCurrent ? 'is-current' : '',
            state.phase === 'RESOLVING' ? 'has-result' : ''
        ].filter(Boolean).join(' ');
        seat.dataset.userId = userId;
        seat.innerHTML = `
            <div class="parlor-seat-avatar-wrap">
                <div class="parlor-seat-avatar">${info.avatarHtml}</div>
            </div>
            <div class="parlor-seat-info">
                <div class="parlor-seat-head">
                    <div class="parlor-seat-name">
                        <div class="parlor-seat-name-text">${info.name}</div>
                    </div>
                    <div class="parlor-seat-num">${diceCount}</div>
                </div>
                <div class="parlor-seat-status ${status.className}">${status.text}</div>
                <div class="parlor-ld-seat-note">${note}</div>
                ${revealedDice.length ? `<div class="parlor-ld-seat-dice">${this._buildDiceRow(revealedDice, { small: true })}</div>` : ''}
            </div>
        `;

        if (isSelectable) {
            seat.addEventListener('click', () => {
                this._selectedParticipantId = userId;
                this.refresh();
            });
        }

        return seat;
    }

    _renderFooter(state) {
        const footer = this._overlay.querySelector('#ld-footer');
        if (!footer) return;

        const selectableIds = this._getSelectableParticipantIds(state);
        const selectedId = this._getSelectedParticipantId(state);
        const selectedName = selectedId
            ? this._playerName(state, selectedId)
            : this._t('PARLOR.Common.Spectating');
        const visibleDice = selectedId ? this.gameInstance.getVisibleDice(selectedId) : null;

        let note = '';
        if (!selectableIds.length) {
            note = this._t('PARLOR.LiarsDice.Footer.Spectating');
        } else if (state.phase === 'ROLLING') {
            note = this._t('PARLOR.LiarsDice.Footer.Rolling');
        } else if (state.phase === 'PLAYER_TURNS' && selectedId === state.currentPlayerId) {
            note = state.lastClaim
                ? this._t('PARLOR.LiarsDice.Footer.CurrentTurnRespond')
                : this._t('PARLOR.LiarsDice.Footer.CurrentTurnFirst');
        } else if (state.phase === 'PLAYER_TURNS' && selectedId) {
            note = this._t('PARLOR.LiarsDice.Footer.OtherTurn');
        } else if (state.phase === 'RESOLVING') {
            note = this._t('PARLOR.LiarsDice.Footer.Resolving');
        } else if (!visibleDice?.length) {
            note = this._t('PARLOR.LiarsDice.Footer.NoDice');
        }

        let actionsHtml = '';
        if (selectedId && state.phase === 'PLAYER_TURNS' && selectedId === state.currentPlayerId) {
            actionsHtml = this._buildClaimControls(state, selectedId);
        }

        footer.innerHTML = `
            <div class="parlor-ld-footer-shell ${!visibleDice?.length ? 'is-empty' : ''}">
                <div class="parlor-ld-footer-head">
                    <div class="parlor-ld-footer-title">${selectedName}</div>
                    ${selectableIds.length > 1 ? `
                        <label class="parlor-ld-footer-select">
                            <span>${this._t('PARLOR.LiarsDice.Footer.SelectRole')}</span>
                            <select id="ld-footer-select">
                                ${selectableIds.map(userId => `
                                    <option value="${userId}" ${userId === selectedId ? 'selected' : ''}>${this._playerName(state, userId)}</option>
                                `).join('')}
                            </select>
                        </label>
                    ` : ''}
                </div>
                <div class="parlor-ld-footer-dice ${state.phase === 'ROLLING' ? 'is-rolling' : ''}">
                    ${state.phase === 'ROLLING'
                        ? `<div class="parlor-ld-cup" aria-hidden="true"></div>`
                        : visibleDice?.length
                            ? this._buildDiceRow(visibleDice)
                            : `<div class="parlor-ld-dice-placeholder">${this._t('PARLOR.LiarsDice.Footer.NoDice')}</div>`}
                </div>
                <div class="parlor-ld-footer-actions">${actionsHtml}</div>
                ${note ? `<div class="parlor-ld-footer-note">${note}</div>` : ''}
            </div>
        `;

        footer.querySelector('#ld-footer-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            this.refresh();
        });

        footer.querySelector('#ld-claim-quantity')?.addEventListener('input', (event) => {
            this._claimDraftQuantity = Math.max(1, parseInt(event.currentTarget.value, 10) || 1);
            event.currentTarget.value = String(this._claimDraftQuantity);
            this._updateClaimFaceButtons(footer, state, selectedId);
        });

        footer.querySelector('#ld-call-open')?.addEventListener('click', (event) => {
            this._requestPlayerAction({
                userId: selectedId,
                action: 'open',
                button: event.currentTarget
            });
        });

        footer.querySelectorAll('[data-ld-claim-face]').forEach(button => {
            button.addEventListener('click', (event) => {
                this._requestClaim({
                    userId: selectedId,
                    quantity: Math.max(1, parseInt(footer.querySelector('#ld-claim-quantity')?.value, 10) || this._claimDraftQuantity),
                    face: Number(button.dataset.ldClaimFace || 0),
                    button: event.currentTarget
                });
            });
        });

        this._updateClaimFaceButtons(footer, state, selectedId);
    }

    _buildClaimControls(state, userId) {
        const quantity = Math.max(1, Number(this._claimDraftQuantity || this._getSuggestedClaimQuantity(state)));
        const claimPending = this._isActionPending(this._playerActionKey(userId, 'makeClaim'));
        const openPending = this._isActionPending(this._playerActionKey(userId, 'open'));
        const faceButtons = [1, 2, 3, 4, 5, 6].map(face => {
            const disabled = claimPending || !this._isClaimAvailable(state, { quantity, face });
            return `
                <button
                    class="parlor-hud-action-btn parlor-ld-claim-face-btn ${face === 1 ? 'accent' : ''}"
                    data-ld-claim-face="${face}"
                    ${disabled ? 'disabled' : ''}
                >
                    ${face}
                </button>
            `;
        }).join('');

        return `
            <div class="parlor-ld-claim-box">
                <div class="parlor-ld-claim-inputs">
                    <label class="parlor-ld-claim-field">
                        <span>
                            ${this._t('PARLOR.LiarsDice.Footer.ClaimCount')}
                            <small class="parlor-ld-claim-hint">${this._t('PARLOR.LiarsDice.Footer.ClaimCountHint')}</small>
                        </span>
                        <input type="number" id="ld-claim-quantity" min="1" value="${quantity}">
                    </label>
                    ${state.lastClaim ? `
                        <button class="parlor-hud-action-btn" id="ld-call-open" ${openPending ? 'disabled' : ''}>
                            <i class="fas fa-eye"></i> ${this._t('PARLOR.LiarsDice.Action.Open')}
                        </button>
                    ` : ''}
                </div>
                <div class="parlor-ld-claim-face-row">
                    ${faceButtons}
                </div>
            </div>
        `;
    }

    _updateClaimFaceButtons(footer, state, userId) {
        if (!footer || !userId) return;

        const quantityInput = footer.querySelector('#ld-claim-quantity');
        const quantity = Math.max(1, parseInt(quantityInput?.value, 10) || this._claimDraftQuantity || 1);
        const claimPending = this._isActionPending(this._playerActionKey(userId, 'makeClaim'));

        footer.querySelectorAll('[data-ld-claim-face]').forEach(button => {
            const face = Number(button.dataset.ldClaimFace || 0);
            const disabled = claimPending || !this._isClaimAvailable(state, { quantity, face });
            button.disabled = disabled;
        });
    }

    _buildTurnOrder(state) {
        const activeIds = this._getActivePlayerIds(state);
        const order = (state.turnOrder || []).length
            ? state.turnOrder
            : activeIds;

        return order.map(userId => {
            const classes = [
                'parlor-ld-order-pill',
                userId === state.currentPlayerId ? 'is-current' : '',
                userId === state.roundStarterId ? 'is-starter' : '',
                Number(state.diceCounts?.[userId] || 0) < 1 ? 'is-out' : ''
            ].filter(Boolean).join(' ');
            return `<span class="${classes}">${this._playerName(state, userId)}</span>`;
        }).join('');
    }

    _buildRevealCounts(state) {
        const cells = [1, 2, 3, 4, 5, 6].map(face => `
            <div class="parlor-ld-count-cell">
                ${this._buildDie(face, { compact: true })}
                <strong>${Number(state.faceCounts?.[face] || 0)}</strong>
            </div>
        `).join('');

        return `<div class="parlor-ld-count-grid">${cells}</div>`;
    }

    _buildDiceRow(dice, { small = false } = {}) {
        return dice.map(value => this._buildDie(value, { small })).join('');
    }

    _buildDie(value, { small = false, compact = false } = {}) {
        const pips = DIE_PIPS[value] || [];
        const classes = [
            'parlor-ld-die',
            small ? 'is-small' : '',
            compact ? 'is-compact' : ''
        ].filter(Boolean).join(' ');

        return `
            <div class="${classes}" data-value="${value}">
                ${Array.from({ length: 9 }, (_, index) => {
                    const pipIndex = index + 1;
                    const className = pips.includes(pipIndex) ? 'is-on' : '';
                    return `<span class="parlor-ld-pip pip-${pipIndex} ${className}"></span>`;
                }).join('')}
            </div>
        `;
    }

    _formatClaim(quantity, face) {
        return this._t('PARLOR.LiarsDice.Text.ClaimFormat', { quantity, face });
    }

    _syncClaimDraft(state) {
        const roundToken = state.roundToken || '';
        const claimKey = `${roundToken}:${Number(state.lastClaim?.quantity || 0)}:${Number(state.lastClaim?.face || 0)}`;
        const suggestedQuantity = this._getSuggestedClaimQuantity(state);

        if (roundToken !== this._claimDraftRoundToken) {
            this._claimDraftRoundToken = roundToken;
            this._claimDraftClaimKey = claimKey;
            this._claimDraftQuantity = suggestedQuantity;
            return;
        }

        if (claimKey !== this._claimDraftClaimKey) {
            this._claimDraftClaimKey = claimKey;
            this._claimDraftQuantity = Math.max(1, suggestedQuantity);
            return;
        }

        this._claimDraftQuantity = Math.max(1, Number(this._claimDraftQuantity || suggestedQuantity));
    }

    _getSuggestedClaimQuantity(state) {
        if (!state.lastClaim) return 1;
        if (Number(state.lastClaim.face || 0) < 6) return Math.max(1, Number(state.lastClaim.quantity || 1));
        return Math.max(1, Number(state.lastClaim.quantity || 1) + 1);
    }

    _isClaimAvailable(state, claim) {
        const quantity = Math.max(1, Math.floor(Number(claim?.quantity || 0)));
        const face = Math.max(1, Math.min(6, Math.floor(Number(claim?.face || 0))));
        if (!quantity || !face) return false;
        if (!state.lastClaim) return true;
        if (quantity > Number(state.lastClaim.quantity || 0)) return true;
        if (quantity < Number(state.lastClaim.quantity || 0)) return false;
        return face > Number(state.lastClaim.face || 0);
    }

    _getSeatStatus(state, userId) {
        if (state.matchWinnerId === userId) {
            return { text: this._t('PARLOR.LiarsDice.Seat.StatusWinner'), className: 'status-live' };
        }
        if (Number(state.diceCounts?.[userId] || 0) < 1) {
            return { text: this._t('PARLOR.LiarsDice.Seat.StatusOut'), className: 'status-folded' };
        }
        if (state.phase === 'ROLLING') {
            return { text: this._t('PARLOR.LiarsDice.Seat.StatusRolling'), className: 'status-live' };
        }
        if (state.phase === 'PLAYER_TURNS' && state.currentPlayerId === userId) {
            return { text: this._t('PARLOR.LiarsDice.Seat.StatusCurrent'), className: 'status-live' };
        }
        if (state.phase === 'RESOLVING') {
            return { text: this._t('PARLOR.LiarsDice.Seat.StatusOpened'), className: 'status-push' };
        }
        return { text: this._t('PARLOR.LiarsDice.Seat.StatusWaiting'), className: 'status-live' };
    }

    _getSeatNote(state, userId) {
        const diceCount = Number(state.diceCounts?.[userId] || 0);
        if (state.matchWinnerId === userId) {
            return this._t('PARLOR.LiarsDice.Seat.NoteWinner');
        }
        if (diceCount < 1) {
            return this._t('PARLOR.LiarsDice.Seat.NoteOut');
        }
        if (state.phase === 'RESOLVING' && state.roundLoserId === userId) {
            return this._t('PARLOR.LiarsDice.Seat.NotePenalty', {
                amount: 1,
                count: diceCount
            });
        }
        if (state.phase === 'ROLLING') {
            return this._t('PARLOR.LiarsDice.Seat.NoteRolling');
        }
        if (state.phase === 'PLAYER_TURNS' && state.currentPlayerId === userId) {
            return state.lastClaim
                ? this._t('PARLOR.LiarsDice.Seat.NoteCurrentRespond')
                : this._t('PARLOR.LiarsDice.Seat.NoteCurrentFirst');
        }
        if (state.phase === 'PLAYER_TURNS' && state.lastClaim?.userId === userId) {
            return this._t('PARLOR.LiarsDice.Seat.NoteLastClaim', {
                claim: this._formatClaim(state.lastClaim.quantity, state.lastClaim.face)
            });
        }
        if (state.roundStarterId === userId) {
            return this._t('PARLOR.LiarsDice.Seat.NoteStarter');
        }
        return this._t('PARLOR.LiarsDice.Seat.NoteDiceLeft', { count: diceCount });
    }

    _getActivePlayerIds(state) {
        return (state.playerIds || []).filter(userId => Number(state.diceCounts?.[userId] || 0) > 0);
    }

    _getControlledActiveIds(state) {
        const activeIds = this._getActivePlayerIds(state);
        return getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => activeIds.includes(id));
    }

    _getSelectableParticipantIds(state) {
        const controlledIds = this._getControlledActiveIds(state);
        if (controlledIds.length) return controlledIds;
        if (game.user.isGM) return this._getActivePlayerIds(state);

        return [];
    }

    _getSelectedParticipantId(state) {
        const selectableIds = this._getSelectableParticipantIds(state);
        const controlledIds = this._getControlledActiveIds(state);
        if (!selectableIds.length) {
            this._selectedParticipantId = '';
            return '';
        }

        if (controlledIds.includes(state.currentPlayerId)) {
            this._selectedParticipantId = state.currentPlayerId;
            return this._selectedParticipantId;
        }

        if (game.user.isGM && selectableIds.includes(state.currentPlayerId) && !selectableIds.includes(this._selectedParticipantId)) {
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

    _getSelfSeatParticipantId(state) {
        return getSelfParticipant(state)?.id || '';
    }

    _isSeatOpenEligible(state, userId) {
        return !!userId
            && userId === state.currentPlayerId
            && this._getSelectableParticipantIds(state).includes(userId)
            && Number(state.diceCounts?.[userId] || 0) > 0
            && state.phase === 'PLAYER_TURNS'
            && !!state.lastClaim;
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
                if (result?.ok === false) {
                    this._showActionError(result);
                }
                return result;
            } catch (error) {
                console.error('parlor | Liars Dice socket action failed:', error);
                ui.notifications.error(this._t('PARLOR.LiarsDice.Error.RequestFailed'));
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) {
                    await new Promise(resolve => setTimeout(resolve, rest));
                }
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
            case 'claim-too-low':
                ui.notifications.warn(this._t('PARLOR.LiarsDice.Error.ClaimTooLow'));
                return;
            case 'invalid-claim':
                ui.notifications.warn(this._t('PARLOR.LiarsDice.Error.InvalidClaim'));
                return;
            case 'no-claim':
                ui.notifications.warn(this._t('PARLOR.LiarsDice.Error.NoClaimToOpen'));
                return;
            case 'not-current':
                ui.notifications.warn(this._t('PARLOR.LiarsDice.Error.NotYourTurn'));
                return;
            case 'phase':
                ui.notifications.warn(this._t('PARLOR.LiarsDice.Error.WrongPhase'));
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

    _requestClaim({ userId, quantity, face, button = null }) {
        return this._requestPlayerAction({
            userId,
            action: 'makeClaim',
            data: { quantity, face },
            key: this._playerActionKey(userId, 'makeClaim'),
            button
        });
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
