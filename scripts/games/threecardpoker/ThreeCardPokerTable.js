/**
 * ThreeCardPokerTable — 三张扑克共享桌面
 *
 * 这桌还是按 V14 那套覆盖层来写，
 * 但交互节奏会更像“多人对庄 + 自己手里做决定”。
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
    buildThreeCardPokerHud,
    buildThreeCardPokerSeatEntries,
    buildThreeCardPokerStatus
} from './ThreeCardPokerPresenterData.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantLabel,
    getParticipantName,
    getSelfParticipant
} from '../../core/ParticipantRoster.js';

const ACTION_LOCK_MS = 420;
const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;

export class ThreeCardPokerTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._dismissedByUser = false;
        this._prevPhase = '';
        this._settlementShown = false;
        this._selectedParticipantId = '';
        this._betDraftAnteAmount = 10;
        this._betDraftPairPlusAmount = 0;
        this._dealerRenderKey = '';
        this._dealerCardsRevealed = false;
        this._hudCardsKey = '';
        this._actionRequests = new Map();
        this._viewportFit = null;
        this._resultFxRound = null;
        this._playedLocalResultFxKeys = new Set();
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:threecardpoker');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:threecardpoker')) {
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
        document.querySelectorAll('#parlor-tcp-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-tcp-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-tcp-layout'
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
            document.querySelectorAll('#parlor-tcp-settlement').forEach(node => node.remove());
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
        document.querySelectorAll('#parlor-tcp-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-tcp-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._resetTracking();
    }

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._presenterHost.refresh(state);
            // 结算弹窗挂在 document.body，不属于 presenter root；每次主题刷新都得单独把它同步上。
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
    }

    // 这里和原生牌桌各走一条渲染链，别把它塞回 _refreshNative，不然主题模式永远等不到结算层。
    _syncSettlement(state) {
        if (state.phase !== this._prevPhase) {
            if (state.phase === 'BETTING') this._settlementShown = false;
            this._prevPhase = state.phase;
        }
        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-tcp-settlement')?.remove();
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
            surface: 'table:threecardpoker',
            hostId: 'parlor-tcp-presenter',
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
            getSeats: () => buildThreeCardPokerSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildThreeCardPokerStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildThreeCardPokerHud(getState(), this._getPresenterDataHelpers()),
            getPrivate: (participantId = null) => {
                const state = getState();
                const targetId = participantId || this._getControlledParticipantIds(state)[0] || '';
                const seat = targetId ? state.playerStates?.[targetId] : null;
                return { participantId: targetId, cards: seat?.hand ? [...seat.hand] : [] };
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

    // 动作路由:复用原生的 _requestGMAction/_requestPlayerAction 封装(自带 pending key 管理)
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['deal', 'reveal', 'settle', 'newRound', 'finishGame']);
        if (gmActions.has(safeAction)) {
            return this._requestGMAction({ action: safeAction });
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
        delete payload.amount;
        return this._requestPlayerAction({ userId: participantId, action: safeAction, data: payload });
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncResultFxRound(state);

        if (state.phase !== this._prevPhase) {
            if (state.phase === 'BETTING') {
                this._dealerRenderKey = '';
                this._dealerCardsRevealed = false;
                this._hudCardsKey = '';
                this._settlementShown = false;
                LocalResultFx.clear(this._overlay);
                document.querySelector('#parlor-tcp-settlement')?.remove();
            }
            this._prevPhase = state.phase;
        }

        this._renderDealer(state);
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderHandHUD(state);
        this._maybePlayLocalResultFx(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-tcp-settlement')?.remove();
        }

        if (state.phase === 'RESOLVING' && !this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }

        this._viewportFit?.update();
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-tcp-overlay';
        overlay.dataset.tcpStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-tcp-backdrop"></div>
            <div class="parlor-tcp-layout">
                <div class="parlor-seat-column seat-column-left" id="tcp-seat-left"></div>
                <div class="parlor-tcp-scene">
                    <div class="parlor-tcp-table">
                        ${this._buildTableArt()}
                        <div class="parlor-tcp-stage">
                            <div class="parlor-tcp-game-badge"><i class="fas fa-layer-group"></i> ${this._t('PARLOR.Games.ThreeCardPoker.Name')}</div>
                            <div class="parlor-tcp-dealer-zone">
                                <div class="parlor-tcp-dealer-badge" id="tcp-dealer-badge"><i class="fas fa-crown"></i> ${this._t('PARLOR.Common.Dealer')}</div>
                                <div class="parlor-tcp-dealer-cards" id="tcp-dealer-cards"></div>
                            </div>
                            <div class="parlor-tcp-center" id="tcp-center"></div>
                        </div>
                    </div>
                </div>
                <div class="parlor-seat-column seat-column-right" id="tcp-seat-right"></div>
            </div>
            <button class="parlor-tcp-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-tcp-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-tcp-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderDealer(state) {
        const wrap = this._overlay.querySelector('#tcp-dealer-cards');
        const badge = this._overlay.querySelector('#tcp-dealer-badge');
        if (!wrap || !badge) return;

        const dealerTitle = this._getDealerTitle(state);
        const cards = state.dealerHand || [];
        const shouldReveal = ['SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase);
        const nextKey = cards.map(card => `${card.rank}-${card.suit}`).join('|');

        if (!cards.length) {
            wrap.innerHTML = '';
            badge.innerHTML = `<i class="fas fa-crown"></i> ${dealerTitle}`;
            this._dealerRenderKey = '';
            this._dealerCardsRevealed = false;
            return;
        }

        if (this._dealerRenderKey !== nextKey) {
            wrap.innerHTML = '';
            cards.forEach((card, index) => {
                const cardEl = CardRenderer.createCard(card, {
                    faceDown: !shouldReveal,
                    size: 'table'
                });
                wrap.appendChild(cardEl);
                CardRenderer.dealFrom(cardEl, { x: 0, y: -260 }, index * 180, {
                    duration: 560,
                    startScale: 0.66,
                    settleScale: 1,
                    settleRotate: (index - 1) * 2
                });
            });
            this._dealerRenderKey = nextKey;
            this._dealerCardsRevealed = shouldReveal;
        } else if (shouldReveal && !this._dealerCardsRevealed) {
            [...wrap.querySelectorAll('.parlor-playing-card')].forEach((cardEl, index) => {
                setTimeout(() => CardRenderer.flip(cardEl, false, 380), index * 110);
            });
            this._dealerCardsRevealed = true;
        }

        const qualifierHtml = shouldReveal
            ? `<span class="parlor-tcp-dealer-qualifier ${state.dealerQualified ? 'is-qualified' : 'is-soft'}">${state.dealerQualified
                ? this._t('PARLOR.ThreeCardPoker.Badge.DealerQualified')
                : this._t('PARLOR.ThreeCardPoker.Badge.DealerNotQualified')}</span>`
            : '';
        badge.innerHTML = `<i class="fas fa-crown"></i> ${dealerTitle}${qualifierHtml}`;
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#tcp-center');
        if (!center) return;

        const isGM = game.user.isGM;
        if (!isGM) {
            center.innerHTML = '';
            return;
        }

        const myId = this._getSelectedParticipantId(state, { preferDecision: state.phase === 'DECISION' });
        const myBet = this._getBetForUser(state, myId);
        const mySeat = this._getSeatState(state, myId);
        const openingTotals = this._getOpeningTotals(state);
        const decisionCounts = this._getDecisionCounts(state);
        const selectedBalance = myId ? ChipManager.getDisplayBalance(myId) : null;
        const activePlayers = this._getActivePlayerIds(state);
        const selectedResult = mySeat?.roundResult || null;

        let panel = null;
        let actionsHtml = '';

        if (state.phase === 'BETTING') {
            panel = {
                tone: myBet ? 'active' : 'betting',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Betting'),
                title: myBet
                    ? this._t('PARLOR.ThreeCardPoker.Center.BettingTitlePlaced', { amount: this._formatOpeningBet(myBet) })
                    : this._t('PARLOR.ThreeCardPoker.Center.BettingTitleIdle'),
                sub: myBet
                    ? this._t('PARLOR.ThreeCardPoker.Center.BettingSubPlaced', { amount: this._formatOpeningBet(myBet) })
                    : this._t('PARLOR.ThreeCardPoker.Center.BettingSubIdle'),
                note: this._t('PARLOR.ThreeCardPoker.Center.BettingNote'),
                stats: [
                    { label: this._t('PARLOR.Common.TableProgress'), value: `${this._countBets(state)} / ${activePlayers.length}` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.AntePot'), value: `${this._formatChip(openingTotals.ante)} GP` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.PairPlusPot'), value: `${this._formatChip(openingTotals.pairPlus)} GP` },
                    ...(selectedBalance == null ? [] : [{ label: this._t('PARLOR.Common.AvailableChips'), value: `${selectedBalance}` }])
                ]
            };
        } else if (state.phase === 'READY') {
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Ready'),
                title: isGM ? this._t('PARLOR.ThreeCardPoker.Center.ReadyTitleGM') : this._t('PARLOR.ThreeCardPoker.Center.ReadyTitlePlayer'),
                sub: this._t('PARLOR.ThreeCardPoker.Center.ReadySub'),
                note: isGM ? this._t('PARLOR.ThreeCardPoker.Center.ReadyNoteGM') : this._t('PARLOR.ThreeCardPoker.Center.ReadyNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.RoundPlayers'), value: `${activePlayers.length}` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.AntePot'), value: `${this._formatChip(openingTotals.ante)} GP` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.PairPlusPot'), value: `${this._formatChip(openingTotals.pairPlus)} GP` }
                ]
            };
            if (isGM) {
                actionsHtml = `
                    <div class="parlor-tcp-prompt-actions">
                        <button class="parlor-hud-action-btn accent" id="tcp-gm-deal" ${this._actionDisabledAttr(this._gmActionKey('deal'))}><i class="fas fa-hand-holding"></i> ${this._t('PARLOR.ThreeCardPoker.Action.DealByDM')}</button>
                    </div>
                `;
            }
        } else if (state.phase === 'DEALING') {
            panel = {
                tone: 'dealing',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Dealing'),
                title: this._t('PARLOR.ThreeCardPoker.Center.DealingTitle'),
                sub: this._t('PARLOR.ThreeCardPoker.Center.DealingSub'),
                note: this._t('PARLOR.ThreeCardPoker.Center.DealingNote'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.RoundPlayers'), value: `${activePlayers.length}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total)} GP` }
                ]
            };
        } else if (state.phase === 'DECISION') {
            const pendingMine = !!(mySeat && mySeat.decision === 'pending' && this._getControlledParticipantIds(state).includes(myId));
            panel = {
                tone: pendingMine ? 'active' : 'ready',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Decision'),
                title: pendingMine
                    ? this._t('PARLOR.ThreeCardPoker.Center.DecisionTitleSelf')
                    : this._t('PARLOR.ThreeCardPoker.Center.DecisionTitleOther'),
                sub: pendingMine
                    ? this._t('PARLOR.ThreeCardPoker.Center.DecisionSubSelf', { hand: this._getHandLabel(mySeat?.handRank) })
                    : this._t('PARLOR.ThreeCardPoker.Center.DecisionSubOther', { done: decisionCounts.done, total: decisionCounts.total }),
                note: pendingMine
                    ? this._t('PARLOR.ThreeCardPoker.Center.DecisionNoteSelf')
                    : this._t('PARLOR.ThreeCardPoker.Center.DecisionNoteOther'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.Decisions'), value: `${decisionCounts.done} / ${decisionCounts.total}` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.PlayPot'), value: `${this._formatChip(openingTotals.play)} GP` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total + openingTotals.play)} GP` }
                ]
            };
        } else if (state.phase === 'REVEAL_READY') {
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.RevealReady'),
                title: isGM ? this._t('PARLOR.ThreeCardPoker.Center.RevealReadyTitleGM') : this._t('PARLOR.ThreeCardPoker.Center.RevealReadyTitlePlayer'),
                sub: this._t('PARLOR.ThreeCardPoker.Center.RevealReadySub', { playPot: this._formatChip(openingTotals.play) }),
                note: isGM ? this._t('PARLOR.ThreeCardPoker.Center.RevealReadyNoteGM') : this._t('PARLOR.ThreeCardPoker.Center.RevealReadyNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.Decisions'), value: `${decisionCounts.done} / ${decisionCounts.total}` },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.PlayPot'), value: `${this._formatChip(openingTotals.play)} GP` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total + openingTotals.play)} GP` }
                ]
            };
            if (isGM) {
                actionsHtml = `
                    <div class="parlor-tcp-prompt-actions">
                        <button class="parlor-hud-action-btn accent" id="tcp-gm-reveal" ${this._actionDisabledAttr(this._gmActionKey('reveal'))}><i class="fas fa-eye"></i> ${this._t('PARLOR.ThreeCardPoker.Action.RevealByDM')}</button>
                    </div>
                `;
            }
        } else if (state.phase === 'SHOWDOWN') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Showdown'),
                title: state.dealerQualified
                    ? this._t('PARLOR.ThreeCardPoker.Center.ShowdownTitleQualified', { hand: this._getHandLabel(state.dealerRank) })
                    : this._t('PARLOR.ThreeCardPoker.Center.ShowdownTitleNotQualified', { hand: this._getHandLabel(state.dealerRank) }),
                sub: selectedResult
                    ? this._t('PARLOR.ThreeCardPoker.Center.ShowdownSubSelected', { result: this._formatResultText(selectedResult) })
                    : this._t('PARLOR.ThreeCardPoker.Center.ShowdownSubTable'),
                note: this._t('PARLOR.ThreeCardPoker.Center.ShowdownNote'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.DealerHand'), value: this._getHandLabel(state.dealerRank) },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.PlayPot'), value: `${this._formatChip(openingTotals.play)} GP` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total + openingTotals.play)} GP` }
                ]
            };
        } else if (state.phase === 'SETTLE') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Settle'),
                title: this._t('PARLOR.ThreeCardPoker.Center.SettleTitle'),
                sub: selectedResult
                    ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatNet(selectedResult.net) })
                    : this._t('PARLOR.Common.ResultOnSeat'),
                note: isGM ? this._t('PARLOR.ThreeCardPoker.Center.SettleNoteGM') : this._t('PARLOR.ThreeCardPoker.Center.SettleNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.DealerHand'), value: this._getHandLabel(state.dealerRank) },
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.Decisions'), value: `${decisionCounts.done} / ${decisionCounts.total}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total + openingTotals.play)} GP` }
                ]
            };
            if (isGM) {
                actionsHtml = `
                    <div class="parlor-tcp-prompt-actions">
                        <button class="parlor-hud-action-btn accent" id="tcp-gm-settle" ${this._actionDisabledAttr(this._gmActionKey('settle'))}><i class="fas fa-receipt"></i> ${this._t('PARLOR.ThreeCardPoker.Action.OpenSettle')}</button>
                    </div>
                `;
            }
        } else if (state.phase === 'RESOLVING') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.ThreeCardPoker.Center.Phase.Resolving'),
                title: this._t('PARLOR.ThreeCardPoker.Center.ResolvingTitle'),
                sub: selectedResult
                    ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatNet(selectedResult.net) })
                    : this._t('PARLOR.Common.ViewSettlementPanel'),
                note: isGM ? this._t('PARLOR.ThreeCardPoker.Center.ResolvingNoteGM') : this._t('PARLOR.ThreeCardPoker.Center.ResolvingNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.ThreeCardPoker.Stat.DealerHand'), value: this._getHandLabel(state.dealerRank) },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(openingTotals.total + openingTotals.play)} GP` }
                ]
            };
        }

        center.innerHTML = panel ? this._buildCenterPanel(state, panel, actionsHtml) : '';

        center.querySelector('#tcp-gm-deal')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'deal', button: event.currentTarget });
        });
        center.querySelector('#tcp-gm-reveal')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'reveal', button: event.currentTarget });
        });
        center.querySelector('#tcp-gm-settle')?.addEventListener('click', (event) => {
            this._requestGMAction({ action: 'settle', button: event.currentTarget });
        });
    }

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#tcp-seat-left');
        const rightColumn = this._overlay.querySelector('#tcp-seat-right');
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
            const roundResult = seatState?.roundResult || null;
            const isMe = uid === myId;
            const seatNum = Math.max(1, visibleSeatIds.indexOf(uid) + 1);
            const { text: statusText, className: statusClass } = this._getSeatStatus(state, uid);

            const seat = document.createElement('div');
            seat.className = `parlor-seat-card parlor-tcp-seat seat-${zone}${isMe ? ' is-me' : ''}${bet ? ' has-bet' : ''}${roundResult ? ' has-result' : ''}`;
            seat.dataset.userId = uid;
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
                    <div class="parlor-tcp-seat-tags">${this._buildSeatTags(state, uid, bet, seatState)}</div>
                    <div class="parlor-seat-status ${statusClass}">${statusText}</div>
                    <div class="parlor-tcp-seat-note">${this._getSeatNote(state, uid)}</div>
                </div>
            `;

            target.appendChild(seat);
        }
    }

    _renderHandHUD(state) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) {
            this._handHUD.destroy();
            this._hudCardsKey = '';
            return;
        }

        const participantId = this._getSelectedParticipantId(state, { preferDecision: true });
        const bet = this._getBetForUser(state, participantId);
        const seatState = this._getSeatState(state, participantId);
        const cards = this._getHudCards(seatState);
        const cardsKey = `${participantId}:${cards.map(card => this._getHudCardKey(card)).join('|')}`;

        if (!this._handHUD.root) {
            this._handHUD.show(cards);
            this._hudCardsKey = cardsKey;
        } else if (this._hudCardsKey !== cardsKey) {
            this._handHUD.updateCards(cards);
            this._hudCardsKey = cardsKey;
        }

        const title = this._getHudTitle(state, participantId);
        const sub = this._getHudSub(state, participantId);
        this._handHUD.hideActions();
        this._handHUD.showFooter(this._buildHudFooter(state, { participantId, bet, seatState, title, sub }));
        this._bindHudFooter(state, { participantId });

        if (state.phase === 'DECISION' && seatState?.decision === 'pending') {
            const selectedName = this._playerName(state, participantId);
            this._handHUD.showActions([
                {
                    label: this._t('PARLOR.ThreeCardPoker.Action.Play'),
                    icon: 'fas fa-check',
                    accent: true,
                    callback: () => this._submitDecision('play', participantId)
                },
                {
                    label: this._t('PARLOR.ThreeCardPoker.Action.Fold'),
                    icon: 'fas fa-times',
                    callback: () => this._submitDecision('fold', participantId)
                }
            ]);
            this._handHUD.showFooter(this._buildHudFooter(state, {
                participantId,
                bet,
                seatState,
                title: this._t('PARLOR.ThreeCardPoker.Hud.DecisionTitle', { name: selectedName }),
                sub
            }));
            this._bindHudFooter(state, { participantId });
        }
    }

    _getHudCards(seatState) {
        return (seatState?.hand || []).map(card => ({
            card,
            startFaceDown: true,
            idleFaceDown: true,
            hoverReveal: true,
            handHover: true
        }));
    }

    _getHudCardKey(entry) {
        const card = entry?.card || null;
        if (!card) return 'back';
        return `${card.rank}-${card.suit}:${entry.idleFaceDown ? 'down' : 'up'}`;
    }

    _getHudTitle(state, participantId) {
        const seatState = this._getSeatState(state, participantId);
        if (state.phase === 'BETTING') return this._t('PARLOR.ThreeCardPoker.Hud.BettingTitle');
        if (state.phase === 'READY') return this._t('PARLOR.ThreeCardPoker.Hud.ReadyTitle');
        if (state.phase === 'DEALING') return this._t('PARLOR.ThreeCardPoker.Hud.DealingTitle');
        if (state.phase === 'DECISION') {
            return seatState?.decision === 'pending'
                ? this._t('PARLOR.ThreeCardPoker.Hud.DecisionPending')
                : this._t('PARLOR.ThreeCardPoker.Hud.DecisionLocked');
        }
        if (state.phase === 'REVEAL_READY') return this._t('PARLOR.ThreeCardPoker.Hud.RevealReadyTitle');
        if (state.phase === 'SHOWDOWN') return this._t('PARLOR.ThreeCardPoker.Hud.ShowdownTitle');
        if (state.phase === 'SETTLE') return this._t('PARLOR.ThreeCardPoker.Hud.SettleTitle');
        if (state.phase === 'RESOLVING') return this._t('PARLOR.ThreeCardPoker.Hud.ResultTitle');
        return this._t('PARLOR.Games.ThreeCardPoker.Name');
    }

    _getHudSub(state, participantId) {
        const bet = this._getBetForUser(state, participantId);
        const seatState = this._getSeatState(state, participantId);
        const roundResult = seatState?.roundResult || null;

        if (state.phase === 'BETTING') {
            return bet
                ? this._t('PARLOR.ThreeCardPoker.Hud.BettingSubPlaced', { amount: this._formatOpeningBet(bet) })
                : this._t('PARLOR.ThreeCardPoker.Hud.BettingSubIdle');
        }

        if (state.phase === 'DECISION') {
            if (seatState?.decision === 'pending') {
                return this._t('PARLOR.ThreeCardPoker.Hud.DecisionSubPending', { hand: this._getHandLabel(seatState?.handRank) });
            }
            return this._t('PARLOR.ThreeCardPoker.Hud.DecisionSubLocked', { decision: this._getDecisionLabel(seatState?.decision) });
        }

        if (roundResult) {
            return this._t('PARLOR.ThreeCardPoker.Hud.ResultSub', { result: this._formatResultText(roundResult) });
        }

        if (bet) return this._t('PARLOR.ThreeCardPoker.Hud.OpeningBetSub', { amount: this._formatOpeningBet(bet) });
        return this._t('PARLOR.ThreeCardPoker.Hud.WaitingSub');
    }

    _buildHudFooter(state, { participantId, bet, seatState, title, sub }) {
        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => this._getActivePlayerIds(state).includes(entry.id));
        const selectedLabel = participantId ? this._playerName(state, participantId) : this._t('PARLOR.Common.CurrentRole');
        const balanceLabel = participantId ? ChipManager.getDisplayBalance(participantId) : null;
        const roundResult = seatState?.roundResult || null;
        const handLabel = seatState?.handRank ? this._getHandLabel(seatState.handRank) : '';
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="tcp-hud-participant-select" class="parlor-tcp-hud-select">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === participantId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : `<span class="parlor-tcp-hud-name">${selectedLabel}</span>`;

        let rightHtml = '';
        if (state.phase === 'BETTING') {
            rightHtml = `
                <div class="parlor-tcp-hud-betbox">
                    <label class="parlor-tcp-hud-field">
                        <span>${this._t('PARLOR.ThreeCardPoker.Hud.AnteLabel')}</span>
                        <input type="number" id="tcp-hud-ante-input" class="parlor-hud-footer-input" min="1" value="${Math.max(1, Number(bet?.anteAmount || this._betDraftAnteAmount || 10))}">
                    </label>
                    <label class="parlor-tcp-hud-field">
                        <span>${this._t('PARLOR.ThreeCardPoker.Hud.PairPlusLabel')}</span>
                        <input type="number" id="tcp-hud-pairplus-input" class="parlor-hud-footer-input" min="0" value="${Math.max(0, Number(bet?.pairPlusAmount || this._betDraftPairPlusAmount || 0))}">
                    </label>
                    <button class="parlor-hud-action-btn accent" id="tcp-hud-place-bet"><i class="fas fa-coins"></i> ${this._t('PARLOR.Common.Bet')}</button>
                </div>
            `;
        } else {
            rightHtml = `
                <div class="parlor-tcp-hud-tags">
                    ${bet ? `<span class="parlor-hud-footer-pill">${this._formatOpeningBet(bet)}</span>` : `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.NoBet')}</span>`}
                    ${seatState?.playAmount ? `<span class="parlor-hud-footer-pill">${this._t('PARLOR.ThreeCardPoker.Hud.PlayBetTag', { amount: this._formatChip(seatState.playAmount) })}</span>` : ''}
                    ${handLabel ? `<span class="parlor-hud-footer-pill">${handLabel}</span>` : ''}
                    ${roundResult ? `<span class="parlor-hud-footer-pill ${roundResult.net >= 0 ? '' : 'muted'}">${this._formatNet(roundResult.net)}</span>` : ''}
                </div>
            `;
        }

        return `
            <div class="parlor-hand-hud-footer-main parlor-tcp-hud-shell">
                <div class="parlor-hud-footer-side parlor-tcp-hud-side">
                    <div class="parlor-tcp-hud-context">
                        <span class="parlor-hud-footer-label">${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml}
                        ${balanceLabel == null ? '' : `<span class="parlor-hud-footer-pill">${typeof balanceLabel === 'number' ? `${balanceLabel} ${this._t('PARLOR.Common.Chips')}` : this._t('PARLOR.Common.ChipsInfinity')}</span>`}
                    </div>
                </div>
                <div class="parlor-hud-footer-center parlor-tcp-hud-center">
                    <div class="parlor-hud-footer-title">${title}</div>
                    <div class="parlor-hud-footer-sub">${sub}</div>
                </div>
                <div class="parlor-hud-footer-side align-right parlor-tcp-hud-side right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _bindHudFooter(state, { participantId }) {
        const root = this._handHUD.root;
        if (!root) return;

        root.querySelector('#tcp-hud-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const nextBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAnteAmount = Math.max(1, Number(nextBet?.anteAmount || this._betDraftAnteAmount || 10));
            this._betDraftPairPlusAmount = Math.max(0, Number(nextBet?.pairPlusAmount || this._betDraftPairPlusAmount || 0));
            this._hudCardsKey = '';
            this.refresh();
        });

        root.querySelector('#tcp-hud-ante-input')?.addEventListener('change', (event) => {
            this._betDraftAnteAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAnteAmount);
        });

        root.querySelector('#tcp-hud-pairplus-input')?.addEventListener('change', (event) => {
            this._betDraftPairPlusAmount = Math.max(0, parseInt(event.currentTarget.value, 10) || 0);
            event.currentTarget.value = String(this._betDraftPairPlusAmount);
        });

        root.querySelector('#tcp-hud-place-bet')?.addEventListener('click', (event) => {
            this._submitOpeningBet({
                participantId,
                button: event.currentTarget
            });
        });
    }

    async _submitOpeningBet({ participantId, button = null }) {
        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const safeParticipantId = controlledIds.includes(participantId)
            ? participantId
            : this._getSelectedParticipantId(state);

        const anteInput = this._handHUD.root?.querySelector('#tcp-hud-ante-input');
        const pairPlusInput = this._handHUD.root?.querySelector('#tcp-hud-pairplus-input');
        const anteAmount = Math.max(0, parseInt(anteInput?.value, 10) || 0);
        const pairPlusAmount = Math.max(0, parseInt(pairPlusInput?.value, 10) || 0);

        if (!safeParticipantId) {
            ui.notifications.warn(this._t('PARLOR.Common.BetMissingParticipant'));
            return;
        }
        if (anteAmount <= 0) {
            ui.notifications.warn(this._t('PARLOR.Common.BetAmountTooLow'));
            anteInput?.focus();
            return;
        }

        this._selectedParticipantId = safeParticipantId;
        this._betDraftAnteAmount = anteAmount;
        this._betDraftPairPlusAmount = pairPlusAmount;

        const result = await this._requestPlayerAction({
            userId: safeParticipantId,
            action: 'placeBet',
            data: { anteAmount, pairPlusAmount },
            button
        });

        if (result?.ok === false) {
            this._showBetFailure(result, safeParticipantId, anteAmount + pairPlusAmount);
            return;
        }

        this._advanceControlledSelectionAfterBet(state, safeParticipantId);
        this.refresh();
    }

    async _submitDecision(decision, participantId) {
        const state = this.gameInstance.getState();
        const safeParticipantId = this._getControlledParticipantIds(state).includes(participantId)
            ? participantId
            : this._getSelectedParticipantId(state, { preferDecision: true });
        if (!safeParticipantId) return;

        const result = await this._requestPlayerAction({
            userId: safeParticipantId,
            action: 'makeDecision',
            data: { decision }
        });

        if (result?.ok === false) {
            this._showDecisionFailure(result, safeParticipantId);
            return;
        }

        this._advanceControlledSelectionAfterDecision(state, safeParticipantId);
        this.refresh();
    }

    _showBetFailure(result, participantId, amount) {
        switch (result.reason) {
            case 'chips': {
                const balance = ChipManager.getDisplayBalance(participantId);
                ui.notifications.warn(this._t('PARLOR.Common.ChipsInsufficient', { balance, amount }));
                break;
            }
            case 'phase':
                ui.notifications.warn(this._t('PARLOR.Common.BetNotInPhase'));
                break;
            case 'not-player':
                ui.notifications.warn(this._t('PARLOR.Common.BetNotParticipant'));
                break;
            case 'invalid-ante':
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.InvalidAnte'));
                break;
            case 'invalid-pairplus':
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.InvalidPairPlus'));
                break;
            case 'bet-too-low':
                ui.notifications.warn(this._t('PARLOR.Common.BetBelowLimit', { min: result.min ?? 1 }));
                break;
            case 'bet-too-high':
                ui.notifications.warn(this._t('PARLOR.Common.BetAboveLimit', { max: result.max ?? 0 }));
                break;
            default:
                ui.notifications.warn(this._t('PARLOR.Common.BetFailedRetry'));
                break;
        }
    }

    _showDecisionFailure(result, participantId) {
        switch (result.reason) {
            case 'chips': {
                const balance = ChipManager.getDisplayBalance(participantId);
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.PlayChipsInsufficient', { balance }));
                break;
            }
            case 'phase':
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.DecisionClosed'));
                break;
            case 'locked':
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.DecisionLocked'));
                break;
            case 'invalid-decision':
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.InvalidDecision'));
                break;
            default:
                ui.notifications.warn(this._t('PARLOR.ThreeCardPoker.Error.DecisionFailed'));
                break;
        }
    }

    _advanceControlledSelectionAfterBet(state, participantId) {
        const nextId = this._getNextUnbetControlledParticipantId(state, participantId);
        if (!nextId) return;
        this._selectedParticipantId = nextId;
        const nextBet = this._getBetForUser(state, nextId);
        this._betDraftAnteAmount = Math.max(1, Number(nextBet?.anteAmount || this._betDraftAnteAmount || 10));
        this._betDraftPairPlusAmount = Math.max(0, Number(nextBet?.pairPlusAmount || this._betDraftPairPlusAmount || 0));
        this._hudCardsKey = '';
    }

    _advanceControlledSelectionAfterDecision(state, participantId) {
        const nextId = this._getNextPendingDecisionParticipantId(state, participantId);
        if (!nextId) return;
        this._selectedParticipantId = nextId;
        this._hudCardsKey = '';
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

    _getNextPendingDecisionParticipantId(state, currentId) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) return '';

        const currentIndex = Math.max(0, controlledIds.indexOf(currentId));
        for (let step = 1; step < controlledIds.length; step++) {
            const candidate = controlledIds[(currentIndex + step) % controlledIds.length];
            if (this._getSeatState(state, candidate)?.decision === 'pending') return candidate;
        }

        return '';
    }

    _showSettlementPopup(state) {
        document.querySelector('#parlor-tcp-settlement')?.remove();
        const popup = document.createElement('div');
        popup.id = 'parlor-tcp-settlement';
        popup.dataset.tcpStyle = 'v14';
        // 这层在 host 外面，登记后才能同时拿到主题标记，并在整桌销毁时一起回收。
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        const rows = this._getActivePlayerIds(state).map(uid => {
            const bet = this._getBetForUser(state, uid);
            const seatState = this._getSeatState(state, uid);
            const roundResult = seatState?.roundResult || null;
            const payout = Number(state.payouts?.[uid] || 0);

            return `
                <tr>
                    <td>${this._playerName(state, uid)}</td>
                    <td>${this._formatOpeningBet(bet)}</td>
                    <td><div class="parlor-tcp-settlement-reveal" data-user-id="${uid}"></div></td>
                    <td>${this._getDecisionLabel(seatState?.decision)}</td>
                    <td>${this._formatResultText(roundResult)}</td>
                    <td>${this._formatChip(payout)} GP</td>
                    <td>${roundResult ? this._formatNet(roundResult.net) : '0 GP'}</td>
                </tr>
            `;
        }).join('');

        popup.innerHTML = `
            <div class="parlor-tcp-settlement-box">
                <div class="settlement-title">${this._t('PARLOR.ThreeCardPoker.Settlement.Title')}</div>
                <div class="settlement-sub">${state.dealerQualified
                    ? this._t('PARLOR.ThreeCardPoker.Center.ShowdownTitleQualified', { hand: this._getHandLabel(state.dealerRank) })
                    : this._t('PARLOR.ThreeCardPoker.Center.ShowdownTitleNotQualified', { hand: this._getHandLabel(state.dealerRank) })}</div>
                <table class="settlement-table">
                    <thead>
                        <tr>
                            <th>${this._t('PARLOR.Common.Player')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Bet')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Reveal')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Decision')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Result')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Payout')}</th>
                            <th>${this._t('PARLOR.ThreeCardPoker.Settlement.Net')}</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-tcp-prompt-actions" style="margin-top:16px;">
                    ${game.user.isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="tcp-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="tcp-next-round"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="tcp-dismiss-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        this._getActivePlayerIds(state).forEach(uid => {
            this._renderSettlementRevealHand(state, uid, popup.querySelector(`.parlor-tcp-settlement-reveal[data-user-id="${uid}"]`));
        });
        popup.querySelector('#tcp-dismiss-settlement')?.addEventListener('click', () => popup.remove());
        popup.querySelector('#tcp-finish-game')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#tcp-next-round')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'finishGame' });
        });
        popup.querySelector('#tcp-next-round')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#tcp-finish-game')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'newRound' });
        });
    }

    _renderSettlementRevealHand(state, uid, wrap) {
        if (!wrap) return;
        wrap.innerHTML = '';

        const cards = this._getSeatState(state, uid)?.hand || [];
        if (!cards.length) {
            wrap.textContent = '—';
            return;
        }

        for (const card of cards) {
            const cardEl = CardRenderer.createCard(card, {
                faceDown: false,
                size: 'small'
            });
            cardEl.style.pointerEvents = 'none';
            wrap.appendChild(cardEl);
        }
    }

    _buildCenterPanel(state, { phaseLabel, title, sub = '', note = '', stats = [], tone = '' }, actionsHtml = '') {
        const statsHtml = stats
            .filter(entry => entry?.label && entry?.value != null && entry.value !== '')
            .map(entry => `
                <div class="parlor-tcp-prompt-stat">
                    <div class="parlor-tcp-prompt-stat-label">${entry.label}</div>
                    <div class="parlor-tcp-prompt-stat-value">${entry.value}</div>
                </div>
            `)
            .join('');

        return `
            <div class="parlor-tcp-prompt ${tone ? `tone-${tone}` : ''}">
                <div class="parlor-tcp-prompt-head">
                    <div class="parlor-tcp-prompt-phase">${phaseLabel}</div>
                    <div class="parlor-tcp-prompt-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round })}</div>
                </div>
                <div class="parlor-tcp-prompt-title">${title}</div>
                ${sub ? `<div class="parlor-tcp-prompt-sub">${sub}</div>` : ''}
                ${statsHtml ? `<div class="parlor-tcp-prompt-stats">${statsHtml}</div>` : ''}
                ${note ? `<div class="parlor-tcp-prompt-note">${note}</div>` : ''}
                ${actionsHtml}
            </div>
        `;
    }

    _buildSeatTags(state, uid, bet, seatState) {
        if (!bet) {
            return `<span class="parlor-tcp-seat-pill is-empty">${this._t('PARLOR.Common.WaitingBet')}</span>`;
        }

        const tags = [
            `<span class="parlor-tcp-seat-pill">${this._t('PARLOR.ThreeCardPoker.Tag.Ante', { amount: this._formatChip(bet.anteAmount) })}</span>`
        ];

        if (Number(bet.pairPlusAmount || 0) > 0) {
            tags.push(`<span class="parlor-tcp-seat-pill">${this._t('PARLOR.ThreeCardPoker.Tag.PairPlus', { amount: this._formatChip(bet.pairPlusAmount) })}</span>`);
        }

        if (Number(seatState?.playAmount || bet.playAmount || 0) > 0) {
            tags.push(`<span class="parlor-tcp-seat-pill is-accent">${this._t('PARLOR.ThreeCardPoker.Tag.Play', { amount: this._formatChip(seatState?.playAmount || bet.playAmount) })}</span>`);
        }

        return tags.join('');
    }

    _getSeatStatus(state, uid) {
        const bet = this._getBetForUser(state, uid);
        const seatState = this._getSeatState(state, uid);
        const roundResult = seatState?.roundResult || null;

        if (!bet) return { text: this._t('PARLOR.Common.WaitingBet'), className: 'status-idle' };
        if (state.phase === 'BETTING') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusPlaced'), className: 'status-live' };
        if (state.phase === 'READY') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusReady'), className: 'status-live' };
        if (state.phase === 'DEALING') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusDealing'), className: 'status-live' };
        if (state.phase === 'DECISION') {
            if (seatState?.decision === 'play') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusPlayLocked'), className: 'status-live' };
            if (seatState?.decision === 'fold') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusFolded'), className: 'status-push' };
            return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusDecision'), className: 'status-playing' };
        }
        if (state.phase === 'REVEAL_READY') {
            if (seatState?.decision === 'fold') return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusFolded'), className: 'status-push' };
            return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusRevealReady'), className: 'status-live' };
        }

        switch (roundResult?.mainResult) {
            case 'fold':
                return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusFolded'), className: 'status-push' };
            case 'dealer-no-qualify':
                return { text: this._t('PARLOR.ThreeCardPoker.Seat.StatusDealerNotQualified'), className: 'status-win' };
            case 'win':
                return { text: this._t('PARLOR.Common.Win'), className: 'status-win' };
            case 'lose':
                return { text: this._t('PARLOR.Common.Lose'), className: 'status-lose' };
            case 'push':
                return { text: this._t('PARLOR.Common.Push'), className: 'status-push' };
            default:
                return { text: this._t('PARLOR.Common.WaitingSettlement'), className: 'status-live' };
        }
    }

    _getSeatNote(state, uid) {
        const bet = this._getBetForUser(state, uid);
        const seatState = this._getSeatState(state, uid);
        const roundResult = seatState?.roundResult || null;

        if (!bet) return this._t('PARLOR.ThreeCardPoker.Seat.NoteIdle');
        if (state.phase === 'BETTING') return this._t('PARLOR.ThreeCardPoker.Seat.NoteBetting', { amount: this._formatOpeningBet(bet) });
        if (state.phase === 'READY') return this._t('PARLOR.ThreeCardPoker.Seat.NoteReady', { amount: this._formatOpeningBet(bet) });
        if (state.phase === 'DEALING') return this._t('PARLOR.ThreeCardPoker.Seat.NoteDealing');
        if (state.phase === 'DECISION') {
            if (seatState?.decision === 'play') {
                return this._t('PARLOR.ThreeCardPoker.Seat.NotePlayLocked', { amount: this._formatChip(seatState.playAmount) });
            }
            if (seatState?.decision === 'fold') {
                return this._t('PARLOR.ThreeCardPoker.Seat.NoteFolded');
            }
            return this._t('PARLOR.ThreeCardPoker.Seat.NoteDecision');
        }
        if (state.phase === 'REVEAL_READY') {
            return seatState?.decision === 'fold'
                ? this._t('PARLOR.ThreeCardPoker.Seat.NoteFolded')
                : this._t('PARLOR.ThreeCardPoker.Seat.NoteRevealReady');
        }
        if (!roundResult) return this._t('PARLOR.Common.WaitingSettlement');

        const parts = [];
        if (roundResult.mainResult === 'dealer-no-qualify') {
            parts.push(this._t('PARLOR.ThreeCardPoker.Result.DealerNotQualified'));
        } else {
            parts.push(this._formatResultText(roundResult));
        }
        if (roundResult.pairPlusReturn > 0) {
            parts.push(this._t('PARLOR.ThreeCardPoker.Result.PairPlusWin'));
        }
        if (roundResult.anteBonusReturn > 0) {
            parts.push(this._t('PARLOR.ThreeCardPoker.Result.AnteBonusWin'));
        }

        return parts.join(' · ');
    }

    _getDecisionCounts(state) {
        const activePlayers = this._getActivePlayerIds(state);
        let done = 0;
        for (const uid of activePlayers) {
            const decision = this._getSeatState(state, uid)?.decision;
            if (decision && decision !== 'pending') done++;
        }
        return { done, total: activePlayers.length };
    }

    _getOpeningTotals(state) {
        const totals = { ante: 0, pairPlus: 0, play: 0, total: 0 };
        for (const bet of (state.bets || [])) {
            totals.ante += Number(bet.anteAmount || 0);
            totals.pairPlus += Number(bet.pairPlusAmount || 0);
            totals.play += Number(bet.playAmount || state.playerStates?.[bet.userId]?.playAmount || 0);
        }
        totals.total = totals.ante + totals.pairPlus;
        return totals;
    }

    _countBets(state) {
        return (state.bets || []).length;
    }

    _getBetForUser(state, userId) {
        return (state.bets || []).find(bet => bet.userId === userId) || null;
    }

    _getSeatState(state, uid) {
        return state.playerStates?.[uid] || null;
    }

    _getActivePlayerIds(state) {
        return (state.playerIds || []).filter(Boolean);
    }

    _formatOpeningBet(bet) {
        if (!bet) return '—';
        const parts = [
            this._t('PARLOR.ThreeCardPoker.Tag.Ante', { amount: this._formatChip(bet.anteAmount) })
        ];
        if (Number(bet.pairPlusAmount || 0) > 0) {
            parts.push(this._t('PARLOR.ThreeCardPoker.Tag.PairPlus', { amount: this._formatChip(bet.pairPlusAmount) }));
        }
        return parts.join(' · ');
    }

    _formatChip(amount) {
        const value = Math.round(Number(amount || 0) * 100) / 100;
        if (Number.isInteger(value)) return `${value}`;
        return value.toFixed(2).replace(/\.?0+$/, '');
    }

    _formatNet(amount) {
        const value = Math.round(Number(amount || 0) * 100) / 100;
        if (value > 0) return `+${this._formatChip(value)} GP`;
        if (value < 0) return `${this._formatChip(value)} GP`;
        return '0 GP';
    }

    _formatResultText(roundResult) {
        if (!roundResult) return this._t('PARLOR.Common.NoBet');
        switch (roundResult.mainResult) {
            case 'fold':
                return this._t('PARLOR.ThreeCardPoker.Result.Fold');
            case 'dealer-no-qualify':
                return this._t('PARLOR.ThreeCardPoker.Result.DealerNotQualified');
            case 'win':
                return this._t('PARLOR.ThreeCardPoker.Result.Win');
            case 'lose':
                return this._t('PARLOR.ThreeCardPoker.Result.Lose');
            case 'push':
                return this._t('PARLOR.ThreeCardPoker.Result.Push');
            default:
                return this._t('PARLOR.Common.Waiting');
        }
    }

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

    _collectLocalResultFxHits(state) {
        if (state.phase !== 'RESOLVING') return [];

        const round = this._resultFxRound ?? 0;
        const controlledIds = this._getControlledParticipantIds(state);
        return controlledIds.flatMap(uid => {
            const seatState = this._getSeatState(state, uid);
            const roundResult = seatState?.roundResult || null;
            if (!roundResult) return [];

            const key = `resolve:${round}:${uid}`;
            if (this._playedLocalResultFxKeys.has(key)) return [];

            const net = Number(roundResult.net || 0);
            const tone = net > 0 ? 'win' : (net < 0 ? 'lose' : 'push');
            return [{
                key,
                tone,
                icon: tone === 'win' ? '✦' : (tone === 'lose' ? '✕' : '○'),
                title: this._t(
                    tone === 'win'
                        ? 'PARLOR.ResultFx.WinTitle'
                        : (tone === 'lose' ? 'PARLOR.ResultFx.LoseTitle' : 'PARLOR.ResultFx.PushTitle')
                ),
                sub: `${this._playerName(state, uid)} · ${this._formatNet(net)}`,
                duration: 1440
            }];
        });
    }

    _getDecisionLabel(decision) {
        if (decision === 'play') return this._t('PARLOR.ThreeCardPoker.Action.Play');
        if (decision === 'fold') return this._t('PARLOR.ThreeCardPoker.Action.Fold');
        return this._t('PARLOR.Common.Waiting');
    }

    _getHandLabel(handRank) {
        if (!handRank?.category) return this._t('PARLOR.ThreeCardPoker.Hand.Unknown');
        const key = handRank.isMiniRoyal
            ? 'PARLOR.ThreeCardPoker.Hand.MiniRoyal'
            : `PARLOR.ThreeCardPoker.Hand.${this._camelizeHandKey(handRank.category)}`;
        return this._t(key);
    }

    _camelizeHandKey(category) {
        switch (category) {
            case 'high-card': return 'HighCard';
            case 'three-kind': return 'ThreeKind';
            case 'straight-flush': return 'StraightFlush';
            default: return category.charAt(0).toUpperCase() + category.slice(1);
        }
    }

    _buildTableArt() {
        return BlackjackTable.prototype._buildTableArt.call(this)
            .replace(/parlor-bj-table-svg/g, 'parlor-tcp-table-svg')
            .replace(/bj-/g, 'tcp-')
            .replace(/<text x="1100" y="570"[^>]*>[^<]*<\/text>/, '')
            .replace(/<text x="1100" y="626"[^>]*>[^<]*<\/text>/, '');
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

    _describeParticipant(state, uid) {
        const info = getDisplayParticipant(state, uid);
        if (BotManager.isBot(uid)) info.name = BotManager.getBotName(uid);
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

    _getSelectedParticipantId(state, { preferDecision = false } = {}) {
        const controlledIds = this._getControlledParticipantIds(state);
        if (!controlledIds.length) {
            this._selectedParticipantId = '';
            return '';
        }

        if (preferDecision) {
            if (controlledIds.includes(this._selectedParticipantId) && this._getSeatState(state, this._selectedParticipantId)?.decision === 'pending') {
                return this._selectedParticipantId;
            }
            const pendingId = controlledIds.find(id => this._getSeatState(state, id)?.decision === 'pending');
            if (pendingId) {
                this._selectedParticipantId = pendingId;
                return pendingId;
            }
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
        this._dealerRenderKey = '';
        this._dealerCardsRevealed = false;
        this._hudCardsKey = '';
        this._actionRequests.clear();
        this._resultFxRound = null;
        this._playedLocalResultFxKeys.clear();
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
                console.error('parlor | Three Card Poker socket action failed:', error);
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) {
                    await new Promise(resolve => setTimeout(resolve, rest));
                }
                this._actionRequests.delete(actionKey);
                if (button?.isConnected) button.disabled = false;
                // 动作响应和状态广播是两条异步链，主持端不能赌自己的广播一定先绕回来。
                // presenter 没有原生 overlay，漏掉它就会出现“状态已结算、弹窗却没挂载”的假卡死。
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

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
