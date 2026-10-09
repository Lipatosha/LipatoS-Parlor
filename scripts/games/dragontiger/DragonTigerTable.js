/**
 * DragonTigerTable — 龙虎斗共享桌面
 *
 * 这层后续维护统一按 Foundry V14 兼容优先来收。
 * 先走和 21 点平行的一套，不跟旧窗口样式继续互相扯。
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
    buildDragonTigerHud,
    buildDragonTigerSeatEntries,
    buildDragonTigerStatus
} from './DragonTigerPresenterData.js';

const MAX_SIDE_SEATS = 5;
const MAX_VISIBLE_SEATS = MAX_SIDE_SEATS * 2;
const SIDE_INFO = {
    dragon: { labelKey: 'PARLOR.DragonTiger.Side.Dragon' },
    tiger: { labelKey: 'PARLOR.DragonTiger.Side.Tiger' },
    tie: { labelKey: 'PARLOR.DragonTiger.Side.Tie' }
};

export class DragonTigerTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._handHUD = new CardHandHUD();
        this._dismissedByUser = false;
        this._prevPhase = '';
        this._renderedDragonKey = '';
        this._renderedTigerKey = '';
        this._cardsRevealed = false;
        this._settlementShown = false;
        this._selectedParticipantId = '';
        this._betDraftAmount = 10;
        this._pendingBetParticipants = new Set();
        this._viewportFit = null;
        this._resultFxRound = null;
        this._playedLocalResultFxKeys = new Set();
        this._onKeyDown = (event) => {
            // V14 兼容优先：Esc 在 Foundry 里很常用，这里别顺手关桌面。
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
        const PresenterClass = PresenterRegistry.resolve(themeId, 'table:dragontiger');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'table:dragontiger')) {
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
        document.querySelectorAll('#parlor-dt-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-dt-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-dt-layout'
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
            document.querySelectorAll('#parlor-dt-settlement').forEach(node => node.remove());
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
        document.querySelectorAll('#parlor-dt-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-dt-overlay').forEach(node => node.remove());
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
            document.querySelector('#parlor-dt-settlement')?.remove();
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
            surface: 'table:dragontiger',
            hostId: 'parlor-dt-presenter',
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
            getSeats: () => buildDragonTigerSeatEntries(getState(), this._getPresenterDataHelpers()),
            getStatus: () => buildDragonTigerStatus(getState(), this._getPresenterDataHelpers()),
            getHud: () => buildDragonTigerHud(getState(), this._getPresenterDataHelpers()),
            // 龙虎玩家不持私牌
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

    // 动作路由:GM 推进走 GM_ACTION,玩家下注走 PLAYER_ACTION(payload 形状照原生)
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });

        const gmActions = new Set(['deal', 'settle', 'newRound', 'finishGame']);
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
                this._renderedDragonKey = '';
                this._renderedTigerKey = '';
                this._cardsRevealed = false;
                this._settlementShown = false;
                LocalResultFx.clear(this._overlay);
                document.querySelector('#parlor-dt-settlement')?.remove();
            }
            this._prevPhase = state.phase;
        }

        this._safeRefreshSection('battle', () => this._renderBattle(state));
        this._safeRefreshSection('seats', () => this._renderSeats(state));
        this._safeRefreshSection('handHUD', () => this._renderHandHUD(state), () => this._renderHandHUDFallback(state));
        this._maybePlayLocalResultFx(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-dt-settlement')?.remove();
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
            console.error(`parlor | Dragon Tiger table render failed in ${section}:`, error);
            fallback?.();
        }
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-dt-overlay';
        overlay.dataset.dtStyle = 'v14';
        overlay.innerHTML = `
            <div class="parlor-dt-backdrop"></div>
            <div class="parlor-dt-layout">
                <div class="parlor-seat-column seat-column-left" id="dt-seat-left"></div>
                <div class="parlor-dt-scene">
                    <div class="parlor-dt-table">
                        ${this._buildTableArt()}
                        <div class="parlor-dt-stage">
                            <div class="parlor-dt-game-badge"><i class="fas fa-dragon"></i> ${this._t('PARLOR.Games.DragonTiger.Name')}</div>
                            <div class="parlor-dt-board">
                                <div class="parlor-dt-lanes">
                                    <section class="parlor-dt-lane lane-dragon" id="dt-lane-dragon">
                                        <div class="parlor-dt-lane-head">
                                            <div class="parlor-dt-lane-mark">${this._sideLabel('dragon')}</div>
                                            <div class="parlor-dt-lane-pot" id="dt-pot-dragon">0 GP</div>
                                        </div>
                                        <div class="parlor-dt-card-slot-wrap">
                                            <div class="parlor-dt-card-slot" id="dt-card-dragon"></div>
                                        </div>
                                        <div class="parlor-dt-lane-odds">1 : 1</div>
                                    </section>
                                    <section class="parlor-dt-lane lane-tie" id="dt-lane-tie">
                                        <div class="parlor-dt-lane-head compact">
                                            <div class="parlor-dt-lane-mark">${this._sideLabel('tie')}</div>
                                            <div class="parlor-dt-lane-pot" id="dt-pot-tie">0 GP</div>
                                        </div>
                                        <div class="parlor-dt-lane-note">${this._t('PARLOR.DragonTiger.Table.TieOdds')}</div>
                                        <div class="parlor-dt-lane-note muted">${this._t('PARLOR.DragonTiger.Table.TieRefund')}</div>
                                    </section>
                                    <section class="parlor-dt-lane lane-tiger" id="dt-lane-tiger">
                                        <div class="parlor-dt-lane-head">
                                            <div class="parlor-dt-lane-mark">${this._sideLabel('tiger')}</div>
                                            <div class="parlor-dt-lane-pot" id="dt-pot-tiger">0 GP</div>
                                        </div>
                                        <div class="parlor-dt-card-slot-wrap">
                                            <div class="parlor-dt-card-slot" id="dt-card-tiger"></div>
                                        </div>
                                        <div class="parlor-dt-lane-odds">1 : 1</div>
                                    </section>
                                </div>
                                <div class="parlor-dt-center" id="dt-center"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="parlor-seat-column seat-column-right" id="dt-seat-right"></div>
            </div>
            <button class="parlor-dt-close-btn"><i class="fas fa-times"></i></button>
        `;

        overlay.querySelector('.parlor-dt-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        overlay.querySelector('.parlor-dt-close-btn')?.addEventListener('click', () => {
            this._requestParlorClose?.() ?? this.close();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderBattle(state) {
        const sideTotals = this._getSideTotals(state);
        const revealPhase = ['SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase);

        this._overlay.querySelector('#dt-pot-dragon').textContent = `${sideTotals.dragon} GP`;
        this._overlay.querySelector('#dt-pot-tiger').textContent = `${sideTotals.tiger} GP`;
        this._overlay.querySelector('#dt-pot-tie').textContent = `${sideTotals.tie} GP`;

        ['dragon', 'tie', 'tiger'].forEach(side => {
            const lane = this._overlay.querySelector(`#dt-lane-${side}`);
            lane?.classList.toggle('is-winner', revealPhase && state.winner === side);
            lane?.classList.toggle('is-dimmed', revealPhase && state.winner && state.winner !== side);
        });

        const dragonFresh = this._renderCardSlot('#dt-card-dragon', state.dragonCard, this._renderedDragonKey, { x: -260, y: -240 }, state.phase);
        this._renderedDragonKey = state.dragonCard ? `${state.dragonCard.suit}-${state.dragonCard.rank}` : '';

        const tigerFresh = this._renderCardSlot('#dt-card-tiger', state.tigerCard, this._renderedTigerKey, { x: 260, y: -240 }, state.phase);
        this._renderedTigerKey = state.tigerCard ? `${state.tigerCard.suit}-${state.tigerCard.rank}` : '';

        if (revealPhase && !this._cardsRevealed) {
            const flipDelay = state.phase === 'SHOWDOWN' && (dragonFresh || tigerFresh) ? 680 : 0;
            setTimeout(() => {
                if (!this._overlay) return;
                this._overlay.querySelectorAll('.parlor-dt-card-slot .parlor-playing-card').forEach(cardEl => {
                    CardRenderer.flip(cardEl, false, 420);
                });
            }, flipDelay);
            this._cardsRevealed = true;
        }
    }

    _renderCardSlot(slotId, card, renderedKey, from, phase) {
        const slot = this._overlay.querySelector(slotId);
        if (!slot) return false;

        if (!card) {
            slot.innerHTML = '';
            return false;
        }

        const nextKey = `${card.suit}-${card.rank}`;
        if (renderedKey === nextKey) return false;

        slot.innerHTML = '';
        const cardEl = CardRenderer.createCard(card, { faceDown: true, size: 'table' });
        slot.appendChild(cardEl);
        CardRenderer.dealFrom(cardEl, from, 0, {
            duration: 620,
            startScale: 0.68,
            settleScale: 1
        });

        return true;
    }

    _renderCenter(state) {
        const center = this._overlay.querySelector('#dt-center');
        if (!center) return;

        const isGM = game.user.isGM;
        const myId = this._getSelectedParticipantId(state);
        const myBet = this._getBetForUser(state, myId);
        const activePlayers = this._getActivePlayerIds(state);
        const controlledIds = this._getControlledParticipantIds(state);
        const bettedIds = new Set((state.bets || []).map(bet => bet.userId).filter(uid => activePlayers.includes(uid)));
        const bettedCount = bettedIds.size;
        const controlledBetCount = controlledIds.filter(uid => bettedIds.has(uid)).length;
        const sideTotals = this._getSideTotals(state);
        const totalPot = sideTotals.dragon + sideTotals.tiger + sideTotals.tie;
        const selectedName = myId ? this._playerName(state, myId) : this._t('PARLOR.Common.CurrentRole');
        const selectedBalance = myId ? ChipManager.getDisplayBalance(myId) : null;

        let panel = null;
        let controlsHtml = '';

        if (state.phase === 'BETTING') {
            controlsHtml = controlledIds.length
                ? this._buildCenterBetControls(state, { myId, controlledIds, myBet })
                : '';
            panel = {
                tone: myBet ? 'active' : 'betting',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Betting'),
                title: myBet
                    ? this._t('PARLOR.DragonTiger.Center.BettingTitlePlaced', { name: selectedName, side: this._sideLabel(myBet.side) })
                    : this._t('PARLOR.DragonTiger.Center.BettingTitleIdle'),
                sub: myBet
                    ? this._t('PARLOR.DragonTiger.Center.BettingSubPlaced', { name: selectedName, side: this._sideLabel(myBet.side), amount: myBet.amount })
                    : this._t('PARLOR.DragonTiger.Center.BettingSubIdle'),
                note: !controlledIds.length
                    ? this._t('PARLOR.Common.NoControlledParticipant')
                    : (controlledIds.length > 1
                    ? this._t('PARLOR.DragonTiger.Footer.MultiControl', { count: controlledIds.length, done: controlledBetCount })
                    : (isGM ? this._t('PARLOR.DragonTiger.Center.BettingNoteGM') : this._t('PARLOR.DragonTiger.Center.BettingNotePlayer'))),
                stats: [
                    { label: this._t('PARLOR.Common.TableProgress'), value: `${bettedCount} / ${activePlayers.length}` },
                    { label: controlledIds.length ? this._t('PARLOR.Common.YourRole') : this._t('PARLOR.DragonTiger.Center.CurrentIdentity'), value: controlledIds.length ? `${controlledBetCount} / ${controlledIds.length}` : this._t('PARLOR.Common.Spectating') },
                    { label: this._t('PARLOR.Common.TablePot'), value: `${totalPot} GP` },
                    ...(selectedBalance == null ? [] : [{ label: this._t('PARLOR.Common.AvailableChips'), value: Number.isFinite(selectedBalance) ? `${selectedBalance}` : this._t('PARLOR.Common.Infinity') }])
                ]
            };
        } else if (state.phase === 'READY') {
            panel = {
                tone: 'ready',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Ready'),
                title: isGM ? this._t('PARLOR.DragonTiger.Center.ReadyTitleGM') : this._t('PARLOR.DragonTiger.Center.ReadyTitlePlayer'),
                sub: this._t('PARLOR.DragonTiger.Center.ReadySub'),
                note: isGM ? this._t('PARLOR.DragonTiger.Center.ReadyNoteGM') : this._t('PARLOR.DragonTiger.Center.ReadyNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.DragonTiger.Stat.DragonPot'), value: `${sideTotals.dragon} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TiePot'), value: `${sideTotals.tie} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TigerPot'), value: `${sideTotals.tiger} GP` }
                ]
            };
        } else if (state.phase === 'DEALING') {
            panel = {
                tone: 'dealing',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Dealing'),
                title: this._t('PARLOR.DragonTiger.Center.DealingTitle'),
                sub: this._t('PARLOR.DragonTiger.Center.DealingSub'),
                note: this._t('PARLOR.DragonTiger.Center.DealingNote'),
                stats: [
                    { label: this._t('PARLOR.Common.TablePot'), value: `${totalPot} GP` },
                    { label: this._t('PARLOR.Common.RoundPlayers'), value: `${activePlayers.length}` }
                ]
            };
        } else if (state.phase === 'SHOWDOWN') {
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Showdown'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: this._t('PARLOR.DragonTiger.Center.ShowdownSub'),
                note: this._t('PARLOR.DragonTiger.Center.ShowdownNote'),
                stats: [
                    { label: this._t('PARLOR.DragonTiger.Stat.DragonPot'), value: `${sideTotals.dragon} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TiePot'), value: `${sideTotals.tie} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TigerPot'), value: `${sideTotals.tiger} GP` }
                ]
            };
        } else if (state.phase === 'SETTLE') {
            const myDelta = myBet ? this._getDelta(state, myId) : 0;
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Settle'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: myBet ? this._t('PARLOR.DragonTiger.Center.SettleSubPlayer', { name: selectedName, result: this._formatDelta(myDelta) }) : this._t('PARLOR.Common.ResultOnSeat'),
                note: isGM ? this._t('PARLOR.DragonTiger.Center.SettleNoteGM') : this._t('PARLOR.DragonTiger.Center.SettleNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.DragonTiger.Stat.DragonPot'), value: `${sideTotals.dragon} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TiePot'), value: `${sideTotals.tie} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TigerPot'), value: `${sideTotals.tiger} GP` }
                ]
            };
        } else if (state.phase === 'RESOLVING') {
            const myDelta = myBet ? this._getDelta(state, myId) : 0;
            panel = {
                tone: 'result',
                phaseLabel: this._t('PARLOR.DragonTiger.Center.Phase.Resolving'),
                title: this._t('PARLOR.Common.WinnerIs', { winner: this._sideLabel(state.winner) }),
                sub: myBet ? this._t('PARLOR.DragonTiger.Center.ResolvingSubPlayer', { name: selectedName, result: this._formatDelta(myDelta) }) : this._t('PARLOR.Common.SettlementOpen'),
                note: isGM ? this._t('PARLOR.DragonTiger.Center.ResolvingNoteGM') : this._t('PARLOR.DragonTiger.Center.ResolvingNotePlayer'),
                stats: [
                    { label: this._t('PARLOR.DragonTiger.Stat.DragonPot'), value: `${sideTotals.dragon} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TiePot'), value: `${sideTotals.tie} GP` },
                    { label: this._t('PARLOR.DragonTiger.Stat.TigerPot'), value: `${sideTotals.tiger} GP` }
                ]
            };
        }

        center.innerHTML = panel ? this._buildCenterPanel(state, panel, controlsHtml) : '';
        if (state.phase === 'BETTING') {
            this._bindCenterBetControls(state, { myId });
        }
    }

    _renderSeats(state) {
        const leftColumn = this._overlay.querySelector('#dt-seat-left');
        const rightColumn = this._overlay.querySelector('#dt-seat-right');
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
                statusText = this._t('PARLOR.DragonTiger.Seat.StatusPlaced', { side: sideLabel });
                statusClass = 'status-live';
            } else if (bet && ['READY', 'DEALING'].includes(state.phase)) {
                statusText = this._t('PARLOR.DragonTiger.Seat.StatusReady', { side: sideLabel });
                statusClass = 'status-live';
            } else if (bet && state.phase === 'SHOWDOWN') {
                statusText = this._formatDelta(delta);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            } else if (bet && state.phase === 'SETTLE') {
                statusText = this._formatDelta(delta);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            } else if (bet && state.phase === 'RESOLVING') {
                statusText = this._formatResult(state, uid);
                statusClass = delta > 0 ? 'status-win' : (delta < 0 ? 'status-lose' : 'status-push');
            }

            const seat = document.createElement('div');
            seat.className = `parlor-seat-card seat-${zone}${isMe ? ' is-me' : ''}${bet ? ' has-bet' : ''}${['SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase) && bet ? ' has-result' : ''}`;
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
                            ? `<div class="parlor-seat-bet">${bet.amount} GP</div><div class="parlor-seat-side side-${bet.side}">${sideLabel}</div>`
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
        const isGM = game.user.isGM;
        const controlledIds = this._getControlledParticipantIds(state);
        const isPlayer = !!myId && controlledIds.includes(myId);
        const myBet = this._getBetForUser(state, myId);
        const activePlayers = this._getActivePlayerIds(state);
        const sideTotals = this._getSideTotals(state);
        const totalPot = sideTotals.dragon + sideTotals.tiger + sideTotals.tie;
        const actions = [];
        let footer = '';

        if (state.phase === 'BETTING') {
            footer = this._buildBettingFooter(state, { myId, controlledIds, isPlayer, myBet });
        } else if (state.phase === 'READY') {
            if (isGM) {
                actions.push({
                    label: this._t('PARLOR.DragonTiger.Action.DealByDM'),
                    accent: true,
                    icon: 'fas fa-play',
                    callback: () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                        sessionId: this.sessionId,
                        action: 'deal'
                    })
                });
            }
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
        }

        if (!actions.length && !footer) {
            this._handHUD.destroy();
            return;
        }

        if (!this._handHUD.root) this._handHUD.show([]);
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
        if (!controlledIds.length) return '';

        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => (state.playerIds || []).includes(entry.id));
        const balanceLabel = myId ? ChipManager.getDisplayBalance(myId) : '0';
        const amount = Math.max(1, Number(myBet?.amount || this._betDraftAmount || 10));
        const controlledBetCount = controlledIds.filter(uid => this._getBetForUser(state, uid)).length;
        const activePlayers = this._getActivePlayerIds(state);
        const bettedCount = (state.bets || []).filter(bet => activePlayers.includes(bet.userId)).length;
        const sideTotals = this._getSideTotals(state);
        const totalPot = sideTotals.dragon + sideTotals.tiger + sideTotals.tie;
        const selectedParticipant = controlledParticipants.find(entry => entry.id === myId) || null;
        const betDisabledAttr = myId && this._pendingBetParticipants.has(myId) ? 'disabled' : '';
        const selectHtml = controlledParticipants.length > 1
            ? `
                <select id="dt-hud-participant-select" class="parlor-hud-footer-input" style="width:190px;">
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
                <div class="parlor-dt-hud-betbox">
                    <input type="number" id="dt-hud-bet-input" value="${amount}" min="1" class="parlor-hud-footer-input" placeholder="GP">
                    <div class="parlor-dt-hud-bet-actions">
                        <button class="parlor-hud-action-btn" data-dt-bet-side="dragon" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetDragon')}</button>
                        <button class="parlor-hud-action-btn" data-dt-bet-side="tiger" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTiger')}</button>
                        <button class="parlor-hud-action-btn accent" data-dt-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTie')}</button>
                    </div>
                </div>
            `;
        } else if (!controlledIds.length) {
            sub = this._t('PARLOR.Common.NoControlledParticipant');
        }

        return `
            <div class="parlor-hud-footer-main parlor-dt-hud-shell">
                <div class="parlor-hud-footer-side parlor-dt-hud-side">
                    <div class="parlor-dt-hud-context">
                        <span class="parlor-hud-footer-label">${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml || `<span class="parlor-dt-hud-name">${participantLabel}</span>`}
                    </div>
                    <div class="parlor-dt-hud-meta">
                        <span class="parlor-hud-footer-pill">${Number.isFinite(balanceLabel) ? `${balanceLabel} ${this._t('PARLOR.Common.Chips')}` : this._t('PARLOR.Common.ChipsInfinity')}</span>
                        <span class="parlor-hud-footer-pill ${myBet ? '' : 'muted'}">${myBet ? this._t('PARLOR.DragonTiger.Seat.StatusPlaced', { side: this._sideLabel(myBet.side) }) : this._t('PARLOR.DragonTiger.Footer.NotBetYet')}</span>
                    </div>
                </div>
                <div class="parlor-hud-footer-center parlor-dt-hud-center">
                    ${this._buildHudMetrics([
                        this._t('PARLOR.Common.RoundCounter', { round: state.round }),
                        `${this._t('PARLOR.Common.TableProgress')} ${bettedCount} / ${activePlayers.length}`,
                        `${this._t('PARLOR.Common.TablePot')} ${totalPot} GP`
                    ])}
                </div>
                <div class="parlor-hud-footer-side align-right parlor-dt-hud-side right">
                    ${rightHtml}
                </div>
            </div>
        `;
    }

    _bindHudFooter(state, { myId }) {
        const root = this._handHUD.root;
        if (!root) return;

        root.querySelector('#dt-hud-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const selectedBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAmount = Math.max(1, Number(selectedBet?.amount || this._betDraftAmount || 10));
            this.refresh();
        });

        root.querySelector('#dt-hud-bet-input')?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        root.querySelectorAll('[data-dt-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const participantId = root.querySelector('#dt-hud-participant-select')?.value || myId || this._selectedParticipantId;
                this._submitBet(button.dataset.dtBetSide, participantId, null, event.currentTarget);
            });
        });
    }

    async _submitBet(side, preferredParticipantId = null, amountOverride = null, triggerButton = null) {
        const safeSide = SIDE_INFO[side] ? side : 'dragon';
        const state = this.gameInstance.getState();
        const controlledIds = this._getControlledParticipantIds(state);
        const participantId = controlledIds.includes(preferredParticipantId)
            ? preferredParticipantId
            : this._getSelectedParticipantId(state);
        const hudAmountInput = this._handHUD.root?.querySelector('#dt-hud-bet-input');
        const centerAmountInput = this._overlay?.querySelector('#dt-center-bet-input');
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
            console.error('parlor | Dragon Tiger bet failed:', err);
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
                ui.notifications.warn(this._t('PARLOR.DragonTiger.Error.InvalidSide'));
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
        document.querySelector('#parlor-dt-settlement')?.remove();

        const popup = document.createElement('div');
        popup.id = 'parlor-dt-settlement';
        popup.className = 'parlor-dt-settlement-overlay';
        popup.dataset.dtStyle = 'v14';
        this._presenterHost?.markDetachedSurface(popup, 'settlement');

        const rows = this._getActivePlayerIds(state).map(uid => {
            const bet = this._getBetForUser(state, uid);
            const payout = Number(state.payouts?.[uid] || 0);
            return `
                <tr>
                    <td>${this._playerName(state, uid)}</td>
                    <td>${bet ? `${this._sideLabel(bet.side)} · ${bet.amount} GP` : '—'}</td>
                    <td>${this._formatResult(state, uid)}</td>
                    <td>${payout} GP</td>
                    <td>${this._formatDelta(this._getDelta(state, uid))}</td>
                </tr>
            `;
        }).join('');

        popup.innerHTML = `
            <div class="parlor-dt-settlement-box">
                <div class="settlement-title">${this._t('PARLOR.DragonTiger.Settlement.Title', { winner: this._sideLabel(state.winner) })}</div>
                <table class="settlement-table">
                    <thead><tr><th>${this._t('PARLOR.Common.Player')}</th><th>${this._t('PARLOR.Common.Bet')}</th><th>${this._t('PARLOR.DragonTiger.Settlement.Result')}</th><th>${this._t('PARLOR.DragonTiger.Settlement.Payout')}</th><th>${this._t('PARLOR.DragonTiger.Settlement.Net')}</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                <div class="parlor-prompt-actions" style="margin-top:16px;">
                    ${game.user.isGM
                        ? `
                            <button class="parlor-hud-action-btn" id="dt-finish-game"><i class="fas fa-door-closed"></i> ${this._t('PARLOR.Common.Finish')}</button>
                            <button class="parlor-hud-action-btn accent" id="dt-next-round"><i class="fas fa-redo"></i> ${this._t('PARLOR.Common.NextRound')}</button>
                        `
                        : `<button class="parlor-hud-action-btn" id="dt-dismiss-settlement"><i class="fas fa-times"></i> ${this._t('PARLOR.Common.CloseResult')}</button>`
                    }
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        popup.querySelector('#dt-dismiss-settlement')?.addEventListener('click', () => popup.remove());
        popup.querySelector('#dt-finish-game')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#dt-next-round')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'finishGame' });
        });
        popup.querySelector('#dt-next-round')?.addEventListener('click', (event) => {
            event.currentTarget.disabled = true;
            popup.querySelector('#dt-finish-game')?.setAttribute('disabled', 'disabled');
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action: 'newRound' });
        });
    }

    _buildFooter(title, sub, { metrics = [] } = {}) {
        return `
            <div class="parlor-hand-hud-footer-main parlor-dt-hud-summary">
                <div class="parlor-hand-hud-footer-title">${title}</div>
                <div class="parlor-hand-hud-footer-sub">${sub}</div>
                ${this._buildHudMetrics(metrics)}
            </div>
        `;
    }

    _buildHudMetrics(items = []) {
        const safeItems = items.filter(Boolean);
        if (!safeItems.length) return '';

        return `
            <div class="parlor-dt-hud-metrics">
                ${safeItems.map(text => `<span class="parlor-hud-footer-pill">${text}</span>`).join('')}
            </div>
        `;
    }

    _renderCenterFallback(state) {
        const center = this._overlay?.querySelector('#dt-center');
        if (!center) return;

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
            case 'BETTING': return this._t('PARLOR.DragonTiger.Center.Phase.Betting');
            case 'READY': return this._t('PARLOR.DragonTiger.Center.Phase.Ready');
            case 'DEALING': return this._t('PARLOR.DragonTiger.Center.Phase.Dealing');
            case 'SHOWDOWN': return this._t('PARLOR.DragonTiger.Center.Phase.Showdown');
            case 'SETTLE': return this._t('PARLOR.DragonTiger.Center.Phase.Settle');
            case 'RESOLVING': return this._t('PARLOR.DragonTiger.Center.Phase.Resolving');
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
                <select id="dt-center-participant-select" class="parlor-dt-center-select">
                    ${controlledParticipants.map(entry => `
                        <option value="${entry.id}" ${entry.id === myId ? 'selected' : ''}>${getParticipantLabel(entry)}</option>
                    `).join('')}
                </select>
            `
            : `<div class="parlor-dt-center-static">${selectedParticipant ? getParticipantLabel(selectedParticipant) : this._t('PARLOR.Common.CurrentParticipant')}</div>`;

        return `
            <div class="parlor-dt-prompt-controls">
                <div class="parlor-dt-center-betbox">
                    <label class="parlor-dt-center-field">
                        <span>${controlledParticipants.length > 1 ? this._t('PARLOR.Common.CurrentBetRole') : this._t('PARLOR.Common.CurrentParticipant')}</span>
                        ${selectHtml}
                    </label>
                    <label class="parlor-dt-center-field amount-field">
                        <span>${this._t('PARLOR.Common.Amount')}</span>
                        <input type="number" id="dt-center-bet-input" value="${amount}" min="1" class="parlor-dt-center-input" placeholder="GP">
                    </label>
                </div>
                <div class="parlor-dt-center-bet-actions">
                    <button class="parlor-hud-action-btn" data-dt-center-bet-side="dragon" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetDragon')}</button>
                    <button class="parlor-hud-action-btn" data-dt-center-bet-side="tiger" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTiger')}</button>
                    <button class="parlor-hud-action-btn accent" data-dt-center-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTie')}</button>
                </div>
            </div>
        `;
    }

    _bindCenterBetControls(state, { myId }) {
        const center = this._overlay?.querySelector('#dt-center');
        if (!center) return;

        center.querySelector('#dt-center-participant-select')?.addEventListener('change', (event) => {
            this._selectedParticipantId = event.currentTarget.value || '';
            const selectedBet = this._getBetForUser(state, this._selectedParticipantId);
            this._betDraftAmount = Math.max(1, Number(selectedBet?.amount || this._betDraftAmount || 10));
            this.refresh();
        });

        center.querySelector('#dt-center-bet-input')?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        center.querySelectorAll('[data-dt-center-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const participantId = center.querySelector('#dt-center-participant-select')?.value || myId || this._selectedParticipantId;
                const amount = center.querySelector('#dt-center-bet-input')?.value || this._betDraftAmount;
                this._submitBet(button.dataset.dtCenterBetSide, participantId, amount, event.currentTarget);
            });
        });
    }

    _buildSeatBetControls(uid, bet) {
        const amount = Math.max(1, Number(bet?.amount || this._betDraftAmount || 10));
        const betDisabledAttr = this._pendingBetParticipants.has(uid) ? 'disabled' : '';
        return `
            <div class="parlor-dt-seat-betbox" data-seat-bet-owner="${uid}">
                <input type="number" class="parlor-dt-seat-bet-input" value="${amount}" min="1" placeholder="GP">
                <div class="parlor-dt-seat-bet-actions">
                    <button class="parlor-hud-action-btn" data-dt-seat-bet-side="dragon" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetDragon')}</button>
                    <button class="parlor-hud-action-btn" data-dt-seat-bet-side="tiger" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTiger')}</button>
                    <button class="parlor-hud-action-btn accent" data-dt-seat-bet-side="tie" ${betDisabledAttr}>${this._t('PARLOR.DragonTiger.Action.BetTie')}</button>
                </div>
            </div>
        `;
    }

    _bindSeatBetControls(seat, uid) {
        const input = seat.querySelector('.parlor-dt-seat-bet-input');
        input?.addEventListener('change', (event) => {
            this._betDraftAmount = Math.max(1, parseInt(event.currentTarget.value, 10) || 10);
            event.currentTarget.value = String(this._betDraftAmount);
        });

        seat.querySelectorAll('[data-dt-seat-bet-side]').forEach(button => {
            button.addEventListener('click', (event) => {
                const amount = input?.value || this._betDraftAmount;
                this._selectedParticipantId = uid;
                this._submitBet(button.dataset.dtSeatBetSide, uid, amount, event.currentTarget);
            });
        });
    }

    _buildCenterPanel(state, { phaseLabel, title, sub = '', note = '', stats = [], tone = '' }, controlsHtml = '') {
        const statsHtml = stats
            .filter(entry => entry?.label && entry?.value != null && entry.value !== '')
            .map(entry => `
                <div class="parlor-dt-prompt-stat">
                    <div class="parlor-dt-prompt-stat-label">${entry.label}</div>
                    <div class="parlor-dt-prompt-stat-value">${entry.value}</div>
                </div>
            `)
            .join('');

        return `
            <div class="parlor-dt-prompt ${tone ? `tone-${tone}` : ''}">
                <div class="parlor-dt-prompt-head">
                    <div class="parlor-dt-prompt-phase">${phaseLabel}</div>
                    <div class="parlor-dt-prompt-round">${this._t('PARLOR.Common.RoundCounter', { round: state.round })}</div>
                </div>
                <div class="parlor-dt-prompt-title">${title}</div>
                ${statsHtml ? `<div class="parlor-dt-prompt-stats">${statsHtml}</div>` : ''}
                ${controlsHtml}
            </div>
        `;
    }

    _getSideTotals(state) {
        const sideTotals = { dragon: 0, tiger: 0, tie: 0 };
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
        return Number(state.payouts?.[userId] || 0) - Number(bet.amount || 0);
    }

    _formatResult(state, userId) {
        const bet = this._getBetForUser(state, userId);
        if (!bet) return this._t('PARLOR.Common.NoBet');

        const delta = this._getDelta(state, userId);
        if (delta > 0) return this._t('PARLOR.DragonTiger.Result.Win', { side: this._sideLabel(bet.side) });
        if (delta < 0 && state.winner === 'tie' && ['dragon', 'tiger'].includes(bet.side)) return this._t('PARLOR.DragonTiger.Result.TieRefund', { side: this._sideLabel(bet.side) });
        if (delta < 0) return this._t('PARLOR.DragonTiger.Result.Lose', { side: this._sideLabel(bet.side) });
        return this._t('PARLOR.DragonTiger.Result.Push', { side: this._sideLabel(bet.side) });
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
        if (value > 0) return `+${value} GP`;
        if (value < 0) return `${value} GP`;
        return '0 GP';
    }

    _formatDelta(delta) {
        const value = Number(delta || 0);
        if (value > 0) return `+${value} GP`;
        if (value < 0) return `${value} GP`;
        return '0 GP';
    }

    _sideLabel(side) {
        const key = SIDE_INFO[side]?.labelKey;
        return key ? this._t(key) : this._t('PARLOR.Common.Unknown');
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
        this._renderedDragonKey = '';
        this._renderedTigerKey = '';
        this._cardsRevealed = false;
        this._settlementShown = false;
        this._pendingBetParticipants.clear();
        this._resultFxRound = null;
        this._playedLocalResultFxKeys.clear();
    }

    _buildTableArt() {
        // V14 兼容优先：桌面贴图按当前样式设置取，保存后整桌会重建一次。
        const { feltTexturePath, railTexturePath, railKind } = ParlorAppearance.getTableTexturePaths();
        const isMetal = railKind === 'metal';
        const railGlossStops = isMetal
            ? `
                        <stop offset="0%" stop-color="#f4f8fc" stop-opacity="0.16"/>
                        <stop offset="42%" stop-color="#d3dde7" stop-opacity="0.06"/>
                        <stop offset="100%" stop-color="#06090d" stop-opacity="0.28"/>
            `
            : `
                        <stop offset="0%" stop-color="#ffeebf" stop-opacity="0.22"/>
                        <stop offset="42%" stop-color="#ffdc90" stop-opacity="0.06"/>
                        <stop offset="100%" stop-color="#240c00" stop-opacity="0.24"/>
            `;
        const outerStroke = isMetal ? 'rgba(60,71,84,0.42)' : 'rgba(83,36,11,0.42)';
        const midStroke = isMetal ? 'rgba(234,241,247,0.28)' : 'rgba(255,231,176,0.34)';
        const innerStroke = isMetal ? 'rgba(238,245,251,0.14)' : 'rgba(255,236,196,0.16)';
        const feltStroke = isMetal ? 'rgba(229,238,247,0.18)' : 'rgba(255,232,182,0.18)';
        const lineStroke = isMetal ? 'rgba(223,233,243,0.08)' : 'rgba(255,230,176,0.1)';
        const lineStrokeSoft = isMetal ? 'rgba(223,233,243,0.05)' : 'rgba(255,230,176,0.06)';
        const lineStrokeFaint = isMetal ? 'rgba(223,233,243,0.04)' : 'rgba(255,230,176,0.05)';

        return `
            <svg class="parlor-dt-table-svg" viewBox="0 0 2000 1120" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
                <defs>
                    <clipPath id="dt-outer-clip"><rect x="104" y="98" width="1792" height="924" rx="462" ry="462"/></clipPath>
                    <clipPath id="dt-inner-clip"><rect x="218" y="194" width="1564" height="732" rx="366" ry="366"/></clipPath>
                    <linearGradient id="dt-felt-base" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stop-color="#19452f"/>
                        <stop offset="52%" stop-color="#123725"/>
                        <stop offset="100%" stop-color="#0c2419"/>
                    </linearGradient>
                    <radialGradient id="dt-felt-glow" cx="50%" cy="44%" r="60%">
                        <stop offset="0%" stop-color="#f8eab4" stop-opacity="0.18"/>
                        <stop offset="58%" stop-color="#f8eab4" stop-opacity="0.04"/>
                        <stop offset="100%" stop-color="#f8eab4" stop-opacity="0"/>
                    </radialGradient>
                    <linearGradient id="dt-rail-gloss" x1="0%" y1="0%" x2="0%" y2="100%">
${railGlossStops}
                    </linearGradient>
                </defs>
                <g clip-path="url(#dt-outer-clip)">
                    <image href="${railTexturePath}" x="0" y="0" width="2000" height="1120" preserveAspectRatio="xMidYMid slice"/>
                    <rect x="104" y="98" width="1792" height="924" rx="462" ry="462" fill="url(#dt-rail-gloss)"/>
                </g>
                <rect x="116" y="110" width="1768" height="900" rx="450" ry="450" fill="none" stroke="${outerStroke}" stroke-width="26"/>
                <rect x="104" y="98" width="1792" height="924" rx="462" ry="462" fill="none" stroke="${midStroke}" stroke-width="8"/>
                <rect x="146" y="138" width="1708" height="844" rx="422" ry="422" fill="none" stroke="${innerStroke}" stroke-width="3"/>
                <g clip-path="url(#dt-inner-clip)">
                    <rect x="218" y="194" width="1564" height="732" rx="366" ry="366" fill="url(#dt-felt-base)"/>
                    <image href="${feltTexturePath}" x="160" y="150" width="1680" height="820" preserveAspectRatio="xMidYMid slice" opacity="0.16"/>
                    <rect x="218" y="194" width="1564" height="732" rx="366" ry="366" fill="rgba(8,31,21,0.2)"/>
                    <ellipse cx="1000" cy="566" rx="612" ry="250" fill="url(#dt-felt-glow)"/>
                </g>
                <rect x="218" y="194" width="1564" height="732" rx="366" ry="366" fill="none" stroke="${feltStroke}" stroke-width="5"/>
                <path d="M430 744 Q1000 842 1570 744" fill="none" stroke="${lineStroke}" stroke-width="4" stroke-linecap="round"/>
                <path d="M504 770 Q1000 842 1496 770" fill="none" stroke="${lineStrokeSoft}" stroke-width="2" stroke-linecap="round"/>
                <path d="M560 286 Q1000 210 1440 286" fill="none" stroke="${lineStrokeFaint}" stroke-width="2" stroke-linecap="round"/>
            </svg>
        `;
    }
}
