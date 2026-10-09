/**
 * CasinoWarTable — 赌场战争共享桌面
 *
 * 这层后续维护统一按 Foundry V14 兼容优先来收。
 * 桌面视觉继续复用老牌桌，主要换成赌场战争这套流程。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { CardHandHUD } from '../../ui/CardHandHUD.js';
import { LocalResultFx } from '../../ui/LocalResultFx.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import { BotManager } from '../../core/BotManager.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { BlackjackTable } from '../blackjack/BlackjackTable.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import {
    buildCasinoWarHud,
    buildCasinoWarSeatEntries,
    buildCasinoWarStatus
} from './CasinoWarPresenterData.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantLabel,
    getParticipantName,
    getSelfParticipant
} from '../../core/ParticipantRoster.js';

const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;
const SUIT_SYMBOLS = {
    spades: '♠',
    hearts: '♥',
    diamonds: '♦',
    clubs: '♣'
};

export class CasinoWarTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._dismissedByUser = false;
        this._prevPhase = '';
        this._settlementShown = false;
        this._selectedParticipantId = '';
        this._betDraftAmount = 10;
        this._isSubmittingBet = false;
        this._viewportFit = null;
        this._renderedDealerKey = '';
        this._dealerFaceDown = false;
        // 结算特效跟踪：避免同一轮重复弹特效
        this._resultFxRound = null;
        this._playedLocalResultFxKeys = new Set();
        this._onKeyDown = (event) => {
            // V14 兼容优先：Esc 在 Foundry 里太常用了，这里别顺手把桌关掉。
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:casinowar');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:casinowar')) {
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
        document.querySelectorAll('#parlor-cw-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-cw-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-cw-layout'
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
            document.querySelectorAll('#parlor-cw-settlement').forEach(node => node.remove());
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        LocalResultFx.clear(this._overlay);
        this._handHUD.destroy();
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-cw-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-cw-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._resetTracking();
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._presenterHost.refresh(state);
            // 结算弹窗仍归本体(契约 §11):呈现器只接管牌桌 surface,整局收尾不能被截断
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
    }

    // 主题模式下的结算同步:_refreshNative 里那段内联结算的等价物(原生路径不动)
    _syncSettlement(state) {
        if (state.phase !== this._prevPhase) {
            if (state.phase === 'BETTING') this._settlementShown = false;
            this._prevPhase = state.phase;
        }
        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-cw-settlement')?.remove();
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
            surface: 'table:casinowar',
            hostId: 'parlor-cw-presenter',
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
            getSeats: () => buildCasinoWarSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildCasinoWarStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildCasinoWarHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => {
                const state = getState();
                const targetId = participantId || this._getControlledParticipantIds(state)[0] || '';
                const seat = targetId ? state.playerStates?.[targetId] : null;
                return { participantId: targetId, cards: seat ? [seat.card, seat.warCard].filter(Boolean) : [] };
            },
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            renderCard: (card, options = {}) => CardRenderer.createCard(card, options),
            playSound: (kind) => ParlorAppearance.playCardSound(kind),
            formatChips: (amount) => this._formatChip(amount),
            getTableBackdrop: () => ParlorAppearance.getTableBackdrop?.() ?? null,
            getTableDeck: () => TableDecks.getActive(),
            openPopup: () => null,
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
            getControlledParticipantIds: (state) => this._getControlledParticipantIds(state),
            resolveSelectedParticipantId: (state, controlledIds) => {
                if (this._selectedParticipantId && controlledIds.includes(this._selectedParticipantId)) return this._selectedParticipantId;
                return controlledIds[0] || '';
            },
            isGM: () => game.user.isGM,
            getBalance: (participantId) => ChipManager.getDisplayBalance(participantId),
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    // 动作路由:GM 推进走 GM_ACTION,玩家下注走 PLAYER_ACTION(payload 形状照原生)
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['deal', 'resolveWar', 'openSettle', 'settle', 'newRound', 'finishGame']);
        if (gmActions.has(safeAction)) {
            return SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                sessionId: this.sessionId,
                action: safeAction
            });
        }

        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const participantId = String(data?.participantId || controlledIds[0] || '');
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });
        if (data?.participantId) this._selectedParticipantId = String(data.participantId);

        const payload = { ...(data || {}) };
        delete payload.participantId;
        delete payload.button;
        delete payload.gm;
        return SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
            sessionId: this.sessionId,
            userId: participantId,
            action: safeAction,
            data: payload
        });
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncResultFxRound(state);

        if (state.phase !== this._prevPhase) {
            if (state.phase === 'BETTING') {
                this._renderedDealerKey = '';
                this._dealerFaceDown = false;
                this._settlementShown = false;
                LocalResultFx.clear(this._overlay);
                document.querySelector('#parlor-cw-settlement')?.remove();
            }
            this._prevPhase = state.phase;
        }

        this._renderDealer(state);
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderHandHUD(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-cw-settlement')?.remove();
        }

        if (state.phase === 'RESOLVING' && !this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }

        this._maybePlayLocalResultFx(state);
        this._viewportFit?.update();
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-cw-overlay';
        overlay.dataset.cwStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-cw-backdrop"></div>
            <div class="parlor-cw-layout">
                <div class="parlor-seat-column seat-column-left" id="cw-seat-left"></div>
                <div class="parlor-cw-scene">
                    <div class="parlor-cw-table">
                        ${this._buildTableArt()}
                        <div class="parlor-cw-stage">
                            <div class="parlor-cw-dealer-zone">
                                <div class="parlor-cw-dealer-badge"><i class="fas fa-crown"></i> ${this._t('PARLOR.Common.Dealer')}</div>
                                <div class="parlor-cw-dealer-cards" id="cw-dealer-cards"></div>
                                <div class="parlor-cw-dealer-note" id="cw-dealer-note"></div>
                            </div>
                            <div class="parlor-cw-center" id="cw-center"></div>
                        </div>
                    </div>
                </div>
                <div class="parlor-seat-column seat-column-right" id="cw-seat-right"></div>
            </div>
            <button class="parlor-cw-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-cw-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-cw-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderDealer(state) {
        const wrap = this._overlay.querySelector('#cw-dealer-cards');
        const note = this._overlay.querySelector('#cw-dealer-note');
        if (!wrap || !note) return;

        const shouldFaceDown = state.phase === 'DEALING';
        const baseCard = state.dealerCard || null;
        const nextKey = baseCard ? `${baseCard.rank}-${baseCard.suit}` : '';

        if (!baseCard) {
            wrap.innerHTML = '';
            note.textContent = this._t('PARLOR.Common.WaitingDeal');
            this._renderedDealerKey = '';
            this._dealerFaceDown = false;
            return;
        }

        let mainSlot = wrap.querySelector('.parlor-cw-dealer-main');
        let warRow = wrap.querySelector('.parlor-cw-dealer-war');
        if (!mainSlot || !warRow) {
            wrap.innerHTML = `
                <div class="parlor-cw-dealer-main"></div>
                <div class="parlor-cw-dealer-war"></div>
            `;
            mainSlot = wrap.querySelector('.parlor-cw-dealer-main');
            warRow = wrap.querySelector('.parlor-cw-dealer-war');
        }

        if (this._renderedDealerKey !== nextKey) {
            mainSlot.innerHTML = '';
            const cardEl = CardRenderer.createCard(baseCard, {
                faceDown: shouldFaceDown,
                size: 'table'
            });
            mainSlot.appendChild(cardEl);
            CardRenderer.dealFrom(cardEl, { x: 0, y: -280 }, 0, {
                duration: 620,
                startScale: 0.68,
                settleScale: 1
            });
            this._renderedDealerKey = nextKey;
            this._dealerFaceDown = shouldFaceDown;
        } else {
            const cardEl = mainSlot.querySelector('.parlor-playing-card');
            if (cardEl && this._dealerFaceDown && !shouldFaceDown) {
                CardRenderer.flip(cardEl, false, 420);
                this._dealerFaceDown = false;
            }
        }

        warRow.innerHTML = '';
        if (['WAR', 'SETTLE', 'RESOLVING'].includes(state.phase)) {
            const warEntries = this._getWarEntries(state);
            warEntries.slice(0, 6).forEach(entry => {
                const stack = document.createElement('div');
                stack.className = 'parlor-cw-dealer-war-slot';
                const cardEl = CardRenderer.createCard(entry.card, { faceDown: false, size: 'small' });
                stack.appendChild(cardEl);
                const label = document.createElement('div');
                label.className = 'parlor-cw-dealer-war-label';
                label.textContent = entry.name;
                stack.appendChild(label);
                warRow.appendChild(stack);
            });
        }

        note.textContent = this._getDealerNote(state);
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#cw-center');
        if (!center) return;

        const isGM = game.user.isGM;
        const myId = this._getSelectedParticipantId(state);
        const myBet = this._getBetForUser(state, myId);
        const activePlayers = this._getActivePlayerIds(state);
        const controlledIds = this._getControlledParticipantIds(state);
        const bettedIds = new Set((state.bets || []).map(bet => bet.userId).filter(uid => activePlayers.includes(uid)));
        const controlledBetCount = controlledIds.filter(uid => bettedIds.has(uid)).length;
        const selectedBalance = myId ? ChipManager.getDisplayBalance(myId) : null;
        const counts = this._getSummaryCounts(state);
        const totalPot = (state.bets || []).reduce((sum, bet) => sum + Number(bet.amount || 0), 0);

        let panel = null;
        if (state.phase === 'BETTING') {
            panel = {
                tone: myBet ? 'active' : 'betting',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Betting'),
                title: myBet
                    ? this._t('PARLOR.CasinoWar.Center.BettingTitlePlaced', { amount: this._formatChip(myBet.amount) })
                    : this._t('PARLOR.CasinoWar.Center.BettingTitleIdle'),
                sub: myBet
                    ? this._t('PARLOR.CasinoWar.Center.BettingSubPlaced', { amount: this._formatChip(myBet.amount) })
                    : this._t('PARLOR.CasinoWar.Center.BettingSubIdle'),
                note: controlledIds.length > 1
                    ? this._t('PARLOR.Common.AutoAdvanceBet')
                    : this._t('PARLOR.CasinoWar.Center.BettingNote'),
                stats: [
                    { label: this._t('PARLOR.Common.TableProgress'), value: `${bettedIds.size} / ${activePlayers.length}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(totalPot)} GP` },
                    ...(selectedBalance == null ? [] : [{ label: this._t('PARLOR.Common.AvailableChips'), value: Number.isFinite(selectedBalance) ? `${selectedBalance}` : this._t('PARLOR.Common.Infinity') }])
                ]
            };
        } else if (state.phase === 'READY') {
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Ready'),
                title: isGM ? this._t('PARLOR.CasinoWar.Center.ReadyTitleGM') : this._t('PARLOR.CasinoWar.Center.ReadyTitlePlayer'),
                sub: this._t('PARLOR.CasinoWar.Center.ReadySub'),
                note: isGM ? this._t('PARLOR.CasinoWar.Center.ReadyNoteGM') : this._t('PARLOR.CasinoWar.Center.ReadyNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.Players'), value: `${activePlayers.length}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(totalPot)} GP` }
                ]
            };
        } else if (state.phase === 'DEALING') {
            panel = {
                tone: 'dealing',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Dealing'),
                title: this._t('PARLOR.CasinoWar.Center.DealingTitle'),
                sub: this._t('PARLOR.CasinoWar.Center.DealingSub'),
                note: this._t('PARLOR.CasinoWar.Center.DealingNote'),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.Players'), value: `${activePlayers.length}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(totalPot)} GP` }
                ]
            };
        } else if (state.phase === 'SHOWDOWN') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Showdown'),
                title: state.warParticipants?.length
                    ? this._t('PARLOR.CasinoWar.Center.ShowdownWarTitle', { count: state.warParticipants.length })
                    : this._t('PARLOR.CasinoWar.Center.ShowdownTitle'),
                sub: this._t('PARLOR.CasinoWar.Center.ShowdownSummary', { wins: counts.wins, losses: counts.losses, wars: counts.wars }),
                note: isGM
                    ? (state.warParticipants?.length ? this._t('PARLOR.CasinoWar.Center.ShowdownNoteGM') : this._t('PARLOR.CasinoWar.Center.ShowdownNoWarGM'))
                    : (state.warParticipants?.length ? this._t('PARLOR.CasinoWar.Center.ShowdownNotePlayer') : this._t('PARLOR.CasinoWar.Center.ShowdownNoWarPlayer')),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.DealerCard'), value: this._cardLabel(state.dealerCard) },
                    { label: this._t('PARLOR.CasinoWar.Stat.Wins'), value: `${counts.wins}` },
                    { label: this._t('PARLOR.CasinoWar.Stat.WarSeats'), value: `${counts.wars}` }
                ]
            };
        } else if (state.phase === 'WAR') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.War'),
                title: this._t('PARLOR.CasinoWar.Center.WarTitle'),
                sub: this._t('PARLOR.CasinoWar.Center.WarSummary', { wins: counts.warWins, losses: counts.warLosses, pushes: counts.warPushes }),
                note: isGM ? this._t('PARLOR.CasinoWar.Center.WarNoteGM') : this._t('PARLOR.CasinoWar.Center.WarNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.WarSeats'), value: `${state.warParticipants?.length || 0}` },
                    { label: this._t('PARLOR.CasinoWar.Stat.DealerCard'), value: this._cardLabel(state.dealerCard) }
                ]
            };
        } else if (state.phase === 'SETTLE') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Settle'),
                title: this._t('PARLOR.CasinoWar.Center.SettleTitle'),
                sub: myBet ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatDelta(state, myId) }) : this._t('PARLOR.Common.ResultOnSeat'),
                note: isGM ? this._t('PARLOR.CasinoWar.Center.SettleNoteGM') : this._t('PARLOR.CasinoWar.Center.SettleNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.Wins'), value: `${counts.wins + counts.warWins}` },
                    { label: this._t('PARLOR.CasinoWar.Stat.Losses'), value: `${counts.losses + counts.surrenders + counts.warLosses}` }
                ]
            };
        } else if (state.phase === 'RESOLVING') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.CasinoWar.Center.Phase.Resolving'),
                title: this._t('PARLOR.CasinoWar.Center.ResolvingTitle'),
                sub: myBet ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatDelta(state, myId) }) : this._t('PARLOR.Common.ViewSettlementPanel'),
                note: isGM ? this._t('PARLOR.CasinoWar.Center.ResolvingNoteGM') : this._t('PARLOR.CasinoWar.Center.ResolvingNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.CasinoWar.Stat.Wins'), value: `${counts.wins + counts.warWins}` },
                    { label: this._t('PARLOR.CasinoWar.Stat.WarSeats'), value: `${state.warParticipants?.length || 0}` }
                ]
            };
        }

        center.innerHTML = panel ? this._buildCenterPanel(state, panel) : '';
    }

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#cw-seat-left');
        const rightColumn = this._overlay.querySelector('#cw-seat-right');
        if (!leftColumn || !rightColumn) return;

        leftColumn.innerHTML = '';
        rightColumn.innerHTML = '';

        const myId = this._getSelfSeatParticipantId(state);
        const allSeatIds = this._getActivePlayerIds(state);
        const hasMe = allSeatIds.includes(myId);
        const otherSeatIds = allSeatIds.filter(uid => uid !== myId).slice(0, hasMe ? MAX_VISIBLE_SEATS - 1 : MAX_VISIBLE_SEATS);

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

        leftColumn.classList.toggle('is-empty', leftSeatIds.length === 0);
        rightColumn.classList.toggle('is-empty', rightSeatIds.length === 0);

        const visibleSeatIds = [...leftSeatIds, ...rightSeatIds];
        const seatEntries = [
            ...leftSeatIds.map(uid => ({ uid, target: leftColumn, zone: 'left' })),
            ...rightSeatIds.map(uid => ({ uid, target: rightColumn, zone: 'right' }))
        ];

        for (const { uid, target, zone } of seatEntries) {
            const participant = this._describeParticipant(state, uid);
            const bet = this._getBetForUser(state, uid);
            const seatState = this._getSeatState(state, uid);
            const isMe = uid === myId;
            const seatNum = Math.max(1, visibleSeatIds.indexOf(uid) + 1);
            const { text: statusText, className: statusClass } = this._getSeatStatus(state, uid);

            const seat = document.createElement('div');
            seat.className = `parlor-seat-card parlor-cw-seat seat-${zone}${isMe ? ' is-me' : ''}${bet ? ' has-bet' : ''}${['SHOWDOWN', 'WAR', 'SETTLE', 'RESOLVING'].includes(state.phase) && bet ? ' has-result' : ''}`;
            seat.innerHTML = `
                <div class="parlor-seat-avatar-wrap">
                    <div class="parlor-seat-avatar">${participant.avatarHtml}</div>
                </div>
                <div class="parlor-seat-info">
                    <div class="parlor-seat-head">
                        <div class="parlor-seat-head-top">
                            <span class="parlor-seat-name-mark">${participant.kind === 'bot' ? this._t('PARLOR.Common.BOT') : (participant.kind === 'npc' ? this._t('PARLOR.Common.NPC') : this._t('PARLOR.Common.Player'))}</span>
                            <div class="parlor-seat-num">#${seatNum}</div>
                        </div>
                        <div class="parlor-seat-name">
                            <span class="parlor-seat-name-text">${isMe ? this._t('PARLOR.Common.You') : participant.name}</span>
                        </div>
                    </div>
                    <div class="parlor-seat-meta">
                        ${bet
                            ? `<div class="parlor-seat-bet">${this._formatChip(bet.amount)} GP</div>`
                            : `<div class="parlor-seat-bet is-empty">${this._t('PARLOR.Common.WaitingBet')}</div>`
                        }
                        <div class="parlor-seat-status ${statusClass}">${statusText}</div>
                    </div>
                    <div class="parlor-cw-seat-cards"></div>
                    <div class="parlor-cw-seat-note">${this._getSeatNote(state, uid)}</div>
                </div>
            `;

            target.appendChild(seat);
            this._renderSeatCards(seat.querySelector('.parlor-cw-seat-cards'), seatState, state.phase);
        }
    }

    _renderSeatCards(container, seatState, phase) {
        if (!container) return;
        container.innerHTML = '';

        const showBase = seatState?.card && !['BETTING', 'READY'].includes(phase);
        const showWar = seatState?.warCard && ['WAR', 'SETTLE', 'RESOLVING'].includes(phase);

        if (!showBase && !showWar) {
            container.innerHTML = `<div class="parlor-cw-seat-empty">${this._t('PARLOR.Common.WaitingDeal')}</div>`;
            return;
        }

        if (showBase) {
            const baseCard = CardRenderer.createCard(seatState.card, {
                faceDown: phase === 'DEALING',
                size: 'small'
            });
            container.appendChild(baseCard);
        }

        if (showWar) {
            const warCard = CardRenderer.createCard(seatState.warCard, {
                faceDown: false,
                size: 'small'
            });
            warCard.classList.add('is-war-card');
            container.appendChild(warCard);
        }
    }

    _renderHandHUD(state) {
        if (!this._handHUD.root) this._handHUD.show([]);

        const myId = this._getSelectedParticipantId(state);
        const isGM = game.user.isGM;
        const controlledIds = this._getControlledParticipantIds(state);
        const isPlayer = !!myId && controlledIds.includes(myId);
        const myBet = this._getBetForUser(state, myId);
        const actions = [];
        let footer = '';

        if (state.phase === 'BETTING') {
            footer = this._buildBettingFooter(state, { myId, controlledIds, isPlayer, myBet });
        } else if (state.phase === 'READY') {
            if (isGM) {
                actions.push({
                    label: this._t('PARLOR.CasinoWar.Action.DealByDM'),
                    accent: true,
                    icon: 'fas fa-play',
                    callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                        sessionId: this.sessionId,
                        action: 'deal'
                    })
                });
            }
            footer = this._buildFooter(this._t('PARLOR.Common.Ready'), isGM ? this._t('PARLOR.CasinoWar.Footer.ReadyGM') : this._t('PARLOR.CasinoWar.Footer.ReadyPlayer'));
        } else if (state.phase === 'DEALING') {
            footer = this._buildFooter(this._t('PARLOR.Common.Dealing'), this._t('PARLOR.CasinoWar.Footer.Dealing'));
        } else if (state.phase === 'SHOWDOWN') {
            if (isGM) {
                actions.push({
                    label: state.warParticipants?.length ? this._t('PARLOR.CasinoWar.Action.ResolveWar') : this._t('PARLOR.CasinoWar.Action.OpenSettle'),
                    accent: true,
                    icon: state.warParticipants?.length ? 'fas fa-burst' : 'fas fa-arrow-right',
                    callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                        sessionId: this.sessionId,
                        action: state.warParticipants?.length ? 'resolveWar' : 'openSettle'
                    })
                });
            }
            footer = this._buildFooter(
                this._t('PARLOR.CasinoWar.Footer.Showdown'),
                state.warParticipants?.length ? this._t('PARLOR.CasinoWar.Footer.ShowdownWar') : this._t('PARLOR.CasinoWar.Footer.ShowdownDone')
            );
        } else if (state.phase === 'WAR') {
            if (isGM) {
                actions.push({
                    label: this._t('PARLOR.CasinoWar.Action.OpenSettle'),
                    accent: true,
                    icon: 'fas fa-arrow-right',
                    callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                        sessionId: this.sessionId,
                        action: 'openSettle'
                    })
                });
            }
            footer = this._buildFooter(this._t('PARLOR.CasinoWar.Footer.War'), this._t('PARLOR.CasinoWar.Footer.WarDone'));
        } else if (state.phase === 'SETTLE') {
            if (isGM) {
                actions.push({
                    label: this._t('PARLOR.Common.Settle'),
                    accent: true,
                    icon: 'fas fa-file-invoice-dollar',
                    callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                        sessionId: this.sessionId,
                        action: 'settle'
                    })
                });
            }
            footer = this._buildFooter(this._t('PARLOR.CasinoWar.Footer.Settle'), isGM ? this._t('PARLOR.CasinoWar.Footer.SettleGM') : this._t('PARLOR.CasinoWar.Footer.SettlePlayer'));
        } else if (state.phase === 'RESOLVING') {
            if (isGM) {
                actions.push(
                    {
                        label: this._t('PARLOR.Common.Finish'),
                        icon: 'fas fa-door-closed',
                        callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                            sessionId: this.sessionId,
                            action: 'finishGame'
                        })
                    },
                    {
                        label: this._t('PARLOR.Common.NextRound'),
                        accent: true,
                        icon: 'fas fa-redo',
                        callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                            sessionId: this.sessionId,
                            action: 'newRound'
                        })
                    }
                );
            }
            footer = this._buildFooter(this._t('PARLOR.CasinoWar.Footer.ResultOpen'), this._t('PARLOR.Common.ViewSettlementPanel'));
        }

        if (actions.length) this._handHUD.showActions(actions);
        else this._handHUD.hideActions();

        if (footer) {
            this._handHUD.showFooter(footer);
            this._bindHudFooter(state, { myId });
        } else {
            this._handHUD.hideFooter();
        }
    }

    _buildBettingFooter(state, { myId, controlledIds, isPlayer, myBet }) {
        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => (state.playerIds || []).includes(entry.id));
        const balanceLabel = myId ? ChipManager.getDisplayBalance(myId) : '0';
        const amount = Math.max(1, Number(myBet?.amount || this._betDraftAmount || 10));
        const controlledBetCount = controlledIds.filter(uid => this._getBetForUser(state, uid)).length;
        const selectedParticipant = controlledParticipants.find(entry => entry.id === myId) || null;
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="cw-hud-participant-select" class="parlor-hud-footer-input" style="width:190px;">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === myId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : '';
        const participantLabel = selectedParticipant ? getParticipantLabel(selectedParticipant) : this._t('PARLOR.Common.CurrentParticipant');

        let title = myBet ? this._t('PARLOR.Common.AlreadyBet', { name: participantLabel }) : (isPlayer ? this._t('PARLOR.Common.BettingPanel') : this._t('PARLOR.Common.Spectating'));
        let sub = myBet
            ? this._t('PARLOR.CasinoWar.Footer.CurrentBet', { amount: this._formatChip(myBet.amount) })
            : (controlledIds.length > 1 ? this._t('PARLOR.CasinoWar.Footer.MultiControl', { count: controlledIds.length, done: controlledBetCount }) : this._t('PARLOR.CasinoWar.Footer.BetAny'));
        let rightHtml = `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.WaitingBet')}</span>`;

        if (isPlayer) {
            rightHtml = `
                <div class="parlor-cw-hud-betbox">
                    <input type="number" id="cw-hud-bet-input" value="${amount}" min="1" class="parlor-hud-footer-input" placeholder="GP">
                    <button class="parlor-hud-action-btn accent" id="cw-hud-bet-confirm"><i class="fas fa-coins"></i> ${this._t('PARLOR.Common.Bet')}</button>
                </div>
            `;
        } else if (!controlledIds.length) {
            sub = this._t('PARLOR.Common.NoControlledParticipant');
        }

        return `
            <div class="parlor-hud-footer-main parlor-cw-hud-shell">
                <div class="parlor-hud-footer-side parlor-cw-hud-side">
                    <div class="parlor-cw-hud-context">
                        <span class="parlor-hud-footer-label">${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml || `<span class="parlor-cw-hud-name">${participantLabel}</span>`}
                    </div>
                    <div class="parlor-cw-hud-meta">
                        <span class="parlor-hud-footer-pill">${Number.isFinite(balanceLabel) ? `${balanceLabel} ${this._t('PARLOR.Common.Chips')}` : this._t('PARLOR.Common.ChipsInfinity')}</span>
                        <span class="parlor-hud-footer-pill ${myBet ? '' : 'muted'}">${myBet ? `${this._formatChip(myBet.amount)} GP` : this._t('PARLOR.CasinoWar.Footer.NotBetYet')}</span>
                    </div>
                </div>
                <div class="parlor-hud-footer-center parlor-cw-hud-center">
                    <div class="parlor-hud-footer-title">${title}</div>
                    <div class="parlor-hud-footer-sub">${sub}</div>
                    <div class="parlor-cw-hud-hint">${controlledIds.length > 1 ? this._t('PARLOR.Common.AutoAdvanceBet') : this._t('PARLOR.Common.BetHint')}</div>
                </div>
                <div class="parlor-hud-footer-side align-right parlor-cw-hud-side right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _bindHudFooter(state, { myId }) {
        const root = this._handHUD.root;
        if (!root) return;

        root.querySelector('#cw-hud-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const selectedBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAmount = Math.max(1, Number(selectedBet?.amount || this._betDraftAmount || 10));
            this.refresh();
        });

        root.querySelector('#cw-hud-bet-input')?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        root.querySelector('#cw-hud-bet-confirm')?.addEventListener('click', () => {
            const participantId = root.querySelector('#cw-hud-participant-select')?.value || myId || this._selectedParticipantId;
            this._submitBet(participantId);
        });
    }

    async _submitBet(preferredParticipantId = null) {
        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const participantId = controlledIds.includes(preferredParticipantId)
            ? preferredParticipantId
            : this._getSelectedParticipantId(state);
        const amountInput = this._handHUD.root?.querySelector('#cw-hud-bet-input');
        const amount = Math.max(0, parseInt(amountInput?.value, 10) || 0);

        if (!participantId) {
            ui.notifications.warn(this._t('PARLOR.Common.BetMissingParticipant'));
            return;
        }
        if (amount <= 0) {
            ui.notifications.warn(this._t('PARLOR.Common.BetAmountTooLow'));
            amountInput?.focus();
            return;
        }
        if (this._isSubmittingBet) return;

        this._selectedParticipantId = participantId;
        this._betDraftAmount = amount;
        this._isSubmittingBet = true;

        try {
            const result = await SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
                sessionId: this.sessionId,
                userId: participantId,
                action: 'placeBet',
                data: { amount }
            });

            if (result?.ok === false) {
                this._showBetFailure(result, participantId, amount);
                return;
            }

            this._advanceControlledSelectionAfterBet(state, participantId);
            this.refresh();
        } catch (err) {
            console.error('parlor | Casino War bet failed:', err);
            ui.notifications.error(this._t('PARLOR.Common.BetFailed'));
        } finally {
            this._isSubmittingBet = false;
        }
    }

    _showBetFailure(result, participantId, amount) {
        switch (result.reason) {
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

    _advanceControlledSelectionAfterBet(state, participantId) {
        const nextId = this._getNextUnbetControlledParticipantId(state, participantId);
        if (!nextId) return;
        this._selectedParticipantId = nextId;
        const nextBet = this._getBetForUser(state, nextId);
        if (nextBet?.amount) this._betDraftAmount = nextBet.amount;
    }

    _getNextUnbetControlledParticipantId(state, currentId) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) return '';

        const currentIndex = Math.max(0, controlledIds.indexOf(currentId));
        const bettedIds = new Set((state.bets || []).map(bet => bet.userId));
        bettedIds.add(currentId);

        for (let step = 1; step < controlledIds.length; step++) {
            const candidate = controlledIds[(currentIndex + step) % controlledIds.length];
            if (!bettedIds.has(candidate)) return candidate;
        }

        return controlledIds[currentIndex] || controlledIds[0] || '';
    }

    _showSettlementPopup(state) {
        document.querySelector('#parlor-cw-settlement')?.remove();
        const counts = this._getSummaryCounts(state);

        const popup = document.createElement('div');
        popup.id = 'parlor-cw-settlement';
        popup.dataset.cwStyle = 'v14';
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        const rows = this._getActivePlayerIds(state).map(uid => {
            const bet = this._getBetForUser(state, uid);
            const payout = Number(state.payouts?.[uid] || 0);
            return `
                <tr>
                    <td>${this._playerName(state, uid)}</td>
                    <td>${this._formatStake(state, uid, bet)}</td>
                    <td>${this._formatReveal(state, uid)}</td>
                    <td>${this._formatResult(state, uid)}</td>
                    <td>${this._formatChip(payout)} GP</td>
                    <td>${this._formatDelta(state, uid)}</td>
                </tr>
            `;
        }).join('');

        popup.innerHTML = `
            <div class="parlor-cw-settlement-box">
                <div class="settlement-title">${this._t('PARLOR.CasinoWar.Settlement.Title')}</div>
                <div class="settlement-sub">${this._t('PARLOR.CasinoWar.Center.ShowdownSummary', {
                    wins: counts.wins + counts.warWins,
                    losses: counts.losses + counts.warLosses + counts.surrenders,
                    wars: state.warParticipants?.length || 0
                })}</div>
                <table class="settlement-table">
                    <thead><tr><th>${this._t('PARLOR.Common.Player')}</th><th>${this._t('PARLOR.CasinoWar.Settlement.Bet')}</th><th>${this._t('PARLOR.CasinoWar.Settlement.Reveal')}</th><th>${this._t('PARLOR.CasinoWar.Settlement.Result')}</th><th>${this._t('PARLOR.CasinoWar.Settlement.Payout')}</th><th>${this._t('PARLOR.CasinoWar.Settlement.Net')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-prompt-actions" style="margin-top:16px;">
                    ${game.user.isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="cw-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="cw-next-round"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="cw-dismiss-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        popup.querySelector('#cw-dismiss-settlement')?.addEventListener('click', () => popup.remove());
        popup.querySelector('#cw-finish-game')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#cw-next-round')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'finishGame' });
        });
        popup.querySelector('#cw-next-round')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#cw-finish-game')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'newRound' });
        });
    }

    _buildFooter(title, sub) {
        return `
            <div class="parlor-hand-hud-footer-main">
                <div class="parlor-hud-footer-side"></div>
                <div class="parlor-hud-footer-center">
                    <div class="parlor-hud-footer-title">${title}</div>
                    <div class="parlor-hud-footer-sub">${sub}</div>
                </div>
                <div class="parlor-hud-footer-side align-right"></div>
            </div>
        `;
    }

    _buildCenterPanel(state, { phaseLabel, title, sub = '', note = '', stats = [], tone = '' }) {
        const statsHtml = stats
            .filter(entry => entry?.label && entry?.value != null && entry.value !== '')
            .map(entry => `
                <div class="parlor-cw-prompt-stat">
                    <div class="parlor-cw-prompt-stat-label">${entry.label}</div>
                    <div class="parlor-cw-prompt-stat-value">${entry.value}</div>
                </div>
            `)
            .join('');

        return `
            <div class="parlor-cw-prompt ${tone ? `tone-${tone}` : ''}">
                <div class="parlor-cw-prompt-head">
                    <div class="parlor-cw-prompt-phase">${phaseLabel}</div>
                    <div class="parlor-cw-prompt-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round })}</div>
                </div>
                <div class="parlor-cw-prompt-title">${title}</div>
                ${sub ? `<div class="parlor-cw-prompt-sub">${sub}</div>` : ''}
                ${statsHtml ? `<div class="parlor-cw-prompt-stats">${statsHtml}</div>` : ''}
                ${note ? `<div class="parlor-cw-prompt-note">${note}</div>` : ''}
            </div>
        `;
    }

    _getSummaryCounts(state) {
        const counts = {
            wins: 0,
            losses: 0,
            wars: 0,
            surrenders: 0,
            warWins: 0,
            warLosses: 0,
            warPushes: 0
        };

        for (const uid of this._getActivePlayerIds(state)) {
            const result = this._getSeatState(state, uid)?.result || '';
            if (result === 'win') counts.wins++;
            if (result === 'lose') counts.losses++;
            if (result === 'war') counts.wars++;
            if (result === 'surrender') counts.surrenders++;
            if (result === 'war-win') counts.warWins++;
            if (result === 'war-lose') counts.warLosses++;
            if (result === 'war-push') counts.warPushes++;
        }

        return counts;
    }

    _getSeatStatus(state, uid) {
        const bet = this._getBetForUser(state, uid);
        const seatState = this._getSeatState(state, uid);

        if (!bet) return { text: this._t('PARLOR.Common.WaitingBet'), className: 'status-idle' };
        if (state.phase === 'BETTING') return { text: this._t('PARLOR.CasinoWar.Seat.StatusPlaced'), className: 'status-live' };
        if (state.phase === 'READY') return { text: this._t('PARLOR.CasinoWar.Seat.StatusReady'), className: 'status-live' };
        if (state.phase === 'DEALING') return { text: this._t('PARLOR.CasinoWar.Seat.StatusDealing'), className: 'status-live' };

        switch (seatState?.result) {
            case 'win': return { text: this._t('PARLOR.CasinoWar.Seat.StatusWin'), className: 'status-win' };
            case 'lose': return { text: this._t('PARLOR.CasinoWar.Seat.StatusLose'), className: 'status-lose' };
            case 'war': return { text: this._t('PARLOR.CasinoWar.Seat.StatusWar'), className: 'status-live' };
            case 'surrender': return { text: this._t('PARLOR.CasinoWar.Seat.StatusSurrender'), className: 'status-push' };
            case 'war-win': return { text: this._t('PARLOR.CasinoWar.Seat.StatusWarWin'), className: 'status-win' };
            case 'war-lose': return { text: this._t('PARLOR.CasinoWar.Seat.StatusWarLose'), className: 'status-lose' };
            case 'war-push': return { text: this._t('PARLOR.CasinoWar.Seat.StatusWarPush'), className: 'status-push' };
            default: return { text: this._t('PARLOR.Common.WaitingDeal'), className: 'status-idle' };
        }
    }

    _getSeatNote(state, uid) {
        const bet = this._getBetForUser(state, uid);
        const seatState = this._getSeatState(state, uid);

        if (!bet) return this._t('PARLOR.CasinoWar.Seat.NoteIdle');
        if (state.phase === 'BETTING') {
            return this._t('PARLOR.CasinoWar.Seat.NoteBetting', { amount: this._formatChip(bet.amount) });
        }
        if (state.phase === 'READY') {
            return this._t('PARLOR.CasinoWar.Seat.NoteReady', { amount: this._formatChip(bet.amount) });
        }
        if (state.phase === 'DEALING') return this._t('PARLOR.CasinoWar.Seat.NoteDealing');

        const mainLabel = this._cardLabel(seatState?.card);
        const dealerLabel = this._cardLabel(state.dealerCard);
        const warLabel = this._cardLabel(seatState?.warCard);
        const dealerWarLabel = this._cardLabel(state.dealerWarCards?.[uid]);

        switch (seatState?.result) {
            case 'win':
                return this._t('PARLOR.CasinoWar.Seat.NoteWin', { player: mainLabel, dealer: dealerLabel });
            case 'lose':
                return this._t('PARLOR.CasinoWar.Seat.NoteLose', { player: mainLabel, dealer: dealerLabel });
            case 'war':
                return this._t('PARLOR.CasinoWar.Seat.NoteWar', { player: mainLabel, dealer: dealerLabel });
            case 'surrender':
                return this._t('PARLOR.CasinoWar.Seat.NoteSurrender');
            case 'war-win':
                return this._t('PARLOR.CasinoWar.Seat.NoteWarWin', { player: warLabel, dealer: dealerWarLabel });
            case 'war-lose':
                return this._t('PARLOR.CasinoWar.Seat.NoteWarLose', { player: warLabel, dealer: dealerWarLabel });
            case 'war-push':
                return this._t('PARLOR.CasinoWar.Seat.NoteWarPush', { player: warLabel, dealer: dealerWarLabel });
            default:
                return this._t('PARLOR.Common.WaitingDeal');
        }
    }

    _getDealerNote(state) {
        if (state.phase === 'BETTING') {
            return game.user.isGM
                ? this._t('PARLOR.CasinoWar.DealerNote.BettingGM')
                : this._t('PARLOR.CasinoWar.DealerNote.BettingPlayer');
        }
        if (state.phase === 'READY') {
            return game.user.isGM
                ? this._t('PARLOR.CasinoWar.DealerNote.ReadyGM')
                : this._t('PARLOR.CasinoWar.DealerNote.ReadyPlayer');
        }
        if (state.phase === 'DEALING') return this._t('PARLOR.CasinoWar.DealerNote.Dealing');
        if (state.phase === 'SHOWDOWN') {
            return state.warParticipants?.length
                ? this._t('PARLOR.CasinoWar.DealerNote.ShowdownWar', { count: state.warParticipants.length })
                : this._t('PARLOR.CasinoWar.DealerNote.ShowdownClear');
        }
        if (state.phase === 'WAR') return this._t('PARLOR.CasinoWar.DealerNote.War');
        if (state.phase === 'SETTLE') return this._t('PARLOR.CasinoWar.DealerNote.Settle');
        if (state.phase === 'RESOLVING') return this._t('PARLOR.CasinoWar.DealerNote.Resolving');
        return this._t('PARLOR.Common.WaitingDeal');
    }

    _getWarEntries(state) {
        return (state.warParticipants || [])
            .map(uid => {
                const card = state.dealerWarCards?.[uid] || null;
                if (!card) return null;
                return {
                    userId: uid,
                    name: this._playerName(state, uid),
                    card
                };
            })
            .filter(Boolean);
    }

    _formatStake(state, uid, bet = this._getBetForUser(state, uid)) {
        if (!bet) return '—';
        const warBet = Number(this._getSeatState(state, uid)?.warBet || 0);
        if (warBet > 0) {
            return this._t('PARLOR.CasinoWar.Settlement.StakeWithWar', {
                bet: this._formatChip(bet.amount),
                war: this._formatChip(warBet)
            });
        }
        return `${this._formatChip(bet.amount)} GP`;
    }

    _formatReveal(state, uid) {
        const seatState = this._getSeatState(state, uid);
        if (!seatState?.card) return '—';

        const main = this._cardLabel(seatState.card);
        if (!seatState?.warCard) return main;
        return this._t('PARLOR.CasinoWar.Settlement.RevealWar', {
            main,
            war: this._cardLabel(seatState.warCard)
        });
    }

    _formatResult(state, uid) {
        const seatState = this._getSeatState(state, uid);
        switch (seatState?.result) {
            case 'win': return this._t('PARLOR.CasinoWar.ResultLabel.Win');
            case 'lose': return this._t('PARLOR.CasinoWar.ResultLabel.Lose');
            case 'war': return this._t('PARLOR.CasinoWar.ResultLabel.War');
            case 'surrender': return this._t('PARLOR.CasinoWar.ResultLabel.Surrender');
            case 'war-win': return this._t('PARLOR.CasinoWar.ResultLabel.WarWin');
            case 'war-lose': return this._t('PARLOR.CasinoWar.ResultLabel.WarLose');
            case 'war-push': return this._t('PARLOR.CasinoWar.ResultLabel.WarPush');
            default: return this._t('PARLOR.Common.NoBet');
        }
    }

    _getSeatState(state, uid) {
        return state.playerStates?.[uid] || null;
    }

    _getBetForUser(state, userId) {
        return (state.bets || []).find(bet => bet.userId === userId) || null;
    }

    _getTotalStake(state, uid) {
        const bet = this._getBetForUser(state, uid);
        const warBet = Number(this._getSeatState(state, uid)?.warBet || 0);
        return Number(bet?.amount || 0) + warBet;
    }

    _getDeltaValue(state, uid) {
        const payout = Number(state.payouts?.[uid] || 0);
        return Number((payout - this._getTotalStake(state, uid)).toFixed(2));
    }

    _formatDelta(state, uid) {
        const value = this._getDeltaValue(state, uid);
        if (value > 0) return `+${this._formatChip(value)} GP`;
        if (value < 0) return `${this._formatChip(value)} GP`;
        return '0 GP';
    }

    _formatChip(amount) {
        const value = Math.round(Number(amount || 0) * 100) / 100;
        if (Number.isInteger(value)) return `${value}`;
        return value.toFixed(2).replace(/\.?0+$/, '');
    }

    _cardLabel(card) {
        if (!card?.rank) return '—';
        return `${card.rank}${SUIT_SYMBOLS[card.suit] || ''}`;
    }

    _buildTableArt() {
        // V14 兼容优先：赌场战争先直接吃 21 点那张老牌桌，别再分叉第二套大 SVG。
        return BlackjackTable.prototype._buildTableArt.call(this)
            .replace(/parlor-bj-table-svg/g, 'parlor-cw-table-svg')
            .replace(/bj-/g, 'cw-')
            .replace('BLACKJACK', 'CASINO WAR')
            .replace('HIGH TABLE', 'CLASSIC TABLE');
    }

    _getDealerProfile(state) {
        const fallback = game.users?.find(user => user.isGM && user.active);
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

    _getActivePlayerIds(state) {
        return (state.playerIds || []).filter(Boolean);
    }

    _describeParticipant(state, uid) {
        const info = getDisplayParticipant(state, uid);
        if (BotManager.isBot(uid)) {
            info.name = BotManager.getBotName(uid);
        }
        return info;
    }

    _playerName(state, uid) {
        return getParticipantName(state, uid);
    }

    _getControlledParticipantIds(state) {
        return getControlledParticipants(state)
            .map(entry => entry.id)
            .filter(id => this._getActivePlayerIds(state).includes(id));
    }

    _getSelectedParticipantId(state) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) {
            this._selectedParticipantId = '';
            return '';
        }
        if (controlledIds.includes(this._selectedParticipantId)) return this._selectedParticipantId;

        const current = getCurrentControlledParticipant(state);
        this._selectedParticipantId = controlledIds.includes(current?.id) ? current.id : controlledIds[0];
        return this._selectedParticipantId;
    }

    _getSelfSeatParticipantId(state) {
        return getSelfParticipant(state)?.id || '';
    }

    _resetTracking() {
        this._prevPhase = '';
        this._settlementShown = false;
        this._renderedDealerKey = '';
        this._dealerFaceDown = false;
        this._resultFxRound = null;
        this._playedLocalResultFxKeys.clear();
    }

    // 跟其他 4 桌一致的结算特效接入：每轮 round 切换时清空已播队列。
    _syncResultFxRound(state) {
        const round = Number.isFinite(Number(state?.round)) ? Number(state.round) : 0;
        if (this._resultFxRound === round) return;
        this._resultFxRound = round;
        this._playedLocalResultFxKeys.clear();
        LocalResultFx.clear(this._overlay);
    }

    _maybePlayLocalResultFx(state) {
        const hits = this._collectLocalResultFxHits(state);
        if (!hits.length) return;
        hits.forEach(hit => this._playedLocalResultFxKeys.add(hit.key));
        LocalResultFx.enqueue(this._overlay, hits);
    }

    // 只在 RESOLVING 阶段、对玩家自己控制的座位、按 round 唯一一次入队
    _collectLocalResultFxHits(state) {
        if (state.phase !== 'RESOLVING') return [];
        const round = this._resultFxRound ?? 0;
        const controlledIds = this._getControlledParticipantIds(state);
        return controlledIds.flatMap(uid => {
            const bet = this._getBetForUser(state, uid);
            if (!bet) return [];

            const key = `resolve:${round}:${uid}`;
            if (this._playedLocalResultFxKeys.has(key)) return [];

            const delta = this._getDeltaValue(state, uid);
            const tone = delta > 0 ? 'win' : (delta < 0 ? 'lose' : 'push');
            return [{
                key,
                tone,
                icon: tone === 'win' ? '✦' : (tone === 'lose' ? '✕' : '○'),
                title: this._t(
                    tone === 'win'
                        ? 'PARLOR.ResultFx.WinTitle'
                        : (tone === 'lose' ? 'PARLOR.ResultFx.LoseTitle' : 'PARLOR.ResultFx.PushTitle')
                ),
                sub: `${this._playerName(state, uid)} · ${this._formatDelta(state, uid)}`,
                duration: 1420
            }];
        });
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
