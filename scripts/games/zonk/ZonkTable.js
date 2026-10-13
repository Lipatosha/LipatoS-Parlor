import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { getControlledParticipants, getParticipantName } from '../../core/ParticipantRoster.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { getGameGuide } from '../../core/GameRegistry.js';
import { BotManager } from '../../core/BotManager.js';
import { scoreZonkDice } from './ZonkRules.js';

// The same physical pip dice and CSS classes used by LiarsDiceTable.
// Its stylesheet is already loaded by the parent Parlor module.
const PIPS = Object.freeze({
    1: [5], 2: [1, 9], 3: [1, 5, 9],
    4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
});
const t = (key, data) => data
    ? game.i18n.format('PARLOR.Zonk.' + key, data)
    : game.i18n.localize('PARLOR.Zonk.' + key);
const esc = value => foundry.utils.escapeHTML(String(value ?? ''));
const fmt = value => Number(value || 0).toLocaleString(game.i18n?.lang || 'ru-RU');
const pipDie = (value, small = false) => {
    const dots = PIPS[value] || [];
    return `<span class="parlor-ld-die ${small ? 'is-small' : ''}" aria-label="${esc(t('Face', { value }))}">
        ${Array.from({ length: 9 }, (_, i) =>
            `<span class="parlor-ld-pip pip-${i + 1} ${dots.includes(i + 1) ? 'is-on' : ''}"></span>`).join('')}
    </span>`;
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
        this._audioContext = null;
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
        }
        this.refresh();
    }

    close({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._overlay?.remove();
        this._overlay = null;
        this._rulesOpen = false;
        this._busy = false;
        this._audioContext?.close?.().catch?.(() => {});
        this._audioContext = null;
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

    _audio() {
        if (!this._soundOn) return null;
        try {
            const AudioClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioClass) return null;
            this._audioContext ||= new AudioClass();
            return this._audioContext;
        } catch { return null; }
    }

    /** Lightweight wooden-dice rattle: generated locally, no external assets/network. */
    _playRollSound() {
        const ctx = this._audio();
        if (!ctx) return;
        try {
            if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
            const duration = 0.68;
            const samples = Math.floor(ctx.sampleRate * duration);
            const buffer = ctx.createBuffer(1, samples, ctx.sampleRate);
            const channel = buffer.getChannelData(0);
            const hits = [0, .045, .09, .15, .21, .285, .365, .43, .51];
            for (const [index, at] of hits.entries()) {
                const offset = Math.floor(ctx.sampleRate * at);
                const length = Math.floor(ctx.sampleRate * (.055 - Math.min(index, 7) * .003));
                const strength = Math.max(.10, .65 - index * .062);
                for (let i = 0; i < length && offset + i < samples; i++) {
                    const time = i / ctx.sampleRate;
                    const env = Math.exp(-time * 86);
                    const crackle = (Math.random() * 2 - 1) * .65;
                    const knock = Math.sin(2 * Math.PI * (230 + index * 27) * time) * .35;
                    channel[offset + i] += Math.max(-1, Math.min(1, (crackle + knock) * env * strength));
                }
            }
            const source = ctx.createBufferSource();
            const filter = ctx.createBiquadFilter();
            const gain = ctx.createGain();
            source.buffer = buffer;
            filter.type = 'lowpass';
            filter.frequency.value = 2200;
            gain.gain.value = .65;
            source.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);
            source.start();
            source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
        } catch (error) {
            console.warn('parlor | Zonk dice sound unavailable', error);
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

    _combos() {
        const combo = (values, points, description = '') => `<div class="parlor-zonk-combo-row">
            <span class="parlor-zonk-combo-faces">${diceRow(values, true)}</span>
            <span class="parlor-zonk-combo-value">${esc(points)}</span>
            ${description ? `<small>${esc(description)}</small>` : ''}
        </div>`;
        return `
            ${combo([1], '100')}
            ${combo([5], '50')}
            ${combo([1, 1, 1], '1000')}
            ${combo([2, 2, 2], '200')}
            ${combo([3, 3, 3], '300')}
            ${combo([4, 4, 4], '400')}
            ${combo([5, 5, 5], '500')}
            ${combo([6, 6, 6], '600')}
            ${combo([1, 1, 2, 2, 3, 3], '750', t('ThreePairs'))}
            ${combo([1, 2, 3, 4, 5, 6], '1500', t('Straight'))}
            <div class="parlor-zonk-combo-extra">${esc(t('MultiplesNote'))}</div>`;
    }

    _rules() {
        const guide = getGameGuide('zonk');
        return `<div class="parlor-zonk-rules-backdrop" data-zonk-rule-backdrop>
            <section class="parlor-zonk-rules" role="dialog" aria-modal="true" aria-label="${esc(t('Rules'))}">
                <header><h2>${esc(t('Rules'))}</h2><button type="button" data-zonk-action="hide-rules" aria-label="${esc(t('Close'))}">×</button></header>
                <div class="parlor-zonk-rules-content">
                    <p class="parlor-zonk-rules-intro">${esc(guide?.summary || '')}</p>
                    ${(guide?.paragraphs || []).map(text => `<p>${esc(text)}</p>`).join('')}
                    <h3>${esc(t('Scoring'))}</h3>
                    <div class="parlor-zonk-rules-combos">${this._combos()}</div>
                    ${guide?.note ? `<p class="parlor-zonk-rules-note">${esc(guide.note)}</p>` : ''}
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
        if (this._soundRollId === null) this._soundRollId = state.rollId;
        else if (this._soundRollId !== state.rollId) {
            this._soundRollId = state.rollId;
            this._playRollSound();
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
        const roster = Array.from({ length: Math.max(6, standings.length) }, (_, index) => {
            const id = standings[index];
            if (!id) return `<div class="parlor-zonk-progress-row is-empty"><span>${index + 1}</span><small>—</small></div>`;
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
                    data-zonk-die="${index}" aria-pressed="${this._selected.has(index)}"
                    aria-label="${esc(t('Face', { value }))}" ${canPlay ? '' : 'disabled'}>
                    ${pipDie(value)}
                </button>`).join('')
            : Array.from({ length: state.remainingDice || 6 }, () =>
                `<div class="parlor-zonk-pick is-placeholder">${pipDie(5)}</div>`).join('');

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
                <div class="parlor-zonk-toolbar">
                    <span class="parlor-zonk-aindor">✦ АИНДОР ✦</span>
                    <div class="parlor-zonk-toolbar-buttons">
                        <button type="button" data-zonk-action="rules">📜 ${esc(t('Rules'))}</button>
                        <button type="button" data-zonk-action="sound" aria-pressed="${this._soundOn}" title="${esc(t('Sound'))}">${this._soundOn ? '🔊' : '🔇'}</button>
                        <button type="button" data-zonk-action="close" title="${esc(t('Close'))}">✕</button>
                    </div>
                </div>
                <div class="parlor-zonk-velvet">
                    <div class="parlor-zonk-stars">✦ · ✧ · ✦</div>
                    <div class="parlor-zonk-title">${esc(t('Title'))}</div>
                    <div class="parlor-zonk-round">${esc(t('Round'))} ${Number(state.round || 1)}
                      ${state.finalTurnsRemaining !== null ? ' · ' + esc(t('FinalRound')) : ''}</div>
                    <div class="parlor-zonk-turn">${ended
                        ? esc(t('WinnerLabel')) + ' ' + esc((state.winnerIds || []).map(id => this._participantName(state, id)).join(', '))
                        : esc(t('TurnOf')) + ' ' + esc(current || '—')}</div>
                    <div class="parlor-zonk-dice-tray">${dice}</div>
                    <div class="parlor-zonk-choice">${showZonk ? `<div class="parlor-zonk-bust-mark">☠ ЗОНК!</div>` : ''}
                         <span>${esc(status)}</span></div>
                    ${choosing && canPlay ? `<div class="parlor-zonk-selection">${points > 0
                        ? '+' + fmt(points) + ' ' + esc(t('Points')) : esc(t('SelectValid'))}</div>` : ''}
                    <div class="parlor-zonk-mini-stats">
                        <div><small>${esc(t('TurnPoints'))}</small><b>${fmt(state.turnPoints || 0)}</b></div>
                        <div><small>${esc(t('DiceLeft'))}</small><b>${state.remainingDice || 6}</b></div>
                        <div><small>${esc(t('Pot'))}</small><b>${esc(pot)}</b></div>
                    </div>
                    <div class="parlor-zonk-buttons">
                        ${choosing ? actionButton('keep', t('Keep', { points: fmt(points || 0) }), canPlay && points > 0, 'is-save') : ''}
                        ${!choosing && !ended && !pending ? `
                            ${actionButton('bank', t('Bank'), canPlay && ready && Number(state.turnPoints || 0) >= (state.minBank || 300), 'is-save')}
                            ${actionButton('roll', hot ? t('BonusRoll') : t('Roll'), canPlay, 'is-throw')}
                        ` : ''}
                    </div>
                    ${state.finalTurnsRemaining !== null && !ended ? `<div class="parlor-zonk-final">${esc(t('FinalRemaining', { count: state.finalTurnsRemaining }))}</div>` : ''}
                    <div class="parlor-zonk-ante">${esc(t('EntryFee'))}: ${esc(bet)} · ${esc(t('MinBank'))}: ${fmt(state.minBank || 300)}</div>
                </div>
                <div class="parlor-zonk-history">
                    <div class="parlor-zonk-history-heading"><span>${esc(t('History'))}</span><small>${esc(t('RecentActions'))}</small></div>
                    <div class="parlor-zonk-history-list">${this._history(state)}</div>
                </div>
                ${game.user.isGM ? `<div class="parlor-zonk-gm">
                   ${actionButton('skip', t('SkipTurn'), !ended && !pending && !this._busy)}
                   ${actionButton('finish', ended ? t('PayAndClose') : t('RefundAndClose'), !this._busy, 'is-danger')}
                </div>` : ''}
            </main>
            <aside class="parlor-zonk-combos">
                <div class="parlor-zonk-panel-title">${esc(t('Scoring'))}</div>
                <div class="parlor-zonk-combo-list">${this._combos()}</div>
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
            this._audio()?.resume?.().catch?.(() => {});
            this.refresh();
            return;
        }
        if (this._busy) return;
        const state = this.gameInstance.getState();
        if (!game.user.isGM && !this._canPlay(state)) return;
        if (action === 'roll') this._audio()?.resume?.().catch?.(() => {});
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
