/**
 * BlackjackTable — 21 点赌桌覆盖层（V4）
 *
 * 这层后续维护统一按 Foundry V14 兼容优先来收。
 *
 * 修复：
 * - 追踪已渲染牌数，只动画新增的牌（不重复播发牌动画）
 * - 结算时弹出独立窗口，DM 点确定后才结算金币
 * - 控庄视角不重复显示庄家牌区（HUD 已有）
 * - 中央区显示当前行动的牌
 */
import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { CardHandHUD } from '../../ui/CardHandHUD.js';
import { LocalResultFx } from '../../ui/LocalResultFx.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { BotManager } from '../../core/BotManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { isNaturalHand } from './BlackjackRules.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantLabel,
    getParticipantName,
    getSelfParticipant
} from '../../core/ParticipantRoster.js';
import {
    buildBlackjackHud,
    buildBlackjackSeatEntries,
    buildBlackjackStatus
} from './BlackjackPresenterData.js';

const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;
const ACTION_LOCK_MS = 420;

export class BlackjackTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._dismissedByUser = false;
        this._prevCardCount = 0;
        this._hudCardOwner = '';
        this._hudCardSigns = [];
        // V14 兼容：追踪各区域已渲染牌数，避免状态刷新时重放动画
        this._renderedDealerCards = 0;
        this._dealerCardsRevealed = false;
        this._renderedCenterKey = '';
        this._renderedCenterCards = 0;
        this._prevPhase = '';
        this._settlementShown = false;
        this._prevStateSnapshot = null;
        this._queuedHudFlights = [];
        this._queuedSeatFlights = [];
        this._selectedParticipantId = '';
        this._actionRequests = new Map();
        this._viewportFit = null;
        this._blackjackFxTimer = null;
        this._blackjackFxRound = null;
        this._playedBlackjackFxKeys = new Set();
        this._resultFxRound = null;
        this._playedLocalResultFxKeys = new Set();
        this._playedSeatBustFxKeys = new Set();
        this._betDraftAmounts = new Map();
        this._onKeyDown = (event) => {
            // V14 兼容优先：Foundry 里 Esc 太常用了，这里别再顺手误关赌桌
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:blackjack');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:blackjack')) {
            this._openPresenter(PresenterClass, themeId);
            return;
        }
        this._openNative();
    }

    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) { this.refresh(); return; }
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-bj-layout'
        });
        this._viewportFit.attach();
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (this._presenterHost) {
            if (dismiss) this._dismissedByUser = true;
            this._presenterHost.destroy();
            this._presenterHost = null;
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._stopBlackjackFx();
        LocalResultFx.clear(this._overlay);
        this._clearSeatBustFx();
        this._handHUD.destroy();
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._resetTracking();
    }

    _resetTracking() {
        this._prevCardCount = 0;
        this._hudCardOwner = '';
        this._hudCardSigns = [];
        this._renderedDealerCards = 0;
        this._dealerCardsRevealed = false;
        this._renderedCenterKey = '';
        this._renderedCenterCards = 0;
        this._prevPhase = '';
        this._settlementShown = false;
        this._prevStateSnapshot = null;
        this._queuedHudFlights = [];
        this._queuedSeatFlights = [];
        this._actionRequests.clear();
        this._blackjackFxRound = null;
        this._playedBlackjackFxKeys.clear();
        this._resultFxRound = null;
        this._playedLocalResultFxKeys.clear();
        this._playedSeatBustFxKeys.clear();
        this._betDraftAmounts.clear();
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._presenterHost.refresh(state);
            // 结算弹窗还是本体负责；presenter 只接管牌桌 surface，不能截断整局收尾。
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncBlackjackFxRound(state);
        this._syncResultFxRound(state);
        const queuedFlights = this._collectFlights(state);
        this._queuedHudFlights = queuedFlights.hud;
        this._queuedSeatFlights = queuedFlights.seat;

        // V14 兼容：阶段切换时顺手把中央区追踪也清掉
        if (state.phase !== this._prevPhase) {
            this._renderedCenterKey = '';
            this._renderedCenterCards = 0;
            if (state.phase === 'BETTING') {
                this._renderedDealerCards = 0;
                this._prevCardCount = 0;
                this._settlementShown = false;
                this._betDraftAmounts.clear();
                this._stopBlackjackFx();
                LocalResultFx.clear(this._overlay);
                this._clearSeatBustFx();
            }
            this._prevPhase = state.phase;
        }

        this._renderDealerCards(state);
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderHandHUD(state);
        this._playSeatFlights();
        this._maybePlaySeatBustFx(state);
        this._maybePlayBlackjackFx(state);
        this._maybePlayLocalResultFx(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-bj-settlement')?.remove();
        }

        // V14 兼容：只在真正算完输赢后弹结算页
        if (state.phase === 'RESOLVING' && !this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }

        this._viewportFit?.update();
        this._prevStateSnapshot = this._cloneState(state);
    }

    _syncSettlement(state) {
        if (state.phase !== this._prevPhase) {
            if (state.phase === 'BETTING') this._settlementShown = false;
            this._prevPhase = state.phase;
        }

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-bj-settlement')?.remove();
            return;
        }

        if (!this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }
    }

    _openPresenter(PresenterClass, themeId) {
        const state = this.gameInstance.getState();
        if (this._presenterHost) {
            this._presenterHost.refresh(state);
            this._syncSettlement(state);
            return;
        }

        if (this._overlay) this._closeNative({ dismiss: false });

        let host = null;
        host = new PresenterHost({
            surface: 'table:blackjack',
            hostId: 'parlor-bj-presenter',
            themeId,
            gameApi: this._createPresenterGameApi(),
            PresenterClass,
            onFallback: () => {
                if (this._presenterHost === host) this._presenterHost = null;
                this._openNative();
            }
        });
        this._presenterHost = host;
        host.open(state);
        this._syncSettlement(state);
    }

    _createPresenterGameApi() {
        const getState = () => this.gameInstance.getState();
        return Object.freeze({
            getState: () => getState(),
            getSeats: () => buildBlackjackSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildBlackjackStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildBlackjackHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => this._getPresenterPrivate(participantId),
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            renderCard: (card, options = {}) => CardRenderer.createCard(card, options),
            playSound: (kind) => ParlorAppearance.playCardSound(kind),
            formatChips: (amount) => this._formatChipValue(amount),
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
            formatChips: (amount) => this._formatChipValue(amount),
            getParticipantName: (state, participantId) => getParticipantName(state, participantId),
            getDisplayParticipant: (state, participantId) => getDisplayParticipant(state, participantId),
            getSelfSeatParticipantId: (state) => this._getSelfSeatParticipantId(state),
            getActivePlayerIds: (state) => this._getActivePlayerIds(state),
            getBettingPlayerIds: (state) => this._getBettingPlayerIds(state),
            getControlledParticipantIds: (state) => this._getControlledParticipantIds(state),
            resolveSelectedParticipantId: (state) => this._getSelectedParticipantId(state, { preferTurn: true }),
            isGM: () => game.user.isGM,
            isDealerController: (state) => this._isDealerController(state),
            getPlayerHudCards: (state, hand) => this._getPlayerHudCards(state, hand),
            getDealerHudCards: (state, hand) => this._getDealerHudCards(state, hand),
            getVisibleHandTotal: (state, hand) => this._getVisibleHandTotal(hand, state.rules),
            canPlayerHit: (state, hand, participantId) => this._canPlayerHit(state, hand, participantId),
            canPlayerStand: (state, hand, participantId) => this._canPlayerStand(state, hand, participantId),
            getBetDraftAmount: (participantId) => this._getBetDraftAmount(participantId),
            isActionPending: (actionKey) => this._isActionPending(actionKey),
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    _getPresenterPrivate(participantId = null) {
        const state = this.gameInstance.getState();
        const targetId = participantId || this._getSelectedParticipantId(state, { preferTurn: true });
        if (!targetId) return { participantId: '', cards: [] };

        const hand = state.playerHands?.[targetId] || null;
        return {
            participantId: targetId,
            cards: [...(hand?.handCards || []), ...(hand?.tableCards || [])]
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

        const gmActions = new Set(['startDeal', 'confirmDeal', 'dealerHit', 'dealerStand', 'settle', 'newRound', 'finishGame']);
        if (gm || gmActions.has(safeAction)) {
            delete payload.participantId;
            return this._requestGMAction({
                action: safeAction,
                data: payload,
                button
            });
        }

        const state = this.gameInstance.getState();
        const participantId = String(payload.participantId || this._getSelectedParticipantId(state, { preferTurn: true }) || '');
        delete payload.participantId;
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });

        return this._requestPlayerAction({
            userId: participantId,
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

    // ═══════════════ DOM 构建（V14 兼容） ═══════════════

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-bj-overlay';
        overlay.dataset.bjStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-bj-backdrop"></div>
            <div class="parlor-bj-blackjack-fx" id="bj-blackjack-fx"></div>
            <div class="parlor-bj-layout">
                <div class="parlor-bj-seat-column seat-column-left" id="bj-seat-left"></div>
                <div class="parlor-bj-scene">
                    <div class="parlor-bj-table">
                        ${this._buildTableArt()}
                        <div class="parlor-bj-table-stage">
                            <div class="parlor-bj-dealer-zone">
                                <div class="parlor-bj-dealer-badge"><i class="fas fa-crown"></i> ${this._t('PARLOR.Common.Dealer')}</div>
                                <div class="parlor-bj-dealer-cards" id="bj-dealer-cards"></div>
                            </div>
                            <div class="parlor-bj-center" id="bj-center"></div>
                        </div>
                    </div>
                    <div class="parlor-bj-status-dock" id="bj-status-dock"></div>
                </div>
                <div class="parlor-bj-seat-column seat-column-right" id="bj-seat-right"></div>
            </div>
            <button class="parlor-bj-close-btn"><i class="fas fa-times"></i></button>
        `;
        overlay.querySelector('.parlor-bj-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-bj-close-btn').addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    // ═══════════════ 事件特效（V14 兼容） ═══════════════

    _syncBlackjackFxRound(state) {
        const round = Number.isFinite(Number(state?.round)) ? Number(state.round) : 0;
        if (this._blackjackFxRound === round) return;
        this._blackjackFxRound = round;
        this._playedBlackjackFxKeys.clear();
    }

    _maybePlayBlackjackFx(state) {
        const hits = this._collectBlackjackFxHits(state);
        if (!hits.length) return;

        hits.forEach(hit => this._playedBlackjackFxKeys.add(hit.key));
        this._playBlackjackFx(hits);
    }

    _collectBlackjackFxHits(state) {
        if (!this._overlay) return [];
        if (!['PLAYER_TURNS', 'DEALER_TURN', 'SETTLE', 'RESOLVING'].includes(state.phase)) return [];

        const hits = [];
        const round = this._blackjackFxRound ?? 0;
        for (const uid of this._getActivePlayerIds(state)) {
            const hand = state.playerHands?.[uid];
            if (hand?.status !== 'blackjack') continue;

            const key = `player:${round}:${uid}`;
            if (this._playedBlackjackFxKeys.has(key)) continue;
            hits.push({
                key,
                name: this._playerName(uid, state)
            });
        }

        if (['DEALER_TURN', 'SETTLE', 'RESOLVING'].includes(state.phase) && this._isDealerNatural(state)) {
            const key = `dealer:${round}`;
            if (!this._playedBlackjackFxKeys.has(key)) {
                hits.push({
                    key,
                    name: this._getDealerTitle(state)
                });
            }
        }

        return hits;
    }

    _isDealerNatural(state) {
        const dealerCards = [...(state.dealerHand?.handCards || []), ...(state.dealerHand?.tableCards || [])];
        return isNaturalHand(dealerCards, state.rules);
    }

    _playBlackjackFx(hits) {
        const fxRoot = this._overlay?.querySelector('#bj-blackjack-fx');
        if (!fxRoot) return;

        this._stopBlackjackFx();
        fxRoot.innerHTML = this._buildBlackjackFxHtml(hits);
        void fxRoot.offsetWidth;
        fxRoot.classList.add('is-active');
        this._overlay?.classList.add('show-blackjack-fx');

        this._blackjackFxTimer = window.setTimeout(() => {
            if (!fxRoot.isConnected) {
                this._blackjackFxTimer = null;
                return;
            }

            fxRoot.classList.remove('is-active');
            fxRoot.innerHTML = '';
            this._overlay?.classList.remove('show-blackjack-fx');
            this._blackjackFxTimer = null;
        }, 1900);
    }

    _stopBlackjackFx() {
        if (this._blackjackFxTimer) {
            clearTimeout(this._blackjackFxTimer);
            this._blackjackFxTimer = null;
        }

        const fxRoot = this._overlay?.querySelector('#bj-blackjack-fx');
        if (fxRoot) {
            fxRoot.classList.remove('is-active');
            fxRoot.innerHTML = '';
        }

        this._overlay?.classList.remove('show-blackjack-fx');
    }

    _buildBlackjackFxHtml(hits) {
        const subtitle = hits.length > 2
            ? `${hits.slice(0, 2).map(hit => hit.name).join(' · ')} +${hits.length - 2}`
            : hits.map(hit => hit.name).join(' · ');
        const rays = [
            { size: 'clamp(380px, 42vw, 760px)', rotate: '-38deg', delay: '0.02s', opacity: '0.52' },
            { size: 'clamp(300px, 34vw, 620px)', rotate: '-12deg', delay: '0.08s', opacity: '0.34' },
            { size: 'clamp(460px, 46vw, 860px)', rotate: '16deg', delay: '0.05s', opacity: '0.46' },
            { size: 'clamp(320px, 36vw, 680px)', rotate: '42deg', delay: '0.12s', opacity: '0.28' },
            { size: 'clamp(280px, 32vw, 560px)', rotate: '72deg', delay: '0.16s', opacity: '0.22' }
        ];
        const spades = [
            { size: 'clamp(240px, 32vw, 520px)', tx: '0px', ty: '-18px', delay: '0s', rotate: '0deg', tone: 'center' },
            { size: 'clamp(86px, 8vw, 138px)', tx: '-420px', ty: '-164px', delay: '0.06s', rotate: '-18deg' },
            { size: 'clamp(72px, 7vw, 122px)', tx: '-314px', ty: '188px', delay: '0.1s', rotate: '14deg' },
            { size: 'clamp(92px, 8.6vw, 150px)', tx: '356px', ty: '-206px', delay: '0.12s', rotate: '18deg' },
            { size: 'clamp(78px, 7.4vw, 126px)', tx: '438px', ty: '138px', delay: '0.16s', rotate: '-12deg' },
            { size: 'clamp(56px, 5.8vw, 96px)', tx: '-520px', ty: '18px', delay: '0.18s', rotate: '-28deg' },
            { size: 'clamp(54px, 5.4vw, 90px)', tx: '548px', ty: '-6px', delay: '0.21s', rotate: '24deg' },
            { size: 'clamp(64px, 6vw, 108px)', tx: '-154px', ty: '-316px', delay: '0.14s', rotate: '-10deg' },
            { size: 'clamp(60px, 5.8vw, 104px)', tx: '172px', ty: '288px', delay: '0.2s', rotate: '11deg' }
        ];
        const sparkles = [
            { x: '18%', y: '28%', size: '8px', delay: '0.14s' },
            { x: '24%', y: '66%', size: '10px', delay: '0.26s' },
            { x: '41%', y: '21%', size: '6px', delay: '0.18s' },
            { x: '58%', y: '24%', size: '8px', delay: '0.1s' },
            { x: '72%', y: '34%', size: '9px', delay: '0.22s' },
            { x: '78%', y: '68%', size: '7px', delay: '0.3s' },
            { x: '54%', y: '74%', size: '11px', delay: '0.2s' }
        ];

        return `
            <div class="parlor-bj-blackjack-veil"></div>
            <div class="parlor-bj-blackjack-grain"></div>
            <div class="parlor-bj-blackjack-ring"></div>
            <div class="parlor-bj-blackjack-rays">
                ${rays.map(ray => `
                    <span
                        class="parlor-bj-blackjack-ray"
                        style="--bj-ray-size:${ray.size}; --bj-ray-rotate:${ray.rotate}; --bj-ray-delay:${ray.delay}; --bj-ray-opacity:${ray.opacity};"
                    ></span>
                `).join('')}
            </div>
            <div class="parlor-bj-blackjack-burst">
                ${spades.map(spade => `
                    <span
                        class="parlor-bj-blackjack-spade ${spade.tone || ''}"
                        style="--bj-spade-size:${spade.size}; --bj-spade-tx:${spade.tx}; --bj-spade-ty:${spade.ty}; --bj-spade-delay:${spade.delay}; --bj-spade-rotate:${spade.rotate};"
                    >♠</span>
                `).join('')}
            </div>
            <div class="parlor-bj-blackjack-sparkles">
                ${sparkles.map(spark => `
                    <span
                        class="parlor-bj-blackjack-spark"
                        style="--bj-spark-x:${spark.x}; --bj-spark-y:${spark.y}; --bj-spark-size:${spark.size}; --bj-spark-delay:${spark.delay};"
                    ></span>
                `).join('')}
            </div>
            <div class="parlor-bj-blackjack-banner">
                <div class="parlor-bj-blackjack-plaque">
                    <div class="parlor-bj-blackjack-title">BLACKJACK</div>
                    <div class="parlor-bj-blackjack-sub">${subtitle}</div>
                </div>
            </div>
        `;
    }

    _syncResultFxRound(state) {
        const round = Number.isFinite(Number(state?.round)) ? Number(state.round) : 0;
        if (this._resultFxRound === round) return;
        this._resultFxRound = round;
        this._playedLocalResultFxKeys.clear();
        this._playedSeatBustFxKeys.clear();
        LocalResultFx.clear(this._overlay);
        this._clearSeatBustFx();
    }

    _maybePlaySeatBustFx(state) {
        const hits = this._collectSeatBustFxHits(state);
        if (!hits.length) return;

        hits.forEach(hit => {
            this._playedSeatBustFxKeys.add(hit.key);
            this._playSeatBustFx(hit);
        });
    }

    _collectSeatBustFxHits(state) {
        if (state.phase !== 'PLAYER_TURNS') return [];

        const round = this._resultFxRound ?? 0;
        return this._getActivePlayerIds(state).flatMap(uid => {
            const hand = state.playerHands?.[uid];
            if (hand?.status !== 'bust') return [];

            const key = `bust:${round}:${uid}`;
            if (this._playedSeatBustFxKeys.has(key)) return [];

            return [{
                key,
                uid
            }];
        });
    }

    _playSeatBustFx({ uid }) {
        const seat = this._overlay?.querySelector(`.parlor-bj-seat[data-user-id="${uid}"]`);
        if (!seat) return;

        seat.classList.remove('is-bust-hit');
        void seat.offsetWidth;
        seat.classList.add('is-bust-hit');

        window.setTimeout(() => {
            if (!seat.isConnected) return;
            seat.classList.remove('is-bust-hit');
        }, 860);
    }

    _clearSeatBustFx() {
        this._overlay?.querySelectorAll('.parlor-bj-seat.is-bust-hit').forEach(node => node.classList.remove('is-bust-hit'));
        this._overlay?.querySelectorAll('.parlor-bj-seat-bust-fx').forEach(node => node.remove());
    }

    _maybePlayLocalResultFx(state) {
        const hits = this._collectLocalResultFxHits(state);
        if (!hits.length) return;

        hits.forEach(hit => this._playedLocalResultFxKeys.add(hit.key));
        LocalResultFx.enqueue(this._overlay, hits);
    }

    _collectLocalResultFxHits(state) {
        if (state.phase !== 'RESOLVING') return [];

        const round = this._resultFxRound ?? 0;
        const controlledIds = this._getControlledParticipantIds(state);
        return controlledIds.flatMap(uid => {
            const hand = state.playerHands?.[uid];
            if (!hand) return [];

            const key = `resolve:${round}:${uid}`;
            if (this._playedLocalResultFxKeys.has(key)) return [];

            const bet = Number(hand.bet || 0);
            const payout = Number((state.payouts || {})[uid] || 0);
            const delta = payout - bet;
            const tone = delta > 0 ? 'win' : (delta < 0 ? 'lose' : 'push');
            const amountText = this._formatPlainDelta(delta);

            return [{
                key,
                tone,
                icon: tone === 'win' ? '✦' : (tone === 'lose' ? '✕' : '○'),
                title: this._t(
                    tone === 'win'
                        ? 'PARLOR.ResultFx.WinTitle'
                        : (tone === 'lose' ? 'PARLOR.ResultFx.LoseTitle' : 'PARLOR.ResultFx.PushTitle')
                ),
                sub: `${this._playerName(uid, state)} · ${amountText}`,
                duration: 1460
            }];
        });
    }

    // ═══════════════ 庄家牌区（V14 兼容） ═══════════════

    _renderDealerCards(state) {
        const el = this._overlay.querySelector('#bj-dealer-cards');
        if (!el) return;

        const dh = state.dealerHand;
        if (!dh) { el.innerHTML = ''; return; }

        const allCards = [...(dh.handCards || []), ...(dh.tableCards || [])];
        if (!allCards.length) { el.innerHTML = ''; return; }

        const revealDealer = ['DEALER_TURN', 'RESOLVING', 'SETTLE'].includes(state.phase);
        const showAll = ['RESOLVING', 'SETTLE'].includes(state.phase);
        const isDealerController = this._isDealerController(state);
        const dealerTitle = this._getDealerTitle(state);
        const badge = this._overlay.querySelector('.parlor-bj-dealer-badge');

        // 控庄者平时可以只看底部面板，但一到庄家回合就得把上面的牌亮出来。
        if (isDealerController && !revealDealer) {
            el.innerHTML = '';
            this._renderedDealerCards = 0;
            this._dealerCardsRevealed = false;
            if (badge) {
                const total = revealDealer ? this._handValue(allCards) : '?';
                badge.innerHTML = `<i class="fas fa-crown"></i> ${dealerTitle} <span class="parlor-bj-dealer-total">${total}</span>`;
            }
            return;
        }

        // V14 兼容：非控庄视角把发牌和翻牌拆开做，桌面上的庄家牌更完整一点
        const shouldReset = allCards.length < this._renderedDealerCards;
        if (shouldReset) {
            el.innerHTML = '';
            this._renderedDealerCards = 0;
            this._dealerCardsRevealed = false;
        }

        const startIndex = this._renderedDealerCards;
        if (allCards.length > startIndex) {
            for (let i = startIndex; i < allCards.length; i++) {
                const card = allCards[i];
                const hidden = i === 1 && !revealDealer;
                const cardEl = CardRenderer.createCard(card, {
                    faceDown: true,
                    size: 'table'
                });
                CardRenderer.dealFrom(cardEl, { x: 0, y: -280 }, (i - startIndex) * 220, {
                    flipAfter: hidden ? null : { faceDown: false, delay: 90, duration: 420 }
                });
                el.appendChild(cardEl);
            }
            this._renderedDealerCards = allCards.length;
        }

        this._syncDealerRevealState(el, {
            revealDealer,
            existingCount: startIndex
        });

        if (badge) {
            const total = revealDealer ? this._handValue(allCards) : '?';
            badge.innerHTML = `<i class="fas fa-crown"></i> ${dealerTitle} <span class="parlor-bj-dealer-total">${total}</span>`;
        }
    }

    _syncDealerRevealState(container, { revealDealer, existingCount = 0 } = {}) {
        const hiddenCard = container?.children?.[1];
        if (!hiddenCard || existingCount <= 1) {
            this._dealerCardsRevealed = revealDealer;
            return;
        }

        const shouldFaceDown = !revealDealer;
        const isFaceDown = hiddenCard.classList.contains('face-down');
        if (shouldFaceDown !== isFaceDown) {
            // 这里只同步已经在桌上的那张庄家暗牌，避免新发出来的牌被提前翻开。
            CardRenderer.flip(hiddenCard, shouldFaceDown, 420, { silent: shouldFaceDown });
        }

        this._dealerCardsRevealed = revealDealer;
    }

    // ═══════════════ 中央区（V14 兼容） ═══════════════

    _renderCenter(state) {
        const el = this._overlay.querySelector('#bj-center');
        const statusDock = this._overlay.querySelector('#bj-status-dock');
        if (!el || !statusDock) return;

        const isGM = game.user.isGM;
        const myId = this._getSelectedParticipantId(state, { preferTurn: state.phase === 'PLAYER_TURNS' });
        const dealerTitle = this._getDealerTitle(state);
        const isDealerController = this._isDealerController(state);
        const setCards = (html = '') => { el.innerHTML = html; };
        const setStatus = (html = '') => { statusDock.innerHTML = html; };

        switch (state.phase) {
            case 'BETTING': {
                const activePlayers = this._getBettingPlayerIds(state);
                const betted = (state.bets || []).filter(b => activePlayers.includes(b.userId)).length;
                let html = `<div class="parlor-prompt-text">💰 ${this._t('PARLOR.Blackjack.Center.BettingTitle', { betted, total: activePlayers.length })}</div>`;
                if (!activePlayers.length) {
                    html += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.NoEligibleBettors')}</div>`;
                } else if (isDealerController) {
                    html += `<div class="parlor-prompt-sub">🎩 ${this._t('PARLOR.Blackjack.Center.BettingDealerControlled', { dealer: dealerTitle })}</div>`;
                } else if (isGM) {
                    html += `<div class="parlor-prompt-sub">🪄 ${this._t('PARLOR.Blackjack.Center.BettingGMReady', { dealer: dealerTitle })}</div>`;
                } else {
                    const hasBet = state.bets?.some(b => b.userId === myId);
                    const canBet = activePlayers.includes(myId);
                    if (!canBet) {
                        html += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.SittingOutNoChips')}</div>`;
                    } else if (!hasBet) {
                        html += `<div class="parlor-bet-form">
                            <input type="number" id="bj-bet-input" value="${this._getBetDraftAmount(myId)}" min="1" class="parlor-bet-input" placeholder="GP">
                            <button class="parlor-hud-action-btn" id="bj-bet-confirm"><i class="fas fa-coins"></i> ${this._t('PARLOR.Common.Bet')}</button>
                        </div>`;
                    } else {
                        html += `<div class="parlor-prompt-sub">✅ ${this._t('PARLOR.Blackjack.Center.BettingConfirmed')}</div>`;
                    }
                }
                setCards('');
                setStatus(`<div class="parlor-bj-prompt">${html}</div>`);
                statusDock.querySelector('#bj-bet-input')?.addEventListener('input', (event) => {
                    this._setBetDraftAmount(myId, event.currentTarget.value);
                });
                statusDock.querySelector('#bj-bet-confirm')?.addEventListener('click', async (event) => {
                    const amt = this._setBetDraftAmount(myId, statusDock.querySelector('#bj-bet-input')?.value);
                    const result = await this._requestPlayerAction({
                        userId: myId,
                        action: 'placeBet',
                        data: { amount: amt },
                        button: event.currentTarget
                    });
                    if (!result?.ok) this._showBetFailure(result, myId, amt);
                });
                break;
            }

            case 'READY': {
                let html = `<div class="parlor-prompt-text">🎴 ${this._t('PARLOR.Blackjack.Center.ReadyTitle')}</div>`;
                if (isGM) {
                    html += `<button class="parlor-hud-action-btn accent" id="bj-start-deal" ${this._actionDisabledAttr(this._gmActionKey('startDeal'))}><i class="fas fa-hand-holding"></i> ${this._t('PARLOR.Common.Deal')}</button>`;
                    html += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.ReadyDealerReady', { dealer: dealerTitle })}</div>`;
                } else {
                    html += `<div class="parlor-prompt-sub">⏳ ${this._t('PARLOR.Blackjack.Center.ReadyWaitingDealer')}</div>`;
                }
                setCards('');
                setStatus(`<div class="parlor-bj-prompt">${html}</div>`);
                statusDock.querySelector('#bj-start-deal')?.addEventListener('click', (event) => {
                    this._requestGMAction({
                        action: 'startDeal',
                        button: event.currentTarget
                    });
                });
                break;
            }

            case 'DEALING': {
                setCards('');
                setStatus(`
                    <div class="parlor-bj-prompt">
                        <div class="parlor-prompt-text">🎴 ${this._t('PARLOR.Common.Dealing')}</div>
                        <div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.DealingSub')}</div>
                    </div>
                `);
                break;
            }

            case 'PLAYER_TURNS': {
                const cid = state.currentPlayerId;
                const hand = state.playerHands?.[cid];
                if (!cid || !hand) {
                    setCards('');
                    setStatus(`<div class="parlor-bj-prompt"><div class="parlor-prompt-text">${this._t('PARLOR.Blackjack.Center.WaitingNextPlayer')}</div></div>`);
                    this._renderedCenterKey = '';
                    this._renderedCenterCards = 0;
                    break;
                }
                const name = this._playerName(cid);
                const centerKey = `player_${cid}`;
                const tableCards = hand?.tableCards || [];
                const pendingHit = state.pendingAction?.userId === cid && state.pendingAction?.action === 'hit';
                const pendingStage = pendingHit ? (state.pendingAction?.stage || 'requested') : '';
                const visibleTotal = this._getVisibleHandTotal(hand, state.rules);
                const bustThreshold = this._getBustThreshold(state);
                const willBust = visibleTotal > bustThreshold;
                const canHit = cid === myId && this._canPlayerHit(state, hand, myId);
                const canStand = cid === myId && this._canPlayerStand(state, hand, myId);

                // V14 兼容：提示区可以重建，但发牌动画只补新增的
                let cardsHTML = '';
                if (tableCards.length) {
                    cardsHTML += '<div class="parlor-bj-center-cards" id="bj-center-cards"></div>';
                }
                let subText = cid === myId ? this._t('PARLOR.Blackjack.Center.PlayerTurnSelf') : this._t('PARLOR.Blackjack.Center.PlayerTurnWait', { name });
                let actionHTML = '';
                const confirmHitKey = this._gmActionKey('confirmDeal');
                const requestHitKey = this._playerActionKey(myId, 'requestHit');
                const standKey = this._playerActionKey(myId, 'requestStand');
                if (pendingHit) {
                    if (pendingStage === 'requested' && isGM) {
                        subText = this._t('PARLOR.Blackjack.Center.PendingHitGM', { name });
                        actionHTML = `
                            <div class="parlor-prompt-actions">
                                <button class="parlor-hud-action-btn accent" id="bj-confirm-hit" ${this._actionDisabledAttr(confirmHitKey)}><i class="fas fa-clone"></i> ${this._t('PARLOR.Common.Deal')}</button>
                            </div>
                        `;
                    } else if (pendingStage === 'dealing') {
                        subText = cid === myId ? this._t('PARLOR.Blackjack.Center.PendingHitDealingSelf') : this._t('PARLOR.Blackjack.Center.PendingHitDealingOther', { name });
                    } else if (cid === myId) {
                        subText = this._t('PARLOR.Blackjack.Center.PendingHitWaitingDM');
                    } else {
                        subText = this._t('PARLOR.Blackjack.Center.PendingHitWaitingOther', { name });
                    }
                } else if (tableCards.length) {
                    subText = willBust
                        ? (cid === myId
                            ? this._t('PARLOR.Blackjack.Center.TableCardsWillBustSelf', { count: tableCards.length, total: visibleTotal })
                            : this._t('PARLOR.Blackjack.Center.TableCardsWillBustOther', { name, count: tableCards.length, total: visibleTotal }))
                        : (cid === myId
                            ? this._t('PARLOR.Blackjack.Center.TableCardsCollectSelf', { count: tableCards.length, total: visibleTotal })
                            : this._t('PARLOR.Blackjack.Center.TableCardsCollectOther', { name, count: tableCards.length, total: visibleTotal }));
                } else if (hand.status === 'bust') {
                    subText = this._t('PARLOR.Blackjack.Center.PlayerBust', { name });
                } else if (cid === myId) {
                    const buttons = [];
                    if (canHit) {
                        buttons.push(`<button class="parlor-hud-action-btn" id="bj-request-hit" ${this._actionDisabledAttr(requestHitKey)}><i class="fas fa-plus"></i> ${this._t('PARLOR.Common.Hit')}</button>`);
                    }
                    if (canStand) {
                        buttons.push(`<button class="parlor-hud-action-btn accent" id="bj-request-stand" ${this._actionDisabledAttr(standKey)}><i class="fas fa-hand-paper"></i> ${this._t('PARLOR.Common.Stand')}</button>`);
                    }
                    if (buttons.length) {
                        actionHTML = `<div class="parlor-prompt-actions">${buttons.join('')}</div>`;
                    }
                }
                const statusHTML = `
                    <div class="parlor-bj-prompt">
                        <div class="parlor-prompt-text">${pendingHit ? this._t('PARLOR.Blackjack.Center.PlayerRequestedHit', { name }) : (hand.status === 'bust' ? this._t('PARLOR.Blackjack.Center.PlayerBust', { name }) : this._t('PARLOR.Blackjack.Center.PlayerTurnTitle', { name }))}</div>
                        <div class="parlor-prompt-sub">${subText}</div>
                        ${actionHTML}
                    </div>
                `;
                setCards(cardsHTML);
                setStatus(statusHTML);

                // V14 兼容：中央 tableCards 只补动画，不全量重播
                const ccEl = el.querySelector('#bj-center-cards');
                if (ccEl && tableCards.length) {
                    const samePlayer = this._renderedCenterKey === centerKey;
                    const startIdx = samePlayer ? this._renderedCenterCards : 0;
                    tableCards.forEach((card, ci) => {
                        const isNewCard = ci >= startIdx;
                        const cardEl = CardRenderer.createCard(card, {
                            faceDown: isNewCard,
                            size: 'table'
                        });
                        if (ci >= startIdx) {
                            CardRenderer.dealFrom(cardEl, { x: 0, y: -320 }, (ci - startIdx) * 220, {
                                flipAfter: { faceDown: false, delay: 110, duration: 420 }
                            });
                        }
                        ccEl.appendChild(cardEl);
                    });
                }

                statusDock.querySelector('#bj-confirm-hit')?.addEventListener('click', (event) => {
                    this._requestGMAction({
                        action: 'confirmDeal',
                        button: event.currentTarget
                    });
                });
                statusDock.querySelector('#bj-request-hit')?.addEventListener('click', (event) => {
                    this._requestPlayerAction({
                        userId: myId,
                        action: 'requestHit',
                        data: {},
                        button: event.currentTarget
                    });
                });
                statusDock.querySelector('#bj-request-stand')?.addEventListener('click', (event) => {
                    this._requestPlayerAction({
                        userId: myId,
                        action: 'requestStand',
                        data: {},
                        button: event.currentTarget
                    });
                });

                this._renderedCenterKey = centerKey;
                this._renderedCenterCards = tableCards.length;
                break;
            }

            case 'DEALER_TURN': {
                const dh = state.dealerHand;
                const dealerStatus = dh?.status || 'playing';

                let statusHTML = `<div class="parlor-bj-prompt"><div class="parlor-prompt-text">🎩 ${this._t('PARLOR.Blackjack.Center.DealerTurnTitle')}</div>`;
                if (dealerStatus === 'dealing') {
                    statusHTML += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.DealerCollecting')}</div>`;
                } else if (isGM) {
                    statusHTML += `<div class="parlor-prompt-actions">
                        <button class="parlor-hud-action-btn" id="bj-dealer-hit" ${this._actionDisabledAttr(this._gmActionKey('dealerHit'))}><i class="fas fa-plus"></i> ${this._t('PARLOR.Blackjack.Action.DealerHit')}</button>
                        <button class="parlor-hud-action-btn accent" id="bj-dealer-stand" ${this._actionDisabledAttr(this._gmActionKey('dealerStand'))}><i class="fas fa-hand-paper"></i> ${this._t('PARLOR.Common.Stand')}</button>
                    </div>`;
                } else {
                    statusHTML += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.DealerActing')}</div>`;
                }
                statusHTML += '</div>';
                setCards('');
                setStatus(statusHTML);

                statusDock.querySelector('#bj-dealer-hit')?.addEventListener('click', (event) => {
                    this._requestGMAction({
                        action: 'dealerHit',
                        button: event.currentTarget
                    });
                });
                statusDock.querySelector('#bj-dealer-stand')?.addEventListener('click', (event) => {
                    this._requestGMAction({
                        action: 'dealerStand',
                        button: event.currentTarget
                    });
                });

                this._renderedCenterKey = '';
                this._renderedCenterCards = 0;
                break;
            }

            case 'SETTLE': {
                const dealerCards = [...(state.dealerHand?.handCards || []), ...(state.dealerHand?.tableCards || [])];
                const dealerTotal = this._handValue(dealerCards, state.rules);
                const busted = state.dealerHand?.status === 'bust' || dealerTotal > this._getBustThreshold(state);
                let html = `
                    <div class="parlor-bj-prompt">
                        <div class="parlor-prompt-text">${busted ? `💥 ${this._t('PARLOR.Blackjack.Center.DealerBustTitle')}` : `🏁 ${this._t('PARLOR.Blackjack.Center.SettleTitle')}`}</div>
                        <div class="parlor-prompt-sub">${busted ? this._t('PARLOR.Blackjack.Center.DealerBustSub', { total: dealerTotal }) : this._t('PARLOR.Blackjack.Center.DealerFinalTotal', { dealer: dealerTitle, total: dealerTotal })}</div>
                `;
                if (isGM) {
                    html += `
                        <div class="parlor-prompt-actions">
                            <button class="parlor-hud-action-btn accent" id="bj-finalize-settle" ${this._actionDisabledAttr(this._gmActionKey('settle'))}><i class="fas fa-file-invoice-dollar"></i> ${this._t('PARLOR.Common.Settle')}</button>
                        </div>
                    `;
                } else {
                    html += `<div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.WaitingSettlementDM')}</div>`;
                }
                html += '</div>';
                setCards('');
                setStatus(html);
                statusDock.querySelector('#bj-finalize-settle')?.addEventListener('click', (event) => {
                    this._requestGMAction({
                        action: 'settle',
                        button: event.currentTarget
                    });
                });
                break;
            }

            case 'RESOLVING': {
                // V14 兼容：结果弹窗单独走，中央区这里只留个状态占位
                setCards('');
                setStatus(`<div class="parlor-bj-prompt"><div class="parlor-prompt-text">🏁 ${this._t('PARLOR.Blackjack.Center.ResolvingTitle')}</div><div class="parlor-prompt-sub">${this._t('PARLOR.Blackjack.Center.ResolvingSub')}</div></div>`);
                break;
            }
        }
    }

    // ═══════════════ 结算弹窗（V14 兼容） ═══════════════

    _showSettlementPopup(state) {
        // V14 兼容：先把旧弹窗拆掉，避免重复挂层
        document.querySelector('#parlor-bj-settlement')?.remove();

        const isGM = game.user.isGM;
        const popup = document.createElement('div');
        popup.id = 'parlor-bj-settlement';
        popup.className = 'parlor-bj-settlement-overlay';
        popup.dataset.bjStyle = 'v14';
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        // V14 兼容：结果表等输赢真正落地后再显示，这里直接给净输赢
        let rows = '';
        const dealerCards = [...(state.dealerHand?.handCards || []), ...(state.dealerHand?.tableCards || [])];
        const dealerTotal = this._handValue(dealerCards, state.rules);

        const dealerTitle = this._getDealerTitle(state);
        const dealerBust = dealerTotal > this._getBustThreshold(state) || state.dealerHand?.status === 'bust';

        // V14 兼容：庄家行固定放最前面
        rows += `<tr class="dealer-row">
            <td>🎩 ${dealerTitle}</td>
            <td>${dealerTotal}</td>
            <td>—</td>
            <td>${dealerBust ? `<span class="lose">${this._t('PARLOR.Common.Bust')}</span>` : `<span style="color:#aaa;">${this._t('PARLOR.Common.Dealer')}</span>`}</td>
        </tr>`;

        for (const uid of (state.turnOrder || [])) {
            const name = this._playerName(uid);
            const hand = state.playerHands?.[uid];
            const allCards = [...(hand?.handCards || []), ...(hand?.tableCards || [])];
            const total = this._handValue(allCards, state.rules);
            const payout = (state.payouts || {})[uid] || 0;
            const bet = hand?.bet || 0;
            const delta = payout - bet;
            const status = hand?.status || '';

            let resultHTML;
            if (status === 'blackjack') {
                resultHTML = '<span class="win">🎯 Blackjack</span>';
            } else if (status === 'bust') {
                resultHTML = `<span class="lose">💥 ${this._t('PARLOR.Common.Bust')}</span>`;
            } else if (delta > 0) {
                resultHTML = `<span class="win">${this._t('PARLOR.Common.Win')}</span>`;
            } else if (delta < 0) {
                resultHTML = `<span class="lose">${this._t('PARLOR.Common.Lose')}</span>`;
            } else if (payout === 0) {
                resultHTML = `<span class="lose">${this._t('PARLOR.Common.Lose')}</span>`;
            } else {
                resultHTML = `<span style="color:#aaa;">${this._t('PARLOR.Common.Tie')}</span>`;
            }

            rows += `<tr>
                <td>${name}</td>
                <td>${total}</td>
                <td>${bet} GP</td>
                <td>${resultHTML} ${this._formatDelta(delta)}</td>
            </tr>`;
        }

        popup.innerHTML = `
            <div class="parlor-bj-settlement-box">
                <div class="settlement-title">🏁 ${this._t('PARLOR.Blackjack.Settlement.Title')}</div>
                <table class="settlement-table">
                    <thead><tr><th>${this._t('PARLOR.Common.Player')}</th><th>${this._t('PARLOR.Blackjack.Settlement.Points')}</th><th>${this._t('PARLOR.Common.Bet')}</th><th>${this._t('PARLOR.Blackjack.Settlement.Profit')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-prompt-actions" style="margin-top:16px;">
                    ${isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="bj-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="bj-next-round"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="bj-dismiss-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        popup.querySelector('#bj-dismiss-settlement')?.addEventListener('click', () => {
            popup.remove();
        });
        popup.querySelector('#bj-finish-game')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#bj-next-round')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'finishGame' });
        });
        popup.querySelector('#bj-next-round')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#bj-finish-game')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'newRound' });
        });
    }

    // ═══════════════ 座位（V14 兼容） ═══════════════

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#bj-seat-left');
        const rightColumn = this._overlay.querySelector('#bj-seat-right');
        if (!leftColumn || !rightColumn) return;
        leftColumn.innerHTML = '';
        rightColumn.innerHTML = '';

        const myId = this._getSelfSeatParticipantId(state);
        const allSeatIds = this._getActivePlayerIds(state);
        const hasMe = allSeatIds.includes(myId);
        const otherSeatIds = allSeatIds.filter(uid => uid !== myId).slice(0, hasMe ? MAX_VISIBLE_SEATS - 1 : MAX_VISIBLE_SEATS);

        let leftSeatIds = [];
        let rightSeatIds = [];

        // V14 兼容优先：左右列固定保留，让赌桌永远在视觉中心。
        if (hasMe) {
            const leftCount = Math.min(MAX_SIDE_SEATS, Math.ceil(otherSeatIds.length / 2));
            leftSeatIds = otherSeatIds.slice(0, leftCount);
            rightSeatIds = [myId, ...otherSeatIds.slice(leftCount, leftCount + (MAX_SIDE_SEATS - 1))];
        } else {
            const leftCount = Math.min(MAX_SIDE_SEATS, Math.ceil(otherSeatIds.length / 2));
            leftSeatIds = otherSeatIds.slice(0, leftCount);
            rightSeatIds = otherSeatIds.slice(leftCount, leftCount + MAX_SIDE_SEATS);
        }

        leftColumn.classList.toggle('is-empty', leftSeatIds.length === 0);
        rightColumn.classList.toggle('is-empty', rightSeatIds.length === 0);

        if (!leftSeatIds.length && !rightSeatIds.length) return;

        const visibleSeatIds = [...leftSeatIds, ...rightSeatIds];

        const betMap = {};
        if (state.bets) for (const b of state.bets) betMap[b.userId] = b.amount;

        const seatEntries = [
            ...leftSeatIds.map((uid, index) => ({
                uid,
                zone: 'left',
                target: leftColumn
            })),
            ...rightSeatIds.map((uid, index) => ({
                uid,
                zone: 'right',
                target: rightColumn
            }))
        ];

        seatEntries.forEach(({ uid, zone, target }) => {
            const hand = state.playerHands?.[uid];
            const isMe = uid === myId;
            const isActive = state.currentPlayerId === uid && state.phase === 'PLAYER_TURNS';
            const participant = this._describeParticipant(uid, state);
            const seatName = isMe ? this._t('PARLOR.Common.You') : participant.name;
            const seatNum = Math.max(1, visibleSeatIds.indexOf(uid) + 1);

            const seat = document.createElement('div');
            seat.className = `parlor-bj-seat seat-${zone}${isMe ? ' is-me' : ''}${isActive ? ' active-turn' : ''}${hand?.status === 'bust' ? ' is-bust' : ''}`;
            seat.dataset.userId = uid;

            // V14 兼容：座位内容保持轻量，避免频繁重建太重
            const seatMark = participant.kind === 'bot' ? this._t('PARLOR.Common.BOT') : (participant.kind === 'npc' ? this._t('PARLOR.Common.NPC') : this._t('PARLOR.Common.Player'));
            const avatar = participant.avatarHtml;
            const betAmt = hand?.bet || betMap[uid];

            let statusClass = 'status-idle';
            let statusText = this._t('PARLOR.Blackjack.Seat.Seated');
            if (hand?.status === 'playing') {
                statusClass = isActive ? 'status-playing' : 'status-live';
                statusText = isActive ? this._t('PARLOR.Blackjack.Seat.Acting') : this._t('PARLOR.Blackjack.Seat.Playing');
            } else if (hand?.status === 'awaiting_deal') {
                statusClass = 'status-playing';
                statusText = this._t('PARLOR.Blackjack.Seat.AwaitingDeal');
            } else if (hand?.status === 'awaiting_collect') {
                statusClass = 'status-playing';
                statusText = this._t('PARLOR.Blackjack.Seat.AwaitingCollect');
            } else if (hand?.status === 'dealing') {
                statusClass = 'status-playing';
                statusText = this._t('PARLOR.Common.Dealing');
            } else if (hand?.status === 'bust') {
                statusClass = 'status-bust';
                statusText = this._t('PARLOR.Common.Bust');
            } else if (hand?.status === 'blackjack') {
                statusClass = 'status-blackjack';
                statusText = 'Blackjack';
            } else if (hand?.status === 'stand') {
                statusClass = 'status-stand';
                statusText = this._t('PARLOR.Common.Stand');
            } else if (betAmt) {
                statusClass = 'status-live';
                statusText = this._t('PARLOR.Blackjack.Seat.BetPlaced');
            }

            seat.innerHTML = `
                <div class="parlor-bj-seat-avatar-wrap">
                    <div class="parlor-bj-seat-avatar">${avatar}</div>
                </div>
                <div class="parlor-bj-seat-info">
                    <div class="parlor-bj-seat-head">
                        <div class="parlor-bj-seat-head-top">
                            <span class="parlor-bj-seat-name-mark">${seatMark}</span>
                            <div class="parlor-bj-seat-num">#${seatNum}</div>
                        </div>
                        <div class="parlor-bj-seat-name">
                            <span class="parlor-bj-seat-name-text">${seatName}</span>
                        </div>
                    </div>
                    <div class="parlor-bj-seat-meta">
                        ${betAmt ? `<div class="parlor-bj-seat-bet">${betAmt} GP</div>` : `<div class="parlor-bj-seat-bet is-empty">${this._t('PARLOR.Common.WaitingBet')}</div>`}
                        <div class="parlor-bj-seat-status ${statusClass}">${statusText}</div>
                    </div>
                </div>
            `;

            target.appendChild(seat);
        });
    }

    // ═══════════════ 手牌 HUD（V14 兼容） ═══════════════

    _renderHandHUD(state) {
        const myId = this._getSelectedParticipantId(state, { preferTurn: true });
        const isGM = game.user.isGM;
        const dealerController = this._isDealerController(state);
        const controlledIds = this._getControlledParticipantIds(state);
        const playerParticipant = controlledIds.length > 0;
        const preferDealerFooter = ['DEALER_TURN', 'SETTLE'].includes(state.phase);
        const useDealerFooter = preferDealerFooter
            ? (dealerController || (isGM && !playerParticipant))
            : (!playerParticipant && (dealerController || isGM));

        let cards = [];
        let actions = [];
        let footerHtml = '';

        if (useDealerFooter) {
            const dh = state.dealerHand;
            if (dh) {
                cards = dealerController ? this._getDealerHudCards(state, dh) : [];
            }
            footerHtml = this._buildDealerHudFooter(state, { isGM, dealerHand: dh });
        } else if (playerParticipant) {
            const myHand = state.playerHands?.[myId];
            if (myHand) {
                cards = this._getPlayerHudCards(state, myHand);
                const isMyTurn = state.currentPlayerId === myId && state.phase === 'PLAYER_TURNS';
                if (isMyTurn) {
                    if (this._canPlayerHit(state, myHand, myId)) {
                        actions.push({
                            label: this._t('PARLOR.Common.Hit'),
                            icon: 'fas fa-plus',
                            disabled: this._isActionPending(this._playerActionKey(myId, 'requestHit')),
                            callback: (event) => {
                                this._requestPlayerAction({
                                    userId: myId,
                                    action: 'requestHit',
                                    data: {},
                                    button: event.currentTarget
                                });
                            }
                        });
                    }
                    if (this._canPlayerStand(state, myHand, myId)) {
                        actions.push({
                            label: this._t('PARLOR.Common.Stand'),
                            icon: 'fas fa-hand-paper',
                            disabled: this._isActionPending(this._playerActionKey(myId, 'requestStand')),
                            callback: (event) => {
                                this._requestPlayerAction({
                                    userId: myId,
                                    action: 'requestStand',
                                    data: {},
                                    button: event.currentTarget
                                });
                            }
                        });
                    }
                }
                footerHtml = this._buildPlayerHudFooter(state, { myId, myHand });
            } else {
                footerHtml = this._buildPlayerHudFooter(state, { myId, myHand: null });
            }
        } else {
            footerHtml = '';
        }

        const shouldShowHud = !!cards.length || !!actions.length || !!footerHtml;
        if (!shouldShowHud) {
            this._handHUD.destroy();
            this._prevCardCount = 0;
            this._hudCardOwner = '';
            this._hudCardSigns = [];
            this._queuedHudFlights = [];
            return;
        }

        const nextCardOwner = useDealerFooter ? 'dealer' : (myId || '');
        const nextCardSigns = cards.map(card => this._getHudCardSign(card));
        const nextCardCount = cards.length;
        if (!this._handHUD.root) {
            this._handHUD.show(cards);
            this._prevCardCount = nextCardCount;
            this._hudCardOwner = nextCardOwner;
            this._hudCardSigns = nextCardSigns;
        } else if (!this._sameHudCardState(nextCardOwner, nextCardSigns)) {
            if (this._canAppendHudCards(nextCardOwner, nextCardSigns)) {
                const queuedFlights = [...this._queuedHudFlights];
                for (const card of cards.slice(this._prevCardCount)) {
                    this._handHUD.addCard(card, { fromRect: queuedFlights.shift()?.fromRect || null });
                }
                this._queuedHudFlights = queuedFlights;
            } else if (this._prevCardCount === 0 || nextCardCount < this._prevCardCount) {
                this._handHUD.show(cards);
            } else {
                this._handHUD.updateCards(cards);
            }
            this._prevCardCount = nextCardCount;
            this._hudCardOwner = nextCardOwner;
            this._hudCardSigns = nextCardSigns;
        }

        if (actions.length) {
            this._handHUD.showActions(actions);
        } else {
            this._handHUD.hideActions();
        }

        if (footerHtml) {
            this._handHUD.showFooter(footerHtml);
            this._bindHudFooter(state, { myId, isGM, dealerController, useDealerFooter });
        } else {
            this._handHUD.hideFooter();
        }
    }

    _buildDealerHudFooter(state, { isGM, dealerHand }) {
        const activePlayers = this._getBettingPlayerIds(state);
        const bettedCount = (state.bets || []).filter(b => activePlayers.includes(b.userId)).length;
        const dealerCards = [...(dealerHand?.handCards || []), ...(dealerHand?.tableCards || [])];
        const dealerTotal = dealerCards.length ? this._handValue(dealerCards, state.rules) : '?';
        const currentName = state.currentPlayerId ? this._playerName(state.currentPlayerId) : this._t('PARLOR.Common.Waiting');

        let title = this._t('PARLOR.Blackjack.Hud.DealerPanel');
        let sub = this._t('PARLOR.Blackjack.Hud.DealerWaiting');
        let rightHtml = `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.Hud.DealerPoints', { total: dealerTotal })}</span></div>`;

        if (state.phase === 'BETTING') {
            title = this._t('PARLOR.Blackjack.Hud.WaitingBets');
            sub = this._t('PARLOR.Blackjack.Hud.BetsProgress', { betted: bettedCount, total: activePlayers.length });
            rightHtml = `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.Hud.PhaseBetting')}</span></div>`;
        } else if (state.phase === 'DEALING') {
            title = this._t('PARLOR.Common.Dealing');
            sub = this._t('PARLOR.Blackjack.Hud.DealingSub');
            rightHtml = `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.Dealing')}</span></div>`;
        } else if (state.phase === 'READY') {
            title = this._t('PARLOR.Blackjack.Hud.DealerReady');
            sub = this._t('PARLOR.Blackjack.Hud.DealerReadySub');
            rightHtml = isGM
                ? `<div class="parlor-hud-footer-actions"><button class="parlor-hud-action-btn accent" id="bj-hud-start-deal" ${this._actionDisabledAttr(this._gmActionKey('startDeal'))}><i class="fas fa-hand-holding"></i> ${this._t('PARLOR.Common.Deal')}</button></div>`
                : `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.WaitingDeal')}</span></div>`;
        } else if (state.phase === 'PLAYER_TURNS') {
            title = this._t('PARLOR.Blackjack.Hud.PlayerTurnTitle', { name: currentName });
            sub = state.pendingAction?.action === 'hit'
                ? this._t('PARLOR.Blackjack.Hud.PlayerHitRequested')
                : this._t('PARLOR.Blackjack.Hud.PlayerTurnSub');
            rightHtml = isGM && state.pendingAction?.action === 'hit' && state.pendingAction?.stage === 'requested'
                ? `<div class="parlor-hud-footer-actions"><button class="parlor-hud-action-btn accent" id="bj-hud-confirm-hit" ${this._actionDisabledAttr(this._gmActionKey('confirmDeal'))}><i class="fas fa-clone"></i> ${this._t('PARLOR.Common.Deal')}</button></div>`
                : `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.Hud.PhasePlayerTurn')}</span></div>`;
        } else if (state.phase === 'DEALER_TURN') {
            title = this._t('PARLOR.Blackjack.Hud.DealerAction');
            sub = dealerHand?.status === 'dealing' ? this._t('PARLOR.Blackjack.Hud.DealerCollecting') : this._t('PARLOR.Blackjack.Hud.DealerDecision');
            rightHtml = isGM && dealerHand?.status !== 'dealing'
                ? `
                    <div class="parlor-hud-footer-actions">
                        <button class="parlor-hud-action-btn" id="bj-hud-dealer-hit" ${this._actionDisabledAttr(this._gmActionKey('dealerHit'))}><i class="fas fa-plus"></i> ${this._t('PARLOR.Blackjack.Action.DealerHit')}</button>
                        <button class="parlor-hud-action-btn accent" id="bj-hud-dealer-stand" ${this._actionDisabledAttr(this._gmActionKey('dealerStand'))}><i class="fas fa-hand-paper"></i> ${this._t('PARLOR.Common.Stand')}</button>
                    </div>
                `
                : `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.Hud.PhaseDealerTurn')}</span></div>`;
        } else if (state.phase === 'SETTLE') {
            title = this._t('PARLOR.Blackjack.Hud.SettleReady');
            sub = this._t('PARLOR.Blackjack.Hud.DealerFinalPoints', { total: dealerTotal });
            rightHtml = isGM
                ? `<div class="parlor-hud-footer-actions"><button class="parlor-hud-action-btn accent" id="bj-hud-finalize-settle" ${this._actionDisabledAttr(this._gmActionKey('settle'))}><i class="fas fa-file-invoice-dollar"></i> ${this._t('PARLOR.Common.Settle')}</button></div>`
                : `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.WaitingSettlement')}</span></div>`;
        } else if (state.phase === 'RESOLVING') {
            title = this._t('PARLOR.Blackjack.Hud.ResultReady');
            sub = this._t('PARLOR.Common.SettlementOpen');
            rightHtml = `<div class="parlor-hud-footer-metrics"><span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.Hud.RoundDone')}</span></div>`;
        }

        return `
            <div class="parlor-hud-footer-main">
                <div class="parlor-hud-footer-side">
                    <span class="parlor-hud-footer-label">${this._t('PARLOR.Common.Dealer')}</span>
                    <span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.Hud.PointsPill', { total: dealerTotal })}</span>
                </div>
                <div class="parlor-hud-footer-center">
                    <div class="parlor-hud-footer-title">${title}</div>
                    <div class="parlor-hud-footer-sub">${sub}</div>
                </div>
                <div class="parlor-hud-footer-side align-right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _buildPlayerHudFooter(state, { myId, myHand }) {
        const bet = myHand?.bet || 0;
        const total = myHand ? this._getVisibleHandTotal(myHand, state.rules) : null;
        const payout = (state.payouts || {})[myId] || 0;
        const roundDelta = myHand ? payout - bet : 0;
        const hasBet = bet > 0;
        const balanceLabel = myId ? ChipManager.getDisplayBalance(myId) : null;
        const betDraftAmount = this._getBetDraftAmount(myId);
        const canBet = this._getBettingPlayerIds(state).includes(myId);
        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => this._getActivePlayerIds(state).includes(entry.id));
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="bj-hud-participant-select" class="parlor-hud-footer-input" style="width:180px;">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === myId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : '';
        const participant = myId ? this._describeParticipant(myId, state) : null;
        const participantLabel = participant?.isSelf ? this._t('PARLOR.Common.YourRole') : (participant?.name || this._t('PARLOR.Common.CurrentRole'));
        const chipPill = balanceLabel == null
            ? ''
            : `<span class="parlor-hud-footer-pill">${Number.isFinite(balanceLabel) ? `${this._t('PARLOR.Common.AvailableChips')} · ${this._formatChipValue(balanceLabel)} GP` : this._t('PARLOR.Common.ChipsInfinity')}</span>`;

        let title = this._t('PARLOR.Blackjack.PlayerHud.WaitingStart');
        let sub = hasBet ? this._t('PARLOR.Blackjack.PlayerHud.BetPlacedWaiting') : this._t('PARLOR.Blackjack.PlayerHud.NoBetYet');
        let rightHtml = '';

        if (state.phase === 'BETTING') {
            title = hasBet ? this._t('PARLOR.Blackjack.PlayerHud.BetLocked') : (canBet ? this._t('PARLOR.Blackjack.PlayerHud.PlaceBetFirst') : this._t('PARLOR.Blackjack.PlayerHud.SittingOutTitle'));
            sub = hasBet
                ? this._t('PARLOR.Blackjack.PlayerHud.BetThisRound', { participant: participantLabel, bet })
                : (canBet ? this._t('PARLOR.Blackjack.PlayerHud.BetRequired', { participant: participantLabel }) : this._t('PARLOR.Blackjack.PlayerHud.SittingOutSub'));
            rightHtml = hasBet
                ? `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.WaitingOthers')}</span>`
                : (canBet ? `
                    <div class="parlor-hud-footer-betbox">
                        <input type="number" id="bj-hud-bet-input" value="${betDraftAmount}" min="1" class="parlor-hud-footer-input" placeholder="GP">
                        <button class="parlor-hud-action-btn accent" id="bj-hud-bet-confirm"><i class="fas fa-coins"></i> ${this._t('PARLOR.Common.Bet')}</button>
                    </div>
                ` : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.SittingOutTitle')}</span>`);
        } else if (state.phase === 'DEALING') {
            title = this._t('PARLOR.Common.Dealing');
            sub = this._t('PARLOR.Blackjack.PlayerHud.DealingSub');
            rightHtml = total !== null
                ? `<span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.PlayerHud.CurrentPoints', { total })}</span>`
                : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.Dealing')}</span>`;
        } else if (state.phase === 'READY') {
            title = this._t('PARLOR.Blackjack.PlayerHud.WaitingDealer');
            sub = hasBet ? this._t('PARLOR.Blackjack.PlayerHud.BetThisRound', { participant: participantLabel, bet }) : this._t('PARLOR.Blackjack.PlayerHud.DealerTidying');
            rightHtml = `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.ReadyPhase')}</span>`;
        } else if (state.phase === 'PLAYER_TURNS') {
            const currentName = state.currentPlayerId ? this._playerName(state.currentPlayerId, state) : this._t('PARLOR.Common.Waiting');
            if (state.currentPlayerId === myId) {
                title = state.pendingAction?.action === 'hit' ? this._t('PARLOR.Blackjack.PlayerHud.HitRequested') : this._t('PARLOR.Blackjack.PlayerHud.YourTurn');
                sub = state.pendingAction?.action === 'hit'
                    ? this._t('PARLOR.Blackjack.PlayerHud.HitRequestedSub')
                    : this._t('PARLOR.Blackjack.PlayerHud.ActionHint');
            } else {
                title = this._t('PARLOR.Blackjack.PlayerHud.WaitingPlayer', { name: currentName });
                sub = this._t('PARLOR.Blackjack.PlayerHud.NotYourTurn');
            }
            rightHtml = total !== null
                ? `<span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.PlayerHud.CurrentPoints', { total })}</span>`
                : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.WaitingDeal')}</span>`;
        } else if (state.phase === 'DEALER_TURN') {
            title = this._t('PARLOR.Blackjack.PlayerHud.DealerTurn');
            sub = this._t('PARLOR.Blackjack.PlayerHud.WaitDealerFinish');
            rightHtml = total !== null
                ? `<span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.PlayerHud.CurrentPoints', { total })}</span>`
                : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.DealerActing')}</span>`;
        } else if (state.phase === 'SETTLE') {
            title = this._t('PARLOR.Common.WaitingSettlement');
            sub = total !== null ? this._t('PARLOR.Blackjack.PlayerHud.FinalPoints', { total }) : this._t('PARLOR.Blackjack.PlayerHud.ResultSoon');
            rightHtml = `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.BeforeSettlement')}</span>`;
        } else if (state.phase === 'RESOLVING') {
            title = roundDelta > 0 ? this._t('PARLOR.Blackjack.PlayerHud.RoundWin') : (roundDelta < 0 ? this._t('PARLOR.Blackjack.PlayerHud.RoundLose') : this._t('PARLOR.Blackjack.PlayerHud.RoundTie'));
            sub = `${roundDelta > 0 ? '+' : ''}${roundDelta} GP`;
            rightHtml = total !== null
                ? `<span class="parlor-hud-footer-pill">${this._t('PARLOR.Blackjack.PlayerHud.FinalPointsPill', { total })}</span>`
                : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Blackjack.PlayerHud.ResultOpen')}</span>`;
        }

        return `
            <div class="parlor-hud-footer-main">
                <div class="parlor-hud-footer-side">
                    <span class="parlor-hud-footer-label">${participantLabel}</span>
                    ${selectHtml}
                    ${chipPill}
                    <span class="parlor-hud-footer-pill ${hasBet ? '' : 'muted'}">${hasBet ? `${bet} GP` : this._t('PARLOR.Common.NoBet')}</span>
                </div>
                <div class="parlor-hud-footer-center">
                    <div class="parlor-hud-footer-title">${title}</div>
                    <div class="parlor-hud-footer-sub">${sub}</div>
                </div>
                <div class="parlor-hud-footer-side align-right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _bindHudFooter(state, { myId, isGM, dealerController, useDealerFooter }) {
        const root = this._handHUD.root;
        if (!root) return;

        root.querySelector('#bj-hud-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            this.refresh();
        });

        root.querySelector('#bj-hud-bet-input')?.addEventListener('input', (event) => {
            this._setBetDraftAmount(myId, event.currentTarget.value);
        });

        root.querySelector('#bj-hud-bet-confirm')?.addEventListener('click', async (event) => {
            const amt = this._setBetDraftAmount(myId, root.querySelector('#bj-hud-bet-input')?.value);
            const result = await this._requestPlayerAction({
                userId: myId,
                action: 'placeBet',
                data: { amount: amt },
                button: event.currentTarget
            });
            if (!result?.ok) this._showBetFailure(result, myId, amt);
        });

        if (useDealerFooter && isGM) {
            root.querySelector('#bj-hud-start-deal')?.addEventListener('click', (event) => {
                this._requestGMAction({
                    action: 'startDeal',
                    button: event.currentTarget
                });
            });
            root.querySelector('#bj-hud-confirm-hit')?.addEventListener('click', (event) => {
                this._requestGMAction({
                    action: 'confirmDeal',
                    button: event.currentTarget
                });
            });
            root.querySelector('#bj-hud-dealer-hit')?.addEventListener('click', (event) => {
                this._requestGMAction({
                    action: 'dealerHit',
                    button: event.currentTarget
                });
            });
            root.querySelector('#bj-hud-dealer-stand')?.addEventListener('click', (event) => {
                this._requestGMAction({
                    action: 'dealerStand',
                    button: event.currentTarget
                });
            });
            root.querySelector('#bj-hud-finalize-settle')?.addEventListener('click', (event) => {
                this._requestGMAction({
                    action: 'settle',
                    button: event.currentTarget
                });
            });
        }
    }

    _showBetFailure(result, participantId, amount) {
        switch (result?.reason) {
            case 'chips': {
                const balance = ChipManager.getDisplayBalance(participantId);
                ui.notifications.warn(this._t('PARLOR.Common.ChipsInsufficient', { balance: Number.isFinite(balance) ? balance : this._t('PARLOR.Common.Infinity'), amount }));
                break;
            }
            case 'phase':
                ui.notifications.warn(this._t('PARLOR.Common.BetNotInPhase'));
                break;
            case 'not-player':
                ui.notifications.warn(this._t('PARLOR.Common.BetNotParticipant'));
                break;
            case 'bet-too-low':
                ui.notifications.warn(this._t('PARLOR.Common.BetBelowLimit', { min: result.min ?? 1 }));
                break;
            case 'bet-too-high':
                ui.notifications.warn(this._t('PARLOR.Common.BetAboveLimit', { max: result.max ?? 0 }));
                break;
            case 'invalid-amount':
                ui.notifications.warn(this._t('PARLOR.Common.BetInvalidAmount'));
                break;
            case 'session-missing':
                ui.notifications.warn(this._t('PARLOR.Common.BetSessionMissing'));
                break;
            default:
                ui.notifications.warn(this._t('PARLOR.Common.BetFailedRetry'));
                break;
        }
    }

    // ═══════════════ 工具（V14 兼容） ═══════════════

    _getBustThreshold(state) {
        return Number(state?.rules?.bustThreshold || this.gameInstance?.getState?.().rules?.bustThreshold || 21);
    }

    _getPlayerHudCards(state, hand) {
        const revealAll = this._shouldRevealHudHands(state);
        return (hand?.handCards || []).map(card => ({
            card,
            startFaceDown: !revealAll,
            idleFaceDown: !revealAll,
            hoverReveal: !revealAll,
            handHover: true
        }));
    }

    _getDealerHudCards(state, dealerHand) {
        const revealAll = this._shouldRevealHudHands(state);
        return (dealerHand?.handCards || []).map((card, index) => {
            const idleFaceDown = !revealAll && index > 0;
            return {
                card,
                startFaceDown: idleFaceDown,
                idleFaceDown,
                hoverReveal: idleFaceDown,
                handHover: true
            };
        });
    }

    _shouldRevealHudHands(state) {
        if (['DEALER_TURN', 'SETTLE', 'RESOLVING'].includes(state.phase)) return true;
        return !!game.settings.get('parlor', 'alwaysRevealHandHud');
    }

    _getHudCardSign(entry) {
        const card = entry?.card || null;
        if (!card) return 'back';
        return `${card.rank}-${card.suit}:${entry.idleFaceDown ? 'down' : 'up'}`;
    }

    _sameHudCardState(nextOwner, nextSigns) {
        if (nextOwner !== this._hudCardOwner) return false;
        if (nextSigns.length !== this._hudCardSigns.length) return false;
        return nextSigns.every((sign, index) => sign === this._hudCardSigns[index]);
    }

    _canAppendHudCards(nextOwner, nextSigns) {
        if (nextOwner !== this._hudCardOwner) return false;
        if (!this._hudCardSigns.length) return false;
        if (nextSigns.length <= this._hudCardSigns.length) return false;
        return this._hudCardSigns.every((sign, index) => sign === nextSigns[index]);
    }

    _getVisibleHandTotal(hand, rules) {
        return this._handValue([...(hand?.handCards || []), ...(hand?.tableCards || [])], rules);
    }

    _canPlayerHit(state, hand, userId) {
        if (!hand) return false;
        if (state.phase !== 'PLAYER_TURNS') return false;
        if (state.currentPlayerId !== userId) return false;
        if (state.pendingAction) return false;
        if (!['playing', 'awaiting_collect'].includes(hand.status)) return false;
        return this._getVisibleHandTotal(hand, state.rules) < this._getBustThreshold(state);
    }

    _canPlayerStand(state, hand, userId) {
        if (!hand) return false;
        if (state.phase !== 'PLAYER_TURNS') return false;
        if (state.currentPlayerId !== userId) return false;
        if (state.pendingAction) return false;
        if (!['playing', 'awaiting_collect'].includes(hand.status)) return false;
        return this._getVisibleHandTotal(hand, state.rules) <= this._getBustThreshold(state);
    }

    _cloneState(state) {
        try {
            return JSON.parse(JSON.stringify(state));
        } catch (_err) {
            return null;
        }
    }

    _collectFlights(state) {
        const flights = { hud: [], seat: [] };
        const prev = this._prevStateSnapshot;
        if (!prev || !this._overlay) return flights;

        const centerCards = [...this._overlay.querySelectorAll('#bj-center .parlor-playing-card')];
        if (!centerCards.length) return flights;

        if (prev.phase === 'PLAYER_TURNS' && prev.currentPlayerId) {
            this._collectParticipantFlights(prev, state, prev.currentPlayerId, centerCards, flights);
        }

        if (prev.phase === 'DEALER_TURN') {
            this._collectDealerFlights(prev, state, centerCards, flights);
        }

        return flights;
    }

    _collectParticipantFlights(prevState, nextState, userId, cardEls, flights) {
        const prevHand = prevState.playerHands?.[userId];
        const nextHand = nextState.playerHands?.[userId];
        if (!prevHand || !nextHand) return;

        const prevCount = prevHand.handCards?.length || 0;
        const nextCount = nextHand.handCards?.length || 0;
        const delta = nextCount - prevCount;
        if (delta <= 0) return;

        const sourceEls = cardEls.slice(-delta);
        const newCards = nextHand.handCards.slice(-delta);
        const selfId = this._getSelfSeatParticipantId(nextState);
        newCards.forEach((card, index) => {
            const fromRect = sourceEls[index]?.getBoundingClientRect();
            if (!fromRect) return;

            if (userId === selfId) {
                flights.hud.push({ fromRect, card });
                return;
            }

            flights.seat.push({ fromRect, card, userId });
        });
    }

    _collectDealerFlights(prevState, nextState, cardEls, flights) {
        if (!this._isDealerController(nextState)) return;

        const prevCount = prevState.dealerHand?.handCards?.length || 0;
        const nextCount = nextState.dealerHand?.handCards?.length || 0;
        const delta = nextCount - prevCount;
        if (delta <= 0) return;

        const sourceEls = cardEls.slice(-delta);
        const newCards = nextState.dealerHand.handCards.slice(-delta);
        newCards.forEach((card, index) => {
            const fromRect = sourceEls[index]?.getBoundingClientRect();
            if (!fromRect) return;
            flights.hud.push({ fromRect, card });
        });
    }

    _playSeatFlights() {
        if (!this._queuedSeatFlights.length) return;

        for (const flight of this._queuedSeatFlights) {
            const seat = [...this._overlay.querySelectorAll('.parlor-bj-seat')]
                .find(node => node.dataset.userId === flight.userId);
            if (!seat) continue;
            this._animateSeatFlight(flight.card, flight.fromRect, seat.getBoundingClientRect());
        }

        this._queuedSeatFlights = [];
    }

    _animateSeatFlight(card, fromRect, targetRect) {
        const ghost = CardRenderer.createCard(card, { faceDown: false, size: 'table' });
        ghost.style.position = 'fixed';
        ghost.style.left = `${fromRect.left}px`;
        ghost.style.top = `${fromRect.top}px`;
        ghost.style.width = `${fromRect.width}px`;
        ghost.style.height = `${fromRect.height}px`;
        ghost.style.margin = '0';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '100001';
        ghost.style.opacity = '0.98';
        ghost.style.transition = 'transform 560ms cubic-bezier(.18,1,.22,1), opacity 520ms ease';

        document.body.appendChild(ghost);

        const fromCx = fromRect.left + fromRect.width / 2;
        const fromCy = fromRect.top + fromRect.height / 2;
        const toCx = targetRect.left + targetRect.width / 2;
        const toCy = targetRect.top + targetRect.height / 2;
        const moveX = toCx - fromCx;
        const moveY = toCy - fromCy;

        requestAnimationFrame(() => {
            ghost.style.transform = `translate(${moveX}px, ${moveY}px) scale(0.42) rotate(-8deg)`;
            ghost.style.opacity = '0.08';
        });

        setTimeout(() => ghost.remove(), 640);
    }

    _formatDelta(delta) {
        if (delta > 0) return `<span class="win">+${delta} GP</span>`;
        if (delta < 0) return `<span class="lose">${delta} GP</span>`;
        return '<span style="color:#aaa;">0 GP</span>';
    }

    _getBetDraftAmount(participantId) {
        const amount = Number(this._betDraftAmounts.get(participantId));
        return Number.isFinite(amount) && amount > 0 ? amount : 10;
    }

    _setBetDraftAmount(participantId, value) {
        const amount = Math.max(1, parseInt(value, 10) || 10);
        if (participantId) this._betDraftAmounts.set(participantId, amount);
        return amount;
    }

    _formatPlainDelta(delta) {
        const value = Math.round(Number(delta || 0) * 100) / 100;
        if (value > 0) return `+${this._formatChipValue(value)} GP`;
        if (value < 0) return `${this._formatChipValue(value)} GP`;
        return '0 GP';
    }

    _formatChipValue(amount) {
        const value = Math.round(Number(amount || 0) * 100) / 100;
        if (Number.isInteger(value)) return `${value}`;
        return value.toFixed(2).replace(/\.?0+$/, '');
    }

    _buildTableArt() {
        // V14 兼容优先：桌面 SVG 还在吃静态贴图，所以这里每次按当前设置重建。
        const { feltTexturePath, railTexturePath, railKind } = ParlorAppearance.getTableTexturePaths();
        const isMetal = railKind === 'metal';
        const railSurfaceStops = isMetal
            ? `
                        <stop offset="0%" stop-color="rgba(229,236,242,0.34)"/>
                        <stop offset="18%" stop-color="rgba(255,255,255,0.14)"/>
                        <stop offset="42%" stop-color="rgba(122,130,142,0.2)"/>
                        <stop offset="74%" stop-color="rgba(41,47,55,0.34)"/>
                        <stop offset="100%" stop-color="rgba(10,12,15,0.58)"/>
            `
            : `
                        <stop offset="0%" stop-color="rgba(212,162,93,0.54)"/>
                        <stop offset="18%" stop-color="rgba(255,214,139,0.22)"/>
                        <stop offset="42%" stop-color="rgba(141,88,41,0.18)"/>
                        <stop offset="74%" stop-color="rgba(54,28,12,0.38)"/>
                        <stop offset="100%" stop-color="rgba(16,8,4,0.68)"/>
            `;
        const railShadowStops = isMetal
            ? `
                        <stop offset="0%" stop-color="rgba(255,255,255,0.22)"/>
                        <stop offset="14%" stop-color="rgba(255,255,255,0.08)"/>
                        <stop offset="58%" stop-color="rgba(0,0,0,0.14)"/>
                        <stop offset="100%" stop-color="rgba(0,0,0,0.34)"/>
            `
            : `
                        <stop offset="0%" stop-color="rgba(255,255,255,0.18)"/>
                        <stop offset="14%" stop-color="rgba(255,255,255,0.06)"/>
                        <stop offset="58%" stop-color="rgba(0,0,0,0.12)"/>
                        <stop offset="100%" stop-color="rgba(0,0,0,0.3)"/>
            `;
        const trimStops = isMetal
            ? `
                        <stop offset="0%" stop-color="#edf4fb"/>
                        <stop offset="22%" stop-color="#c7d1dc"/>
                        <stop offset="50%" stop-color="#69717c"/>
                        <stop offset="78%" stop-color="#d8e1ea"/>
                        <stop offset="100%" stop-color="#f7fbff"/>
            `
            : `
                        <stop offset="0%" stop-color="#ffefb6"/>
                        <stop offset="22%" stop-color="#dfb665"/>
                        <stop offset="50%" stop-color="#8b5d1e"/>
                        <stop offset="78%" stop-color="#e7bf71"/>
                        <stop offset="100%" stop-color="#fff2c8"/>
            `;
        const railStrokeColor = isMetal ? '#2a3037' : '#2a1609';
        const railEdgeStroke = isMetal ? 'rgba(233,240,246,0.14)' : 'rgba(255,246,216,0.1)';
        const railInnerFill = isMetal ? 'rgba(11,19,25,0.32)' : 'rgba(8,26,18,0.28)';
        const railInnerStroke = isMetal ? 'rgba(240,246,252,0.08)' : 'rgba(255,248,224,0.08)';
        const feltEdgeStroke = isMetal ? 'rgba(220,230,242,0.18)' : 'rgba(255,227,168,0.26)';

        return `
            <svg viewBox="0 0 2200 1080" class="parlor-bj-table-svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <defs>
                    <filter id="bj-table-shadow" x="-10%" y="-20%" width="120%" height="160%">
                        <feDropShadow dx="0" dy="36" stdDeviation="34" flood-color="#000" flood-opacity="0.5"/>
                    </filter>
                    <filter id="bj-felt-noise" x="0%" y="0%" width="100%" height="100%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="2" seed="17" result="noise"/>
                        <feColorMatrix type="saturate" values="0" in="noise" result="gray"/>
                        <feBlend in="SourceGraphic" in2="gray" mode="soft-light"/>
                    </filter>
                    <filter id="bj-soft-glow">
                        <feGaussianBlur stdDeviation="8" result="blur"/>
                        <feMerge>
                            <feMergeNode in="blur"/>
                            <feMergeNode in="SourceGraphic"/>
                        </feMerge>
                    </filter>

                    <linearGradient id="bj-rail-wood" x1="0%" y1="0%" x2="0%" y2="100%">
${railSurfaceStops}
                    </linearGradient>
                    <linearGradient id="bj-rail-shadow" x1="0%" y1="0%" x2="0%" y2="100%">
${railShadowStops}
                    </linearGradient>
                    <pattern id="bj-rail-wood-grain" patternUnits="userSpaceOnUse" width="360" height="360" patternTransform="rotate(9)">
                        <image
                            href="${railTexturePath}"
                            x="0"
                            y="0"
                            width="360"
                            height="360"
                            preserveAspectRatio="xMidYMid slice"
                        />
                    </pattern>
                    <linearGradient id="bj-gold-trim" x1="0%" y1="0%" x2="100%" y2="100%">
${trimStops}
                    </linearGradient>
                    <radialGradient id="bj-felt-main" cx="50%" cy="44%" r="72%">
                        <stop offset="0%" stop-color="#2dae6b"/>
                        <stop offset="34%" stop-color="#1b8450"/>
                        <stop offset="70%" stop-color="#0f4d2f"/>
                        <stop offset="100%" stop-color="#061d13"/>
                    </radialGradient>
                    <pattern id="bj-felt-fabric" patternUnits="userSpaceOnUse" width="420" height="420">
                        <image
                            href="${feltTexturePath}"
                            x="0"
                            y="0"
                            width="420"
                            height="420"
                            preserveAspectRatio="xMidYMid slice"
                        />
                    </pattern>
                    <radialGradient id="bj-felt-sheen" cx="50%" cy="20%" r="64%">
                        <stop offset="0%" stop-color="rgba(255,246,216,0.24)"/>
                        <stop offset="42%" stop-color="rgba(255,246,216,0.08)"/>
                        <stop offset="100%" stop-color="rgba(255,246,216,0)"/>
                    </radialGradient>
                    <radialGradient id="bj-center-glow" cx="50%" cy="50%" r="66%">
                        <stop offset="0%" stop-color="rgba(255,236,184,0.22)"/>
                        <stop offset="55%" stop-color="rgba(255,236,184,0.06)"/>
                        <stop offset="100%" stop-color="rgba(255,236,184,0)"/>
                    </radialGradient>
                    <radialGradient id="bj-pocket-glow" cx="50%" cy="50%" r="70%">
                        <stop offset="0%" stop-color="rgba(250,213,118,0.26)"/>
                        <stop offset="100%" stop-color="rgba(250,213,118,0)"/>
                    </radialGradient>
                    <clipPath id="bj-rail-clip">
                        <rect x="114" y="78" width="1972" height="924" rx="462"/>
                    </clipPath>
                    <clipPath id="bj-felt-clip">
                        <rect x="242" y="172" width="1716" height="736" rx="368"/>
                    </clipPath>
                </defs>

                <rect x="124" y="116" width="1952" height="868" rx="434" fill="rgba(0,0,0,0.42)" filter="url(#bj-table-shadow)"/>

                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bj-rail-wood-grain)" stroke="${railStrokeColor}" stroke-width="10"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bj-rail-wood)" clip-path="url(#bj-rail-clip)"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bj-rail-shadow)" opacity="0.78" clip-path="url(#bj-rail-clip)"/>
                <rect x="140" y="104" width="1920" height="872" rx="436" fill="none" stroke="${railEdgeStroke}" stroke-width="2"/>
                <rect x="160" y="124" width="1880" height="832" rx="416" fill="none" stroke="url(#bj-gold-trim)" stroke-width="6"/>
                <rect x="182" y="146" width="1836" height="788" rx="394" fill="${railInnerFill}" stroke="${railInnerStroke}" stroke-width="2"/>

                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bj-felt-main)" stroke="${feltEdgeStroke}" stroke-width="4"/>
                <rect
                    x="242"
                    y="172"
                    width="1716"
                    height="736"
                    rx="368"
                    fill="url(#bj-felt-fabric)"
                    opacity="0.34"
                    clip-path="url(#bj-felt-clip)"
                />
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bj-felt-main)" opacity="0.16" filter="url(#bj-felt-noise)" clip-path="url(#bj-felt-clip)"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bj-felt-sheen)" clip-path="url(#bj-felt-clip)"/>
                <rect x="270" y="200" width="1660" height="680" rx="340" fill="none" stroke="rgba(255,237,189,0.07)" stroke-width="2"/>

                <g opacity="0.34">
                    <ellipse cx="404" cy="744" rx="114" ry="34" fill="url(#bj-pocket-glow)"/>
                    <ellipse cx="776" cy="846" rx="146" ry="40" fill="url(#bj-pocket-glow)"/>
                    <ellipse cx="1100" cy="882" rx="172" ry="42" fill="url(#bj-pocket-glow)"/>
                    <ellipse cx="1424" cy="846" rx="146" ry="40" fill="url(#bj-pocket-glow)"/>
                    <ellipse cx="1796" cy="744" rx="114" ry="34" fill="url(#bj-pocket-glow)"/>
                </g>

                <g opacity="0.6">
                    <path d="M532 704 Q1100 374 1668 704" fill="none" stroke="rgba(255,225,156,0.18)" stroke-width="8" stroke-linecap="round"/>
                    <path d="M660 790 Q1100 560 1540 790" fill="none" stroke="rgba(255,225,156,0.11)" stroke-width="3" stroke-linecap="round"/>
                    <path d="M598 274 Q1100 228 1602 274" fill="none" stroke="rgba(255,225,156,0.12)" stroke-width="3" stroke-linecap="round"/>
                </g>

                <g opacity="0.2">
                    <path d="M398 230 H1802" stroke="rgba(255,238,194,0.1)" stroke-width="10" stroke-linecap="round"/>
                    <path d="M676 852 H1524" stroke="rgba(255,238,194,0.12)" stroke-width="8" stroke-linecap="round"/>
                </g>

                <ellipse cx="1100" cy="526" rx="548" ry="214" fill="url(#bj-center-glow)"/>
                <ellipse cx="1100" cy="526" rx="476" ry="170" fill="none" stroke="rgba(255,232,180,0.18)" stroke-width="3"/>
                <ellipse cx="1100" cy="526" rx="392" ry="132" fill="none" stroke="rgba(255,232,180,0.1)" stroke-width="2" stroke-dasharray="18 16"/>
                <path d="M854 512 Q1100 424 1346 512" fill="none" stroke="rgba(255,232,180,0.14)" stroke-width="3" stroke-linecap="round"/>
                <path d="M854 564 Q1100 652 1346 564" fill="none" stroke="rgba(255,232,180,0.1)" stroke-width="3" stroke-linecap="round"/>

                <text x="1100" y="570" text-anchor="middle" fill="rgba(255,240,204,0.28)" font-size="78" font-weight="700" letter-spacing="14" filter="url(#bj-soft-glow)">BLACKJACK</text>
                <text x="1100" y="626" text-anchor="middle" fill="rgba(255,228,176,0.18)" font-size="22" font-weight="600" letter-spacing="10">HIGH TABLE</text>
            </svg>
        `;
    }

    _getDealerProfile(state) {
        const fallback = game.users?.find(u => u.isGM && u.active);
        if (state.dealerProfile?.controllerId) {
            return {
                ...state.dealerProfile,
                type: 'gm',
                participantId: null,
                actorId: null,
                name: this._t('PARLOR.Common.Dealer'),
                avatar: null,
                ownerName: state.dealerProfile.ownerName || fallback?.name || this._t('PARLOR.Common.DM')
            };
        }

        return {
            type: 'gm',
            participantId: null,
            actorId: null,
            userId: fallback?.id || null,
            controllerId: fallback?.id || null,
            name: this._t('PARLOR.Common.Dealer'),
            avatar: null,
            ownerName: fallback?.name || this._t('PARLOR.Common.DM')
        };
    }

    _getDealerTitle(state) {
        const dealer = this._getDealerProfile(state);
        const dealerName = String(dealer?.name || '').trim();
        const dealerLabel = this._t('PARLOR.Common.Dealer');
        if (dealer?.type === 'gm' || (!dealer?.participantId && !dealer?.actorId)) return dealerLabel;
        if (!dealerName || dealerName === dealerLabel) return dealerLabel;
        const prefix = `${dealerLabel} ·`;
        if (dealerName.startsWith(prefix)) return dealerName;
        return `${prefix} ${dealerName}`;
    }

    _isDealerController(state) {
        const dealer = this._getDealerProfile(state);
        return !!dealer && (dealer.controllerId === game.user.id || dealer.participantId === game.user.id);
    }

    _getActivePlayerIds(state) {
        const source = (state.turnOrder?.length > 0)
            ? state.turnOrder
            : (state.playerIds || []);
        return source.filter(Boolean);
    }

    _getBettingPlayerIds(state) {
        if (Array.isArray(state.bettingPlayerIds)) {
            return state.bettingPlayerIds.filter(Boolean);
        }
        const sittingOut = new Set(this._getSittingOutPlayerIds(state));
        return this._getActivePlayerIds(state).filter(id => !sittingOut.has(id));
    }

    _getSittingOutPlayerIds(state) {
        if (Array.isArray(state.sittingOutPlayerIds)) {
            return state.sittingOutPlayerIds.filter(Boolean);
        }
        return this._getActivePlayerIds(state)
            .filter(id => !ChipManager.canAfford(id, 1));
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }

    _describeParticipant(uid, state = this.gameInstance?.getState?.()) {
        const info = getDisplayParticipant(state, uid);
        if (BotManager.isBot(uid)) {
            info.name = BotManager.getBotName(uid);
        }
        return info;
    }

    _playerName(uid, state = this.gameInstance?.getState?.()) {
        return getParticipantName(state, uid);
    }

    _getControlledParticipantIds(state) {
        return getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => this._getActivePlayerIds(state).includes(id));
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
                return await request();
            } catch (error) {
                console.error('parlor | Blackjack socket action failed:', error);
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) {
                    await new Promise(resolve => setTimeout(resolve, rest));
                }
                this._actionRequests.delete(actionKey);
                if (button?.isConnected) button.disabled = false;
                if (this._overlay || this._presenterHost) this.refresh();
            }
        })();

        this._actionRequests.set(actionKey, pending);
        return pending;
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

    _getSelectedParticipantId(state, { preferTurn = false } = {}) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) {
            this._selectedParticipantId = '';
            return '';
        }

        if (preferTurn && controlledIds.includes(state.currentPlayerId)) {
            this._selectedParticipantId = state.currentPlayerId;
            return this._selectedParticipantId;
        }

        if (controlledIds.includes(this._selectedParticipantId)) return this._selectedParticipantId;

        const current = getCurrentControlledParticipant(state, state.currentPlayerId);
        if (controlledIds.includes(current?.id)) {
            this._selectedParticipantId = current.id;
            return this._selectedParticipantId;
        }

        const selfId = getSelfParticipant(state)?.id || '';
        this._selectedParticipantId = controlledIds.includes(selfId) ? selfId : controlledIds[0];
        return this._selectedParticipantId;
    }

    _getSelfSeatParticipantId(state) {
        return getSelfParticipant(state)?.id || '';
    }

    _handValue(cards, rules = null) {
        const bustThreshold = Number(rules?.bustThreshold || this.gameInstance?.getState?.().rules?.bustThreshold || 21);
        let total = 0, aces = 0;
        for (const c of cards) {
            let v = parseInt(c.rank);
            if (['J','Q','K'].includes(c.rank)) v = 10;
            if (c.rank === 'A') { v = 11; aces++; }
            total += v;
        }
        while (total > bustThreshold && aces > 0) { total -= 10; aces--; }
        return total;
    }
}
