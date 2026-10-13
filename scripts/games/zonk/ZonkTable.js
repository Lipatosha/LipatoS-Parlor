import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { getControlledParticipants, getParticipantName } from '../../core/ParticipantRoster.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { getGameGuide } from '../../core/GameRegistry.js';
import { BotManager } from '../../core/BotManager.js';
import { scoreZonkDice } from './ZonkRules.js';
import { renderFarkleDie as pipDie } from './FarkleDie.js';
import { getUpcomingZonkTurns } from './ZonkRoundTurns.js';
import { renderD6Face } from '../../core/DiceFaces.js';

// Dice markup is intentionally isolated from all other Parlor dice skins.
const t = (key, data) => data
    ? game.i18n.format('PARLOR.Zonk.' + key, data)
    : game.i18n.localize('PARLOR.Zonk.' + key);
const esc = value => foundry.utils.escapeHTML(String(value ?? ''));
const fmt = value => Number(value || 0).toLocaleString(game.i18n?.lang || 'ru-RU');
const diceRow = (dice, small = false) => (dice || []).map(value => small
    ? renderD6Face(value, { className: 'parlor-ld-die', small: true })
    : pipDie(value)).join('');

export class ZonkTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._dismissedByUser = false;
        this._selected = new Set();
        this._editedRollId = null;
        this._editedPlayerId = '';
        this._previewQueue = Promise.resolve();
        this._visibleRollId = null;
        this._visiblePlayerId = '';
        this._soundRollId = null;
        this._soundOn = true;
        this._rulesOpen = false;
        this._busy = false;
        this._lastAnimatedRollId = null;
        this._winnerNoticeShown = false;
        this._victoryDismissed = false;
    }

    render(force = false) {
        if (force) this._dismissedByUser = false;
        if (this._dismissedByUser) return;
        if (!this._overlay) {
            document.querySelectorAll('#parlor-zonk-overlay').forEach(node => node.remove());
            this._overlay = document.createElement('div');
            this._overlay.id = 'parlor-zonk-overlay';
            this._overlay.className = 'parlor-zonk-overlay';
            document.body.appendChild(this._overlay);
        }
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._overlay?.remove();
        this._overlay = null;
        this._rulesOpen = false;
        this._busy = false;
    }

    _participantName(state, id) {
        if (BotManager.isBot(id)) return BotManager.getBotName(id);
        return getParticipantName(state, id) || id;
    }

    _canPlay(state) {
        if (state.phase !== 'PLAYER_TURNS' || !state.currentPlayerId) return false;
        if (game.user.isGM) return true;
        return getControlledParticipants(state).some(entry => entry.id === state.currentPlayerId);
    }

    /** Use the actual Foundry VTT installation sound, served from public/sounds/dice.wav. */
    _playRollSound() {
        if (!this._soundOn) return;
        try {
            const helper = globalThis.foundry?.audio?.AudioHelper;
            if (typeof helper?.play !== 'function') return;
            Promise.resolve(helper.play({
                src: 'sounds/dice.wav',
                volume: 0.6,
                loop: false,
                channel: 'interface'
            }, false)).catch(error => console.warn('parlor | Foundry dice.wav failed', error));
        } catch (error) {
            console.warn('parlor | Could not play Foundry dice.wav', error);
        }
    }

    _history(state) {
        const rows = (state.history || []).slice(0, 100).map(entry => {
            const name = entry.participantId ? this._participantName(state, entry.participantId) : '';
            const key = ({
                start: 'HistoryStart', roll: 'HistoryRoll', keep: 'HistoryKeep',
                bank: 'HistoryBank', zonk: 'HistoryZonk', skip: 'HistorySkip',
                finish: 'HistoryFinish', paid: 'HistoryPaid', refund: 'HistoryRefund'
            })[entry.kind] || 'HistoryRoll';
            const amount = Number(entry.points || 0);
            const dice = diceRow(entry.dice, true);
            return `<div class="parlor-zonk-history-row is-${esc(entry.kind)}">
                <span class="parlor-zonk-history-name">${esc(name || t('House'))}</span>
                <span class="parlor-zonk-history-verb">${esc(t(key))}</span>
                <span class="parlor-zonk-history-dice">${dice}</span>
                ${amount ? `<b class="parlor-zonk-history-points">${entry.kind === 'keep' ? '+' : ''}${fmt(amount)}</b>` : ''}
            </div>`;
        });
        return rows.length ? rows.join('') : `<div class="parlor-zonk-history-empty">${esc(t('HistoryEmpty'))}</div>`;
    }

    /** Exact illustrated rules order, re-skinned using the shared Foundry materials. */
    _combos({ showDescriptions = false } = {}) {
        const combo = (faces, points, note = '') => `<div class="parlor-zonk-combo-row">
            <span class="parlor-zonk-combo-faces">${diceRow(faces, true)}</span>
            <strong class="parlor-zonk-combo-value">${fmt(points)}</strong>
            ${note ? `<small>${esc(note)}</small>` : ''}
        </div>`;
        // The reference uses starred 'any face' cubes. Draw # on the actual die tiles.
        const anyDice = (groups, points) => `<div class="parlor-zonk-combo-row">
            <span class="parlor-zonk-combo-faces parlor-zonk-any-groups">${groups.map(count =>
                `<span class="parlor-zonk-any-group">${Array.from({ length: count }, () =>
                    '<span class="parlor-zonk-any-die" aria-label="любая грань">#</span>').join('')}</span>`
            ).join('')}</span>
            <strong class="parlor-zonk-combo-value">${fmt(points)}</strong>
        </div>`;
        const group = (label, body) => `<section class="parlor-zonk-manuscript-section">
            <h4>${esc(label)}</h4><div class="parlor-zonk-manuscript-entries">${body}</div>
        </section>`;
        const simpleKind = (label, multiplier) =>
            `<div class="parlor-zonk-kind-row"><span>${esc(label)} ${esc(t('Multiplier'))}</span> <b>${esc(multiplier)}</b></div>`;
        return `<div class="parlor-zonk-manuscript" aria-label="${esc(t('Scoring'))}">
            <div class="parlor-zonk-manuscript-columns">
                <div class="parlor-zonk-guide-column">
                    ${group(t('SectionSingles'), combo([1],100) + combo([5],50))}
                    ${group(t('SectionTriples'), [
                        combo([1,1,1],1000), combo([2,2,2],200), combo([3,3,3],300),
                        combo([4,4,4],400), combo([5,5,5],500), combo([6,6,6],600)
                    ].join(''))}
                    <div class="parlor-zonk-multiples">
                        ${simpleKind(t('FourKind'),'×2')}
                        ${simpleKind(t('FiveKind'),'×4')}
                        ${simpleKind(t('SixKind'),'×8')}
                    </div>
                </div>
                <div class="parlor-zonk-guide-column">
                    ${group(t('SectionPartialStraight'),combo([1,2,3,4,5],500) + combo([2,3,4,5,6],750))}
                    ${group(t('SectionStraight'),combo([1,2,3,4,5,6],1500))}
                    ${group(t('SectionPairs'),anyDice([2,2,2],1500))}
                    ${group(t('SectionDoubleTriples'),anyDice([3,3],2500))}
                    ${group(t('SectionFourPlusPair'),anyDice([4,2],1500))}
                    ${showDescriptions ? `<div class="parlor-zonk-combo-extra">
                        <p>${esc(t('ScoreHelpText'))}</p>
                        <p>${esc(t('ScoreHelpFullHand'))}</p>
                        <p>${esc(t('ScoreHelpBust'))}</p>
                    </div>` : ''}
                </div>
            </div>
        </div>`;
    }

    _rules() {
        const guide = getGameGuide('zonk');
        const paragraphs = guide?.paragraphs || [];
        return `<div class="parlor-zonk-rules-backdrop" data-zonk-rule-backdrop>
          <section class="parlor-zonk-rules" role="dialog" aria-modal="true" aria-label="${esc(t('Rules'))}">
            <header class="parlor-zonk-rules-header">
              <h2>${esc(t('Rules'))}: Farkle</h2>
              <button type="button" data-zonk-action="hide-rules" aria-label="${esc(t('Close'))}">×</button>
            </header>
            <div class="parlor-zonk-rules-content">
              <article class="parlor-zonk-rulebook-paper">
                <p class="parlor-zonk-rules-intro">${esc(guide?.summary || '')}</p>
                <div class="parlor-zonk-rulebook-text">
                  ${paragraphs.map(text => `<p>${esc(text)}</p>`).join('')}
                </div>
                ${guide?.note ? `<p class="parlor-zonk-rules-note">${esc(guide.note)}</p>` : ''}
                <h3 class="parlor-zonk-rulebook-title">${esc(t('Scoring'))}</h3>
                <div class="parlor-zonk-rules-combos">${this._combos({ showDescriptions: true })}</div>
              </article>
            </div>
            <footer><button type="button" data-zonk-action="hide-rules">${esc(t('Understood'))}</button></footer>
          </section>
        </div>`;
    }

    refresh() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        if (this._visibleRollId !== state.rollId || this._visiblePlayerId !== state.currentPlayerId || state.turnPhase !== 'choose') {
            this._selected.clear();
            this._editedRollId = null;
            this._editedPlayerId = '';
            this._visibleRollId = state.rollId;
            this._visiblePlayerId = state.currentPlayerId;
        }
        // Local Foundry dice.wav only: no Dice So Nice in Farkle.
        // A rollId is authoritative and changes once per new GM-synced throw.
        if (this._soundRollId !== state.rollId) {
            this._soundRollId = state.rollId;
            if (['choose', 'zonked'].includes(state.turnPhase) && state.currentDice?.length) this._playRollSound();
        }
        const choosing = state.turnPhase === 'choose';
        const zonked = state.turnPhase === 'zonked';
        const ready = state.turnPhase === 'ready';
        const ended = state.phase === 'FINISHED';
        if (ended && !this._winnerNoticeShown && state.winnerIds?.length) {
            this._winnerNoticeShown = true;
            const winnerNames = state.winnerIds.map(id => this._participantName(state, id)).join(', ');
            ui.notifications?.info(t(state.winnerIds.length === 1 ? 'VictoryNotice' : 'VictoryDrawNotice', {
                winners: winnerNames
            }));
        }
        const pending = !state.started;
        const hot = ready && state.remainingDice === 6;
        const canPlay = this._canPlay(state) && !this._busy;
        // Spectators (including the GM viewing another player's turn) use GM-synced choices.
        // Only the client actively clicking these dice keeps its optimistic local selection.
        const localChoice = this._editedRollId === state.rollId
            && this._editedPlayerId === state.currentPlayerId;
        const displaySelection = new Set(choosing
            ? (BotManager.isBot(state.currentPlayerId) ? (state.botSelectedIndices || [])
                : (localChoice ? [...this._selected] : (state.playerSelectedIndices || [])))
            : []);
        const selectedIndices = [...this._selected].sort((a, b) => a - b);
        const points = scoreZonkDice(selectedIndices.map(index => state.currentDice?.[index]));
        const current = state.currentPlayerId ? this._participantName(state, state.currentPlayerId) : '';
        const topScore = Math.max(0, ...Object.values(state.playerStates || {}).map(p => Number(p.score || 0)));
        const progress = Math.min(100, Math.floor(topScore * 100 / (state.targetScore || 5000)));
        const pot = SettlementManager.formatAmount(state.pot, state);
        const bet = SettlementManager.formatAmount(state.ante, state);
        const actionButton = (action, label, enabled, cls = '') =>
            `<button type="button" class="parlor-zonk-action ${cls}" data-zonk-action="${action}" ${enabled ? '' : 'disabled'}>${esc(label)}</button>`;

        const standings = [...(state.turnOrder || [])].sort((a, b) =>
            (state.playerStates?.[b]?.score || 0) - (state.playerStates?.[a]?.score || 0));
        // Keep these numbers in turn order, regardless of scoreboard rank.
        const upcomingOrder = getUpcomingZonkTurns(state);
        // Show actual seated participants only, up to the supported ten.
        const roster = standings.slice(0, 10).map((id, index) => {
            const p = state.playerStates?.[id] || {};
            const active = id === state.currentPlayerId;
            const winner = state.winnerIds?.includes(id);
            const upcoming = upcomingOrder.get(id);
            return `<div class="parlor-zonk-progress-row ${active ? 'is-current' : ''} ${winner ? 'is-winner' : ''} ${upcoming ? 'is-upcoming' : 'is-played'}">
                <span class="parlor-zonk-rank">${index + 1}</span>
                ${upcoming ? `<span class="parlor-zonk-turn-order" title="${esc(t('UpcomingTurn', { number: upcoming }))}" aria-label="${esc(t('UpcomingTurn', { number: upcoming }))}">${upcoming}</span>` : ''}
                <span class="parlor-zonk-player" title="${esc(this._participantName(state, id))}">${esc(this._participantName(state, id))}</span>
                <strong>${fmt(p.score || 0)}</strong>
            </div>`;
        }).join('');

        const animateRoll = choosing && this._lastAnimatedRollId !== state.rollId;
        if (animateRoll) this._lastAnimatedRollId = state.rollId;
        const dice = (choosing || zonked)
            ? (state.currentDice || []).map((value, index) => `
                <button type="button" class="parlor-zonk-pick ${displaySelection.has(index) ? 'is-selected' : ''}"
                    data-zonk-die="${index}" style="--z-roll-tilt:${[-5,4,-2,6,-3,3][index % 6]}deg"
                    aria-pressed="${displaySelection.has(index)}"
                    aria-label="${esc(t('Face', { value }))}" ${canPlay ? '' : 'disabled'}>
                    ${pipDie(value)}
                </button>`).join('')
            : '';

        const last = (state.history || [])[0];
        const showZonk = zonked;
        const status = pending ? (state.lastError || t('Waiting'))
            : ended ? t('GameOver')
            : zonked ? t('Bust')
            : choosing ? t('ChooseDice')
            : ready ? (hot ? t('HotDice') : t('RollOrBank'))
            : t('ReadyToRoll');

        this._overlay.innerHTML = `<div class="parlor-zonk-layout">
            <header class="parlor-zonk-toolbar">
                <div class="parlor-zonk-brand"><small>АИНДОР</small><strong>FARKLE</strong></div>
                <div class="parlor-zonk-turn">${ended
                    ? esc(t('WinnerLabel')) + ' ' + esc((state.winnerIds || []).map(id => this._participantName(state, id)).join(', '))
                    : esc(t('TurnOf')) + ' ' + esc(current || '—')}</div>
                <div class="parlor-zonk-toolbar-right">
                    <div class="parlor-zonk-round">${esc(t('Round'))} ${Number(state.round || 1)}
                        ${state.finalTurnsRemaining !== null ? ' · ' + esc(t('FinalRound')) : ''}</div>
                    <div class="parlor-zonk-toolbar-buttons">
                        <button type="button" data-zonk-action="rules" title="${esc(t('Rules'))}">◫ ${esc(t('Rules'))}</button>
                        <button type="button" data-zonk-action="sound" aria-pressed="${this._soundOn}" title="${esc(t('Sound'))}">${this._soundOn ? '◖))' : '◖×'}</button>
                        <button type="button" data-zonk-action="close" title="${esc(t('Close'))}">✕</button>
                    </div>
                    <details class="parlor-zonk-more">
                        <summary title="${esc(t('ExtraActions'))}" aria-label="${esc(t('ExtraActions'))}">⋯</summary>
                        <div class="parlor-zonk-more-menu">
                            ${game.user.isGM
                                ? actionButton('finish', ended ? t('PayAndClose') : t('RefundAndClose'), !this._busy, 'is-danger')
                                : `<span>${esc(t('OnlyGM'))}</span>`}
                        </div>
                    </details>
                </div>
            </header>
            <aside class="parlor-zonk-progress">
                <div class="parlor-zonk-panel-title">${esc(t('Progress'))}</div>
                <div class="parlor-zonk-progress-score">${fmt(topScore)}<span>/${fmt(state.targetScore || 5000)}</span></div>
                <div class="parlor-zonk-progress-track"><div style="width:${progress}%"></div></div>
                <div class="parlor-zonk-players-heading"><strong>${esc(t('Players'))}</strong><span>${standings.length}/10</span></div>
                <div class="parlor-zonk-progress-players">${roster}</div>
                <div class="parlor-zonk-progress-foot">
                    ${actionButton('skip', t('SkipTurn'), game.user.isGM && !ended && !pending && !this._busy && !zonked, 'is-skip')}
                </div>
            </aside>
            <main class="parlor-zonk-center">
                <div class="parlor-zonk-mini-stats">
                    <div><small>${esc(t('TurnPoints'))}</small><b>${fmt(state.turnPoints || 0)}</b></div>
                    <div><small>${esc(t('DiceLeft'))}</small><b>${state.remainingDice || 6}</b></div>
                    <div><small>${esc(t('Pot'))}</small><b>${esc(pot)}</b></div>
                </div>
                <div class="parlor-zonk-velvet">
                    <section class="parlor-zonk-roll-zone" aria-label="${esc(t('RollField'))}">
                        <div class="parlor-zonk-roll-zone-heading"><strong>${esc(t('RollField'))}</strong><span>${choosing ? state.currentDice?.length || 0 : state.remainingDice || 6} ${esc(t('DiceShort'))}</span></div>
                        <div class="parlor-zonk-dice-tray ${animateRoll ? 'is-new-roll' : ''}" data-zonk-roll-zone aria-live="polite">${dice}</div>
                        <div class="parlor-zonk-roll-hint">
                            ${showZonk ? `<strong>${esc(t('Bust'))}</strong>` : ''}
                            ${choosing ? esc(status) + (points > 0 ? ` · +${fmt(points)} ${esc(t('Points'))}` : '') : (zonked ? '' : esc(status))}
                        </div>
                    </section>
                </div>
                <div class="parlor-zonk-buttons">
                    ${choosing
                        ? actionButton('keep', t('Bank'), canPlay && points > 0, 'is-save')
                        : actionButton('bank', t('Bank'), canPlay && ready && Number(state.turnPoints || 0) >= 0, 'is-save')}
                    ${actionButton('roll', hot ? t('BonusRoll') : t('Roll'), canPlay && !choosing && !zonked && !ended && !pending, 'is-throw')}
                </div>
                ${state.finalTurnsRemaining !== null && !ended ? `<div class="parlor-zonk-final">${esc(t('FinalRemaining', { count: state.finalTurnsRemaining }))}</div>` : ''}
                <div class="parlor-zonk-ante">${esc(t('EntryFee'))}: ${esc(bet)}</div>
                <section class="parlor-zonk-history">
                    <div class="parlor-zonk-history-heading"><span>${esc(t('History'))}</span><small>${esc(t('RecentActions'))}</small></div>
                    <div class="parlor-zonk-history-list">${this._history(state)}</div>
                </section>
            </main>
            <aside class="parlor-zonk-right">
                <section class="parlor-zonk-combos">
                    <div class="parlor-zonk-panel-title">${esc(t('Scoring'))}</div>
                    <div class="parlor-zonk-combo-list">${this._combos({ showDescriptions: false })}</div>
                </section>
            </aside>
            ${ended && !this._victoryDismissed ? `<div class="parlor-zonk-victory-overlay">
                <section class="parlor-zonk-victory" role="dialog" aria-modal="true" aria-label="${esc(t('VictoryTitle'))}">
                    <h2>${esc(state.winnerIds?.length === 1 ? t('VictoryTitle') : t('VictoryDrawTitle'))}</h2>
                    <p class="parlor-zonk-victory-winners">${esc((state.winnerIds || []).map(id => this._participantName(state, id)).join(', '))}</p>
                    <p>${fmt(topScore)} ${esc(t('Points'))}</p>
                    <div class="parlor-zonk-victory-actions">
                        ${game.user.isGM ? actionButton('rematch', t('Rematch'), !this._busy, 'is-throw') : `<small>${esc(t('RematchHostHint'))}</small>`}
                        ${actionButton('hide-victory', t('VictoryDismiss'), true)}
                    </div>
                </section>
            </div>` : ''}
            ${this._rulesOpen ? this._rules() : ''}
        </div>`;

        for (const node of this._overlay.querySelectorAll('[data-zonk-die]')) {
            node.addEventListener('click', () => {
                const index = Number(node.dataset.zonkDie);
                // Start from the visible synced choice, not an empty spectator cache.
                this._selected = new Set(displaySelection);
                if (this._selected.has(index)) this._selected.delete(index);
                else this._selected.add(index);
                this._editedRollId = state.rollId;
                this._editedPlayerId = state.currentPlayerId;
                const indices = [...this._selected].sort((a, b) => a - b);
                this.refresh();
                this._broadcastSelectionPreview(state.currentPlayerId, state.rollId, indices);
            });
        }
        for (const node of this._overlay.querySelectorAll('[data-zonk-action]')) {
            node.addEventListener('click', () => this._performAction(node.dataset.zonkAction));
        }
        this._overlay.querySelector('[data-zonk-rule-backdrop]')?.addEventListener('click', event => {
            if (event.target?.hasAttribute('data-zonk-rule-backdrop')) {
                this._rulesOpen = false;
                this.refresh();
            }
        });
    }

    _broadcastSelectionPreview(participantId, rollId, indices) {
        // Serialize fast clicks so slower network requests cannot overwrite a newer preview.
        this._previewQueue = this._previewQueue.catch(() => {}).then(async () => {
            const state = this.gameInstance.getState();
            if (state.phase !== 'PLAYER_TURNS' || state.turnPhase !== 'choose'
                || state.currentPlayerId !== participantId || state.rollId !== rollId) return;
            await SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
                sessionId: this.gameInstance.sessionId,
                userId: participantId,
                action: 'previewSelection',
                data: { rollId, indices }
            });
        }).catch(error => console.warn('parlor | Farkle selection preview failed', error));
    }

    async _requestRematch() {
        const state = this.gameInstance.getState();
        if (this._busy || !game.user.isGM || state.phase !== 'FINISHED') return;
        const draft = {
            ante: Number(state.ante || 10),
            targetScore: Number(state.targetScore || 5000),
            settlementMode: SettlementManager.getMode(state)
        };
        const modes = [
            [SettlementManager.MODES.CHIPS, 'Фишки'],
            ...(SettlementManager.canUseDnd5eGold() ? [
                [SettlementManager.MODES.DND5E_GOLD, 'Золото'],
                [SettlementManager.MODES.DND5E_SILVER, 'Серебро'],
                [SettlementManager.MODES.DND5E_COPPER, 'Медь']
            ] : [])
        ];
        const content = `<div class="parlor-zonk-rematch-form">
            <label>${esc(t('RematchAnte'))}
                <input type="number" name="ante" min="1" max="100000" step="1" value="${draft.ante}">
            </label>
            <label>${esc(t('RematchCurrency'))}
                <select name="settlementMode">${modes.map(([id,label]) =>
                    `<option value="${esc(id)}" ${id === draft.settlementMode ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
            </label>
            <label>${esc(t('RematchTarget'))}
                <select name="targetScore">${[2000,3000,5000,10000].map(value =>
                    `<option value="${value}" ${value === draft.targetScore ? 'selected' : ''}>${fmt(value)}</option>`).join('')}</select>
            </label>
        </div>`;
        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('RematchSettings') },
            content,
            render: (_event, dialog) => {
                const root = dialog.element || dialog;
                // The full-screen Farkle overlay is z-index 2300; Foundry dialogs
                // need their top-level application raised ABOVE the victory screen.
                const windowRoot = root.closest?.('.application') || root;
                const elevate = () => {
                    windowRoot.classList?.add('parlor-overlay-dialog', 'parlor-zonk-rematch-dialog');
                    if (windowRoot.style) windowRoot.style.zIndex = '3200';
                };
                elevate();
                requestAnimationFrame(elevate);
                setTimeout(elevate, 60);
                const fields = root.querySelectorAll('.parlor-zonk-rematch-form [name]');
                for (const field of fields) field.addEventListener('change', () => {
                    if (field.name === 'ante') draft.ante = Number(field.value);
                    if (field.name === 'targetScore') draft.targetScore = Number(field.value);
                    if (field.name === 'settlementMode') draft.settlementMode = field.value;
                });
            },
            buttons: [
                { action: 'start', label: t('Rematch'), default: true,
                    callback: () => ({ ...draft }) },
                { action: 'cancel', label: t('RematchCancel'), callback: () => null }
            ],
            rejectClose: false
        });
        if (!result || !Number.isInteger(result.ante) || result.ante < 1 || result.ante > 100000) {
            if (result) ui.notifications?.warn(t('RematchInvalid'));
            return;
        }
        this._busy = true;
        this.refresh();
        try {
            const response = await SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                sessionId: this.gameInstance.sessionId,
                action: 'rematchZonk',
                data: result
            });
            if (response?.ok === false) {
                ui.notifications?.warn(t(response.reason === 'funds'
                    ? 'RematchInsufficient' : 'RematchFailed'));
            }
        } catch (error) {
            console.error('parlor | Farkle rematch failed', error);
            ui.notifications?.error(t('RematchFailed'));
        } finally {
            this._busy = false;
            if (this._overlay) this.refresh();
        }
    }

    async _performAction(action) {
        if (action === 'close') {
            if (typeof this._requestParlorClose === 'function') await this._requestParlorClose();
            else this.close();
            return;
        }
        if (action === 'rules' || action === 'hide-rules') {
            this._rulesOpen = action === 'rules';
            this.refresh();
            return;
        }
        if (action === 'sound') {
            this._soundOn = !this._soundOn;
            this.refresh();
            return;
        }
        if (action === 'hide-victory') {
            this._victoryDismissed = true;
            this.refresh();
            return;
        }
        if (action === 'rematch') {
            if (game.user.isGM) await this._requestRematch();
            return;
        }
        if (this._busy) return;
        const state = this.gameInstance.getState();
        if (!game.user.isGM && !this._canPlay(state)) return;
        this._busy = true;
        this.refresh();
        try {
            let result;
            if (action === 'finish' || action === 'skip') {
                if (!game.user.isGM) return;
                if (action === 'finish' && state.phase !== 'FINISHED') {
                    const confirmed = await foundry.applications.api.DialogV2.confirm({
                        window: { title: t('RefundAndClose') },
                        content: '<p>' + esc(t('CancelConfirm')) + '</p>'
                    });
                    if (!confirmed) return;
                }
                result = await SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                    sessionId: this.gameInstance.sessionId,
                    action: action === 'finish' ? 'finishGame' : 'skipTurn',
                    data: {}
                });
            } else {
                if (!this._canPlay(state)) return;
                result = await SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
                    sessionId: this.gameInstance.sessionId,
                    userId: state.currentPlayerId,
                    action,
                    data: action === 'keep' ? { indices: [...this._selected] } : {}
                });
            }
            if (result?.ok === false) ui.notifications?.warn(t('InvalidAction'));
        } catch (error) {
            console.error('parlor | Zonk action failed', error);
            ui.notifications?.error(t('ActionError'));
        } finally {
            this._busy = false;
            if (this._overlay) this.refresh();
        }
    }
}
