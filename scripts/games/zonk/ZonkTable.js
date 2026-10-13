import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { getControlledParticipants, getParticipantName } from '../../core/ParticipantRoster.js';
import { BotManager } from '../../core/BotManager.js';
import { getZonkKeepOptions, scoreZonkDice } from './ZonkRules.js';

const FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
const t = (key, data) => data ? game.i18n.format('PARLOR.Zonk.' + key, data) : game.i18n.localize('PARLOR.Zonk.' + key);
const esc = (value) => foundry.utils.escapeHTML(String(value ?? ''));

export class ZonkTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._dismissedByUser = false;
        this._selected = new Set();
        this._visibleRollId = null;
        this._visiblePlayerId = '';
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
        }
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._overlay?.remove();
        this._overlay = null;
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

    refresh() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        if (this._visibleRollId !== state.rollId || this._visiblePlayerId !== state.currentPlayerId || state.turnPhase !== 'choose') {
            this._selected.clear();
            this._visibleRollId = state.rollId;
            this._visiblePlayerId = state.currentPlayerId;
        }

        const current = state.currentPlayerId ? this._participantName(state, state.currentPlayerId) : '';
        const canPlay = this._canPlay(state) && !this._busy;
        const options = state.turnPhase === 'choose' ? getZonkKeepOptions(state.currentDice || []) : [];
        const selectedIndices = [...this._selected].sort((a, b) => a - b);
        const selectedScore = scoreZonkDice(selectedIndices.map(index => state.currentDice?.[index]));
        const dice = state.turnPhase === 'choose' ? (state.currentDice || []) : [];
        const ready = state.turnPhase === 'ready';
        const choosing = state.turnPhase === 'choose';
        const ended = state.phase === 'FINISHED';
        const pending = !state.started;
        const hot = state.remainingDice === 6 && ready;
        const button = (action, label, enabled, kind = '') => `<button type="button" class="parlor-zonk-btn ${kind}" data-zonk-action="${action}" ${enabled ? '' : 'disabled'}>${esc(label)}</button>`;

        const rankings = [...(state.turnOrder || [])].sort((a, b) => (state.playerStates?.[b]?.score || 0) - (state.playerStates?.[a]?.score || 0));
        const seats = rankings.map((id, index) => {
            const p = state.playerStates?.[id] || {};
            const active = id === state.currentPlayerId;
            const winner = state.winnerIds?.includes(id);
            return `<div class="parlor-zonk-seat ${active ? 'is-active' : ''} ${winner ? 'is-winner' : ''}">
                <span class="parlor-zonk-seat-rank">${index + 1}</span>
                <div class="parlor-zonk-seat-name">${esc(this._participantName(state, id))}
                    <small>${winner ? esc(t('Winner')) : active ? esc(t('NowPlaying')) : (p.status === 'zonk' ? esc(t('Bust')) : '')}</small>
                </div>
                <strong>${Number(p.score || 0).toLocaleString('ru-RU')}</strong>
                <span class="parlor-zonk-seat-zonks" title="${esc(t('Busts'))}">☠ ${Number(p.zonks || 0)}</span>
            </div>`;
        }).join('');

        const diceMarkup = choosing
            ? dice.map((face, index) => `<button type="button" class="parlor-zonk-die ${this._selected.has(index) ? 'is-selected' : ''}"
               data-zonk-die="${index}" aria-pressed="${this._selected.has(index)}" ${canPlay ? '' : 'disabled'}
               aria-label="${esc(t('Die'))} ${index + 1}: ${face}"><span>${FACES[face] || '?'}</span><em>${face}</em></button>`).join('')
            : Array.from({ length: state.remainingDice || 6 }, () => '<span class="parlor-zonk-die is-waiting"><span>⚄</span></span>').join('');

        const status = pending ? (state.lastError || t('Waiting'))
            : ended ? t('GameOver')
            : choosing ? t('ChooseDice')
            : ready ? (hot ? t('HotDice') : t('RollOrBank'))
            : t('ReadyToRoll');

        const turnMarker = ended
            ? `<div class="parlor-zonk-last">${esc(t('WinnerLabel'))} ${esc((state.winnerIds || []).map(id => this._participantName(state, id)).join(', '))}</div>`
            : `<div class="parlor-zonk-current">${esc(t('TurnOf'))} <b>${esc(current || '—')}</b></div>`;

        this._overlay.innerHTML = `
        <div class="parlor-zonk-layout">
          <header class="parlor-zonk-header">
            <div><div class="parlor-zonk-kicker">${esc(t('Kicker'))}</div><h1>${esc(t('Title'))}</h1><div class="parlor-zonk-tagline">${esc(t('Tagline'))}</div></div>
            <div class="parlor-zonk-header-right">
              <div class="parlor-zonk-metric"><small>${esc(t('Target'))}</small><strong>${Number(state.targetScore || 5000).toLocaleString('ru-RU')}</strong></div>
              <div class="parlor-zonk-metric"><small>${esc(t('Pot'))}</small><strong>${Number(state.pot || 0).toLocaleString('ru-RU')}</strong></div>
              <button type="button" class="parlor-zonk-close" data-zonk-action="close" aria-label="${esc(t('Close'))}">×</button>
            </div>
          </header>
          <div class="parlor-zonk-body">
            <main class="parlor-zonk-table">
              <div class="parlor-zonk-table-inner">
                <div class="parlor-zonk-round">${esc(t('Round'))} ${state.round || 1} ${state.finalTurnsRemaining !== null ? '· ' + esc(t('FinalRound')) : ''}</div>
                ${turnMarker}
                <div class="parlor-zonk-dice" aria-live="polite">${diceMarkup}</div>
                <div class="parlor-zonk-info">${esc(status)}</div>
                ${choosing && canPlay ? `<div class="parlor-zonk-selection">${selectedScore ? '+' + selectedScore + ' ' + esc(t('Points')) : esc(t('SelectValid'))}</div>` : ''}
                <div class="parlor-zonk-totals">
                    <div><small>${esc(t('TurnPoints'))}</small><b>${Number(state.turnPoints || 0).toLocaleString('ru-RU')}</b></div>
                    <div><small>${esc(t('DiceLeft'))}</small><b>${state.remainingDice || 6}</b></div>
                    <div><small>${esc(t('MinBank'))}</small><b>${state.minBank || 300}</b></div>
                </div>
                <div class="parlor-zonk-actions">
                  ${choosing ? `${button('best', t('AutoSelect'), canPlay && options.length > 0)}
                                   ${button('keep', t('Keep', { points: selectedScore || 0 }), canPlay && selectedScore > 0, 'is-primary')}` : ''}
                  ${!choosing && !ended && !pending ? `${button('roll', hot ? t('BonusRoll') : t('Roll'), canPlay, 'is-primary')}
                    ${button('bank', t('Bank'), canPlay && ready && Number(state.turnPoints || 0) >= (state.minBank || 300))}` : ''}
                </div>
                <div class="parlor-zonk-event" role="status">${esc(state.lastEvent || (pending ? state.lastError || '' : t('Tip')))}</div>
                ${state.finalTurnsRemaining !== null && !ended ? `<div class="parlor-zonk-final">${esc(t('FinalRemaining', { count: state.finalTurnsRemaining }))}</div>` : ''}
              </div>
            </main>
            <aside class="parlor-zonk-sidebar">
              <h2>${esc(t('Scoreboard'))}</h2>
              <div class="parlor-zonk-seats">${seats}</div>
              <div class="parlor-zonk-cheatsheet">
                 <h3>${esc(t('Scoring'))}</h3>
                 <div>⚀ = 100 · ⚄ = 50</div>
                 <div>⚀⚀⚀ = 1000</div>
                 <div>${esc(t('TripleNote'))}</div>
                 <div>${esc(t('MultiplesNote'))}</div>
                 <div>${esc(t('PairsNote'))}</div>
                 <div>${esc(t('StraightNote'))}</div>
              </div>
              ${game.user.isGM ? `<div class="parlor-zonk-gm">
                 <div>${esc(t('GmTools'))}</div>
                 ${button('skip', t('SkipTurn'), !ended && !pending, '')}
                 ${button('finish', ended ? t('PayAndClose') : t('RefundAndClose'), !this._busy, 'is-danger')}
              </div>` : ''}
            </aside>
          </div>
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
    }

    async _performAction(action) {
        if (action === 'close') {
            if (typeof this._requestParlorClose === 'function') await this._requestParlorClose();
            else this.close();
            return;
        }
        const state = this.gameInstance.getState();
        if (action === 'best') {
            const best = getZonkKeepOptions(state.currentDice || [])[0];
            this._selected = new Set(best?.indices || []);
            this.refresh();
            return;
        }
        if (this._busy) return;
        if (!game.user.isGM && !this._canPlay(state)) return;
        this._busy = true;
        this.refresh();
        try {
            let result;
            if (action === 'finish' || action === 'skip') {
                if (!game.user.isGM) return;
                if (action === 'finish' && state.phase !== 'FINISHED') {
                    const decision = await foundry.applications.api.DialogV2.confirm({
                        window: { title: t('RefundAndClose') },
                        content: '<p>' + esc(t('CancelConfirm')) + '</p>'
                    });
                    if (!decision) return;
                }
                const cmd = action === 'finish' ? 'finishGame' : 'skipTurn';
                result = await SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                    sessionId: this.gameInstance.sessionId, action: cmd, data: {}
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
