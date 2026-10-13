import { GameBase } from '../GameBase.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import {
    ZONK_DICE, ZONK_DEFAULT_TARGET, ZONK_MIN_BANK,
    scoreZonkDice, canScoreZonkRoll
} from './ZonkRules.js';
import { appendFarkleRackRow } from './FarkleRack.js';

const boundedInt = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};
const rollD6 = (random) => {
    const r = Number(random());
    return 1 + Math.floor(Math.max(0, Math.min(0.99999999999999, Number.isFinite(r) ? r : 0)) * 6);
};

/** GM-authoritative multiplayer Zonk. All dice, scores and wagers are public. */
export class ZonkGame extends GameBase {
    static get gameType() { return 'zonk'; }

    constructor(config) {
        super(config);
        this.ante = boundedInt(config?.gameOptions?.ante, 10, 1, 100000);
        this.targetScore = boundedInt(config?.gameOptions?.targetScore, ZONK_DEFAULT_TARGET, 1000, 20000);
        this.minBank = ZONK_MIN_BANK;
        this.exemptIds = new Set(config?.gameOptions?.exemptParticipantIds || []);
        this._rng = typeof config?.zonkRng === 'function' ? config.zonkRng : Math.random;
        this.turnOrder = [...this.playerIds];
        this.playerStates = {};
        this.currentPlayerId = '';
        this.currentDice = [];
        this.keptDice = [];
        this.keptDiceRows = [];
        this.remainingDice = ZONK_DICE;
        this.turnPoints = 0;
        this.turnPhase = 'needRoll';
        this.rollId = 0;
        this.pot = 0;
        this.lastRoll = [];
        this.lastEvent = '';
        this.history = [];
        this.historySequence = 0;
        this.winnerIds = [];
        this.finalTurnsRemaining = null;
        this.settlementApplied = false;
        this.started = false;
        this.lastError = '';
    }

    get phases() { return ['IDLE', 'PLAYER_TURNS', 'FINISHED']; }
    get transitions() {
        return {
            IDLE: ['PLAYER_TURNS'],
            PLAYER_TURNS: ['FINISHED'],
            FINISHED: []
        };
    }

    async start() {
        if (this.started) return { ok: false, reason: 'already-started' };
        if (this.turnOrder.length < 2 || this.turnOrder.length > 10) {
            this.lastError = 'Для Farkle требуется от 2 до 10 участников.';
            return { ok: false, reason: 'players' };
        }
        const shortIds = this.turnOrder.filter(id => !this.exemptIds.has(id)
            && !SettlementManager.canAfford(id, this.ante, this));
        if (shortIds.length) {
            this.lastError = 'Недостаточно средств для взноса: ' + shortIds.join(', ');
            return { ok: false, reason: 'funds', shortIds };
        }
        const contributions = this.turnOrder
            .filter(id => !this.exemptIds.has(id))
            .map(userId => ({ userId, delta: -this.ante }));
        const ok = await SettlementManager.applyDeltas(contributions, this);
        if (ok === false) {
            this.lastError = 'Не удалось списать вступительные взносы.';
            return { ok: false, reason: 'settlement' };
        }
        this.started = true;
        this.pot = this.ante * contributions.length;
        this._record('start', '', { points: this.pot });
        this.playerStates = Object.fromEntries(this.turnOrder.map(id => [id, {
            score: 0, status: 'waiting', lastGain: 0, zonks: 0, turns: 0
        }]));
        this.round = 1;
        this._transition('PLAYER_TURNS');
        this._beginTurn();
        await this._broadcastState();
        return { ok: true };
    }

    getState() {
        return {
            ...super.getState(),
            ante: this.ante,
            targetScore: this.targetScore,
            minBank: this.minBank,
            turnOrder: this.turnOrder,
            playerStates: this.playerStates,
            currentPlayerId: this.currentPlayerId,
            currentDice: this.currentDice,
            keptDice: this.keptDice,
            keptDiceRows: this.keptDiceRows,
            remainingDice: this.remainingDice,
            turnPoints: this.turnPoints,
            turnPhase: this.turnPhase,
            rollId: this.rollId,
            pot: this.pot,
            lastRoll: this.lastRoll,
            lastEvent: this.lastEvent,
            history: this.history,
            historySequence: this.historySequence,
            winnerIds: this.winnerIds,
            finalTurnsRemaining: this.finalTurnsRemaining,
            settlementApplied: this.settlementApplied,
            started: this.started,
            lastError: this.lastError
        };
    }

    setState(state) {
        super.setState(state);
        for (const key of [
            'ante', 'targetScore', 'minBank', 'turnOrder', 'playerStates',
            'currentPlayerId', 'currentDice', 'keptDice', 'keptDiceRows', 'remainingDice', 'turnPoints',
            'turnPhase', 'rollId', 'pot', 'lastRoll', 'lastEvent', 'winnerIds',
            'finalTurnsRemaining', 'settlementApplied', 'started', 'lastError',
            'history', 'historySequence'
        ]) {
            if (Object.prototype.hasOwnProperty.call(state, key)) this[key] = state[key];
        }
    }

    handlePlayerAction(participantId, action, data = {}) {
        if (this.phase !== 'PLAYER_TURNS') return { ok: false, reason: 'phase' };
        if (participantId !== this.currentPlayerId || !this.playerIds.has(participantId)) {
            return { ok: false, reason: 'turn' };
        }

        if (action === 'roll') {
            if (!['needRoll', 'ready'].includes(this.turnPhase)) return { ok: false, reason: 'keep-first' };
            // All hot-dice rerolls keep their saved dice, filling the 6→1 staircase
            // across throws. We retain the most recent 21 dice (six visible tiers).
            this.currentDice = Array.from({ length: this.remainingDice }, () => rollD6(this._rng));
            this.lastRoll = [...this.currentDice];
            this.rollId++;
            this._record('roll', participantId, { dice: [...this.currentDice] });
            this.turnPhase = 'choose';
            if (!canScoreZonkRoll(this.currentDice)) {
                this._finishTurn(0, true);
            }
            this._broadcastState();
            return { ok: true };
        }

        if (action === 'keep') {
            if (this.turnPhase !== 'choose') return { ok: false, reason: 'phase' };
            const indices = data?.indices;
            if (!Array.isArray(indices) || !indices.length
                || indices.length > this.currentDice.length
                || !indices.every(i => Number.isInteger(i) && i >= 0 && i < this.currentDice.length)
                || new Set(indices).size !== indices.length) {
                return { ok: false, reason: 'selection' };
            }
            const points = scoreZonkDice(indices.map(i => this.currentDice[i]));
            if (!points) return { ok: false, reason: 'invalid-combination' };
            this.turnPoints += points;
            const kept = indices.map(i => this.currentDice[i]);
            this.keptDiceRows = appendFarkleRackRow(this.keptDiceRows, kept);
            this.keptDice = [...this.keptDice, ...kept].slice(-21);
            this._record('keep', participantId, { dice: kept, points });
            this.remainingDice -= indices.length;
            this.currentDice = [];
            if (this.remainingDice === 0) this.remainingDice = ZONK_DICE;
            this.turnPhase = 'ready';
            this.lastEvent = `+${points} очков за комбинацию`;
            this._broadcastState();
            return { ok: true, points };
        }

        if (action === 'bank') {
            if (this.turnPhase !== 'ready' || this.turnPoints < this.minBank) {
                return { ok: false, reason: 'minimum-bank' };
            }
            this._finishTurn(this.turnPoints, false);
            this._broadcastState();
            return { ok: true };
        }
        return { ok: false, reason: 'action' };
    }

    async handleGMAction(action) {
        if (action === 'skipTurn' && this.phase === 'PLAYER_TURNS') {
            this._finishTurn(0, true, { skipped: true });
            await this._broadcastState();
            return { ok: true };
        }
        if (action === 'finishGame') {
            await this._settleOrRefund();
            return { ok: true };
        }
        return { ok: false, reason: 'action' };
    }

    _beginTurn() {
        this.currentPlayerId = this.turnOrder[this._nextIndex || 0] || '';
        this._nextIndex = this._nextIndex ?? 0;
        this.currentDice = [];
        this.keptDice = [];
        this.keptDiceRows = [];
        this.remainingDice = ZONK_DICE;
        this.turnPoints = 0;
        this.turnPhase = 'needRoll';
        if (this.playerStates[this.currentPlayerId]) {
            this.playerStates[this.currentPlayerId].status = 'playing';
        }
    }

    _record(kind, participantId = '', payload = {}) {
        const entry = {
            id: ++this.historySequence,
            kind,
            participantId: String(participantId || ''),
            dice: Array.isArray(payload.dice) ? payload.dice.slice(0, ZONK_DICE) : [],
            points: Number(payload.points || 0),
            time: Date.now()
        };
        this.history = [entry, ...this.history].slice(0, 7);
    }

    _finishTurn(gain, zonk, { skipped = false } = {}) {
        const id = this.currentPlayerId;
        const seat = this.playerStates[id];
        if (!seat) return;
        seat.turns++;
        seat.lastGain = gain;
        if (zonk) seat.zonks++;
        this._record(skipped ? 'skip' : (zonk ? 'zonk' : 'bank'), id, {
            points: gain, dice: zonk ? this.lastRoll : []
        });
        seat.score += gain;
        seat.status = zonk ? 'zonk' : 'banked';
        this.lastEvent = zonk
            ? 'Farkle! Очки текущего хода сгорели.'
            : `В копилку добавлено ${gain} очков.`;
        this.currentDice = [];
        this.keptDice = [];
        this.keptDiceRows = [];
        this.turnPoints = 0;

        const triggeredFinal = this.finalTurnsRemaining === null && seat.score >= this.targetScore;
        if (triggeredFinal) {
            this.finalTurnsRemaining = this.turnOrder.length - 1;
            this.lastEvent += ' Последний круг!';
        } else if (this.finalTurnsRemaining !== null) {
            this.finalTurnsRemaining--;
        }

        if (this.finalTurnsRemaining !== null && this.finalTurnsRemaining <= 0) {
            this._finishMatch();
            return;
        }
        this._nextIndex = ((this._nextIndex || 0) + 1) % this.turnOrder.length;
        if (this._nextIndex === 0) this.round++;
        this._beginTurn();
    }

    _finishMatch() {
        const maxScore = Math.max(...Object.values(this.playerStates).map(s => s.score));
        this.winnerIds = this.turnOrder.filter(id => this.playerStates[id].score === maxScore);
        this.currentPlayerId = '';
        this.currentDice = [];
        this.keptDice = [];
        this.keptDiceRows = [];
        this.turnPhase = 'complete';
        this.lastEvent = this.winnerIds.length === 1
            ? 'Партия завершена. Победитель определён!'
            : 'Партия завершена. Ничья по очкам!';
        this._transition('FINISHED');
        this._record('finish', this.winnerIds[0] || '', { points: maxScore });
    }

    async _settleOrRefund() {
        if (this.settlementApplied || !this.started) return;
        // A cancelled, unfinished match returns all entry fees.
        const payers = this.turnOrder.filter(id => !this.exemptIds.has(id));
        let entries = [];
        if (this.phase === 'FINISHED' && this.winnerIds.length) {
            const share = Math.floor(this.pot / this.winnerIds.length);
            let remainder = this.pot - share * this.winnerIds.length;
            entries = this.winnerIds.map(id => ({
                userId: id, delta: share + (remainder-- > 0 ? 1 : 0)
            }));
        } else {
            entries = payers.map(userId => ({ userId, delta: this.ante }));
        }
        const applied = await SettlementManager.applyDeltas(entries, this);
        if (applied !== false) {
            this.settlementApplied = true;
            this._record(this.phase === 'FINISHED' ? 'paid' : 'refund', '', { points: this.pot });
            await this._broadcastState();
        }
    }
}
