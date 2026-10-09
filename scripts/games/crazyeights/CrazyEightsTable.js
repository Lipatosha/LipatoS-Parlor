/**
 * 疯狂八桌面覆盖层（经典皮）
 *
 * 桌心 = 牌堆（可点即抽）+ 弃牌顶牌 + 当前花色徽章 + 方向环 + 座次一圈；
 * 手牌走 CrazyEightsHandHUD 的浅扇形：可出的牌高亮、点一下直接出；出 8 之后花色选择器放在桌心弹出。
 * 主题接管时（open 走 _openPresenter）这层只负责把 gameApi 喂给呈现器，结算弹窗仍由本体挂在 body 上。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { BotManager } from '../../core/BotManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantName
} from '../../core/ParticipantRoster.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { CrazyEightsHandHUD } from './CrazyEightsHandHUD.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import {
    buildCrazyEightsHud,
    buildCrazyEightsSeatEntries,
    buildCrazyEightsStatus
} from './CrazyEightsPresenterData.js';
import {
    SUITS,
    SUIT_SYMBOLS,
    getLegalActions,
    getNextIndex,
    handPoints,
    cardKey,
    describeCard
} from './CrazyEightsRules.js';

const ACTION_LOCK_MS = 420;
const OVERLAY_ID = 'parlor-c8-overlay';
const SETTLEMENT_ID = 'parlor-c8-settlement';
const STOCK_STACK_CARDS = 3;
const SEAT_MINI_CARDS = 7;
const HERALD_LINES = 2;
const RED_SUITS = new Set(['hearts', 'diamonds']);

const ERROR_KEYS = Object.freeze({
    'not-current': 'NotYourTurn',
    'phase': 'WrongPhase',
    'not-player': 'NotPlayer',
    'card-not-playable': 'CardNotPlayable',
    'card-not-in-hand': 'CardNotInHand',
    'invalid-card': 'InvalidCard',
    'must-choose-suit': 'MustChooseSuit',
    'no-suit-needed': 'NoSuitNeeded',
    'invalid-suit': 'InvalidSuit',
    'pending-draw': 'PendingDraw',
    'cannot-draw': 'CannotDraw',
    'cannot-pass': 'CannotPass'
});

export class CrazyEightsTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._dismissedByUser = false;
        this._selectedParticipantId = '';
        this._actionRequests = new Map();
        this._handHUD = new CrazyEightsHandHUD();
        // 手牌 HUD 当前画的是谁的哪一手（owner + roundToken + 牌序），变了才决定补牌/重排/重建
        this._hudKey = '';
        this._hudFlagsKey = '';
        this._hudCardKeys = [];
        // 桌心/座位/HUD 各自的签名：没变就不重建 DOM，免得花色选择器/牌堆按钮在点击瞬间被换掉，
        // 也免得机器人局每一步都把满桌牌背重排一遍
        this._centerKey = '';
        this._seatsKey = '';
        this._hudActionsKey = '';
        this._hudFooterKey = '';
        this._prevPhase = '';
        this._settlementShown = false;
        this._settlementFocus = null;
        // 刷新页面后手牌是空的，每局只向主机要一次
        this._handRequestedFor = '';
        this._hudResizeObserver = null;
        this._observedHUD = null;
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:crazyeights');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:crazyeights')) {
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

        document.querySelectorAll(`#${OVERLAY_ID}`).forEach(node => node.remove());
        this._createOverlay();
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (this._presenterHost) {
            if (dismiss) this._dismissedByUser = true;
            this._presenterHost.destroy();
            this._presenterHost = null;
            document.querySelectorAll(`#${SETTLEMENT_ID}`).forEach(node => node.remove());
            this._settlementShown = false;
            this._settlementFocus = null;
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._handHUD.destroy();
        this._hudKey = '';
        this._hudFlagsKey = '';
        this._hudCardKeys = [];
        this._centerKey = '';
        this._seatsKey = '';
        this._hudActionsKey = '';
        this._hudFooterKey = '';
        this._hudResizeObserver?.disconnect();
        this._hudResizeObserver = null;
        this._observedHUD = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll(`#${SETTLEMENT_ID}`).forEach(node => node.remove());
        document.querySelectorAll(`#${OVERLAY_ID}`).forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        this._settlementShown = false;
        this._settlementFocus = null;
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._presenterHost.refresh(state);
            // 结算弹窗挂在 body 上、不在呈现器 root 里，主题模式下也得由本体自己开关
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
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
            surface: 'table:crazyeights',
            hostId: 'parlor-c8-presenter',
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
        // render() 是宿主常用的更新入口，首次挂载和重绘都必须同步独立结算层。
        if (this._presenterHost === host) this._syncSettlement(state);
    }

    _createPresenterGameApi() {
        const getState = () => this.gameInstance.getState();
        return Object.freeze({
            getState,
            getSeats: () => buildCrazyEightsSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildCrazyEightsStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildCrazyEightsHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => {
                const state = getState();
                const targetId = participantId || this._getSelectedParticipantId(state) || '';
                return { participantId: targetId, cards: targetId ? (this.gameInstance.getVisibleHand?.(targetId) || []) : [] };
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
            getParticipantName: (state, participantId) => this._playerName(state, participantId),
            getDisplayParticipant: (state, participantId) => this._describeParticipant(state, participantId),
            getControlledParticipantIds: (state) => this._getSelectableParticipantIds(state),
            resolveSelectedParticipantId: (state) => this._getSelectedParticipantId(state),
            getSelfSeatParticipantId: (state) => getControlledParticipants(state)[0]?.id || '',
            isGM: () => game.user.isGM,
            // 自测局的 DM 席位不动账,显示成无限,别让金币模式下的 0 吓人
            getBalance: (participantId) => (
                (this.gameInstance.getState().exemptParticipantIds || []).includes(participantId)
                    ? '∞'
                    : SettlementManager.getDisplayBalance(participantId)
            ),
            getVisibleHand: (participantId) => this.gameInstance.getVisibleHand?.(participantId) ?? null,
            getLegalActions: (participantId, hand) => this._legalFor(participantId, hand),
            isActionPending: (key) => this._isActionPending(key),
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    // 动作路由：GM 推进走 _requestGMAction，玩家出牌/选花色/抽/过走 _requestPlayerAction
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['newRound', 'finishGame']);
        if (gmActions.has(safeAction)) {
            const payload = { ...(data || {}) };
            delete payload.gm;
            delete payload.button;
            delete payload.participantId;
            delete payload.amount;
            return this._requestGMAction({ action: safeAction, data: payload });
        }

        const state = this.gameInstance.getState();
        const participantId = String(data?.participantId || this._getSelectedParticipantId(state) || '');
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });
        if (data?.participantId) this._selectedParticipantId = String(data.participantId);

        const payload = { ...(data || {}) };
        delete payload.participantId;
        delete payload.button;
        delete payload.gm;
        delete payload.amount;
        return this._requestPlayerAction({ userId: participantId, action: safeAction, data: payload });
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderHandHUD(state);
        this._syncSettlement(state);
        this._syncHudSpace();
    }

    _syncHudSpace() {
        if (!this._overlay) return;
        const root = this._handHUD.root;
        const update = () => this._overlay?.style.setProperty('--c8-hud-height', `${this._handHUD.root?.offsetHeight || 0}px`);
        if (root !== this._observedHUD) {
            this._hudResizeObserver?.disconnect();
            this._observedHUD = root;
            if (root && typeof ResizeObserver === 'function') {
                this._hudResizeObserver = new ResizeObserver(update);
                this._hudResizeObserver.observe(root);
            }
        }
        update();
    }

    /** 本机收到自己/代管席位的手牌：两条路都刷一次，让 HUD 把新牌接进去 */
    handlePrivateUpdate(data) {
        if (!data || data.sessionId !== this.sessionId) return;
        if (data.type !== 'crazyeights.hand') return;
        this.refresh();
    }

    // ───────── 覆盖层骨架 ─────────

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
            <div class="parlor-c8-backdrop"></div>
            <div class="parlor-c8-layout">
                <div class="parlor-c8-seat-column seat-column-left" id="c8-seat-left"></div>
                <div class="parlor-c8-scene">
                    <div class="parlor-c8-table">
                        <div class="parlor-c8-table-shell">
                            <div class="parlor-c8-badge"><i class="fas fa-dice-d8"></i> ${this._t('PARLOR.Games.CrazyEights.Name')}</div>
                            <div class="parlor-c8-center" id="c8-center"></div>
                        </div>
                    </div>
                </div>
                <div class="parlor-c8-seat-column seat-column-right" id="c8-seat-right"></div>
            </div>
            <button type="button" class="parlor-c8-close-btn" aria-label="${this._escape(this._t('PARLOR.Common.Close'))}" title="${this._escape(this._t('PARLOR.Common.Close'))}"><span aria-hidden="true">×</span></button>
        `;

        overlay.querySelector('.parlor-c8-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-c8-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });

        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    // ───────── 桌心 ─────────

    _renderCenter(state) {
        const center = this._overlay.querySelector('#c8-center');
        if (!center) return;

        const selectedId = this._getSelectedParticipantId(state);
        const legal = this._legalForSelected(state, selectedId);
        const isTurn = state.phase === 'PLAYER_TURNS' && !!selectedId && state.currentPlayerId === selectedId;
        const showSuitPicker = isTurn && !!state.turn?.mustChooseSuit;
        const canDraw = isTurn && !!legal.canDraw;
        const status = buildCrazyEightsStatus(state, this._getPresenterDataHelpers());
        const lastSeq = state.lastAction?.seq || 0;

        const key = JSON.stringify([
            state.phase, state.round, state.roundToken, state.currentPlayerId, state.turnStep, lastSeq,
            cardKey(state.discardTop), state.discardCount, state.currentSuit, state.direction, state.stockCount,
            state.turn?.pendingDraw, showSuitPicker, canDraw, state.handCounts, state.winnerIds, selectedId,
            this._isActionPending(this._playerActionKey(selectedId, 'draw')),
            this._isActionPending(this._playerActionKey(selectedId, 'chooseSuit')),
            game.user.isGM && state.phase === 'RESOLVING'
        ]);
        if (key === this._centerKey) return;
        this._centerKey = key;

        const orderHtml = this._buildTurnOrder(state);
        const heraldHtml = this._buildHerald(state);
        const pendingDraw = Number(state.turn?.pendingDraw || 0);
        const stockCount = Number(state.stockCount || 0);
        const suit = state.currentSuit || state.discardTop?.suit || '';
        const wildOnTop = !!state.discardTop && state.discardTop.rank === (state.rules?.wildRank || '8');

        center.innerHTML = `
            <div class="parlor-c8-panel">
                <div class="parlor-c8-panel-head">
                    <div class="parlor-c8-panel-phase">${this._escape(status.phase)}</div>
                    <div class="parlor-c8-panel-round">${this._escape(status.round)}</div>
                    <div class="parlor-c8-panel-pot"><span>${this._t('PARLOR.Common.TablePot')}</span><strong>${Number(state.pot || 0)}</strong></div>
                </div>
                <div class="parlor-c8-panel-title">${this._escape(status.title)}</div>
                <div class="parlor-c8-panel-sub">${this._escape(status.sub)}</div>
                <div class="parlor-c8-zone">
                    <div class="parlor-c8-stock ${canDraw ? 'is-clickable' : ''} ${stockCount ? '' : 'is-empty'}" id="c8-stock" title="${this._escape(this._t('PARLOR.CrazyEights.Label.Stock'))}">
                        <div class="parlor-c8-stack" id="c8-stock-stack"></div>
                        <div class="parlor-c8-plaque">${this._escape(this._t('PARLOR.CrazyEights.Label.Stock'))} <strong>${stockCount}</strong></div>
                        ${pendingDraw > 0 ? `<div class="parlor-c8-pending">+${pendingDraw}</div>` : ''}
                    </div>
                    <div class="parlor-c8-midzone">
                        <div class="parlor-c8-direction" data-dir="${Number(state.direction) < 0 ? -1 : 1}">
                            <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 15a22 22 0 1 1-8 17" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M10 22 2 36h16Z" fill="currentColor"/></svg>
                            <span>${this._escape(this._t(`PARLOR.CrazyEights.Center.Direction.${Number(state.direction) < 0 ? 'CounterClockwise' : 'Clockwise'}`))}</span>
                        </div>
                        <div class="parlor-c8-suit ${RED_SUITS.has(suit) ? 'is-red' : ''} ${wildOnTop ? 'is-wild' : ''} ${showSuitPicker ? 'is-pending' : ''}" id="c8-suit" data-suit="${this._escape(suit)}" title="${this._escape(this._t('PARLOR.CrazyEights.Label.Suit'))}">
                            <span class="parlor-c8-suit-glyph">${showSuitPicker ? '?' : (SUIT_SYMBOLS[suit] || '')}</span>
                        </div>
                    </div>
                    <div class="parlor-c8-discard ${state.discardTop ? '' : 'is-empty'}" id="c8-discard" title="${this._escape(this._t('PARLOR.CrazyEights.Label.Discard'))}">
                        <div class="parlor-c8-top" id="c8-discard-top"></div>
                        <div class="parlor-c8-plaque">${this._escape(this._t('PARLOR.CrazyEights.Label.Discard'))} <strong>${Number(state.discardCount || 0)}</strong></div>
                    </div>
                </div>
                ${showSuitPicker ? this._buildSuitPicker() : ''}
                <div class="parlor-c8-order-label">${this._t('PARLOR.CrazyEights.Order.Label')}</div>
                <ol class="parlor-c8-order">${orderHtml}</ol>
                ${heraldHtml ? `<div class="parlor-c8-herald">${heraldHtml}</div>` : ''}
            </div>
        `;

        this._mountStock(center, state);
        this._mountDiscardTop(center, state, lastSeq);

        center.querySelector('#c8-stock')?.addEventListener('click', (event) => {
            if (!canDraw) return;
            this._requestPlayerAction({ userId: selectedId, action: 'draw', button: event.currentTarget });
        });

        const medallion = center.querySelector('#c8-suit');
        center.querySelectorAll('[data-c8-pick-suit]').forEach(button => {
            const pick = button.dataset.c8PickSuit;
            button.addEventListener('mouseenter', () => {
                if (!medallion) return;
                medallion.dataset.suit = pick;
                medallion.classList.toggle('is-red', RED_SUITS.has(pick));
                medallion.querySelector('.parlor-c8-suit-glyph').textContent = SUIT_SYMBOLS[pick] || '';
            });
            button.addEventListener('mouseleave', () => {
                if (!medallion) return;
                medallion.dataset.suit = suit;
                medallion.classList.toggle('is-red', RED_SUITS.has(suit));
                medallion.querySelector('.parlor-c8-suit-glyph').textContent = '?';
            });
            button.addEventListener('click', (event) => {
                this._requestPlayerAction({ userId: selectedId, action: 'chooseSuit', data: { suit: pick }, button: event.currentTarget });
            });
        });

    }

    _mountStock(center, state) {
        const stack = center.querySelector('#c8-stock-stack');
        if (!stack) return;
        const count = Math.min(STOCK_STACK_CARDS, Number(state.stockCount || 0));
        for (let i = 0; i < count; i++) {
            const card = CardRenderer.createCard(null, { faceDown: true, size: 'normal', animate: false });
            card.style.setProperty('--k', String(i));
            stack.appendChild(card);
        }
    }

    _mountDiscardTop(center, state, lastSeq) {
        const slot = center.querySelector('#c8-discard-top');
        if (!slot || !state.discardTop) return;
        const card = CardRenderer.createCard(state.discardTop, { faceDown: false, size: 'normal', animate: false });
        // 刚有人出牌就播一次落牌；只是刷新（比如轮次变了）不重播
        const dropKey = `${state.roundToken}:${cardKey(state.discardTop)}:${state.discardCount}`;
        if (dropKey !== this._discardDropKey) {
            const recent = (state.lastActions || []).some(entry => ['play', 'wild'].includes(entry.type) && entry.seq === lastSeq);
            if (recent || (state.lastActions || []).some(entry => ['play', 'wild'].includes(entry.type))) card.classList.add('parlor-c8-drop-in');
            this._discardDropKey = dropKey;
        }
        slot.appendChild(card);
    }

    _buildSuitPicker() {
        const buttons = SUITS.map(suit => `
            <button type="button" class="parlor-c8-suit-btn ${RED_SUITS.has(suit) ? 'is-red' : ''}" data-c8-pick-suit="${suit}">
                <span class="parlor-c8-suit-btn-glyph">${SUIT_SYMBOLS[suit]}</span>
                <span class="parlor-c8-suit-btn-name">${this._escape(this._t(`PARLOR.CrazyEights.Suit.${suit}`))}</span>
            </button>
        `).join('');
        return `
            <div class="parlor-c8-suit-picker">
                <div class="parlor-c8-suit-picker-title">${this._escape(this._t('PARLOR.CrazyEights.Action.ChooseSuit'))}</div>
                <div class="parlor-c8-suit-picker-note">${this._escape(this._t('PARLOR.CrazyEights.Footer.ChooseSuit'))}</div>
                <div class="parlor-c8-suit-picker-row">${buttons}</div>
            </div>
        `;
    }

    _buildTurnOrder(state) {
        const order = Array.isArray(state.turnOrder) ? state.turnOrder : [];
        if (!order.length) return '';
        const winnerIds = state.winnerIds || [];
        const currentIndex = order.indexOf(state.currentPlayerId);
        // 顺序条从当前玩家起，按引擎同一方向展开；反转后仍可从左往右读到下一位。
        const ordered = currentIndex < 0 ? order : order.map((_, offset) => (
            order[getNextIndex(order.length, currentIndex, state.direction, offset)]
        ));
        return ordered.map((id, index) => {
            const count = Number(state.handCounts?.[id] ?? 0);
            const classes = [
                'parlor-c8-order-pill',
                state.phase === 'PLAYER_TURNS' && state.currentPlayerId === id ? 'is-current' : '',
                count === 1 && state.phase !== 'RESOLVING' ? 'is-last' : '',
                winnerIds.includes(id) ? 'is-winner' : ''
            ].filter(Boolean).join(' ');
            const label = state.phase === 'PLAYER_TURNS' && currentIndex >= 0 && index < 2
                ? this._t(index === 0 ? 'PARLOR.CrazyEights.Order.Current' : 'PARLOR.CrazyEights.Order.Next') : '';
            const name = this._escape(this._playerName(state, id));
            return `<li class="${classes}" ${index === 0 && label ? 'aria-current="step"' : ''} title="${name}">
                ${label ? `<span class="parlor-c8-order-role">${this._escape(label)}</span>` : ''}
                <span class="parlor-c8-order-name">${name}</span>
                <span class="parlor-c8-order-count" aria-label="${this._escape(this._t('PARLOR.CrazyEights.Seat.CardsLeft', { count }))}">${count}</span>
            </li>`;
        }).join('');
    }

    _buildHerald(state) {
        const entries = (state.lastActions || []).slice(-HERALD_LINES);
        return entries
            .map(entry => this._describeAction(state, entry))
            .filter(Boolean)
            .map(text => `<div class="parlor-c8-herald-line">${this._escape(text)}</div>`)
            .join('');
    }

    _describeAction(state, entry) {
        if (!entry) return '';
        const name = entry.participantId ? this._playerName(state, entry.participantId) : '';
        const prefix = 'PARLOR.CrazyEights.Center.LastAction.';
        switch (entry.type) {
            case 'deal': return this._t(`${prefix}Deal`, { count: Number(entry.count || 0) });
            case 'play': return this._t(`${prefix}Play`, { name, card: describeCard(entry.card) });
            case 'wild': return this._t(`${prefix}Wild`, { name });
            case 'chooseSuit': return this._t(`${prefix}ChooseSuit`, { name, suit: this._suitLabel(entry.suit) });
            case 'draw': return this._t(`${prefix}Draw`, { name, count: Number(entry.count || 0) });
            case 'pass': return this._t(`${prefix}Pass`, { name });
            case 'penalty': return this._t(`${prefix}Penalty`, { name, count: Number(entry.count || 0) });
            case 'skip': return this._t(`${prefix}Skip`, { name: entry.targetId ? this._playerName(state, entry.targetId) : name });
            case 'reverse': return this._t(`${prefix}Reverse`, { name });
            case 'reshuffle': return this._t(`${prefix}Reshuffle`);
            case 'win': return this._t(`${prefix}Win`, { name });
            case 'dead': return this._t(`${prefix}Dead`);
            default: return '';
        }
    }

    // ───────── 座位 ─────────

    _renderSeats(state) {
        const left = this._overlay.querySelector('#c8-seat-left');
        const right = this._overlay.querySelector('#c8-seat-right');
        if (!left || !right) return;

        const entries = buildCrazyEightsSeatEntries(state, this._getPresenterDataHelpers());
        // 座位卡带一排牌背图片,每次 refresh 都重建会让整局一直在重排;数据没变就不动
        const key = JSON.stringify([
            state.phase, state.roundToken,
            entries.map(entry => [entry.id, entry.name, entry.badges, entry.statusText, entry.highlight, entry.className, entry.extraHtml, state.handCounts?.[entry.id]])
        ]);
        if (key === this._seatsKey) return;
        this._seatsKey = key;

        left.innerHTML = entries.filter(entry => entry.side === 'left').map(entry => this._buildSeat(state, entry)).join('');
        right.innerHTML = entries.filter(entry => entry.side === 'right').map(entry => this._buildSeat(state, entry)).join('');

        // 牌面走 CardRenderer（吃玩家卡面设置），innerHTML 拼不出来，装完骨架再往槽里塞
        this._overlay.querySelectorAll('.parlor-c8-seat-cards[data-pid]').forEach(slot => {
            const id = slot.dataset.pid;
            const revealed = state.phase === 'RESOLVING' && Array.isArray(state.revealedHands?.[id]) ? state.revealedHands[id] : null;
            if (revealed) {
                for (const card of revealed) {
                    slot.appendChild(CardRenderer.createCard(card, { faceDown: false, size: 'small', animate: false }));
                }
                return;
            }
            const count = Math.min(SEAT_MINI_CARDS, Number(state.handCounts?.[id] || 0));
            for (let i = 0; i < count; i++) {
                slot.appendChild(CardRenderer.createCard(null, { faceDown: true, size: 'small', animate: false }));
            }
        });
    }

    _buildSeat(state, entry) {
        const classes = [
            'parlor-seat-card',
            'parlor-c8-seat',
            entry.className || '',
            entry.isSelf ? 'is-me' : ''
        ].filter(Boolean).join(' ');
        const badge = (entry.badges || [])[0];
        const display = this._describeParticipant(state, entry.id);
        const count = Number(state.handCounts?.[entry.id] ?? 0);

        return `
            <div class="${classes}" data-pid="${this._escape(entry.id)}">
                <div class="parlor-c8-seat-top">
                    <div class="parlor-c8-avatar">${entry.avatarHtml || ''}</div>
                    <div class="parlor-c8-seat-main">
                        <div class="parlor-c8-seat-name">${this._escape(entry.name)}</div>
                        <div class="parlor-c8-seat-owner">${this._escape(display.ownerName || '')}</div>
                    </div>
                    <div class="parlor-c8-seat-count">${count}</div>
                </div>
                <div class="parlor-c8-seat-status">${this._escape(entry.statusText || '')}</div>
                <div class="parlor-c8-seat-cards" data-pid="${this._escape(entry.id)}"></div>
                ${badge && badge.className === 'wax' ? `<div class="parlor-c8-seat-badge">${this._escape(badge.label)}</div>` : ''}
                ${entry.extraHtml || ''}
            </div>
        `;
    }

    // ───────── 手牌 HUD ─────────

    _renderHandHUD(state) {
        // 结算已在弹窗展示尾牌，撤下固定手牌栏，避免压住结算按钮。
        const hud = state.phase === 'RESOLVING' ? null : buildCrazyEightsHud(state, this._getPresenterDataHelpers());
        if (!hud) {
            this._handHUD.destroy();
            this._hudKey = '';
            this._hudFlagsKey = '';
            this._hudCardKeys = [];
            this._hudActionsKey = '';
            this._hudFooterKey = '';
            return;
        }

        const selectedId = hud.ownerId === 'gm' ? '' : hud.ownerId;
        this._maybeRequestHand(state, selectedId);

        const entries = hud.cards;
        const nextKeys = entries.map(entry => cardKey(entry.card));
        const key = `${selectedId}:${state.roundToken}:${nextKeys.join(',')}`;
        const flagsKey = `${key}|${entries.map(entry => entry.playable === true ? 1 : entry.playable === false ? 0 : '-').join('')}`;
        const isTurn = state.phase === 'PLAYER_TURNS' && !!selectedId && state.currentPlayerId === selectedId;

        if (!this._handHUD.root) {
            this._handHUD.show(entries);
        } else if (key !== this._hudKey) {
            const sameOwner = this._hudKey.startsWith(`${selectedId}:${state.roundToken}:`);
            const added = nextKeys.filter(k => !this._hudCardKeys.includes(k));
            const removed = this._hudCardKeys.filter(k => !nextKeys.includes(k));
            if (sameOwner && added.length === 1 && !removed.length && state.phase === 'PLAYER_TURNS') {
                // 抽到一张：从牌堆飞进它在排序后的位置，其余牌让位
                const index = nextKeys.indexOf(added[0]);
                const stockRect = this._overlay?.querySelector('#c8-stock')?.getBoundingClientRect() || null;
                this._handHUD.addCard(entries[index], { fromRect: stockRect, index });
                this._handHUD.updateCards(entries);
            } else if (sameOwner && nextKeys.length === this._hudCardKeys.length) {
                this._handHUD.updateCards(entries);
            } else {
                this._handHUD.show(entries);
            }
        } else if (flagsKey !== this._hudFlagsKey) {
            // 牌没变但可出状态变了(轮到自己/别人),原地刷标志;都没变就一根手指都不动
            this._handHUD.updateCards(entries);
        }
        this._hudKey = key;
        this._hudFlagsKey = flagsKey;
        this._hudCardKeys = nextKeys;
        this._handHUD.setPinned(isTurn);

        // 花色选择器放在桌心，HUD 动作行不重复放
        const actions = (hud.actions || []).filter(action => action.kind !== 'suit');
        const actionsKey = JSON.stringify([selectedId, actions.map(action => [action.kind, action.label, !!action.disabled])]);
        if (actionsKey !== this._hudActionsKey) {
            this._hudActionsKey = actionsKey;
            this._handHUD.showActions(actions.map(action => ({
                label: action.label,
                icon: action.icon,
                accent: /gold|accent/u.test(action.className || ''),
                disabled: !!action.disabled,
                callback: (event) => action.onClick?.(event, {})
            })));
        }

        const footer = this._buildHudFooter(state, hud, selectedId);
        if (footer !== this._hudFooterKey) {
            this._hudFooterKey = footer;
            this._handHUD.showFooter(footer);
            this._handHUD.root?.querySelector('#c8-hud-participant')?.addEventListener('change', (event) => {
                this._selectedParticipantId = event.currentTarget.value || '';
                this.refresh();
            });
        }
    }

    _buildHudFooter(state, hud, selectedId) {
        const legal = this._legalForSelected(state, selectedId);
        const isTurn = state.phase === 'PLAYER_TURNS' && !!selectedId && state.currentPlayerId === selectedId;
        let note;
        if (!selectedId) note = this._t('PARLOR.CrazyEights.Footer.Spectating');
        else if (state.phase === 'DEALING') note = this._t('PARLOR.CrazyEights.Footer.Dealing');
        else if (state.phase === 'RESOLVING') note = this._t('PARLOR.CrazyEights.Footer.Resolving');
        else if (!isTurn) note = this._t('PARLOR.CrazyEights.Footer.OtherTurn', { name: this._playerName(state, state.currentPlayerId) });
        else if (state.turn?.mustChooseSuit) note = this._t('PARLOR.CrazyEights.Footer.ChooseSuit');
        else if (Number(state.turn?.pendingDraw || 0) > 0) note = this._t('PARLOR.CrazyEights.Footer.PendingDraw', { count: Number(state.turn.pendingDraw) });
        else if (state.turn?.drawnThisTurn) note = this._t(legal.canPass ? 'PARLOR.CrazyEights.Footer.YourTurnAfterDraw' : 'PARLOR.CrazyEights.Footer.MustPlayAfterDraw');
        else note = this._t('PARLOR.CrazyEights.Footer.YourTurn');

        return `
            <div class="parlor-hud-footer-main parlor-c8-hud-footer">
                <div class="parlor-hud-footer-center">
                    <div class="parlor-hud-footer-title">${this._escape(hud.identity?.name || '')}</div>
                    <div class="parlor-hud-footer-sub">${this._escape(hud.identity?.sub || '')}${hud.identity?.sub && note ? ' · ' : ''}${this._escape(note)}</div>
                </div>
                ${hud.centerHtml || ''}
            </div>
        `;
    }

    /** 刷新页面后手牌是空的：每局只向主机要一次，主机只会发给这席位的控制者 */
    _maybeRequestHand(state, selectedId) {
        if (!selectedId) return;
        if (!['DEALING', 'PLAYER_TURNS'].includes(state.phase)) return;
        if (!(state.roundPlayerIds || []).includes(selectedId)) return;
        if (this.gameInstance.getVisibleHand?.(selectedId)) return;
        const mark = `${selectedId}:${state.roundToken}`;
        if (this._handRequestedFor === mark) return;
        this._handRequestedFor = mark;
        this._requestPlayerAction({ userId: selectedId, action: 'requestHand' });
    }

    // ───────── 结算 ─────────

    _syncSettlement(state) {
        if (state.phase !== this._prevPhase) {
            if (state.phase === 'DEALING') this._settlementShown = false;
            this._prevPhase = state.phase;
        }
        if (state.phase !== 'RESOLVING') {
            this._setSettlementActive(false);
            document.querySelector(`#${SETTLEMENT_ID}`)?.remove();
            return;
        }
        if (!this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }
    }

    _setSettlementActive(active) {
        if (active) this._settlementFocus = document.activeElement;
        // 遮罩之下的原生桌和主题桌都退出键盘导航，不能隔着结算触发动作。
        for (const root of [this._overlay, this._presenterHost?.root]) {
            if (root) root.inert = active;
        }
        if (!active && this._settlementFocus?.isConnected) this._settlementFocus.focus();
        if (!active) this._settlementFocus = null;
    }

    _showSettlementPopup(state) {
        document.querySelector(`#${SETTLEMENT_ID}`)?.remove();
        const popup = document.createElement('div');
        popup.id = SETTLEMENT_ID;
        popup.dataset.c8Style = 'v14';
        // 这层在 host 外面，登记后主题才拿得到标记，整桌销毁时也一起回收
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        const result = state.roundResult || {};
        const status = buildCrazyEightsStatus(state, this._getPresenterDataHelpers());
        const rows = (result.rows || []).map(row => `
            <tr class="${(state.winnerIds || []).includes(row.id) ? 'is-winner' : ''}">
                <td>${this._escape(this._playerName(state, row.id))}</td>
                <td><div class="parlor-c8-settlement-reveal" data-pid="${this._escape(row.id)}"></div></td>
                <td>${Number(row.cardsLeft || 0)}</td>
                <td>${Number(row.points || 0)}</td>
                <td>${Number(row.ante || 0)}</td>
                <td>${Number(row.penalty || 0)}</td>
                <td>${Number(row.payout || 0)}</td>
                <td class="${Number(row.net) > 0 ? 'is-up' : Number(row.net) < 0 ? 'is-down' : ''}">${Number(row.net) > 0 ? '+' : ''}${Number(row.net || 0)}</td>
            </tr>
        `).join('');

        popup.innerHTML = `
            <div class="parlor-c8-settlement-box" role="dialog" aria-modal="true" aria-labelledby="c8-settlement-title">
                <div class="settlement-title" id="c8-settlement-title">${this._escape(status.title)}</div>
                <div class="settlement-sub">${this._escape(status.sub)}</div>
                ${result.kind === 'aborted' ? '' : `
                    <div class="parlor-c8-settlement-scroll" tabindex="0"><table class="settlement-table">
                        <thead>
                            <tr>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Player')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Hand')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.CardsLeft')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Points')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Ante')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Penalty')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Payout')}</th>
                                <th>${this._t('PARLOR.CrazyEights.Settlement.Net')}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table></div>
                `}
                <div class="parlor-c8-settlement-note">${this._escape(this._t(game.user.isGM ? 'PARLOR.CrazyEights.Center.ResolvingNoteGM' : 'PARLOR.CrazyEights.Center.ResolvingNotePlayer'))}</div>
                <div class="parlor-c8-settlement-actions">
                    ${game.user.isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="c8-settle-finish"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="c8-settle-next"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="c8-settle-dismiss"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        this._setSettlementActive(true);
        popup.querySelector('button')?.focus();
        popup.querySelectorAll('.parlor-c8-settlement-reveal[data-pid]').forEach(slot => {
            const cards = state.revealedHands?.[slot.dataset.pid] || [];
            for (const card of cards) {
                slot.appendChild(CardRenderer.createCard(card, { faceDown: false, size: 'small', animate: false }));
            }
        });
        popup.querySelector('#c8-settle-dismiss')?.addEventListener('click', () => {
            popup.remove();
            this._setSettlementActive(false);
        });
        for (const [id, action] of [['c8-settle-finish', 'finishGame'], ['c8-settle-next', 'newRound']]) {
            popup.querySelector('#' + id)?.addEventListener('click', event => {
                this._runSettlementAction(popup, action, event.currentTarget);
            });
        }
    }

    async _runSettlementAction(popup, action, button) {
        const buttons = popup.querySelectorAll('.parlor-c8-settlement-actions button');
        if (Array.from(buttons).some(entry => entry.disabled)) return;
        buttons.forEach(entry => { entry.disabled = true; });
        try {
            await this._requestGMAction({ action, button });
        } finally {
            // 请求失败后允许重试；成功切局时旧弹窗已移除，不影响新一局的操作。
            buttons.forEach(entry => { if (entry.isConnected) entry.disabled = false; });
        }
    }

    // ───────── 席位选择 / 规则辅助 ─────────

    _legalFor(participantId, hand = null) {
        const state = this.gameInstance.getState();
        const cards = Array.isArray(hand) ? hand : (this.gameInstance.getVisibleHand?.(participantId) || []);
        return getLegalActions(cards, {
            topCard: state.discardTop,
            currentSuit: state.currentSuit,
            rules: state.rules,
            pendingDraw: state.turn?.pendingDraw || 0,
            mustChooseSuit: !!state.turn?.mustChooseSuit,
            drawnThisTurn: !!state.turn?.drawnThisTurn,
            drawCountThisTurn: state.turn?.drawCountThisTurn || 0,
            stockCount: state.stockCount,
            discardCount: state.discardCount
        });
    }

    _legalForSelected(state, selectedId) {
        if (!selectedId) return { mustChooseSuit: false, playable: [], canDraw: false, canPass: false, cardsAvailable: false };
        return this._legalFor(selectedId, this.gameInstance.getVisibleHand?.(selectedId) || []);
    }

    _getSelectableParticipantIds(state) {
        const activeIds = state.roundPlayerIds?.length ? state.roundPlayerIds : (state.playerIds || []);
        const controlledIds = getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => activeIds.includes(id));
        if (controlledIds.length) return controlledIds;
        // GM 没自己的席位时只能代操非机器人席位;机器人自己会走,给 GM 一个"替机器人抽牌"的按钮只会误点
        if (game.user.isGM) return activeIds.filter(id => !BotManager.isBot(id));
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

    _describeParticipant(state, userId) {
        const info = getDisplayParticipant(state, userId);
        if (BotManager.isBot(userId)) {
            info.name = BotManager.getBotName(userId);
        }
        return info;
    }

    _playerName(state, userId) {
        if (!userId) return '';
        if (BotManager.isBot(userId)) return BotManager.getBotName(userId);
        return getParticipantName(state, userId);
    }

    _suitLabel(suit) {
        return `${SUIT_SYMBOLS[suit] || ''} ${this._t(`PARLOR.CrazyEights.Suit.${suit}`)}`.trim();
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
                console.error('parlor | CrazyEights socket action failed:', error);
                ui.notifications.error(this._t('PARLOR.CrazyEights.Error.RequestFailed'));
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest));
                this._actionRequests.delete(actionKey);
                if (button?.isConnected) button.disabled = false;
                if (this._overlay || this._presenterHost) this.refresh();
            }
        })();

        this._actionRequests.set(actionKey, pending);
        return pending;
    }

    _showActionError(result) {
        const key = ERROR_KEYS[result?.reason];
        if (!key) return;
        ui.notifications.warn(this._t(`PARLOR.CrazyEights.Error.${key}`));
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
