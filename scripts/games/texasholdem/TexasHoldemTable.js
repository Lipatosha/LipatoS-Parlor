/**
 * TexasHoldemTable — 德州扑克覆盖层
 *
 * 桌面先把信息摆清楚：公共牌、底池、行动位、每个座位的 stack。
 * 复杂扑克桌最怕玩家不知道“现在差多少、能做什么”，所以 HUD 优先服务行动判断。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { CardHandHUD } from '../../ui/CardHandHUD.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantName
} from '../../core/ParticipantRoster.js';
import { getTexasHoldemHandLabelKey, evaluateBestTexasHoldemHand, HAND_CATEGORY_VALUE } from './TexasHoldemRules.js';
import {
    buildTexasHoldemHud,
    buildTexasHoldemSeatEntries,
    buildTexasHoldemStatus
} from './TexasHoldemPresenterData.js';

const MAX_SIDE_SEATS = 3;

function escape(value) {
    return foundry.utils.escapeHTML(String(value ?? ''));
}

export class TexasHoldemTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._viewportFit = null;
        this._dismissedByUser = false;
        this._selectedParticipantId = '';
        this._actionRequests = new Map();
        this._settlementShownFor = '';
        this._communityCardSigns = [];
        this._communityHandToken = '';
        this._onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            this._requestParlorClose?.() ?? this.close();
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:texasholdem');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:texasholdem')) {
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

        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-th-layout'
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
        this._handHUD.destroy();
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        this._communityCardSigns = [];
        this._communityHandToken = '';
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._presenterHost.refresh(state);
            // 结算弹窗走本体(契约 §11):呈现器只接管牌桌 surface,整局打完仍要靠这里弹结算。
            // 少了这句,主题模式下机器人对局结束不弹结算面板(#parlor-th-settlement z3300 本就盖在呈现器 z3000 之上)
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._renderCommunity(state);
        this._renderSeats(state);
        this._renderStatusDock(state);
        this._renderHandHUD(state);
        this._syncSettlement(state);
        this._viewportFit?.update();
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
            surface: 'table:texasholdem',
            hostId: 'parlor-th-presenter',
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
            getState,
            getSeats: () => buildTexasHoldemSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildTexasHoldemStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildTexasHoldemHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => this._getPresenterPrivate(participantId),
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            renderCard: (card, options = {}) => CardRenderer.createCard(card, options),
            playSound: (kind) => ParlorAppearance.playCardSound(kind),
            formatChips: (amount) => this._formatChip(amount),
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
            formatChips: (amount) => this._formatChip(amount),
            getParticipantName: (state, participantId) => getParticipantName(state, participantId),
            getDisplayParticipant: (state, participantId) => getDisplayParticipant(state, participantId),
            getSeatStatus: (state, participantId) => this._getSeatStatus(state, participantId),
            getStreetLabel: (street) => this._getStreetLabel(street),
            getPhaseTitle: (state) => this._getPhaseTitle(state),
            getControlledParticipantIds: (state) => this._getControlledParticipantIds(state),
            resolveSelectedParticipantId: (state, controlledIds) => this._resolveSelectedParticipantId(state, controlledIds),
            getVisibleHoleCards: (participantId) => this.gameInstance.getVisibleHoleCards?.(participantId) || [],
            // 牌力评估(底牌+公共牌 → 当前最佳五张):给 HUD 牌力块用
            evaluateHand: (cards) => {
                const hand = evaluateBestTexasHoldemHand(cards);
                if (!hand) return null;
                return {
                    labelKey: getTexasHoldemHandLabelKey(hand),
                    value: HAND_CATEGORY_VALUE[hand.category] ?? 0
                };
            },
            getCallAmount: (state, participantId) => this._getCallAmount(state, participantId),
            getMinRaiseTo: (state, participantId) => this._getMinRaiseTo(state, participantId),
            getMaxRaiseTo: (state, participantId) => this._getMaxRaiseTo(state, participantId),
            getRaiseShortcuts: (state, participantId) => this._getRaiseShortcuts(state, participantId),
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    _getPresenterPrivate(participantId = null) {
        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const targetId = participantId || this._resolveSelectedParticipantId(state, controlledIds);
        if (!targetId) return { participantId: '', cards: [] };
        return {
            participantId: targetId,
            cards: this.gameInstance.getVisibleHoleCards?.(targetId) || []
        };
    }

    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const participantId = String(data?.participantId || this._resolveSelectedParticipantId(state, controlledIds) || '');
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });

        const payload = { ...(data || {}) };
        delete payload.participantId;
        const button = payload.button || null;
        delete payload.button;
        return this._requestPlayerAction(participantId, safeAction, payload, button);
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
        this.gameInstance.handlePrivateUpdate?.(data);
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-th-overlay';
        overlay.dataset.thStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-th-backdrop"></div>
            <div class="parlor-th-layout">
                <div class="parlor-th-seat-column seat-column-left" id="th-seat-left"></div>
                <div class="parlor-th-scene">
                    <div class="parlor-th-table">
                        ${this._buildTableArt()}
                        <div class="parlor-th-table-stage">
                            <div class="parlor-th-game-badge"><i class="fas fa-spade"></i> ${this._t('PARLOR.Games.TexasHoldem.Name')}</div>
                            <div class="parlor-th-community" id="th-community"></div>
                            <div class="parlor-th-pot-strip" id="th-pot-strip"></div>
                        </div>
                    </div>
                    <div class="parlor-th-status-dock" id="th-status-dock"></div>
                </div>
                <div class="parlor-th-seat-column seat-column-right" id="th-seat-right"></div>
            </div>
            <button class="parlor-th-close-btn"><i class="fas fa-times"></i></button>
        `;
        overlay.querySelector('.parlor-th-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-th-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _buildTableArt() {
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
            <svg viewBox="0 0 2200 1080" class="parlor-th-table-svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <defs>
                    <filter id="th-table-shadow" x="-10%" y="-20%" width="120%" height="160%">
                        <feDropShadow dx="0" dy="36" stdDeviation="34" flood-color="#000" flood-opacity="0.5"/>
                    </filter>
                    <filter id="th-felt-noise" x="0%" y="0%" width="100%" height="100%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="2" seed="23" result="noise"/>
                        <feColorMatrix type="saturate" values="0" in="noise" result="gray"/>
                        <feBlend in="SourceGraphic" in2="gray" mode="soft-light"/>
                    </filter>
                    <linearGradient id="th-rail-wood" x1="0%" y1="0%" x2="0%" y2="100%">
${railSurfaceStops}
                    </linearGradient>
                    <linearGradient id="th-rail-shadow" x1="0%" y1="0%" x2="0%" y2="100%">
${railShadowStops}
                    </linearGradient>
                    <pattern id="th-rail-wood-grain" patternUnits="userSpaceOnUse" width="360" height="360" patternTransform="rotate(9)">
                        <image href="${railTexturePath}" x="0" y="0" width="360" height="360" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <linearGradient id="th-gold-trim" x1="0%" y1="0%" x2="100%" y2="100%">
${trimStops}
                    </linearGradient>
                    <radialGradient id="th-felt-main" cx="50%" cy="44%" r="72%">
                        <stop offset="0%" stop-color="#2dae6b"/>
                        <stop offset="34%" stop-color="#1b8450"/>
                        <stop offset="70%" stop-color="#0f4d2f"/>
                        <stop offset="100%" stop-color="#061d13"/>
                    </radialGradient>
                    <pattern id="th-felt-fabric" patternUnits="userSpaceOnUse" width="420" height="420">
                        <image href="${feltTexturePath}" x="0" y="0" width="420" height="420" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <radialGradient id="th-felt-sheen" cx="50%" cy="20%" r="64%">
                        <stop offset="0%" stop-color="rgba(255,246,216,0.24)"/>
                        <stop offset="42%" stop-color="rgba(255,246,216,0.08)"/>
                        <stop offset="100%" stop-color="rgba(255,246,216,0)"/>
                    </radialGradient>
                    <radialGradient id="th-pot-glow" cx="50%" cy="50%" r="66%">
                        <stop offset="0%" stop-color="rgba(255,236,184,0.18)"/>
                        <stop offset="55%" stop-color="rgba(255,236,184,0.05)"/>
                        <stop offset="100%" stop-color="rgba(255,236,184,0)"/>
                    </radialGradient>
                    <clipPath id="th-rail-clip">
                        <rect x="114" y="78" width="1972" height="924" rx="462"/>
                    </clipPath>
                    <clipPath id="th-felt-clip">
                        <rect x="242" y="172" width="1716" height="736" rx="368"/>
                    </clipPath>
                </defs>

                <rect x="124" y="116" width="1952" height="868" rx="434" fill="rgba(0,0,0,0.42)" filter="url(#th-table-shadow)"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#th-rail-wood-grain)" stroke="${railStrokeColor}" stroke-width="10"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#th-rail-wood)" clip-path="url(#th-rail-clip)"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#th-rail-shadow)" opacity="0.78" clip-path="url(#th-rail-clip)"/>
                <rect x="140" y="104" width="1920" height="872" rx="436" fill="none" stroke="${railEdgeStroke}" stroke-width="2"/>
                <rect x="160" y="124" width="1880" height="832" rx="416" fill="none" stroke="url(#th-gold-trim)" stroke-width="6"/>
                <rect x="182" y="146" width="1836" height="788" rx="394" fill="${railInnerFill}" stroke="${railInnerStroke}" stroke-width="2"/>

                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#th-felt-main)" stroke="${feltEdgeStroke}" stroke-width="4"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#th-felt-fabric)" opacity="0.34" clip-path="url(#th-felt-clip)"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#th-felt-main)" opacity="0.16" filter="url(#th-felt-noise)" clip-path="url(#th-felt-clip)"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#th-felt-sheen)" clip-path="url(#th-felt-clip)"/>
                <rect x="270" y="200" width="1660" height="680" rx="340" fill="none" stroke="rgba(255,237,189,0.07)" stroke-width="2"/>

                <ellipse cx="1100" cy="538" rx="640" ry="210" fill="url(#th-pot-glow)" opacity="0.58"/>
                <g opacity="0.38">
                    <ellipse cx="640" cy="790" rx="126" ry="34" fill="url(#th-pot-glow)"/>
                    <ellipse cx="920" cy="850" rx="152" ry="38" fill="url(#th-pot-glow)"/>
                    <ellipse cx="1280" cy="850" rx="152" ry="38" fill="url(#th-pot-glow)"/>
                    <ellipse cx="1560" cy="790" rx="126" ry="34" fill="url(#th-pot-glow)"/>
                </g>
            </svg>
        `;
    }

    _renderCommunity(state) {
        const wrap = this._overlay?.querySelector('#th-community');
        const potWrap = this._overlay?.querySelector('#th-pot-strip');
        if (!wrap || !potWrap) return;

        const handToken = state.handToken || '';
        if (this._communityHandToken !== handToken) {
            this._communityHandToken = handToken;
            this._communityCardSigns = [];
        }

        wrap.innerHTML = '';
        const cards = Array.isArray(state.communityCards) ? state.communityCards : [];
        const nextSigns = [];
        for (let index = 0; index < 5; index++) {
            const card = cards[index] || null;
            const sign = card ? `${card.rank}-${card.suit}` : '';
            nextSigns[index] = sign;
            const el = CardRenderer.createCard(card, {
                faceDown: !card,
                size: 'table',
                animate: !!card && this._communityCardSigns[index] !== sign
            });
            el.classList.toggle('is-empty-slot', !card);
            wrap.appendChild(el);
        }
        this._communityCardSigns = nextSigns;

        const totalPot = this._getTotalPot(state);
        const callText = state.currentPlayerId
            ? this._t('PARLOR.TexasHoldem.Table.ToCall', {
                amount: this._formatChip(this._getCallAmount(state, state.currentPlayerId))
            })
            : this._t('PARLOR.Common.Waiting');
        potWrap.innerHTML = `
            <span><i class="fas fa-coins"></i> ${this._t('PARLOR.TexasHoldem.Table.Pot', { amount: this._formatChip(totalPot) })}</span>
            <span>${this._getStreetLabel(state.street)}</span>
            <span>${callText}</span>
        `;
    }

    _renderSeats(state) {
        const left = this._overlay?.querySelector('#th-seat-left');
        const right = this._overlay?.querySelector('#th-seat-right');
        if (!left || !right) return;

        const seatIds = (state.seatIds || state.playerIds || []).slice(0, MAX_SIDE_SEATS * 2);
        const midpoint = Math.ceil(seatIds.length / 2);
        const leftIds = seatIds.slice(0, midpoint);
        const rightIds = seatIds.slice(midpoint);

        left.classList.toggle('is-empty', !leftIds.length);
        right.classList.toggle('is-empty', !rightIds.length);
        left.innerHTML = leftIds.map((id, index) => this._renderSeatShell(state, id, index, 'left')).join('');
        right.innerHTML = rightIds.map((id, index) => this._renderSeatShell(state, id, index, 'right')).join('');
    }

    _renderSeatShell(state, participantId, index, side) {
        const display = getDisplayParticipant(state, participantId);
        const seat = state.playerStates?.[participantId] || null;
        const isCurrent = state.currentPlayerId === participantId;
        const classes = [
            'parlor-th-seat',
            `seat-${side}`,
            isCurrent ? 'active-turn' : '',
            display.isSelf ? 'is-me' : '',
            seat?.status === 'folded' ? 'is-folded' : '',
            seat?.status === 'all-in' ? 'is-all-in' : '',
            seat?.result === 'win' ? 'is-winner' : ''
        ].filter(Boolean).join(' ');
        const stack = this._formatChip(state.tableStacks?.[participantId] || 0);
        const committed = this._formatChip(seat?.committed || 0);
        const tags = this._buildSeatTags(state, participantId);
        const status = this._getSeatStatus(state, participantId);
        const seatIds = state.seatIds || state.playerIds || [];
        const seatNum = Math.max(1, seatIds.indexOf(participantId) + 1);
        const typeClass = display.kind === 'bot' ? 'is-bot' : (display.kind === 'npc' ? 'is-npc' : 'is-human');

        return `
            <article class="${classes}" data-participant-id="${escape(participantId)}">
                <div class="parlor-th-seat-avatar-wrap ${typeClass}">
                    <div class="parlor-th-seat-avatar">${display.avatarHtml || ''}</div>
                </div>
                <div class="parlor-th-seat-info">
                    <div class="parlor-th-seat-head">
                        <span class="parlor-th-seat-name-text">${escape(getParticipantName(state, participantId))}</span>
                        <span class="parlor-th-seat-num">#${seatNum}</span>
                    </div>
                    <div class="parlor-th-seat-meta">
                        <span class="parlor-th-seat-bet">${this._t('PARLOR.TexasHoldem.Table.Stack', { amount: stack })}</span>
                        <span class="parlor-th-seat-side">${this._t('PARLOR.TexasHoldem.Table.InPot', { amount: committed })}</span>
                    </div>
                    <div class="parlor-th-seat-foot">
                        <span class="parlor-th-seat-status ${status.className}">${escape(status.text)}</span>
                        ${tags}
                    </div>
                </div>
            </article>
        `;
    }

    _renderStatusDock(state) {
        const dock = this._overlay?.querySelector('#th-status-dock');
        if (!dock) return;

        const currentName = state.currentPlayerId
            ? getParticipantName(state, state.currentPlayerId)
            : '';
        const blinds = this._t('PARLOR.TexasHoldem.Table.Blinds', {
            small: this._formatChip(state.smallBlind),
            big: this._formatChip(state.bigBlind)
        });
        const title = currentName
            ? this._t('PARLOR.TexasHoldem.Table.CurrentTurn', { name: currentName })
            : this._getPhaseTitle(state);
        dock.innerHTML = `
            <div class="parlor-th-prompt">
                <div class="parlor-th-prompt-head">
                    <span>${this._getStreetLabel(state.street)}</span>
                    <span>${this._t('PARLOR.Common.RoundCounter', { round: state.handNumber || state.round || 0 })}</span>
                </div>
                <div class="parlor-th-prompt-title">${escape(title)}</div>
                <div class="parlor-th-prompt-sub">${escape(blinds)}</div>
            </div>
        `;
    }

    _renderHandHUD(state) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) {
            this._handHUD.destroy();
            return;
        }

        const selectedId = this._resolveSelectedParticipantId(state, controlledIds);
        const cards = this._buildHudCards(selectedId);
        const cardSigns = cards.map(entry => `${entry.card?.rank || 'x'}-${entry.card?.suit || 'x'}:${entry.idleFaceDown ? 'down' : 'up'}`);

        if (!this._handHUD.root || this._handHUD.root.dataset.ownerId !== selectedId) {
            this._handHUD.show(cards);
            this._handHUD.root.dataset.ownerId = selectedId;
            this._handHUD.root.dataset.cardSigns = cardSigns.join('|');
        } else if (this._handHUD.root.dataset.cardSigns !== cardSigns.join('|')) {
            this._handHUD.updateCards(cards);
            this._handHUD.root.dataset.cardSigns = cardSigns.join('|');
        }

        this._renderHudFooter(state, selectedId, controlledIds);
        this._renderHudActions(state, selectedId);
    }

    _buildHudCards(participantId) {
        const visible = this.gameInstance.getVisibleHoleCards(participantId);
        if (!Array.isArray(visible) || !visible.length) {
            return [0, 1].map(() => ({
                card: null,
                size: 'hud',
                startFaceDown: true,
                idleFaceDown: true,
                hoverReveal: false,
                handHover: true
            }));
        }

        return visible.map(card => ({
            card,
            size: 'hud',
            startFaceDown: true,
            idleFaceDown: true,
            hoverReveal: true,
            handHover: true
        }));
    }

    _renderHudFooter(state, participantId, controlledIds) {
        const seat = state.playerStates?.[participantId] || null;
        const name = getParticipantName(state, participantId);
        const toCall = this._getCallAmount(state, participantId);
        const stack = this._formatChip(state.tableStacks?.[participantId] || 0);
        const maxRaiseTo = this._getMaxRaiseTo(state, participantId);
        const minRaiseTo = this._getMinRaiseTo(state, participantId);
        const raiseDisabled = maxRaiseTo <= state.currentBet;
        const statusText = this._getSeatStatus(state, participantId).text;

        // footer 里有玩家正在编辑的加注输入框,只在真正影响行动的数值变了才重建,
        // 不然每次状态广播都重写一遍,会把手输到一半的加注额冲掉。
        const sig = [
            participantId, stack, toCall, state.currentBet, minRaiseTo, maxRaiseTo,
            raiseDisabled ? 'nr' : 'r', statusText, controlledIds.join(',')
        ].join('|');
        if (this._handHUD.root && this._handHUD.root.dataset.footerSig === sig) return;

        const shortcuts = this._getRaiseShortcuts(state, participantId);
        const defaultRaise = Math.min(Math.max(minRaiseTo, state.currentBet + state.bigBlind), maxRaiseTo);
        const selectHtml = controlledIds.length > 1
            ? `<select class="parlor-th-hud-select" id="th-hud-participant">
                ${controlledIds.map(id => `<option value="${escape(id)}" ${id === participantId ? 'selected' : ''}>${escape(getParticipantName(state, id))}</option>`).join('')}
            </select>`
            : `<span class="parlor-th-hud-name">${escape(name)}</span>`;
        const quickHtml = raiseDisabled ? '' : `
                    <div class="parlor-th-hud-raise-quick">
                        <button type="button" data-raise-quick="${shortcuts.min}">${this._t('PARLOR.TexasHoldem.Action.RaiseMin')}</button>
                        <button type="button" data-raise-quick="${shortcuts.half}">${this._t('PARLOR.TexasHoldem.Action.RaiseHalfPot')}</button>
                        <button type="button" data-raise-quick="${shortcuts.pot}">${this._t('PARLOR.TexasHoldem.Action.RaisePot')}</button>
                        <button type="button" data-raise-quick="${shortcuts.max}">${this._t('PARLOR.TexasHoldem.Action.RaiseMax')}</button>
                    </div>`;

        this._handHUD.showFooter(`
            <div class="parlor-th-hud-shell">
                <div class="parlor-th-hud-context">
                    <span class="parlor-hud-footer-label">${this._t('PARLOR.Common.CurrentParticipant')}</span>
                    ${selectHtml}
                </div>
                <div class="parlor-th-hud-tags">
                    <span>${this._t('PARLOR.TexasHoldem.Table.Stack', { amount: stack })}</span>
                    <span>${this._t('PARLOR.TexasHoldem.Table.ToCall', { amount: this._formatChip(toCall) })}</span>
                    <span>${escape(statusText)}</span>
                </div>
                <div class="parlor-th-hud-raise ${raiseDisabled ? 'is-disabled' : ''}">
                    <label for="th-hud-raise-input">${this._t('PARLOR.TexasHoldem.Action.RaiseTo')}</label>
                    <input id="th-hud-raise-input" type="number" min="${minRaiseTo}" max="${maxRaiseTo}" step="1" value="${defaultRaise}" ${raiseDisabled ? 'disabled' : ''}>
                    ${quickHtml}
                </div>
            </div>
        `);
        if (this._handHUD.root) this._handHUD.root.dataset.footerSig = sig;

        this._handHUD.root?.querySelector('#th-hud-participant')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            this.refresh();
        });
        this._handHUD.root?.querySelectorAll('[data-raise-quick]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const input = this._handHUD.root?.querySelector('#th-hud-raise-input');
                if (input) input.value = btn.dataset.raiseQuick;
            });
        });

        if (!seat) this._handHUD.hideActions();
    }

    _getRaiseShortcuts(state, participantId) {
        const minRaiseTo = this._getMinRaiseTo(state, participantId);
        const maxRaiseTo = this._getMaxRaiseTo(state, participantId);
        const currentBet = Number(state.currentBet || 0);
        const toCall = this._getCallAmount(state, participantId);
        // 先跟平再按池子加,potAfterCall 才是这一手真正能拿来算池底的钱。
        const potAfterCall = this._getTotalPot(state) + toCall;
        const clamp = (value) => Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(value)));
        return {
            min: minRaiseTo,
            half: clamp(currentBet + potAfterCall / 2),
            pot: clamp(currentBet + potAfterCall),
            max: maxRaiseTo
        };
    }

    _renderHudActions(state, participantId) {
        const isTurn = state.phase === 'PLAYER_TURNS' && state.currentPlayerId === participantId;
        const seat = state.playerStates?.[participantId] || null;
        if (!isTurn || !seat || seat.status !== 'active') {
            this._handHUD.showActions([]);
            return;
        }

        const toCall = this._getCallAmount(state, participantId);
        const canRaise = this._getMaxRaiseTo(state, participantId) > state.currentBet;
        const actions = [];

        if (toCall <= 0) {
            actions.push({
                icon: 'fas fa-hand-paper',
                label: this._t('PARLOR.TexasHoldem.Action.Check'),
                callback: event => this._requestPlayerAction(participantId, 'check', {}, event.currentTarget)
            });
        } else {
            actions.push({
                icon: 'fas fa-equals',
                label: this._t('PARLOR.TexasHoldem.Action.CallAmount', { amount: this._formatChip(toCall) }),
                callback: event => this._requestPlayerAction(participantId, 'call', {}, event.currentTarget)
            });
            actions.push({
                icon: 'fas fa-times',
                label: this._t('PARLOR.TexasHoldem.Action.Fold'),
                callback: event => this._requestPlayerAction(participantId, 'fold', {}, event.currentTarget)
            });
        }

        if (canRaise) {
            actions.push({
                icon: 'fas fa-arrow-up',
                label: this._t('PARLOR.TexasHoldem.Action.Raise'),
                accent: true,
                callback: event => {
                    const input = this._handHUD.root?.querySelector('#th-hud-raise-input');
                    // 手输的数值先夹回合法区间再提交,免得低于最低加注被后端直接打回、按钮看着却没反应。
                    const minRaiseTo = this._getMinRaiseTo(state, participantId);
                    const maxRaiseTo = this._getMaxRaiseTo(state, participantId);
                    const amount = Math.max(minRaiseTo, Math.min(maxRaiseTo, Math.round(Number(input?.value || 0))));
                    this._requestPlayerAction(participantId, 'raiseTo', { amount }, event.currentTarget);
                }
            });
        }

        actions.push({
            icon: 'fas fa-fire',
            label: this._t('PARLOR.TexasHoldem.Action.AllIn'),
            callback: event => this._requestPlayerAction(participantId, 'allIn', {}, event.currentTarget)
        });

        this._handHUD.showActions(actions);
    }

    _syncSettlement(state) {
        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-th-settlement')?.remove();
            this._settlementShownFor = '';
            return;
        }

        const key = `${state.handToken || 'setup'}:${state.roundResult?.kind || 'none'}:${state.tableSettled ? 'settled' : 'live'}`;
        if (this._settlementShownFor === key && document.querySelector('#parlor-th-settlement')) return;
        this._settlementShownFor = key;
        this._showSettlementPopup(state);
    }

    _showSettlementPopup(state) {
        document.querySelector('#parlor-th-settlement')?.remove();
        const popup = document.createElement('div');
        popup.id = 'parlor-th-settlement';
        popup.dataset.thStyle = 'v14';
        this._presenterHost?.markDetachedSurface(popup, 'settlement');
        const rows = (state.seatIds || state.playerIds || [])
            .map(id => this._renderSettlementRow(state, id))
            .join('');
        const potRows = (state.pots || [])
            .map((pot, index) => {
                const winners = (pot.winnerIds || []).map(id => getParticipantName(state, id)).join(', ') || this._t('PARLOR.TexasHoldem.Settlement.NoWinner');
                return `<div><strong>${this._t('PARLOR.TexasHoldem.Settlement.PotIndex', { index: index + 1 })}</strong> ${this._formatChip(pot.amount)} · ${escape(winners)}</div>`;
            }).join('');
        const isGM = game.user.isGM;
        const canContinue = isGM && !state.tableSettled && (state.activeSeatIds || []).length >= 2;
        const canFinish = isGM && !state.tableSettled;

        popup.innerHTML = `
            <div class="parlor-th-settlement-box">
                <h2 class="settlement-title">${this._t('PARLOR.TexasHoldem.Settlement.Title')}</h2>
                <div class="settlement-sub">${escape(this._getSettlementSub(state))}</div>
                <div class="parlor-th-pot-summary">${potRows || escape(this._t('PARLOR.TexasHoldem.Settlement.NoPots'))}</div>
                <table class="settlement-table">
                    <thead>
                        <tr>
                            <th>${this._t('PARLOR.Common.Player')}</th>
                            <th>${this._t('PARLOR.TexasHoldem.Settlement.Hand')}</th>
                            <th>${this._t('PARLOR.TexasHoldem.Table.InPotShort')}</th>
                            <th>${this._t('PARLOR.TexasHoldem.Settlement.Net')}</th>
                            <th>${this._t('PARLOR.TexasHoldem.Table.StackShort')}</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-th-settlement-actions">
                    ${canContinue ? `<button class="parlor-hud-action-btn accent" id="th-next-hand"><i class="fas fa-redo"></i> ${this._t('PARLOR.TexasHoldem.Action.NextHand')}</button>` : ''}
                    ${canFinish ? `<button class="parlor-hud-action-btn" id="th-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>` : `<button class="parlor-hud-action-btn" id="th-close-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`}
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        this._fillSettlementHands(popup, state);
        popup.querySelector('#th-next-hand')?.addEventListener('click', (event) => this._requestGMAction('newHand', {}, event.currentTarget));
        popup.querySelector('#th-finish-game')?.addEventListener('click', (event) => this._requestGMAction('finishGame', {}, event.currentTarget));
        popup.querySelector('#th-close-settlement')?.addEventListener('click', () => popup.remove());
    }

    _fillSettlementHands(popup, state) {
        // 摊牌时把每个人的最佳五张牌摆进结算行,平局是不是真同牌型一眼就能对出来。
        popup.querySelectorAll('.settlement-hand-cards').forEach((wrap) => {
            const seat = state.playerStates?.[wrap.dataset.handCards];
            const cards = Array.isArray(seat?.bestCards) ? seat.bestCards : [];
            for (const card of cards) {
                wrap.appendChild(CardRenderer.createCard(card, { size: 'mini' }));
            }
        });
    }

    _renderSettlementRow(state, participantId) {
        const seat = state.playerStates?.[participantId] || null;
        const handLabel = seat?.handRank
            ? this._t(getTexasHoldemHandLabelKey(seat.handRank))
            : (seat?.status === 'folded' ? this._t('PARLOR.TexasHoldem.Result.Fold') : this._t('PARLOR.Common.Waiting'));
        const net = this._formatSigned(seat?.handDelta || 0);
        const isWinner = seat?.result === 'win';
        const winBadge = isWinner ? `<span class="settlement-win-badge">${this._t('PARLOR.Common.Win')}</span>` : '';
        return `
            <tr class="${isWinner ? 'is-winner-row' : ''}">
                <td><div class="settlement-player">${escape(getParticipantName(state, participantId))}${winBadge}</div></td>
                <td>
                    <div class="settlement-hand">
                        <span class="settlement-hand-name">${escape(handLabel)}</span>
                        <div class="settlement-hand-cards" data-hand-cards="${escape(participantId)}"></div>
                    </div>
                </td>
                <td>${this._formatChip(seat?.committed || 0)}</td>
                <td class="${Number(seat?.handDelta || 0) >= 0 ? 'win' : 'lose'}">${net}</td>
                <td>${this._formatChip(state.tableStacks?.[participantId] || 0)}</td>
            </tr>
        `;
    }

    _buildSeatTags(state, participantId) {
        const tags = [];
        if (state.dealerButtonId === participantId) tags.push({ text: this._t('PARLOR.TexasHoldem.Tag.Dealer'), kind: 'dealer' });
        if (state.smallBlindId === participantId) tags.push({ text: this._t('PARLOR.TexasHoldem.Tag.SmallBlind'), kind: 'sb' });
        if (state.bigBlindId === participantId) tags.push({ text: this._t('PARLOR.TexasHoldem.Tag.BigBlind'), kind: 'bb' });
        return tags.map(tag => `<span class="parlor-th-seat-pill is-${tag.kind}">${escape(tag.text)}</span>`).join('');
    }

    _getSeatStatus(state, participantId) {
        const seat = state.playerStates?.[participantId] || null;
        if (!seat) {
            const stack = Number(state.tableStacks?.[participantId] || 0);
            return stack > 0
                ? { text: this._t('PARLOR.TexasHoldem.Seat.WaitingHand'), className: 'status-live' }
                : { text: this._t('PARLOR.TexasHoldem.Seat.NoStack'), className: 'status-idle' };
        }
        if (state.currentPlayerId === participantId) return { text: this._t('PARLOR.TexasHoldem.Seat.Current'), className: 'status-playing' };
        if (seat.status === 'folded') return { text: this._t('PARLOR.TexasHoldem.Result.Fold'), className: 'status-push' };
        if (seat.status === 'all-in') return { text: this._t('PARLOR.TexasHoldem.Action.AllIn'), className: 'status-live' };
        if (seat.result === 'win') return { text: this._t('PARLOR.Common.Win'), className: 'status-win' };
        if (seat.result === 'lose') return { text: this._t('PARLOR.Common.Lose'), className: 'status-lose' };
        if (seat.lastAction) return { text: this._getActionLabel(seat.lastAction), className: 'status-live' };
        return { text: this._t('PARLOR.Common.Waiting'), className: 'status-live' };
    }

    _getActionLabel(action) {
        const map = {
            check: 'PARLOR.TexasHoldem.Action.Check',
            call: 'PARLOR.TexasHoldem.Action.Call',
            fold: 'PARLOR.TexasHoldem.Action.Fold',
            raise: 'PARLOR.TexasHoldem.Action.Raise',
            'all-in': 'PARLOR.TexasHoldem.Action.AllIn',
            'small-blind': 'PARLOR.TexasHoldem.Tag.SmallBlind',
            'big-blind': 'PARLOR.TexasHoldem.Tag.BigBlind'
        };
        return this._t(map[action] || 'PARLOR.Common.Waiting');
    }

    _getPhaseTitle(state) {
        if (state.setupError?.reason === 'buy-in-short') return this._t('PARLOR.TexasHoldem.Setup.BuyInShortTitle');
        if (state.roundResult?.kind === 'waiting') return this._t('PARLOR.TexasHoldem.Table.WaitingStacks');
        if (state.phase === 'DEALING') return this._t('PARLOR.TexasHoldem.Table.Dealing');
        if (state.phase === 'RESOLVING') return this._t('PARLOR.TexasHoldem.Settlement.Title');
        return this._t('PARLOR.Common.Waiting');
    }

    _getSettlementSub(state) {
        if (state.tableSettled) return this._t('PARLOR.TexasHoldem.Settlement.TableSettled');
        if (state.roundResult?.kind === 'uncontested') {
            return this._t('PARLOR.TexasHoldem.Settlement.Uncontested', {
                name: getParticipantName(state, state.roundResult.winnerId),
                amount: this._formatChip(state.roundResult.pot || this._getTotalPot(state))
            });
        }
        if (state.roundResult?.kind === 'waiting') return this._t('PARLOR.TexasHoldem.Settlement.Waiting');
        return this._t('PARLOR.TexasHoldem.Settlement.Showdown');
    }

    _getControlledParticipantIds(state) {
        return getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => (state.seatIds || state.playerIds || []).includes(id));
    }

    _resolveSelectedParticipantId(state, controlledIds) {
        if (!controlledIds.length) return '';
        if (state.currentPlayerId && controlledIds.includes(state.currentPlayerId)) {
            this._selectedParticipantId = state.currentPlayerId;
            return state.currentPlayerId;
        }
        if (controlledIds.includes(this._selectedParticipantId)) return this._selectedParticipantId;
        const current = getCurrentControlledParticipant(state, null);
        this._selectedParticipantId = controlledIds.includes(current?.id) ? current.id : controlledIds[0];
        return this._selectedParticipantId;
    }

    _getTotalPot(state) {
        return Object.values(state.playerStates || {})
            .reduce((sum, seat) => sum + Number(seat.committed || 0), 0);
    }

    _getCallAmount(state, participantId) {
        const seat = state.playerStates?.[participantId];
        if (!seat) return 0;
        return Math.max(0, Number(state.currentBet || 0) - Number(seat.streetCommitted || 0));
    }

    _getMinRaiseTo(state, participantId) {
        const seat = state.playerStates?.[participantId] || null;
        const stack = Number(state.tableStacks?.[participantId] || 0);
        const maxRaiseTo = Number(seat?.streetCommitted || 0) + stack;
        const fullRaiseTo = Number(state.currentBet || 0) + Number(state.minRaise || state.bigBlind || 0);
        return Math.min(Math.max(fullRaiseTo, Number(state.currentBet || 0) + 1), maxRaiseTo);
    }

    _getMaxRaiseTo(state, participantId) {
        const seat = state.playerStates?.[participantId] || null;
        return Number(seat?.streetCommitted || 0) + Number(state.tableStacks?.[participantId] || 0);
    }

    _getStreetLabel(street) {
        const safeStreet = ['preflop', 'flop', 'turn', 'river', 'showdown', 'waiting'].includes(street) ? street : 'waiting';
        const key = safeStreet.charAt(0).toUpperCase() + safeStreet.slice(1);
        return this._t(`PARLOR.TexasHoldem.Street.${key}`);
    }

    _requestGMAction(action, data, button) {
        return this._runSocketAction(`gm:${action}`, button, () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
            sessionId: this.sessionId,
            action,
            data
        }));
    }

    _requestPlayerAction(participantId, action, data, button) {
        return this._runSocketAction(`player:${participantId}:${action}`, button, () => SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
            sessionId: this.sessionId,
            userId: participantId,
            action,
            data
        }));
    }

    _runSocketAction(key, button, request) {
        if (this._actionRequests.has(key)) return this._actionRequests.get(key);
        if (button) button.disabled = true;
        const pending = Promise.resolve()
            .then(request)
            .catch(err => {
                console.warn('parlor | Texas Holdem action failed', err);
                return { ok: false, reason: 'request-failed' };
            })
            .finally(() => {
                this._actionRequests.delete(key);
                if (button?.isConnected) button.disabled = false;
            });
        this._actionRequests.set(key, pending);
        return pending;
    }

    _formatChip(value) {
        const amount = Number(value || 0);
        if (Number.isInteger(amount)) return `${amount}`;
        return amount.toFixed(2).replace(/\.?0+$/, '');
    }

    _formatSigned(value) {
        const amount = Number(value || 0);
        const text = this._formatChip(amount);
        return amount > 0 ? `+${text}` : text;
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
