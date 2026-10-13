import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { getControlledParticipants, getParticipantName } from '../../core/ParticipantRoster.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { getGameGuide } from '../../core/GameRegistry.js';
import { BotManager } from '../../core/BotManager.js';
import { scoreZonkDice } from './ZonkRules.js';
import { getFarkleRackDisplay } from './FarkleRack.js';
import { D6_SPRITE_PATH, normalizeD6, renderD6Face } from '../../core/DiceFaces.js';
import { Dsn3dBridge } from '../../core/Dsn3dBridge.js';

// The same physical pip dice and CSS classes used by LiarsDiceTable.
// Its stylesheet is already loaded by the parent Parlor module.
const t = (key, data) => data
    ? game.i18n.format('PARLOR.Zonk.' + key, data)
    : game.i18n.localize('PARLOR.Zonk.' + key);
const esc = value => foundry.utils.escapeHTML(String(value ?? ''));
const fmt = value => Number(value || 0).toLocaleString(game.i18n?.lang || 'ru-RU');
/**
 * Full-sized dice in Farkle use a real HTML image above the table textures.
 * The original shared WebP contains six 128px faces side-by-side.
 * An img inside the clipped face keeps the full-resolution artwork visible
 * even when Foundry/DSN overrides CSS background painting on nested buttons.
 * Compact dice in rules/history continue to use the established sprite CSS.
 */
const pipDie = (value, small = false) => {
    const face = renderD6Face(value, { className: 'parlor-ld-die', small });
    if (small) return face;
    const sliceOffset = ((normalizeD6(value) - 1) * 100 / 6).toFixed(6);
    const image = `<img class="parlor-zonk-face-image" src="${D6_SPRITE_PATH}"
        style="transform:translateX(-${sliceOffset}%)" draggable="false"
        loading="eager" decoding="sync" aria-hidden="true" alt="">`;
    return face.replace('</span>', image + '</span>');
};
const diceRow = (dice, small = false) => (dice || []).map(value => pipDie(value, small)).join('');

export class ZonkTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._dismissedByUser = false;
        this._selected = new Set();
        this._visibleRollId = null;
        this._visiblePlayerId = '';
        this._soundRollId = null;
        this._soundOn = true;
        this._rulesOpen = false;
        this._busy = false;
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
            Dsn3dBridge.attachOverlay(`zonk:${this.gameInstance.sessionId}`);
        }
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._overlay?.remove();
        this._overlay = null;
        Dsn3dBridge.detachOverlay(`zonk:${this.gameInstance.sessionId}`);
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
        const rows = (state.history || []).slice(0, 6).map(entry => {
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
            this._visibleRollId = state.rollId;
            this._visiblePlayerId = state.currentPlayerId;
        }
        // A roll's results are GM-authoritative and remain visible in the blue
        // play zone until the action changes to keep / bank / skip / Farkle.
        // Dice So Nice handles only the 3D animation of these exact values.
        // The persistent interactive faces are in our own synced table DOM,
        // not in DSN's auto-hiding full-screen scene.
        if (this._soundRollId === null) this._soundRollId = state.rollId;
        else if (this._soundRollId !== state.rollId) {
            this._soundRollId = state.rollId;
            if (state.turnPhase === 'choose' && Array.isArray(state.currentDice) && state.currentDice.length) {
                if (Dsn3dBridge.isAvailable()) {
                    Promise.resolve(Dsn3dBridge.rollD6Visuals(state.currentDice, { broadcast: false }))
                        .catch(error => console.warn('parlor | Farkle DSN roll failed', error));
                } else this._playRollSound();
            }
        }

        const choosing = state.turnPhase === 'choose';
        const ready = state.turnPhase === 'ready';
        const ended = state.phase === 'FINISHED';
        const pending = !state.started;
        const hot = ready && state.remainingDice === 6;
        const canPlay = this._canPlay(state) && !this._busy;
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
        // Show actual seated participants only, up to the supported ten.
        const roster = standings.slice(0, 10).map((id, index) => {
            const p = state.playerStates?.[id] || {};
            const active = id === state.currentPlayerId;
            const winner = state.winnerIds?.includes(id);
            return `<div class="parlor-zonk-progress-row ${active ? 'is-current' : ''} ${winner ? 'is-winner' : ''}">
                <span class="parlor-zonk-rank">${index + 1}</span>
                <span class="parlor-zonk-player" title="${esc(this._participantName(state, id))}">${esc(this._participantName(state, id))}</span>
                <strong>${fmt(p.score || 0)}</strong>
            </div>`;
        }).join('');

        const dice = choosing
            ? (state.currentDice || []).map((value, index) => `
                <button type="button" class="parlor-zonk-pick ${this._selected.has(index) ? 'is-selected' : ''}"
                    data-zonk-die="${index}" style="--z-roll-tilt:${[-5, 4, -2, 6, -3, 3][index % 6]}deg"
                    aria-pressed="${this._selected.has(index)}"
                    aria-label="${esc(t('Face', { value }))}" ${canPlay ? '' : 'disabled'}>
                    ${pipDie(value)}
                </button>`).join('')
            : ''; // Nothing on the 3D roll surface until a real roll lands.

        // Each keep action starts its OWN new row, rather than being packed
        // into remaining empty cells of the previous row.
        const rackRows = getFarkleRackDisplay(state.keptDiceRows);
        const savedCount = rackRows.reduce((sum, row) => sum + row.values.length, 0);
        const stairs = rackRows.map(({ capacity, rowIndex, values }) =>
            `<div class="parlor-zonk-stair-row" data-stair-row="${rowIndex}" data-capacity="${capacity}">
                ${Array.from({ length: capacity }, (_, col) => {
                    const face = values[col];
                    return `<div class="parlor-zonk-stair-slot ${face ? 'is-filled' : ''}" data-stair-cell="${rowIndex}-${col}">
                        ${face ? pipDie(face) : '<span class="parlor-zonk-stair-glyph" aria-hidden="true">◇</span>'}
                    </div>`;
                }).join('')}
            </div>`).join('');

        const last = (state.history || [])[0];
        const showZonk = last?.kind === 'zonk' || last?.kind === 'skip';
        const status = pending ? (state.lastError || t('Waiting'))
            : ended ? t('GameOver')
            : choosing ? t('ChooseDice')
            : ready ? (hot ? t('HotDice') : t('RollOrBank'))
            : t('ReadyToRoll');

        this._overlay.innerHTML = `<div class="parlor-zonk-layout">
            <aside class="parlor-zonk-progress">
                <div class="parlor-zonk-panel-title">${esc(t('Progress'))}</div>
                <div class="parlor-zonk-progress-score">${fmt(topScore)}<span>/${fmt(state.targetScore || 5000)}</span></div>
                <div class="parlor-zonk-progress-track"><div style="width:${progress}%"></div></div>
                <div class="parlor-zonk-progress-players">${roster}</div>
                <div class="parlor-zonk-progress-foot">
                    <small>${esc(t('Leader'))}</small><strong>${fmt(topScore)}</strong>
                </div>
            </aside>
            <main class="parlor-zonk-center">
              <header class="parlor-zonk-toolbar">
                <div class="parlor-zonk-brand"><small>АИНДОР</small><strong>FARKLE</strong></div>
                <div class="parlor-zonk-turn">${ended
                    ? esc(t('WinnerLabel')) + ' ' + esc((state.winnerIds || []).map(id => this._participantName(state, id)).join(', '))
                    : esc(t('TurnOf')) + ' ' + esc(current || '—')}</div>
                <div class="parlor-zonk-round">${esc(t('Round'))} ${Number(state.round || 1)}
                    ${state.finalTurnsRemaining !== null ? ' · ' + esc(t('FinalRound')) : ''}</div>
                <div class="parlor-zonk-toolbar-buttons">
                    <button type="button" data-zonk-action="rules" title="${esc(t('Rules'))}">◫ ${esc(t('Rules'))}</button>
                    <button type="button" data-zonk-action="sound" aria-pressed="${this._soundOn}" title="${esc(t('Sound'))}">${this._soundOn ? '◖))' : '◖×'}</button>
                    <button type="button" data-zonk-action="close" title="${esc(t('Close'))}">✕</button>
                </div>
              </header>
              <div class="parlor-zonk-velvet">
                <div class="parlor-zonk-lower-board">
                  <section class="parlor-zonk-status-area">
                    <div class="parlor-zonk-choice">
                      ${showZonk ? `<strong class="parlor-zonk-bust-mark">${esc(t('Bust'))}!</strong>` : ''}
                      <span>${esc(status)}</span>
                    </div>
                    ${choosing && canPlay ? `<div class="parlor-zonk-selection">${points > 0
                      ? '+' + fmt(points) + ' ' + esc(t('Points')) : esc(t('SelectValid'))}</div>` : ''}
                    <div class="parlor-zonk-mini-stats">
                      <div><small>${esc(t('TurnPoints'))}</small><b>${fmt(state.turnPoints || 0)}</b></div>
                      <div><small>${esc(t('DiceLeft'))}</small><b>${state.remainingDice || 6}</b></div>
                      <div><small>${esc(t('Pot'))}</small><b>${esc(pot)}</b></div>
                    </div>
                  </section>
                  <section class="parlor-zonk-saved-area" aria-label="${esc(t('SavedDice'))}">
                    <div class="parlor-zonk-saved-heading">${esc(t('SavedDice'))} <span>${savedCount}/21</span></div>
                    <div class="parlor-zonk-staircase">${stairs}</div>
                  </section>
                </div>
                <section class="parlor-zonk-roll-zone" aria-label="${esc(t('DiceLeft'))}">
                  <div class="parlor-zonk-roll-zone-heading">${esc(t('RollZone'))}</div>
                  <div class="parlor-zonk-dice-tray" data-zonk-roll-zone aria-live="polite">${dice}</div>
                  ${!choosing && !ended ? `<div class="parlor-zonk-roll-zone-hint">${esc(t('RollZoneHint'))}</div>` : ''}
                </section>
                <div class="parlor-zonk-buttons">
                  ${choosing
                    ? actionButton('keep', t('Keep', { points: fmt(points || 0) }), canPlay && points > 0, 'is-save')
                    : actionButton('bank', t('Bank'), canPlay && ready && Number(state.turnPoints || 0) >= (state.minBank || 300), 'is-save')}
                  ${actionButton('roll', hot ? t('BonusRoll') : t('Roll'), canPlay && !choosing && !ended && !pending, 'is-throw')}
                </div>
                ${state.finalTurnsRemaining !== null && !ended ? `<div class="parlor-zonk-final">${esc(t('FinalRemaining', { count: state.finalTurnsRemaining }))}</div>` : ''}
                <div class="parlor-zonk-ante">${esc(t('EntryFee'))}: ${esc(bet)} · ${esc(t('MinBank'))}: ${fmt(state.minBank || 300)}</div>
              </div>
              <section class="parlor-zonk-history">
                <div class="parlor-zonk-history-heading"><span>${esc(t('History'))}</span><small>${esc(t('RecentActions'))}</small></div>
                <div class="parlor-zonk-history-list">${this._history(state)}</div>
              </section>
              ${game.user.isGM ? `<div class="parlor-zonk-gm">
                  ${actionButton('skip', t('SkipTurn'), !ended && !pending && !this._busy)}
                  ${actionButton('finish', ended ? t('PayAndClose') : t('RefundAndClose'), !this._busy, 'is-danger')}
              </div>` : ''}
            </main>
            <aside class="parlor-zonk-combos">
                <div class="parlor-zonk-panel-title">${esc(t('Scoring'))}</div>
                <div class="parlor-zonk-combo-list">${this._combos({ showDescriptions: false })}</div>
            </aside>
            ${this._rulesOpen ? this._rules() : ''}
        </div>`;

        for (const node of this._overlay.querySelectorAll('[data-zonk-die]')) {
            node.addEventListener('click', () => {
                const index = Number(node.dataset.zonkDie);
                if (this._selected.has(index)) this._selected.delete(index);
                else this._selected.add(index);
                this.refresh();
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
