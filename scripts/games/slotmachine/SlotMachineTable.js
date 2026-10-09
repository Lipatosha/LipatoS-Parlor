import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { SettlementManager as ChipManager } from '../../core/SettlementManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { SlotMachineConfig } from '../../core/SlotMachineConfig.js';
import { OverlayViewportFit } from '../../ui/OverlayViewportFit.js';
import {
    getControlledParticipants,
    getDisplayParticipant,
    getParticipantName
} from '../../core/ParticipantRoster.js';
import {
    REEL_COLUMNS,
    REEL_ROWS,
    SLOT_BET_STEP,
    SLOT_RANDOM_SYMBOL_IDS,
    getSymbolPayouts,
    SLOT_SYMBOLS
} from './SlotMachineRules.js';
import { renderSlotSymbolSvg } from './SlotSymbols.js';

const ACTION_LOCK_MS = 420;
const REEL_SPIN_MS = [1180, 1520, 1860, 2200, 2540];
const PAYTABLE_SYMBOLS = ['wild', 'scatter', 'seven', 'bell', 'watermelon', 'orange', 'apple', 'strawberry', 'banana', 'plum', 'lemon', 'pear'];
const PAYOUT_SOUND_VOLUME = 0.72;
const SLOT_ACTION_SOUND_VOLUME = 0.66;
const SLOT_PAYOUT_SOUNDS = Object.freeze({
    small: 'modules/parlor/assets/slot/456965__funwithsound__short-success-sound-glockenspiel-treasure-video-game.mp3',
    win: 'modules/parlor/assets/slot/456966__funwithsound__success-fanfare-trumpets.mp3',
    big: 'modules/parlor/assets/slot/690264__datbloxybirb__victory-trumpet-and-french-horn-sound-effect.mp3'
});
const SLOT_ACTION_SOUNDS = Object.freeze({
    spin: 'modules/parlor/assets/slot/spinning.ogg',
    lever: 'modules/parlor/assets/slot/828131__mihacappy__lever.wav'
});

export class SlotMachineTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._dismissedByUser = false;
        this._prevPhase = '';
        this._spinAnimationKey = '';
        this._displayBoard = null;
        this._spinModel = null;
        this._spinStakeDraft = 0;
        this._leverPullRatio = 0;
        this._leverDragCleanup = null;
        this._actionRequests = new Map();
        this._viewportFit = null;
        this._playedPayoutSoundKey = '';
        this._playedSpinSoundKey = '';
    }

    get sessionId() { return this.gameInstance.sessionId; }

    render(force) {
        if (force) this._dismissedByUser = false;
        if (this._dismissedByUser) return;
        this.open();
    }

    open() {
        if (this._dismissedByUser) return;
        if (this._overlay) {
            this.refresh();
            return;
        }

        document.querySelectorAll('#parlor-slot-overlay').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-slot-shell'
        });
        this._viewportFit.attach();
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.querySelectorAll('#parlor-slot-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._cleanupLeverDrag();
        this._clearSpinAnimation();
        this._resetTracking();
    }

    refresh() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        const spinKey = `${state.spinId}:${state.round}`;

        if (state.phase !== this._prevPhase) {
            if (state.phase === 'READY' && this._prevPhase === 'SPINNING') {
                this._clearSpinAnimation();
                this._displayBoard = this._boardHasSymbols(state.board) ? state.board : this._displayBoard || this._createIdleBoard();
                this._spinAnimationKey = '';
                this._spinStakeDraft = this._sanitizeSpinStake(state.spinCost, state.spinCost);
                this._playPayoutSound(state);
            }
            this._prevPhase = state.phase;
        }

        if (!this._spinStakeDraft) {
            this._spinStakeDraft = this._sanitizeSpinStake(state.spinCost, state.spinCost);
        }

        if (!this._displayBoard) {
            this._displayBoard = this._boardHasSymbols(state.board) ? state.board : this._createIdleBoard();
        }

        if (state.phase === 'SPINNING' && state.spinId && this._spinAnimationKey !== spinKey) {
            this._startSpinAnimation(state);
            this._playSpinSound(state);
        } else if (state.phase !== 'SPINNING' && this._boardHasSymbols(state.board)) {
            this._displayBoard = state.board;
        }

        this._renderHeader(state);
        this._renderBoard(state);
        this._renderStatusBar(state);
        this._renderControls(state);
        this._renderPaytable(state);
        this._viewportFit?.update();
    }

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'parlor-slot-overlay';
        overlay.dataset.slotStyle = 'v16';
        overlay.innerHTML = `
            <div class="parlor-slot-backdrop"></div>
            <div class="parlor-slot-shell">
                <div class="parlor-slot-marquee-shell">
                    <div class="parlor-slot-bulb-strip top" aria-hidden="true"></div>
                    <div class="parlor-slot-brand-title">ROYAL REEL 777</div>
                    <div class="parlor-slot-marquee" id="slot-marquee"></div>
                </div>

                <div class="parlor-slot-cabinet">
                    <div class="parlor-slot-head" id="slot-head"></div>

                    <div class="parlor-slot-machine">
                        <div class="parlor-slot-reels-shell">
                            <div class="parlor-slot-glass-head">
                                <div class="parlor-slot-glass-title">MECHANICAL REELS</div>
                            </div>

                            <div class="parlor-slot-board-wrap">
                                <div class="parlor-slot-centerline" aria-hidden="true"></div>
                                <div class="parlor-slot-board" id="slot-board"></div>
                            </div>

                            <div class="parlor-slot-statusbar" id="slot-statusbar"></div>
                            <div class="parlor-slot-winfx" id="slot-winfx"></div>
                        </div>

                        <aside class="parlor-slot-console" id="slot-side"></aside>
                    </div>

                    <div class="parlor-slot-paytable" id="slot-paytable"></div>
                </div>
            </div>
        `;

        overlay.querySelector('.parlor-slot-backdrop')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement(overlay);
        this._overlay = overlay;
    }

    _renderHeader(state) {
        const head = this._overlay.querySelector('#slot-head');
        const marquee = this._overlay.querySelector('#slot-marquee');
        if (!head || !marquee) return;

        const operatorId = this._getOperatorId(state);
        const result = this._getCurrentResult(state);
        const isOperator = this._isCurrentUserOperator(state);
        const stake = this._getDisplayedSpinCost(state);
        const marqueeSub = this._getMarqueeSub(state, result);

        head.innerHTML = `
            <div class="parlor-slot-head-chip">${isOperator
                ? this._t('PARLOR.SlotMachine.Header.OperatorSelf')
                : this._t('PARLOR.SlotMachine.Header.OperatorWatch')}</div>
            <div class="parlor-slot-head-chip">${this._t('PARLOR.SlotMachine.Control.Operator', { name: this._playerName(state, operatorId) })}</div>
            <div class="parlor-slot-head-chip">${this._t('PARLOR.SlotMachine.Control.Cost', { amount: this._formatChip(stake) })}</div>
            <div class="parlor-slot-head-chip">${this._t('PARLOR.SlotMachine.Header.SpinCounter', { round: Math.max(0, Number(state.round || 0)) })}</div>
        `;

        marquee.innerHTML = `
            <div class="parlor-slot-marquee-main">${this._getMarqueeTitle(state, result)}</div>
            ${marqueeSub ? `<div class="parlor-slot-marquee-sub">${marqueeSub}</div>` : ''}
        `;
    }

    _renderBoard(state) {
        const boardEl = this._overlay.querySelector('#slot-board');
        const winFxEl = this._overlay.querySelector('#slot-winfx');
        if (!boardEl) return;

        const spinKey = `${state.spinId}:${state.round}`;
        const result = this._getCurrentResult(state);
        const showHighlights = state.phase === 'READY' && !!result?.hasWin;
        const hitCells = showHighlights ? this._getWinningCellKeys(state.spinSummary) : new Set();
        const board = this._displayBoard || this._createIdleBoard();
        const boardWrap = boardEl.closest('.parlor-slot-board-wrap');
        const showWinFx = state.phase === 'READY' && !!result?.hasWin;

        if (state.phase === 'SPINNING' && this._spinModel?.key === spinKey) {
            boardEl.innerHTML = this._buildAnimatedBoardHtml(this._spinModel);
        } else {
            boardEl.innerHTML = this._buildStaticBoardHtml(board, { hitCells });
        }

        boardWrap?.classList.toggle('is-win', showWinFx);
        if (winFxEl) {
            winFxEl.innerHTML = showWinFx ? this._buildWinFxHtml(result) : '';
        }
    }

    _renderStatusBar(state) {
        const bar = this._overlay.querySelector('#slot-statusbar');
        if (!bar) return;

        const result = this._getCurrentResult(state);
        const stake = this._getDisplayedSpinCost(state);
        const cells = [
            {
                label: this._t('PARLOR.SlotMachine.Control.SpinCost'),
                value: `${this._formatChip(stake)} GP`
            },
            {
                label: this._t('PARLOR.SlotMachine.Stat.Payout'),
                value: `${this._formatChip(result?.totalPayout || 0)} GP`,
                tone: result?.hasWin ? 'is-win' : ''
            },
            {
                label: this._t('PARLOR.SlotMachine.Stat.HitLines'),
                value: `${this._getHitWays(state.spinSummary)}`
            },
            {
                label: this._t('PARLOR.SlotMachine.Stat.ScatterCount'),
                value: `${state.spinSummary?.scatterCount || 0}`
            }
        ];

        bar.innerHTML = cells.map(entry => `
            <div class="parlor-slot-statuscell ${entry.tone || ''}">
                <span class="parlor-slot-statuslabel">${entry.label}</span>
                <strong class="parlor-slot-statusvalue">${entry.value}</strong>
            </div>
        `).join('');
    }

    _renderControls(state) {
        const side = this._overlay.querySelector('#slot-side');
        if (!side) return;
        this._cleanupLeverDrag();

        const operatorId = this._getOperatorId(state);
        const participant = this._describeParticipant(state, operatorId);
        const result = this._getCurrentResult(state);
        const balance = operatorId ? ChipManager.getDisplayBalance(operatorId) : null;
        const isOperator = this._isCurrentUserOperator(state);
        const stake = this._getDisplayedSpinCost(state);
        const canAfford = operatorId ? ChipManager.canAfford(operatorId, stake) : false;
        const spinActionKey = this._playerActionKey(operatorId, 'spin');
        const canEndGame = game.user.isGM || isOperator;
        const finishActionKey = canEndGame ? this._gmActionKey('finishGame') : this._localActionKey('leaveWatch');
        const stakeLocked = state.phase !== 'READY';
        const leverDisabled = !isOperator || state.phase !== 'READY' || !canAfford || this._isActionPending(spinActionKey);
        const leverPull = state.phase === 'SPINNING' ? 1 : Math.max(0, Math.min(1, this._leverPullRatio));
        const resultBlurb = this._getResultBlurb(state, result);
        const marqueeTitle = this._getMarqueeTitle(state, result);

        const actionHtml = isOperator
            ? `
                <div class="parlor-slot-console-card stake">
                    <div class="parlor-slot-console-label">${this._t('PARLOR.SlotMachine.Control.Stake')}</div>
                    <div class="parlor-slot-stake-row">
                        <button class="parlor-slot-stake-btn" type="button" data-slot-stake-delta="-${SLOT_BET_STEP}" ${stakeLocked ? 'disabled' : ''}>-${SLOT_BET_STEP}</button>
                        <input class="parlor-slot-stake-input" type="number" min="${SLOT_BET_STEP}" step="${SLOT_BET_STEP}" value="${stake}" data-slot-stake-input ${stakeLocked ? 'disabled' : ''}>
                        <button class="parlor-slot-stake-btn" type="button" data-slot-stake-delta="${SLOT_BET_STEP}" ${stakeLocked ? 'disabled' : ''}>+${SLOT_BET_STEP}</button>
                    </div>
                </div>
            `
            : `
                <div class="parlor-slot-watch-box">
                    <div class="parlor-slot-watch-title">${this._t('PARLOR.Common.Spectating')}</div>
                    <div class="parlor-slot-watch-note">${this._t('PARLOR.SlotMachine.Center.WatchNote')}</div>
                </div>
            `;

        side.innerHTML = `
            <div class="parlor-slot-console-card operator">
                <div class="parlor-slot-playerhead">
                    <div class="parlor-slot-playeravatar">${participant.avatarHtml}</div>
                    <div class="parlor-slot-playermeta">
                        <div class="parlor-slot-playerkicker">${participant.kind === 'npc' ? this._t('PARLOR.Common.NPC') : this._t('PARLOR.Common.Player')}</div>
                        <div class="parlor-slot-playername">${this._playerName(state, operatorId)}</div>
                    </div>
                </div>
            </div>

            <div class="parlor-slot-console-grid">
                <div class="parlor-slot-console-card meter">
                    <div class="parlor-slot-console-label">${this._t('PARLOR.Common.AvailableChips')}</div>
                    <div class="parlor-slot-console-value">${this._formatBalance(balance)}</div>
                </div>
                <div class="parlor-slot-console-card meter ${result?.hasWin ? 'tone-win' : ''}">
                    <div class="parlor-slot-console-label">${this._t('PARLOR.SlotMachine.Control.LastResult')}</div>
                    <div class="parlor-slot-console-value">${this._formatNet(result?.net || 0)}</div>
                </div>
            </div>

            <div class="parlor-slot-control-stack">
                ${actionHtml}
                <div class="parlor-slot-console-card lever-card${leverDisabled ? ' is-disabled' : ''}${state.phase === 'SPINNING' ? ' is-spinning' : ''}">
                    <div class="parlor-slot-console-label">${this._t('PARLOR.SlotMachine.Control.Lever')}</div>
                    <div
                        class="parlor-slot-lever-stage${state.phase === 'SPINNING' ? ' is-pulled' : ''}"
                        id="slot-lever-stage"
                        style="--slot-lever-pull:${leverPull.toFixed(4)};"
                        data-slot-lever-enabled="${leverDisabled ? 'false' : 'true'}"
                    >
                        <div class="parlor-slot-lever-lane"></div>
                        <div class="parlor-slot-lever-rod"></div>
                        <button class="parlor-slot-lever-knob" type="button" id="slot-lever-knob" ${leverDisabled ? 'disabled' : ''} aria-label="${this._t('PARLOR.SlotMachine.Control.Lever')}"></button>
                    </div>
                </div>
            </div>

            <div class="parlor-slot-console-strip ${result?.hasWin ? 'is-win' : ''}">
                <div class="parlor-slot-console-strip-title">${marqueeTitle}</div>
                ${resultBlurb
                    ? `<div class="parlor-slot-console-strip-sub">${resultBlurb}</div>`
                    : ''}
            </div>

            <button class="parlor-slot-gm-btn" id="slot-finish-btn" ${this._actionDisabledAttr(finishActionKey)}>
                <i class="fas fa-door-open"></i> ${this._t('PARLOR.Common.Finish')}
            </button>
        `;
        side.querySelectorAll('[data-slot-stake-delta]').forEach(button => {
            button.addEventListener('click', () => {
                const delta = Number(button.dataset.slotStakeDelta || 0);
                this._spinStakeDraft = this._sanitizeSpinStake(this._getDisplayedSpinCost(state) + delta, state.spinCost);
                this.refresh();
            });
        });
        side.querySelector('[data-slot-stake-input]')?.addEventListener('change', (event) => {
            this._spinStakeDraft = this._sanitizeSpinStake(event.currentTarget.value, state.spinCost);
            this.refresh();
        });
        this._bindLeverControl({
            side,
            state,
            operatorId,
            canAfford,
            spinActionKey
        });
        side.querySelector('#slot-finish-btn')?.addEventListener('click', (event) => {
            this._handleFinishClick(state, event.currentTarget);
        });
    }

    _renderPaytable(state) {
        const paytable = this._overlay.querySelector('#slot-paytable');
        if (!paytable) return;
        const highlightedSymbols = this._getHighlightedPaytableSymbols(state);
        const slotPaytable = SlotMachineConfig.getPaytable();

        paytable.innerHTML = `
            <div class="parlor-slot-paytable-head">
                <div class="parlor-slot-paytable-title">${this._t('PARLOR.SlotMachine.Paytable.Title')}</div>
                <div class="parlor-slot-paytable-pills">
                    <span class="parlor-slot-paytable-pill">${this._t('PARLOR.SlotMachine.Paytable.Rule.Paylines')}</span>
                    <span class="parlor-slot-paytable-pill">${this._t('PARLOR.SlotMachine.Paytable.Rule.LeftToRight')}</span>
                    <span class="parlor-slot-paytable-pill">${this._t('PARLOR.SlotMachine.Paytable.Rule.Wild')}</span>
                    <span class="parlor-slot-paytable-pill">${this._t('PARLOR.SlotMachine.Paytable.Rule.Scatter')}</span>
                </div>
            </div>
            <div class="parlor-slot-paytable-track">
                ${PAYTABLE_SYMBOLS.map(symbolId => `
                    <div class="parlor-slot-paytable-item${this._isSpecialPaytableSymbol(symbolId) ? ' is-special' : ''}${highlightedSymbols.has(symbolId) ? ' is-highlighted' : ''}">
                        <div class="parlor-slot-paytable-symbol">
                            ${this._buildSymbolHtml(symbolId, { compact: true })}
                        </div>
                        <div class="parlor-slot-paytable-values">
                            ${this._getPaytableRates(symbolId, slotPaytable).map(rate => `
                                <span class="parlor-slot-paytable-rate">${rate}</span>
                            `).join('')}
                        </div>
                        ${this._getPaytableNote(symbolId)
                            ? `<div class="parlor-slot-paytable-note">${this._getPaytableNote(symbolId)}</div>`
                            : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }

    _buildStaticBoardHtml(board, { hitCells = new Set() } = {}) {
        return Array.from({ length: REEL_COLUMNS }, (_, colIndex) => `
            <div class="parlor-slot-reel">
                <div class="parlor-slot-reel-track is-static">
                    ${Array.from({ length: REEL_ROWS }, (_, rowIndex) => {
                        const symbolId = board?.[rowIndex]?.[colIndex] || null;
                        const hit = hitCells.has(`${rowIndex}:${colIndex}`);
                        const hitStyle = hit ? ` style="--slot-hit-order:${(colIndex * REEL_ROWS) + rowIndex};"` : '';
                        return `
                            <div class="parlor-slot-window-cell${hit ? ' is-hit' : ''}"${hitStyle}>
                                ${symbolId ? this._buildSymbolHtml(symbolId, { highlighted: hit }) : '<div class="parlor-slot-symbol-empty"></div>'}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `).join('');
    }

    _buildAnimatedBoardHtml(spinModel) {
        return (spinModel?.reels || []).map(reel => `
            <div class="parlor-slot-reel is-spinning">
                <div
                    class="parlor-slot-reel-track is-animating"
                    style="--slot-stop-steps:${reel.stopSteps};--slot-coast-steps:${reel.coastSteps};--slot-brake-steps:${reel.brakeSteps};--slot-overshoot-steps:${reel.overshootSteps};--slot-spin-duration:${reel.duration}ms;"
                >
                    ${reel.symbols.map((symbolId, index) => {
                        const finalStart = reel.symbols.length - REEL_ROWS;
                        const isFinalCell = index >= finalStart;
                        const finalIndex = Math.max(0, index - finalStart);
                        const settleDelay = reel.duration + 20 + (finalIndex * 95);

                        return `
                            <div class="parlor-slot-window-cell is-rolling${isFinalCell ? ' is-final' : ''}"${isFinalCell ? ` style="--slot-settle-delay:${settleDelay}ms;"` : ''}>
                                ${this._buildSymbolHtml(symbolId, { rolling: !isFinalCell })}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `).join('');
    }

    _buildSymbolHtml(symbolId, { compact = false, rolling = false, highlighted = false } = {}) {
        const meta = SLOT_SYMBOLS[symbolId];
        if (!meta) return '<div class="parlor-slot-symbol-empty"></div>';

        const palette = meta.palette || {};
        const style = [
            `--slot-symbol-main:${palette.main || '#ffd65a'}`,
            `--slot-symbol-accent:${palette.accent || '#fff5c8'}`,
            `--slot-symbol-ink:${palette.ink || '#402010'}`
        ].join(';');

        return `
            <div class="parlor-slot-symbol${compact ? ' is-compact' : ''}${rolling ? ' is-rolling' : ''}${highlighted ? ' is-highlighted' : ''}" style="${style}" aria-label="${this._getSymbolLabel(symbolId)}">
                <div class="parlor-slot-symbol-face">
                    <div class="parlor-slot-symbol-emblem">
                        ${this._buildSymbolArt(symbolId, { rolling, highlighted })}
                    </div>
                    <div class="parlor-slot-symbol-banner">${meta.shortLabel || this._getSymbolLabel(symbolId)}</div>
                </div>
            </div>
        `;
    }

    _buildSymbolArt(symbolId, { rolling = false, highlighted = false } = {}) {
        // 符号现在是程序化 SVG（见 SlotSymbols.js），颜色吃各符号自己的 palette。
        // rolling/highlighted 两态只加 class，滚动模糊和命中高亮都交给 CSS，不再需要专门的 blur/win 贴图。
        const svg = renderSlotSymbolSvg(symbolId, SLOT_SYMBOLS[symbolId]?.palette);
        if (!svg) return '<div class="parlor-slot-symbol-empty"></div>';

        return `
            <div class="parlor-slot-symbol-sprite${rolling ? ' is-rolling' : ''}${highlighted ? ' is-highlighted' : ''}" aria-hidden="true">
                ${svg}
            </div>
        `;
    }

    _buildWinFxHtml(result) {
        const metrics = [
            {
                label: this._t('PARLOR.SlotMachine.Stat.HitLines'),
                value: `${this._getHitWays(result)}`
            },
            {
                label: this._t('PARLOR.SlotMachine.Stat.Payout'),
                value: `+${this._formatChip(result?.totalPayout || 0)} GP`,
                toneClass: ' is-payout'
            }
        ];

        return `
            <div class="parlor-slot-winflash">
                <div class="parlor-slot-winflash-title">${this._t('PARLOR.SlotMachine.Marquee.Win')}</div>
                <div class="parlor-slot-winflash-pills">
                    ${metrics.map(metric => `
                        <span class="parlor-slot-winflash-pill${metric.toneClass || ''}">
                            <span class="parlor-slot-winflash-pill-label">${metric.label}</span>
                            <span class="parlor-slot-winflash-pill-value">${metric.value}</span>
                        </span>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _startSpinAnimation(state) {
        this._clearSpinAnimation();
        this._spinAnimationKey = `${state.spinId}:${state.round}`;
        this._displayBoard = state.board;
        this._spinModel = {
            key: this._spinAnimationKey,
            reels: Array.from({ length: REEL_COLUMNS }, (_, colIndex) => {
                const lead = Array.from({ length: REEL_ROWS }, () => this._getRandomSymbolId());
                const stream = Array.from({ length: 10 + (colIndex * 4) }, () => this._getRandomSymbolId());
                const finalSymbols = Array.from({ length: REEL_ROWS }, (_, rowIndex) => state.board?.[rowIndex]?.[colIndex] || this._getRandomSymbolId());
                const stopSteps = lead.length + stream.length;
                const coastSteps = Math.max(REEL_ROWS + 4, stopSteps - 6.2);
                const brakeSteps = Math.max(REEL_ROWS + 1, stopSteps - 2.1);
                const overshootSteps = stopSteps + Math.max(0.16, 0.34 - (colIndex * 0.03));

                return {
                    symbols: [...lead, ...stream, ...finalSymbols],
                    stopSteps,
                    coastSteps: coastSteps.toFixed(2),
                    brakeSteps: brakeSteps.toFixed(2),
                    overshootSteps: overshootSteps.toFixed(2),
                    duration: REEL_SPIN_MS[colIndex] || REEL_SPIN_MS[REEL_SPIN_MS.length - 1]
                };
            })
        };
    }

    async _submitSpin(operatorId, button) {
        if (!operatorId) return;
        const stake = this._getDisplayedSpinCost(this.gameInstance.getState());

        const result = await this._runSocketAction(this._playerActionKey(operatorId, 'spin'), button, () => SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
            sessionId: this.sessionId,
            userId: operatorId,
            action: 'spin',
            data: { spinCost: stake }
        }));

        if (result?.ok) return;

        if (result?.reason === 'chips') {
            const balance = ChipManager.getDisplayBalance(operatorId);
            ui.notifications.warn(this._t('PARLOR.Common.ChipsInsufficient', {
                balance: this._formatBalance(balance),
                amount: `${this._formatChip(stake)} GP`
            }));
            return;
        }

        ui.notifications.warn(this._t('PARLOR.SlotMachine.Error.SpinFailed'));
    }

    _bindLeverControl({ side, state, operatorId, canAfford, spinActionKey }) {
        const leverStage = side.querySelector('#slot-lever-stage');
        const leverKnob = side.querySelector('#slot-lever-knob');
        if (!leverStage || !leverKnob) return;

        const enabled = !!operatorId
            && this._isCurrentUserOperator(state)
            && state.phase === 'READY'
            && canAfford
            && !this._isActionPending(spinActionKey);
        if (!enabled) {
            this._setLeverPull(0);
            return;
        }

        const startDrag = (event) => {
            if (event.button != null && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();

            const updatePull = (clientY) => {
                const rect = leverStage.getBoundingClientRect();
                const startY = rect.top + 32;
                const range = Math.max(72, rect.height - 84);
                const pull = Math.max(0, Math.min(1, (clientY - startY) / range));
                this._setLeverPull(pull);
            };

            const finishDrag = async (clientY, cancelled = false) => {
                updatePull(clientY);
                const shouldSpin = !cancelled && this._leverPullRatio >= 0.78;
                this._cleanupLeverDrag({ keepPull: shouldSpin });
                if (!shouldSpin) {
                    this._setLeverPull(0);
                    return;
                }

                try {
                    this._playSlotSound(SLOT_ACTION_SOUNDS.lever, { volume: SLOT_ACTION_SOUND_VOLUME });
                    await this._submitSpin(operatorId);
                } finally {
                    if (this.gameInstance.getState().phase !== 'SPINNING') {
                        this._setLeverPull(0);
                    }
                }
            };

            updatePull(event.clientY);
            leverStage.classList.add('is-dragging');
            leverKnob.classList.add('is-dragging');

            const onMove = (moveEvent) => {
                updatePull(moveEvent.clientY);
            };
            const onEnd = (endEvent) => {
                finishDrag(endEvent.clientY, false).catch(error => {
                    console.error('parlor | Slot Machine lever drag failed:', error);
                    this._setLeverPull(0);
                });
            };
            const onCancel = () => {
                this._cleanupLeverDrag();
                this._setLeverPull(0);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onEnd, { once: true });
            window.addEventListener('pointercancel', onCancel, { once: true });

            this._leverDragCleanup = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onEnd);
                window.removeEventListener('pointercancel', onCancel);
                leverStage.classList.remove('is-dragging');
                leverKnob.classList.remove('is-dragging');
                this._leverDragCleanup = null;
            };
        };

        leverStage.addEventListener('pointerdown', startDrag);
        leverKnob.addEventListener('pointerdown', startDrag);
        this._leverDragCleanup = () => {
            leverStage.removeEventListener('pointerdown', startDrag);
            leverKnob.removeEventListener('pointerdown', startDrag);
            this._leverDragCleanup = null;
        };
    }

    _cleanupLeverDrag({ keepPull = false } = {}) {
        const cleanup = this._leverDragCleanup;
        if (cleanup) cleanup();
        if (!keepPull) this._leverPullRatio = 0;
    }

    _setLeverPull(value) {
        this._leverPullRatio = Math.max(0, Math.min(1, Number(value || 0)));
        const stage = this._overlay?.querySelector('#slot-lever-stage');
        if (stage) {
            stage.style.setProperty('--slot-lever-pull', this._leverPullRatio.toFixed(4));
            stage.classList.toggle('is-pulled', this._leverPullRatio >= 0.98 || this.gameInstance.getState().phase === 'SPINNING');
        }
    }

    _getCurrentResult(state) {
        const operatorId = this._getOperatorId(state);
        if (state.phase === 'SPINNING') {
            return state.lastResult || null;
        }
        return state.lastResult || state.playerResults?.[operatorId] || null;
    }

    _getOperatorId(state) {
        return (state.playerIds || []).find(Boolean) || '';
    }

    _isCurrentUserOperator(state) {
        const operatorId = this._getOperatorId(state);
        return getControlledParticipants(state).some(entry => entry.id === operatorId);
    }

    _describeParticipant(state, participantId) {
        return getDisplayParticipant(state, participantId);
    }

    _playerName(state, participantId) {
        return getParticipantName(state, participantId);
    }

    _getResultBlurb(state, result) {
        if (state.phase === 'SPINNING' || !result) return '';
        if (result.hasWin) {
            const ways = this._getHitWays(result);
            return this._t('PARLOR.SlotMachine.Control.LastResultWin', {
                payout: this._formatChip(result.totalPayout),
                ways,
                lines: ways
            });
        }
        return this._t('PARLOR.SlotMachine.Control.LastResultLose');
    }

    _getMarqueeTitle(state, result) {
        if (state.phase === 'SPINNING') return this._t('PARLOR.SlotMachine.Marquee.Spinning');
        if (!result) return this._t('PARLOR.SlotMachine.Marquee.Ready');
        if (result.hasWin) return this._t('PARLOR.SlotMachine.Marquee.Win');
        return this._t('PARLOR.SlotMachine.Marquee.NoWin');
    }

    _getMarqueeSub(state, result) {
        if (!result || state.phase === 'SPINNING' || !result.hasWin) return '';
        return this._t('PARLOR.SlotMachine.Marquee.WinSub', { amount: this._formatChip(result.totalPayout) });
    }

    _playPayoutSound(state) {
        const result = this._getCurrentResult(state);
        if (!result?.hasWin) return;

        const soundKey = `${state.spinId || 0}:${state.round || 0}:${result.totalPayout || 0}`;
        if (this._playedPayoutSoundKey === soundKey) return;
        this._playedPayoutSoundKey = soundKey;

        this._playSlotSound(SLOT_PAYOUT_SOUNDS[this._getPayoutSoundTier(result)] || SLOT_PAYOUT_SOUNDS.small, {
            volume: PAYOUT_SOUND_VOLUME
        });
    }

    _playSpinSound(state) {
        const soundKey = `${state.spinId || 0}:${state.round || 0}`;
        if (this._playedSpinSoundKey === soundKey) return;
        this._playedSpinSoundKey = soundKey;
        this._playSlotSound(SLOT_ACTION_SOUNDS.spin, { volume: SLOT_ACTION_SOUND_VOLUME });
    }

    _playSlotSound(src, { volume = SLOT_ACTION_SOUND_VOLUME } = {}) {
        if (!src) return;
        const helper = globalThis.AudioHelper || foundry.audio?.AudioHelper;
        if (typeof helper?.play !== 'function') return;

        try {
            Promise.resolve(helper.play({
                src,
                volume,
                loop: false,
                context: 'interface'
            }, false)).catch(() => {});
        } catch (_err) {
            // 音效是界面反馈，播放失败别影响主流程。
        }
    }

    _getPayoutSoundTier(result) {
        const totalBet = Math.max(SLOT_BET_STEP, Number(result?.totalBet || result?.stake || 0));
        const payoutRatio = Number(result?.totalPayout || 0) / totalBet;
        if (payoutRatio >= 10) return 'big';
        if (payoutRatio >= 3) return 'win';
        return 'small';
    }

    _isSpecialPaytableSymbol(symbolId) {
        return symbolId === 'wild' || symbolId === 'scatter';
    }

    _getPaytableRates(symbolId, paytable = null) {
        const pays = getSymbolPayouts(symbolId, paytable);
        return [3, 4, 5].map(count => `x${Number(pays[count] || 0)}`);
    }

    _getPaytableNote(symbolId) {
        if (symbolId === 'wild') return this._t('PARLOR.SlotMachine.Paytable.WildNote');
        if (symbolId === 'scatter') return this._t('PARLOR.SlotMachine.Paytable.ScatterNote');
        return '';
    }

    _getHighlightedPaytableSymbols(state) {
        const hits = new Set();
        if (state?.phase !== 'READY') return hits;

        const summary = state?.spinSummary || {};
        const winningGroups = summary.winningWays || summary.winningLines || [];
        winningGroups.forEach(group => {
            if (group?.symbolId) hits.add(group.symbolId);
        });

        if (Number(summary.scatterMultiplier || 0) > 0) {
            hits.add('scatter');
        }

        return hits;
    }

    _getWinningCellKeys(spinSummary) {
        const hits = new Set();
        const winningGroups = spinSummary?.winningWays || spinSummary?.winningLines || [];
        for (const group of winningGroups) {
            for (const [row, col] of (group.positions || [])) {
                hits.add(`${row}:${col}`);
            }
        }

        if (Number(spinSummary?.scatterMultiplier || 0) > 0) {
            const board = this.gameInstance.getState().board || [];
            board.forEach((row, rowIndex) => {
                row.forEach((symbolId, colIndex) => {
                    if (symbolId === 'scatter') hits.add(`${rowIndex}:${colIndex}`);
                });
            });
        }

        return hits;
    }

    _getHitWays(summaryOrResult) {
        return Number((summaryOrResult?.hitWays ?? summaryOrResult?.hitLines) || 0);
    }

    _boardHasSymbols(board) {
        return !!(board || []).flat().find(symbolId => !!symbolId);
    }

    _createIdleBoard() {
        return Array.from({ length: REEL_ROWS }, () => Array.from({ length: REEL_COLUMNS }, () => this._getRandomSymbolId()));
    }

    _getRandomSymbolId() {
        return SLOT_RANDOM_SYMBOL_IDS[Math.floor(Math.random() * SLOT_RANDOM_SYMBOL_IDS.length)];
    }

    _getDisplayedSpinCost(state) {
        if (this._isCurrentUserOperator(state) && state.phase !== 'SPINNING') {
            return this._sanitizeSpinStake(this._spinStakeDraft, state.spinCost);
        }
        return this._sanitizeSpinStake(state.spinCost, state.spinCost);
    }

    _sanitizeSpinStake(amount, fallback = SLOT_BET_STEP) {
        const safeFallback = Math.max(SLOT_BET_STEP, Math.ceil((Number(fallback || 0) || SLOT_BET_STEP) / SLOT_BET_STEP) * SLOT_BET_STEP);
        const raw = Math.floor(Number(amount || 0));
        const value = Number.isFinite(raw) && raw > 0 ? raw : safeFallback;
        return Math.max(SLOT_BET_STEP, Math.ceil(value / SLOT_BET_STEP) * SLOT_BET_STEP);
    }

    _clearSpinAnimation() {
        this._spinModel = null;
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

    _formatBalance(balance) {
        if (balance == null) return '--';
        if (typeof balance === 'number') return `${this._formatChip(balance)} ${this._t('PARLOR.Common.Chips')}`;
        return this._t('PARLOR.Common.ChipsInfinity');
    }

    _getSymbolLabel(symbolId) {
        return this._t(SLOT_SYMBOLS[symbolId]?.labelKey || 'PARLOR.Common.Unknown');
    }

    _resetTracking() {
        this._prevPhase = '';
        this._spinAnimationKey = '';
        this._displayBoard = null;
        this._spinModel = null;
        this._spinStakeDraft = 0;
        this._leverPullRatio = 0;
        this._playedPayoutSoundKey = '';
        this._playedSpinSoundKey = '';
        this._actionRequests.clear();
    }

    _gmActionKey(action) {
        return `gm:${action}`;
    }

    _playerActionKey(userId, action) {
        return `player:${userId || 'none'}:${action}`;
    }

    _localActionKey(action) {
        return `local:${action}`;
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
                console.error('parlor | Slot Machine socket action failed:', error);
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

    _requestGMAction({ action, data = {}, key = this._gmActionKey(action), button = null }) {
        return this._runSocketAction(key, button, () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
            sessionId: this.sessionId,
            action,
            data
        }));
    }

    _handleFinishClick(state, button) {
        if (game.user.isGM || this._isCurrentUserOperator(state)) {
            this._requestGMAction({ action: 'finishGame', button });
            return;
        }

        this._confirmLeaveWatch(button);
    }

    async _confirmLeaveWatch(button) {
        const confirmed = await this._runSocketAction(this._localActionKey('leaveWatch'), button, () => foundry.applications.api.DialogV2.wait({
            window: {
                title: this._t('PARLOR.SlotMachine.ClosePrompt.Title')
            },
            content: `
                <div class="parlor-confirm-text">
                    ${this._t('PARLOR.SlotMachine.ClosePrompt.WatchBody')}
                </div>
            `,
            render: (_event, dialog) => this._liftDialogAboveTable(dialog),
            buttons: [
                {
                    action: 'confirm',
                    label: this._t('PARLOR.SlotMachine.ClosePrompt.WatchConfirm'),
                    icon: 'fas fa-door-open',
                    default: true,
                    callback: () => true
                },
                {
                    action: 'cancel',
                    label: this._t('PARLOR.Common.Cancel'),
                    callback: () => false
                }
            ],
            rejectClose: false
        }));

        if (confirmed) {
            this._requestParlorLocalLeave?.() ?? this.close();
        }
    }

    _liftDialogAboveTable(dialog) {
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

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
