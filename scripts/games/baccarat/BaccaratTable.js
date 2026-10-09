/**
 * BaccaratTable — 百家乐共享桌面
 *
 * 这层后续维护统一按 Foundry V14 兼容优先来收。
 * 先把庄 / 闲 / 和做稳，桌面和交互别跟龙虎斗那套轮廓打架。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { CardRenderer } from '../../ui/CardRenderer.js';
import { CardHandHUD } from '../../ui/CardHandHUD.js';
import { LocalResultFx } from '../../ui/LocalResultFx.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import { BotManager } from '../../core/BotManager.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import {
    getControlledParticipants,
    getCurrentControlledParticipant,
    getDisplayParticipant,
    getParticipantLabel,
    getParticipantName,
    getSelfParticipant
} from '../../core/ParticipantRoster.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import {
    buildBaccaratHud,
    buildBaccaratSeatEntries,
    buildBaccaratStatus
} from './BaccaratPresenterData.js';

const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;
const SIDE_INFO = {
    player: { labelKey: 'PARLOR.Baccarat.Side.Player', odds: '1 : 1' },
    banker: { labelKey: 'PARLOR.Baccarat.Side.Banker', odds: '0.95 : 1' },
    tie: { labelKey: 'PARLOR.Baccarat.Side.Tie', odds: '8 : 1' }
};

export class BaccaratTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._dismissedByUser = false;
        this._prevPhase = '';
        this._renderedPlayerCards = 0;
        this._renderedBankerCards = 0;
        this._revealedPlayerCards = 0;
        this._revealedBankerCards = 0;
        this._settlementShown = false;
        this._selectedParticipantId = '';
        this._betDraftAmount = 10;
        this._pendingBetParticipants = new Set();
        this._viewportFit = null;
        this._resultFxRound = null;
        this._playedLocalResultFxKeys = new Set();
        this._onKeyDown = (event) => {
            // V14 兼容优先：Esc 在 Foundry 里经常是全局操作，这里别擅自关桌。
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:baccarat');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:baccarat')) {
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
        document.querySelectorAll('#parlor-bac-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bac-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-bac-layout',
            measureSelectors: ['.parlor-bac-scene', '#bac-seat-left', '#bac-seat-right']
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
            document.querySelectorAll('#parlor-bac-settlement').forEach(node => node.remove());
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
        document.querySelectorAll('#parlor-bac-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bac-overlay').forEach(node => node.remove());
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
            document.querySelector('#parlor-bac-settlement')?.remove();
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
            surface: 'table:baccarat',
            hostId: 'parlor-bac-presenter',
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
            getSeats: () => buildBaccaratSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildBaccaratStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildBaccaratHud(getState(), this._getPresenterDataHelpers()),
            // 百家乐玩家不持私牌
            getPrivate: () => ({ participantId: '', cards: [] }),
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

    // 动作路由:GM 推进走 GM_ACTION,玩家下注走 PLAYER_ACTION(payload 形状照原生 _bindHudFooter)
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['deal', 'draw', 'settle', 'newRound', 'finishGame']);
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
                this._renderedPlayerCards = 0;
                this._renderedBankerCards = 0;
                this._revealedPlayerCards = 0;
                this._revealedBankerCards = 0;
                this._settlementShown = false;
                LocalResultFx.clear(this._overlay);
                document.querySelector('#parlor-bac-settlement')?.remove();
            }
            this._prevPhase = state.phase;
        }

        this._safeRefreshSection('battle', () => this._renderBattle(state));
        this._safeRefreshSection('center', () => this._renderCenter(state), () => this._renderCenterFallback(state));
        this._safeRefreshSection('seats', () => this._renderSeats(state));
        this._safeRefreshSection('handHUD', () => this._renderHandHUD(state), () => this._renderHandHUDFallback(state));
        this._maybePlayLocalResultFx(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-bac-settlement')?.remove();
        }

        if (state.phase === 'RESOLVING' && !this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }

        this._viewportFit?.update();
    }

    _safeRefreshSection(section, render, fallback = null) {
        try {
            render?.();
        } catch (error) {
            console.error(`parlor | Baccarat table render failed in ${section}:`, error);
            fallback?.();
        }
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-bac-overlay';
        overlay.dataset.bacStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-bac-backdrop"></div>
            <div class="parlor-bac-layout">
                <div class="parlor-bac-scene">
                    <div class="parlor-bac-table">
                        ${this._buildTableArt()}
                        <div class="parlor-bac-stage">
                            <div class="parlor-bac-game-badge"><i class="fas fa-crown"></i> ${this._t('PARLOR.Games.Baccarat.Name')}</div>
                            <div class="parlor-bac-board">
                                <div class="parlor-bac-lanes">
                                    <section class="parlor-bac-side side-player" id="bac-side-player">
                                        <div class="parlor-bac-side-head">
                                            <div class="parlor-bac-side-mark">${this._sideLabel('player')}</div>
                                            <div class="parlor-bac-side-pot" id="bac-pot-player">0 GP</div>
                                        </div>
                                        <div class="parlor-bac-side-total" id="bac-total-player">?</div>
                                        <div class="parlor-bac-card-strip" id="bac-hand-player" data-empty-label="${this._t('PARLOR.Common.WaitingDeal')}"></div>
                                        <div class="parlor-bac-side-note">${this._t('PARLOR.Baccarat.Table.PlayerOdds', { odds: SIDE_INFO.player.odds })}</div>
                                    </section>
                                    <section class="parlor-bac-tie" id="bac-side-tie">
                                        <div class="parlor-bac-tie-core">
                                            <div class="parlor-bac-tie-mark">${this._sideLabel('tie')}</div>
                                            <div class="parlor-bac-tie-pot" id="bac-pot-tie">0 GP</div>
                                            <div class="parlor-bac-tie-note">${this._t('PARLOR.Baccarat.Table.TieOdds', { odds: SIDE_INFO.tie.odds })}</div>
                                            <div class="parlor-bac-tie-note muted">${this._t('PARLOR.Baccarat.Table.TieRefund')}</div>
                                        </div>
                                    </section>
                                    <section class="parlor-bac-side side-banker" id="bac-side-banker">
                                        <div class="parlor-bac-side-head">
                                            <div class="parlor-bac-side-mark">${this._sideLabel('banker')}</div>
                                            <div class="parlor-bac-side-pot" id="bac-pot-banker">0 GP</div>
                                        </div>
                                        <div class="parlor-bac-side-total" id="bac-total-banker">?</div>
                                        <div class="parlor-bac-card-strip" id="bac-hand-banker" data-empty-label="${this._t('PARLOR.Common.WaitingDeal')}"></div>
                                        <div class="parlor-bac-side-note">${this._t('PARLOR.Baccarat.Table.BankerOdds', { odds: SIDE_INFO.banker.odds })}</div>
                                    </section>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="parlor-seat-column parlor-bac-seat-rail seat-column-left" id="bac-seat-left"></div>
                    <div class="parlor-seat-column parlor-bac-seat-rail seat-column-right" id="bac-seat-right"></div>
                </div>
            </div>
            <div class="parlor-bac-center" id="bac-center"></div>
            <button class="parlor-bac-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-bac-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-bac-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderBattle(state) {
        const sideTotals = this._getSideTotals(state);
        const revealPhase = ['SHOWDOWN', 'DRAW_RULES', 'DRAWING', 'FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase);
        const resultPhase = ['FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase);

        this._overlay.querySelector('#bac-pot-player').textContent = `${this._formatChip(sideTotals.player)} GP`;
        this._overlay.querySelector('#bac-pot-banker').textContent = `${this._formatChip(sideTotals.banker)} GP`;
        this._overlay.querySelector('#bac-pot-tie').textContent = `${this._formatChip(sideTotals.tie)} GP`;
        this._overlay.querySelector('#bac-total-player').textContent = revealPhase ? `${this._getBattleTotal(state, 'player')}` : '?';
        this._overlay.querySelector('#bac-total-banker').textContent = revealPhase ? `${this._getBattleTotal(state, 'banker')}` : '?';

        ['player', 'tie', 'banker'].forEach(side => {
            const lane = this._overlay.querySelector(`#bac-side-${side}`);
            lane?.classList.toggle('is-winner', resultPhase && state.winner === side);
            lane?.classList.toggle('is-dimmed', resultPhase && state.winner && state.winner !== side);
        });

        const playerCards = state.playerHand || [];
        const bankerCards = state.bankerHand || [];
        const playerFresh = this._renderHandStrip('#bac-hand-player', playerCards, {
            side: 'player',
            from: { x: -320, y: -220 }
        });
        const bankerFresh = this._renderHandStrip('#bac-hand-banker', bankerCards, {
            side: 'banker',
            from: { x: 320, y: -220 }
        });

        this._syncHandReveal('#bac-hand-player', this._getRevealCount(state, playerCards.length), {
            side: 'player',
            freshCount: playerFresh,
            phase: state.phase
        });
        this._syncHandReveal('#bac-hand-banker', this._getRevealCount(state, bankerCards.length), {
            side: 'banker',
            freshCount: bankerFresh,
            phase: state.phase
        });
    }

    _renderHandStrip(stripId, cards, { side, from }) {
        const strip = this._overlay.querySelector(stripId);
        if (!strip) return 0;

        const renderedKey = side === 'player' ? '_renderedPlayerCards' : '_renderedBankerCards';
        const revealedKey = side === 'player' ? '_revealedPlayerCards' : '_revealedBankerCards';

        if (!cards.length) {
            strip.innerHTML = '';
            this[renderedKey] = 0;
            this[revealedKey] = 0;
            return 0;
        }

        if (cards.length < this[renderedKey]) {
            strip.innerHTML = '';
            this[renderedKey] = 0;
            this[revealedKey] = 0;
        }

        const startIndex = this[renderedKey];
        for (let index = startIndex; index < cards.length; index++) {
            const card = cards[index];
            const cardEl = CardRenderer.createCard(card, { faceDown: true, size: 'table' });
            strip.appendChild(cardEl);
            CardRenderer.dealFrom(cardEl, {
                x: from.x + index * 34,
                y: from.y - index * 10
            }, (index - startIndex) * 220, {
                duration: 560,
                startScale: 0.66,
                settleScale: 1,
                settleRotate: (index - 1) * 2
            });
        }

        const freshCount = Math.max(0, cards.length - startIndex);
        this[renderedKey] = cards.length;
        return freshCount;
    }

    _getRevealCount(state, cardCount) {
        if (!cardCount) return 0;
        if (['SHOWDOWN', 'DRAW_RULES'].includes(state.phase)) return Math.min(cardCount, 2);
        if (['DRAWING', 'FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase)) return cardCount;
        return 0;
    }

    _getBattleTotal(state, side) {
        const summary = state.roundSummary || {};
        if (['SHOWDOWN', 'DRAW_RULES', 'DRAWING'].includes(state.phase)) {
            return side === 'player'
                ? (summary.initialPlayerTotal ?? state.playerTotal ?? '?')
                : (summary.initialBankerTotal ?? state.bankerTotal ?? '?');
        }

        return side === 'player' ? state.playerTotal : state.bankerTotal;
    }

    _syncHandReveal(stripId, targetCount, { side, freshCount = 0, phase }) {
        const strip = this._overlay.querySelector(stripId);
        if (!strip) return;

        const revealedKey = side === 'player' ? '_revealedPlayerCards' : '_revealedBankerCards';
        const currentCount = this[revealedKey];
        if (targetCount <= currentCount) return;

        const cardEls = [...strip.querySelectorAll('.parlor-playing-card')];
        const baseDelay = phase === 'DRAWING' ? 620 : 0;
        const startIndex = currentCount;

        for (let index = startIndex; index < targetCount; index++) {
            const cardEl = cardEls[index];
            if (!cardEl) continue;

            setTimeout(() => {
                if (!this._overlay || !cardEl.isConnected) return;
                CardRenderer.flip(cardEl, false, 380);
            }, baseDelay + ((index - startIndex) * 110) + (freshCount > 0 ? 60 : 0));
        }

        this[revealedKey] = targetCount;
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#bac-center');
        if (!center) return;

        const isGM = game.user.isGM;
        if (!isGM) {
            center.innerHTML = '';
            return;
        }

        const myId = this._getSelectedParticipantId(state);
        const myBet = this._getBetForUser(state, myId);
        const activePlayers = this._getActivePlayerIds(state);
        const controlledIds = this._getControlledParticipantIds(state);
        const bettedIds = new Set((state.bets || []).map(bet => bet.userId).filter(uid => activePlayers.includes(uid)));
        const sideTotals = this._getSideTotals(state);
        const totalPot = sideTotals.player + sideTotals.banker + sideTotals.tie;
        const roundNote = this._getRoundNote(state);
        const selectedBalance = myId ? ChipManager.getDisplayBalance(myId) : null;

        let panel = null;
        let controlsHtml = '';
        let detailHtml = '';

        if (state.phase === 'BETTING') {
            controlsHtml = controlledIds.length
                ? this._buildCenterBetControls(state, { myId, controlledIds, myBet })
                : '';
            panel = {
                tone: myBet ? 'active' : 'betting',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Betting'),
                title: myBet ? this._t('PARLOR.Baccarat.Center.BettingTitlePlaced', { side: this._sideLabel(myBet.side) }) : this._t('PARLOR.Baccarat.Center.BettingTitleIdle'),
                sub: myBet
                    ? this._t('PARLOR.Baccarat.Center.BettingSubPlaced', { side: this._sideLabel(myBet.side), amount: this._formatChip(myBet.amount) })
                    : this._t('PARLOR.Baccarat.Center.BettingSubIdle'),
                note: !controlledIds.length
                    ? this._t('PARLOR.Common.NoControlledParticipant')
                    : (controlledIds.length > 1
                        ? this._t('PARLOR.Baccarat.Footer.MultiControl', { count: controlledIds.length, done: controlledBetCount })
                        : this._t('PARLOR.Baccarat.Center.BettingNote')),
                stats: [
                    { label: this._t('PARLOR.Common.TableProgress'), value: `${bettedIds.size} / ${activePlayers.length}` },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(totalPot)} GP` },
                    ...(selectedBalance == null ? [] : [{ label: this._t('PARLOR.Common.AvailableChips'), value: Number.isFinite(selectedBalance) ? `${selectedBalance}` : this._t('PARLOR.Common.Infinity') }])
                ]
            };
        } else if (state.phase === 'READY') {
            controlsHtml = isGM
                ? this._buildPromptActionControls([{
                    action: 'deal',
                    label: this._t('PARLOR.Baccarat.Action.DealByDM'),
                    accent: true,
                    icon: 'fas fa-play'
                }])
                : '';
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Ready'),
                title: isGM ? this._t('PARLOR.Baccarat.Center.ReadyTitleGM') : this._t('PARLOR.Baccarat.Center.ReadyTitlePlayer'),
                sub: this._t('PARLOR.Baccarat.Center.ReadySub'),
                note: this._t('PARLOR.Baccarat.Center.ReadyNote'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerPot'), value: `${this._formatChip(sideTotals.player)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.TiePot'), value: `${this._formatChip(sideTotals.tie)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerPot'), value: `${this._formatChip(sideTotals.banker)} GP` }
                ]
            };
        } else if (state.phase === 'DEALING') {
            panel = {
                tone: 'dealing',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Dealing'),
                title: this._t('PARLOR.Baccarat.Center.DealingTitle'),
                sub: this._t('PARLOR.Baccarat.Center.DealingSub'),
                note: this._t('PARLOR.Baccarat.Center.DealingNote'),
                stats: [
                    { label: this._t('PARLOR.Common.TablePot'), value: `${this._formatChip(totalPot)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerHand'), value: `${state.playerHand?.length || 0} ${this._t('PARLOR.Baccarat.Stat.Cards')}` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerHand'), value: `${state.bankerHand?.length || 0} ${this._t('PARLOR.Baccarat.Stat.Cards')}` }
                ]
            };
        } else if (state.phase === 'SHOWDOWN') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Showdown'),
                title: this._getInitialScoreText(state),
                sub: this._t('PARLOR.Baccarat.Center.ShowdownSub'),
                note: roundNote || this._t('PARLOR.Baccarat.Center.ShowdownNote'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerPot'), value: `${this._formatChip(sideTotals.player)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.TiePot'), value: `${this._formatChip(sideTotals.tie)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerPot'), value: `${this._formatChip(sideTotals.banker)} GP` }
                ]
            };
        } else if (state.phase === 'DRAW_RULES') {
            controlsHtml = isGM
                ? this._buildPromptActionControls([{
                    action: 'draw',
                    label: this._getDrawActionLabel(state),
                    accent: true,
                    icon: 'fas fa-layer-group'
                }])
                : '';
            detailHtml = this._buildDrawReasonHtml(state);
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.DrawRules'),
                title: this._getDrawRuleTitle(state),
                sub: this._getDrawRuleSummary(state),
                note: isGM ? this._t('PARLOR.Baccarat.Center.DrawRulesNoteGM') : this._t('PARLOR.Baccarat.Center.DrawRulesNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerInitial'), value: `${state.roundSummary?.initialPlayerTotal ?? state.playerTotal}` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerInitial'), value: `${state.roundSummary?.initialBankerTotal ?? state.bankerTotal}` }
                ]
            };
        } else if (state.phase === 'DRAWING') {
            panel = {
                tone: 'dealing',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Drawing'),
                title: this._t('PARLOR.Baccarat.Center.DrawingTitle'),
                sub: this._getDrawExecutionSummary(state),
                note: this._t('PARLOR.Baccarat.Center.DrawingNote'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerHand'), value: `${state.playerHand?.length || 0} ${this._t('PARLOR.Baccarat.Stat.Cards')}` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerHand'), value: `${state.bankerHand?.length || 0} ${this._t('PARLOR.Baccarat.Stat.Cards')}` }
                ]
            };
        } else if (state.phase === 'FINAL_SHOWDOWN') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.FinalShowdown'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: this._t('PARLOR.Baccarat.Center.FinalScore', { playerTotal: state.playerTotal, bankerTotal: state.bankerTotal }),
                note: this._getFinalRoundNote(state) || this._t('PARLOR.Baccarat.Center.FinalShowdownNote'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerPot'), value: `${this._formatChip(sideTotals.player)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.TiePot'), value: `${this._formatChip(sideTotals.tie)} GP` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerPot'), value: `${this._formatChip(sideTotals.banker)} GP` }
                ]
            };
        } else if (state.phase === 'SETTLE') {
            const myDelta = myBet ? this._getDelta(state, myId) : 0;
            controlsHtml = isGM
                ? this._buildPromptActionControls([{
                    action: 'settle',
                    label: this._t('PARLOR.Common.Settle'),
                    accent: true,
                    icon: 'fas fa-file-invoice-dollar'
                }])
                : '';
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Settle'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: myBet ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatDelta(myDelta) }) : this._t('PARLOR.Common.ResultOnSeat'),
                note: isGM ? this._t('PARLOR.Baccarat.Center.SettleNoteGM') : this._t('PARLOR.Baccarat.Center.SettleNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerPoints'), value: `${state.playerTotal}` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerPoints'), value: `${state.bankerTotal}` }
                ]
            };
        } else if (state.phase === 'RESOLVING') {
            const myDelta = myBet ? this._getDelta(state, myId) : 0;
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.Baccarat.Center.Phase.Resolving'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: myBet ? this._t('PARLOR.Common.CurrentRoleResult', { result: this._formatDelta(myDelta) }) : this._t('PARLOR.Common.SettlementOpen'),
                note: this._getFinalRoundNote(state) || (isGM ? this._t('PARLOR.Baccarat.Center.ResolvingNoteGM') : this._t('PARLOR.Baccarat.Center.ResolvingNotePlayer')),
                stats: [
                    { label: this._t('PARLOR.Baccarat.Stat.PlayerPoints'), value: `${state.playerTotal}` },
                    { label: this._t('PARLOR.Baccarat.Stat.BankerPoints'), value: `${state.bankerTotal}` }
                ]
            };
        }

        center.innerHTML = panel ? this._buildCenterPanel(state, panel, controlsHtml, detailHtml) : '';
        this._bindCenterBetControls(state, { myId });
        this._bindCenterActionControls();
    }

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#bac-seat-left');
        const rightColumn = this._overlay.querySelector('#bac-seat-right');
        if (!leftColumn || !rightColumn) return;

        leftColumn.innerHTML = '';
        rightColumn.innerHTML = '';

        const myId = this._getSelfSeatParticipantId(state);
        const controlledIds = this._getControlledParticipantIds(state);
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
            const isMe = uid === myId;
            const isControlled = controlledIds.includes(uid);
            const seatNum = Math.max(1, visibleSeatIds.indexOf(uid) + 1);
            const sideLabel = bet ? this._sideLabel(bet.side) : '';
            const delta = bet ? this._getDelta(state, uid) : 0;
            const seatControlsHtml = state.phase === 'BETTING' && isControlled
                ? this._buildSeatBetControls(uid, bet)
                : '';

            let statusText = this._t('PARLOR.Common.WaitingBet');
            let statusClass = 'status-idle';

            if (bet && state.phase === 'BETTING') {
                statusText = this._t('PARLOR.Baccarat.Seat.StatusPlaced', { side: sideLabel });
                statusClass = 'status-live';
            } else if (bet && ['READY', 'DEALING'].includes(state.phase)) {
                statusText = this._t('PARLOR.Baccarat.Seat.StatusReady', { side: sideLabel });
                statusClass = 'status-live';
            } else if (bet && state.phase === 'SHOWDOWN') {
                statusText = this._t('PARLOR.Baccarat.Seat.StatusShowdown');
                statusClass = 'status-live';
            } else if (bet && ['DRAW_RULES', 'DRAWING'].includes(state.phase)) {
                statusText = this._t('PARLOR.Baccarat.Seat.StatusDrawing');
                statusClass = 'status-live';
            } else if (bet && state.phase === 'FINAL_SHOWDOWN') {
                statusText = this._formatSeatResult(delta);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            } else if (bet && state.phase === 'SETTLE') {
                statusText = this._formatSeatResult(delta);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            } else if (bet && state.phase === 'RESOLVING') {
                statusText = this._formatResult(state, uid);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            }

            const seat = document.createElement('div');
            seat.className = `parlor-seat-card seat-${zone}${isMe ? ' is-me' : ''}${bet ? ' has-bet' : ''}${['FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase) && bet ? ' has-result' : ''}`;
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
                            ? `<div class="parlor-seat-bet">${this._formatChip(bet.amount)} GP</div><div class="parlor-seat-side side-${bet.side}">${sideLabel}</div>`
                            : `<div class="parlor-seat-bet is-empty">${this._t('PARLOR.Common.WaitingBet')}</div><div class="parlor-seat-side is-empty">—</div>`
                        }
                        <div class="parlor-seat-status ${statusClass}">${statusText}</div>
                    </div>
                    ${seatControlsHtml}
                </div>
            `;

            if (state.phase === 'BETTING' && isControlled) {
                this._bindSeatBetControls(seat, uid);
            }

            target.appendChild(seat);
        }
    }

    _renderHandHUD(state) {
        const myId = this._getSelectedParticipantId(state);
        const controlledIds = this._getControlledParticipantIds(state);
        const isPlayer = !!myId && controlledIds.includes(myId);
        const myBet = this._getBetForUser(state, myId);
        let footer = '';

        if (state.phase === 'BETTING') {
            footer = this._buildBettingFooter(state, { myId, controlledIds, isPlayer, myBet });
        }

        if (!footer) {
            this._handHUD.destroy();
            return;
        }

        if (!this._handHUD.root) this._handHUD.show([]);
        this._handHUD.hideActions();
        this._handHUD.showFooter(footer);
        this._bindHudFooter(state, { myId });
    }

    _buildBettingFooter(state, { myId, controlledIds, isPlayer, myBet }) {
        if (!controlledIds.length) return '';

        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => (state.playerIds || []).includes(entry.id));
        const balanceLabel = myId ? ChipManager.getDisplayBalance(myId) : '0';
        const amount = Math.max(1, Number(myBet?.amount || this._betDraftAmount || 10));
        const controlledBetCount = controlledIds.filter(uid => this._getBetForUser(state, uid)).length;
        const selectedParticipant = controlledParticipants.find(entry => entry.id === myId) || null;
        const betDisabledAttr = myId && this._pendingBetParticipants.has(myId) ? 'disabled' : '';
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="bac-hud-participant-select" class="parlor-hud-footer-input" style="width:190px;">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === myId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : '';
        const participantLabel = selectedParticipant ? getParticipantLabel(selectedParticipant) : this._t('PARLOR.Common.CurrentParticipant');
        let rightHtml = `<span class="parlor-hud-footer-pill muted">${this._t('PARLOR.Common.WaitingBet')}</span>`;

        if (isPlayer) {
            rightHtml = `
                <div class="parlor-bac-hud-betbox">
                    <input type="number" id="bac-hud-bet-input" value="${amount}" min="1" class="parlor-hud-footer-input" placeholder="GP">
                    <div class="parlor-bac-hud-bet-actions">
                        <button class="parlor-hud-action-btn" data-bac-bet-side="player" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetPlayer')}</button>
                        <button class="parlor-hud-action-btn" data-bac-bet-side="banker" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetBanker')}</button>
                        <button class="parlor-hud-action-btn accent" data-bac-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetTie')}</button>
                    </div>
                </div>
            `;
        } else if (!controlledIds.length) {
            sub = this._t('PARLOR.Common.NoControlledParticipant');
        }

        return `
            <div class="parlor-hud-footer-main parlor-bac-hud-shell">
                <div class="parlor-hud-footer-side parlor-bac-hud-side">
                    <div class="parlor-bac-hud-context">
                        <span class="parlor-hud-footer-label">${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml || `<span class="parlor-bac-hud-name">${participantLabel}</span>`}
                    </div>
                    <div class="parlor-bac-hud-meta">
                        <span class="parlor-hud-footer-pill">${Number.isFinite(balanceLabel) ? `${balanceLabel} ${this._t('PARLOR.Common.Chips')}` : this._t('PARLOR.Common.ChipsInfinity')}</span>
                        <span class="parlor-hud-footer-pill ${myBet ? '' : 'muted'}">${myBet ? this._t('PARLOR.Baccarat.Seat.StatusPlaced', { side: this._sideLabel(myBet.side) }) : this._t('PARLOR.Baccarat.Footer.NotBetYet')}</span>
                    </div>
                </div>
                <div class="parlor-hud-footer-center parlor-bac-hud-center">
                    <div class="parlor-hud-footer-metrics">
                        <span class="parlor-hud-footer-pill">${this._t('PARLOR.Common.RoundCounter', { round: state.round })}</span>
                        <span class="parlor-hud-footer-pill">${this._t('PARLOR.Common.TableProgress')} ${controlledBetCount} / ${controlledIds.length || 0}</span>
                    </div>
                </div>
                <div class="parlor-hud-footer-side align-right parlor-bac-hud-side right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _bindHudFooter(state, { myId }) {
        const root = this._handHUD.root;
        if (!root) return;

        root.querySelector('#bac-hud-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const selectedBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAmount = Math.max(1, Number(selectedBet?.amount || this._betDraftAmount || 10));
            this.refresh();
        });

        root.querySelector('#bac-hud-bet-input')?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        root.querySelectorAll('[data-bac-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const participantId = root.querySelector('#bac-hud-participant-select')?.value || myId || this._selectedParticipantId;
                this._submitBet(button.dataset.bacBetSide, participantId, null, event.currentTarget);
            });
        });
    }

    async _submitBet(side, preferredParticipantId = null, amountOverride = null, triggerButton = null) {
        const safeSide = SIDE_INFO[side] ? side : 'player';
        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const participantId = controlledIds.includes(preferredParticipantId)
            ? preferredParticipantId
            : this._getSelectedParticipantId(state);
        const hudAmountInput = this._handHUD.root?.querySelector('#bac-hud-bet-input');
        const centerAmountInput = this._overlay?.querySelector('#bac-center-bet-input');
        const safeOverride = amountOverride == null ? null : Math.max(0, parseInt(amountOverride, 10) || 0);
        const amount = safeOverride ?? Math.max(0, parseInt(hudAmountInput?.value ?? centerAmountInput?.value ?? this._betDraftAmount, 10) || 0);

        if (!participantId) {
            ui.notifications.warn(this._t('PARLOR.Common.BetMissingParticipant'));
            return;
        }
        if (amount <= 0) {
            ui.notifications.warn(this._t('PARLOR.Common.BetAmountTooLow'));
            hudAmountInput?.focus();
            centerAmountInput?.focus();
            return;
        }
        if (this._pendingBetParticipants.has(participantId)) return;

        this._selectedParticipantId = participantId;
        this._betDraftAmount = amount;
        this._pendingBetParticipants.add(participantId);
        if (triggerButton) triggerButton.disabled = true;

        try {
            const result = await SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
                sessionId: this.sessionId,
                userId: participantId,
                action: 'placeBet',
                data: { side: safeSide, amount }
            });

            if (result?.ok === false) {
                this._showBetFailure(result, participantId, amount);
                return;
            }

            this.refresh();
        } catch (err) {
            console.error('parlor | Baccarat bet failed:', err);
            ui.notifications.error(this._t('PARLOR.Common.BetFailed'));
        } finally {
            this._pendingBetParticipants.delete(participantId);
            if (triggerButton?.isConnected) triggerButton.disabled = false;
            if (this._overlay) this.refresh();
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
            case 'invalid-side':
                ui.notifications.warn(this._t('PARLOR.Baccarat.Error.InvalidSide'));
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
        document.querySelector('#parlor-bac-settlement')?.remove();

        const popup = document.createElement('div');
        popup.id = 'parlor-bac-settlement';
        popup.dataset.bacStyle = 'v14';
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        const rows = this._getActivePlayerIds(state).map(uid => {
            const bet = this._getBetForUser(state, uid);
            const payout = Number(state.payouts?.[uid] || 0);
            return `
                <tr>
                    <td>${this._playerName(state, uid)}</td>
                    <td>${bet ? `${this._sideLabel(bet.side)} · ${this._formatChip(bet.amount)} GP` : '—'}</td>
                    <td>${this._formatResult(state, uid)}</td>
                    <td>${this._formatChip(payout)} GP</td>
                    <td>${this._formatDelta(this._getDelta(state, uid))}</td>
                </tr>
            `;
        }).join('');

        popup.innerHTML = `
            <div class="parlor-bac-settlement-box">
                <div class="settlement-title">${this._t('PARLOR.Baccarat.Settlement.Title', { winner: this._sideLabel(state.winner) })}</div>
                <div class="settlement-sub">${this._t('PARLOR.Baccarat.Center.FinalScore', { playerTotal: state.playerTotal, bankerTotal: state.bankerTotal })}</div>
                <table class="settlement-table">
                    <thead><tr><th>${this._t('PARLOR.Common.Player')}</th><th>${this._t('PARLOR.Common.Bet')}</th><th>${this._t('PARLOR.Baccarat.Settlement.Result')}</th><th>${this._t('PARLOR.Baccarat.Settlement.Payout')}</th><th>${this._t('PARLOR.Baccarat.Settlement.Net')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-prompt-actions" style="margin-top:16px;">
                    ${game.user.isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="bac-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="bac-next-round"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="bac-dismiss-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        popup.querySelector('#bac-dismiss-settlement')?.addEventListener('click', () => popup.remove());
        popup.querySelector('#bac-finish-game')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#bac-next-round')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'finishGame' });
        });
        popup.querySelector('#bac-next-round')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#bac-finish-game')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'newRound' });
        });
    }

    _buildFooter(title, sub) {
        return `
            <div class="parlor-hand-hud-footer-main">
                <div class="parlor-hand-hud-footer-title">${title}</div>
                <div class="parlor-hand-hud-footer-sub">${sub}</div>
            </div>
        `;
    }

    _renderCenterFallback(state) {
        const center = this._overlay?.querySelector('#bac-center');
        if (!center) return;
        if (!game.user.isGM) {
            center.innerHTML = '';
            return;
        }

        center.innerHTML = this._buildCenterPanel(state, {
            phaseLabel: this._getFallbackPhaseLabel(state),
            title: state.phase === 'BETTING' ? this._t('PARLOR.Common.Spectating') : this._t('PARLOR.Common.Waiting'),
            sub: state.phase === 'BETTING'
                ? this._t('PARLOR.Common.NoControlledParticipant')
                : this._t('PARLOR.Common.ViewSettlementPanel'),
            note: this._t('PARLOR.Common.BetFailedRetry')
        });
    }

    _renderHandHUDFallback(state) {
        if (!this._handHUD.root) this._handHUD.show([]);
        this._handHUD.hideActions();
        this._handHUD.showFooter(this._buildFooter(
            state.phase === 'BETTING' ? this._t('PARLOR.Common.Spectating') : this._getFallbackPhaseLabel(state),
            state.phase === 'BETTING'
                ? this._t('PARLOR.Common.NoControlledParticipant')
                : this._t('PARLOR.Common.ViewSettlementPanel')
        ));
    }

    _getFallbackPhaseLabel(state) {
        switch (state.phase) {
            case 'BETTING': return this._t('PARLOR.Baccarat.Center.Phase.Betting');
            case 'READY': return this._t('PARLOR.Baccarat.Center.Phase.Ready');
            case 'DEALING': return this._t('PARLOR.Baccarat.Center.Phase.Dealing');
            case 'SHOWDOWN': return this._t('PARLOR.Baccarat.Center.Phase.Showdown');
            case 'DRAW_RULES': return this._t('PARLOR.Baccarat.Center.Phase.DrawRules');
            case 'DRAWING': return this._t('PARLOR.Baccarat.Center.Phase.Drawing');
            case 'FINAL_SHOWDOWN': return this._t('PARLOR.Baccarat.Center.Phase.FinalShowdown');
            case 'SETTLE': return this._t('PARLOR.Baccarat.Center.Phase.Settle');
            case 'RESOLVING': return this._t('PARLOR.Baccarat.Center.Phase.Resolving');
            default: return this._t('PARLOR.Common.Waiting');
        }
    }

    _buildCenterBetControls(state, { myId, controlledIds, myBet }) {
        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => (state.playerIds || []).includes(entry.id));
        const amount = Math.max(1, Number(myBet?.amount || this._betDraftAmount || 10));
        const selectedParticipant = controlledParticipants.find(entry => entry.id === myId) || null;
        const betDisabledAttr = myId && this._pendingBetParticipants.has(myId) ? 'disabled' : '';
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="bac-center-participant-select" class="parlor-bac-center-select">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === myId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : `<div class="parlor-bac-center-static">${selectedParticipant ? getParticipantLabel(selectedParticipant) : this._t('PARLOR.Common.CurrentParticipant')}</div>`;

        return `
            <div class="parlor-bac-prompt-controls">
                <div class="parlor-bac-center-betbox">
                    <label class="parlor-bac-center-field">
                        <span>${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml}
                    </label>
                    <label class="parlor-bac-center-field amount-field">
                        <span>${this._t('PARLOR.Common.Amount')}</span>
                        <input type="number" id="bac-center-bet-input" value="${amount}" min="1" class="parlor-bac-center-input" placeholder="GP">
                    </label>
                </div>
                <div class="parlor-bac-center-bet-actions">
                    <button class="parlor-hud-action-btn" data-bac-center-bet-side="player" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetPlayer')}</button>
                    <button class="parlor-hud-action-btn" data-bac-center-bet-side="banker" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetBanker')}</button>
                    <button class="parlor-hud-action-btn accent" data-bac-center-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetTie')}</button>
                </div>
            </div>
        `;
    }

    _buildPromptActionControls(actions = []) {
        if (!actions.length) return '';

        return `
            <div class="parlor-bac-prompt-controls">
                <div class="parlor-bac-center-bet-actions parlor-bac-prompt-action-row">
                    ${actions.map(action => `
                        <button
                            class="parlor-hud-action-btn${action.accent ? ' accent' : ''}"
                            data-bac-center-action="${action.action}"
                        >
                            ${action.icon ? `<i class="${action.icon}"></i>` : ''}${action.label}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _bindCenterBetControls(state, { myId }) {
        const center = this._overlay?.querySelector('#bac-center');
        if (!center) return;

        center.querySelector('#bac-center-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const selectedBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAmount = Math.max(1, Number(selectedBet?.amount || this._betDraftAmount || 10));
            this.refresh();
        });

        center.querySelector('#bac-center-bet-input')?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        center.querySelectorAll('[data-bac-center-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const participantId = center.querySelector('#bac-center-participant-select')?.value || myId || this._selectedParticipantId;
                const amount = center.querySelector('#bac-center-bet-input')?.value || this._betDraftAmount;
                this._submitBet(button.dataset.bacCenterBetSide, participantId, amount, event.currentTarget);
            });
        });
    }

    _bindCenterActionControls() {
        const center = this._overlay?.querySelector('#bac-center');
        if (!center) return;

        center.querySelectorAll('[data-bac-center-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.bacCenterAction;
                if (!action) return;

                SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                    sessionId: this.sessionId,
                    action
                });
            });
        });
    }

    _buildSeatBetControls(uid, bet) {
        const amount = Math.max(1, Number(bet?.amount || this._betDraftAmount || 10));
        const betDisabledAttr = this._pendingBetParticipants.has(uid) ? 'disabled' : '';
        return `
            <div class="parlor-bac-seat-betbox" data-seat-bet-owner="${uid}">
                <input type="number" class="parlor-bac-seat-bet-input" value="${amount}" min="1" placeholder="GP">
                <div class="parlor-bac-seat-bet-actions">
                    <button class="parlor-hud-action-btn" data-bac-seat-bet-side="player" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetPlayer')}</button>
                    <button class="parlor-hud-action-btn" data-bac-seat-bet-side="banker" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetBanker')}</button>
                    <button class="parlor-hud-action-btn accent" data-bac-seat-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.Baccarat.Action.BetTie')}</button>
                </div>
            </div>
        `;
    }

    _bindSeatBetControls(seat, uid) {
        const input = seat.querySelector('.parlor-bac-seat-bet-input');
        input?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        seat.querySelectorAll('[data-bac-seat-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const amount = input?.value || this._betDraftAmount;
                this._selectedParticipantId = uid;
                this._submitBet(button.dataset.bacSeatBetSide, uid, amount, event.currentTarget);
            });
        });
    }

    _buildCenterPanel(state, { phaseLabel, title, sub = '', note = '', stats = [], tone = '' }, controlsHtml = '', detailHtml = '') {
        const statsHtml = stats
            .filter(entry => entry?.label && entry?.value != null && entry.value !== '')
            .map(entry => `
                <div class="parlor-bac-prompt-stat">
                    <div class="parlor-bac-prompt-stat-label">${entry.label}</div>
                    <div class="parlor-bac-prompt-stat-value">${entry.value}</div>
                </div>
            `)
            .join('');

        return `
            <div class="parlor-bac-prompt ${tone ? `tone-${tone}` : ''}">
                <div class="parlor-bac-prompt-head">
                    <div class="parlor-bac-prompt-phase">${phaseLabel}</div>
                    <div class="parlor-bac-prompt-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round })}</div>
                </div>
                <div class="parlor-bac-prompt-title">${title}</div>
                ${detailHtml}
                ${statsHtml ? `<div class="parlor-bac-prompt-stats">${statsHtml}</div>` : ''}
                ${controlsHtml}
            </div>
        `;
    }

    _getInitialScoreText(state) {
        const summary = state.roundSummary || {};
        const playerTotal = summary.initialPlayerTotal ?? state.playerTotal ?? '?';
        const bankerTotal = summary.initialBankerTotal ?? state.bankerTotal ?? '?';
        return this._t('PARLOR.Baccarat.Center.FinalScore', { playerTotal, bankerTotal });
    }

    _getDrawRuleTitle(state) {
        const summary = state.roundSummary || {};
        if (summary.natural) return this._t('PARLOR.Baccarat.DrawTitle.Natural');
        if (!summary.playerShouldDraw && summary.bankerPlan === 'stand') return this._t('PARLOR.Baccarat.DrawTitle.NoThirdCard');
        return this._t('PARLOR.Baccarat.DrawTitle.RuleBased');
    }

    _getDrawRuleSummary(state) {
        const summary = state.roundSummary || {};
        if (!summary.playerReason && !summary.bankerReason) return '';
        return [summary.playerReason, summary.bankerReason].map(entry => this._localizeReason(entry)).filter(Boolean).join(' ');
    }

    _buildDrawReasonHtml(state) {
        const items = this._getDrawReasonItems(state);
        if (!items.length) return '';

        return `
            <div class="parlor-bac-prompt-reasons">
                ${items.map(item => `
                    <div class="parlor-bac-prompt-reason">
                        <div class="parlor-bac-prompt-reason-label">${item.label}</div>
                        <div class="parlor-bac-prompt-reason-text">${item.text}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    _getDrawReasonItems(state) {
        const summary = state.roundSummary || {};
        const bankerReason = summary.drawResolved && summary.resolvedBankerReason
            ? summary.resolvedBankerReason
            : summary.bankerReason;

        return [
            {
                label: this._sideLabel('player'),
                text: this._localizeReason(summary.playerReason)
            },
            {
                label: this._sideLabel('banker'),
                text: this._localizeReason(bankerReason)
            }
        ].filter(item => item.text);
    }

    _getDrawActionLabel(state) {
        const summary = state.roundSummary || {};
        if (summary.natural) return this._t('PARLOR.Baccarat.DrawAction.GoToResult');
        if (!summary.playerShouldDraw && summary.bankerPlan === 'stand') return this._t('PARLOR.Baccarat.DrawAction.ConfirmNoDraw');
        return this._t('PARLOR.Baccarat.DrawAction.ExecuteDraw');
    }

    _getDrawExecutionSummary(state) {
        const summary = state.roundSummary || {};
        if (summary.playerDrew && summary.bankerDrew) return this._t('PARLOR.Baccarat.DrawExecution.Both');
        if (summary.playerDrew) return this._t('PARLOR.Baccarat.DrawExecution.PlayerOnly');
        if (summary.bankerDrew) return this._t('PARLOR.Baccarat.DrawExecution.BankerOnly');
        return this._t('PARLOR.Baccarat.DrawExecution.None');
    }

    _getFinalRoundNote(state) {
        const summary = state.roundSummary || {};
        const parts = [];
        if (summary.natural) {
            parts.push(this._t('PARLOR.Baccarat.FinalNote.Natural'));
        } else {
            if (summary.playerDrew && summary.playerThirdValue != null) {
                parts.push(this._t('PARLOR.Baccarat.FinalNote.PlayerDrew', { value: summary.playerThirdValue }));
            } else if (summary.playerShouldDraw === false) {
                parts.push(this._t('PARLOR.Baccarat.FinalNote.PlayerStand'));
            }

            if (summary.bankerDrew && summary.bankerThirdValue != null) {
                parts.push(this._t('PARLOR.Baccarat.FinalNote.BankerDrew', { value: summary.bankerThirdValue }));
            }

            if (!summary.bankerDrew && summary.resolvedBankerReason) {
                parts.push(this._localizeReason(summary.resolvedBankerReason));
            }
        }

        return parts.join(' ');
    }

    _getRoundNote(state) {
        if (state.phase === 'SHOWDOWN') return this._getDrawRuleSummary(state);
        if (state.phase === 'DRAW_RULES') return this._getDrawRuleSummary(state);
        if (['DRAWING', 'FINAL_SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase)) {
            return this._getFinalRoundNote(state);
        }
        return '';
    }

    _getSideTotals(state) {
        const sideTotals = { player: 0, banker: 0, tie: 0 };
        for (const bet of (state.bets || [])) {
            if (sideTotals[bet.side] == null) continue;
            sideTotals[bet.side] += Number(bet.amount || 0);
        }
        return sideTotals;
    }

    _getActivePlayerIds(state) {
        return (state.playerIds || []).filter(Boolean);
    }

    _getBetForUser(state, userId) {
        return (state.bets || []).find(bet => bet.userId === userId) || null;
    }

    _getDelta(state, userId) {
        const bet = this._getBetForUser(state, userId);
        if (!bet) return 0;
        return Number((Number(state.payouts?.[userId] || 0) - Number(bet.amount || 0)).toFixed(2));
    }

    _formatResult(state, userId) {
        const bet = this._getBetForUser(state, userId);
        if (!bet) return this._t('PARLOR.Common.NoBet');

        const delta = this._getDelta(state, userId);
        if (delta > 0) return this._t('PARLOR.Baccarat.Result.Win', { side: this._sideLabel(bet.side) });
        if (delta === 0 && state.winner === 'tie' && ['player', 'banker'].includes(bet.side)) return this._t('PARLOR.Baccarat.Result.TiePush', { side: this._sideLabel(bet.side) });
        if (delta < 0) return this._t('PARLOR.Baccarat.Result.Lose', { side: this._sideLabel(bet.side) });
        return this._t('PARLOR.Baccarat.Result.Push', { side: this._sideLabel(bet.side) });
    }

    _formatChip(amount) {
        const value = Math.round(Number(amount || 0) * 100) / 100;
        if (Number.isInteger(value)) return `${value}`;
        return value.toFixed(2).replace(/\.?0+$/, '');
    }

    _formatDelta(delta) {
        const value = Number(delta || 0);
        if (value > 0) return `+${this._formatChip(value)} GP`;
        if (value < 0) return `${this._formatChip(value)} GP`;
        return '0 GP';
    }

    _formatSeatResult(delta) {
        const value = Number(delta || 0);
        if (value > 0) return this._t('PARLOR.Baccarat.SeatResult.Win', { amount: this._formatChip(value) });
        if (value < 0) return this._t('PARLOR.Baccarat.SeatResult.Lose', { amount: this._formatChip(Math.abs(value)) });
        return this._t('PARLOR.Baccarat.SeatResult.Push');
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
            const bet = this._getBetForUser(state, uid);
            if (!bet) return [];

            const key = `resolve:${round}:${uid}`;
            if (this._playedLocalResultFxKeys.has(key)) return [];

            const delta = this._getDelta(state, uid);
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
                sub: `${this._playerName(state, uid)} · ${this._sideLabel(bet.side)} · ${this._formatDeltaLabel(delta)}`,
                duration: 1420
            }];
        });
    }

    _formatDeltaLabel(delta) {
        const value = Number(delta || 0);
        if (value > 0) return `+${this._formatChip(value)} GP`;
        if (value < 0) return `${this._formatChip(value)} GP`;
        return '0 GP';
    }

    _sideLabel(side) {
        const key = SIDE_INFO[side]?.labelKey;
        return key ? this._t(key) : this._t('PARLOR.Common.Unknown');
    }

    _localizeReason(reason) {
        if (!reason) return '';
        if (typeof reason === 'string') return reason;
        return reason.key ? this._t(reason.key, reason.data || {}) : '';
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
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
            .filter(id => (state.playerIds || []).includes(id));
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
        this._renderedPlayerCards = 0;
        this._renderedBankerCards = 0;
        this._revealedPlayerCards = 0;
        this._revealedBankerCards = 0;
        this._settlementShown = false;
        this._pendingBetParticipants.clear();
        this._resultFxRound = null;
        this._playedLocalResultFxKeys.clear();
    }

    _buildTableArt() {
        // V14 兼容优先：百家乐桌面和 21 点一样，保存样式后按当前配置重建 SVG。
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
            <svg class="parlor-bac-table-svg" viewBox="0 0 2200 1080" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
                <defs>
                    <filter id="bac-table-shadow" x="-10%" y="-20%" width="120%" height="160%">
                        <feDropShadow dx="0" dy="36" stdDeviation="34" flood-color="#000" flood-opacity="0.5"/>
                    </filter>
                    <filter id="bac-felt-noise" x="0%" y="0%" width="100%" height="100%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.72" numOctaves="2" seed="17" result="noise"/>
                        <feColorMatrix type="saturate" values="0" in="noise" result="gray"/>
                        <feBlend in="SourceGraphic" in2="gray" mode="soft-light"/>
                    </filter>
                    <filter id="bac-soft-glow">
                        <feGaussianBlur stdDeviation="8" result="blur"/>
                        <feMerge>
                            <feMergeNode in="blur"/>
                            <feMergeNode in="SourceGraphic"/>
                        </feMerge>
                    </filter>
                    <linearGradient id="bac-rail-wood" x1="0%" y1="0%" x2="0%" y2="100%">
${railSurfaceStops}
                    </linearGradient>
                    <linearGradient id="bac-rail-shadow" x1="0%" y1="0%" x2="0%" y2="100%">
${railShadowStops}
                    </linearGradient>
                    <pattern id="bac-rail-wood-grain" patternUnits="userSpaceOnUse" width="360" height="360" patternTransform="rotate(9)">
                        <image href="${railTexturePath}" x="0" y="0" width="360" height="360" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <linearGradient id="bac-gold-trim" x1="0%" y1="0%" x2="100%" y2="100%">
${trimStops}
                    </linearGradient>
                    <radialGradient id="bac-felt-main" cx="50%" cy="44%" r="72%">
                        <stop offset="0%" stop-color="#2dae6b"/>
                        <stop offset="34%" stop-color="#1b8450"/>
                        <stop offset="70%" stop-color="#0f4d2f"/>
                        <stop offset="100%" stop-color="#061d13"/>
                    </radialGradient>
                    <pattern id="bac-felt-fabric" patternUnits="userSpaceOnUse" width="420" height="420">
                        <image href="${feltTexturePath}" x="0" y="0" width="420" height="420" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <radialGradient id="bac-felt-sheen" cx="50%" cy="20%" r="64%">
                        <stop offset="0%" stop-color="rgba(255,246,216,0.24)"/>
                        <stop offset="42%" stop-color="rgba(255,246,216,0.08)"/>
                        <stop offset="100%" stop-color="rgba(255,246,216,0)"/>
                    </radialGradient>
                    <radialGradient id="bac-center-glow" cx="50%" cy="50%" r="66%">
                        <stop offset="0%" stop-color="rgba(255,236,184,0.22)"/>
                        <stop offset="55%" stop-color="rgba(255,236,184,0.06)"/>
                        <stop offset="100%" stop-color="rgba(255,236,184,0)"/>
                    </radialGradient>
                    <clipPath id="bac-rail-clip">
                        <rect x="114" y="78" width="1972" height="924" rx="462"/>
                    </clipPath>
                    <clipPath id="bac-felt-clip">
                        <rect x="242" y="172" width="1716" height="736" rx="368"/>
                    </clipPath>
                </defs>

                <rect x="124" y="116" width="1952" height="868" rx="434" fill="rgba(0,0,0,0.42)" filter="url(#bac-table-shadow)"/>

                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bac-rail-wood-grain)" stroke="${railStrokeColor}" stroke-width="10"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bac-rail-wood)" clip-path="url(#bac-rail-clip)"/>
                <rect x="114" y="78" width="1972" height="924" rx="462" fill="url(#bac-rail-shadow)" opacity="0.78" clip-path="url(#bac-rail-clip)"/>
                <rect x="140" y="104" width="1920" height="872" rx="436" fill="none" stroke="${railEdgeStroke}" stroke-width="2"/>
                <rect x="160" y="124" width="1880" height="832" rx="416" fill="none" stroke="url(#bac-gold-trim)" stroke-width="6"/>
                <rect x="182" y="146" width="1836" height="788" rx="394" fill="${railInnerFill}" stroke="${railInnerStroke}" stroke-width="2"/>

                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bac-felt-main)" stroke="${feltEdgeStroke}" stroke-width="4"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bac-felt-fabric)" opacity="0.16" clip-path="url(#bac-felt-clip)"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bac-felt-main)" opacity="0.05" filter="url(#bac-felt-noise)" clip-path="url(#bac-felt-clip)"/>
                <rect x="242" y="172" width="1716" height="736" rx="368" fill="url(#bac-felt-sheen)" clip-path="url(#bac-felt-clip)"/>
                <rect x="270" y="200" width="1660" height="680" rx="340" fill="none" stroke="rgba(255,237,189,0.07)" stroke-width="2"/>
                <ellipse cx="1100" cy="496" rx="468" ry="160" fill="url(#bac-center-glow)" opacity="0.18"/>
            </svg>
        `;
    }
}
