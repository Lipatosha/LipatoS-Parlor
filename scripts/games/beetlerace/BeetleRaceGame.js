/**
 * 甲虫赛跑 · 引擎（主机权威）
 *
 * 阶段：PARADE（入场巡游，只在第一场）→ BETTING → COUNTDOWN → RACING → RESOLVING，newRound 回到 BETTING。
 *
 * 比赛本身不走状态广播逐帧同步：主机开跑时定一个种子，各端拿同一份 spec 各跑各的 BeetleRaceSim。
 * DM 作弊 = 往 run.interventions 里追加一条"第 N 步生效"的记录再广播一次，N 比主机当前步多一截提前量。
 *
 * 时间：各端电脑时钟对不齐，所以广播的是"还剩 / 已过多少毫秒"，接收端从收到那一刻往后算（见 getClock）。
 * 钱：注额下注时不扣，结算时一次性 applyDeltas（newRound / finishGame 各调一次，settlementApplied 兜幂等）；
 * 局中被强制散桌不动钱。
 */

import { GameBase } from '../GameBase.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { ParlorManager } from '../../core/ParlorManager.js';
import { isBotParticipantId, isNpcParticipantId } from '../../core/ParticipantRoster.js';
import { BeetleRaceSim, INTERVENTION_LEAD_STEPS } from './BeetleRaceSim.js';
import { BeetleRaceLibrary } from './BeetleRaceLibrary.js';
import {
    PARADE_STEP_MS,
    PARADE_INTRO_MS,
    COUNTDOWN_MS,
    RESOLVE_GRACE_MS,
    buildSimSpec,
    applyBet,
    computeSettlement
} from './BeetleRaceRules.js';

const TICK_MS = 100;

export class BeetleRaceGame extends GameBase {
    static get gameType() { return 'beetlerace'; }

    constructor(config) {
        super(config);
        // 开桌时大厅已经把赛事卡解析成完整快照塞进来了（见 BeetleRaceLibrary.resolveRace）
        this.race = config?.gameOptions?.race || null;
        this.exemptParticipantIds = (Array.isArray(config?.gameOptions?.exemptParticipantIds) ? config.gameOptions.exemptParticipantIds : [])
            .map(id => String(id || ''))
            .filter(Boolean);
        this._rng = typeof config?.beetleRaceRng === 'function' ? config.beetleRaceRng : Math.random;
        this._now = typeof config?.beetleRaceNow === 'function' ? config.beetleRaceNow : () => Date.now();
        this._timers = new Set();
        this._tick = null;
        this._sim = null;
        this._resetRound();
        // 客户端收到状态时记下"那一刻"，好把剩余/已过毫秒换算成本地时间
        this._clock = { at: 0, parade: 0, betting: 0, countdown: 0, race: 0 };
    }

    get phases() {
        return ['IDLE', 'PARADE', 'BETTING', 'COUNTDOWN', 'RACING', 'RESOLVING'];
    }

    get transitions() {
        return {
            IDLE: ['PARADE', 'BETTING'],
            PARADE: ['BETTING'],
            BETTING: ['COUNTDOWN'],
            COUNTDOWN: ['RACING'],
            RACING: ['RESOLVING'],
            RESOLVING: ['BETTING']
        };
    }

    _resetRound() {
        this.bets = [];
        this.run = null;
        this.order = [];
        this.result = null;
        this.settlementApplied = false;
        this.paradeIndex = 0;
        this._phaseStartedAt = this._now();
        this._raceStartedAt = 0;
        this._settledAt = 0;
        this.biases = {};
    }

    start() {
        this._clearTimers();
        this._resetRound();
        this.round += 1;
        if (!this.race?.lanes?.length) {
            // 快照坏了（比如开桌前甲虫被删光），停在结算让 DM 散桌，别让桌子卡死
            this.result = { kind: 'aborted', reason: 'no-race', winnerLane: -1, rows: [] };
            this.settlementApplied = true;
            this._phase = 'RESOLVING';
            return;
        }
        if (this.race.parade && this.round === 1) this._enterParade();
        else this._enterBetting();
    }

    // ───────── 状态 ─────────

    getState() {
        return {
            ...super.getState(),
            race: this.race,
            exemptParticipantIds: [...this.exemptParticipantIds],
            paradeIndex: this.paradeIndex,
            ...this.getClock(),
            run: this.run ? { seed: this.run.seed, interventions: this.run.interventions.map(iv => ({ ...iv })) } : null,
            biases: { ...this.biases },
            order: [...this.order],
            result: this.result,
            settlementApplied: this.settlementApplied
        };
    }

    setState(state) {
        super.setState(state);
        if (state.race) this.race = state.race;
        if (state.exemptParticipantIds) this.exemptParticipantIds = [...state.exemptParticipantIds];
        if (state.paradeIndex != null) this.paradeIndex = Number(state.paradeIndex) || 0;
        if (state.run !== undefined) this.run = state.run ? { seed: state.run.seed, interventions: [...(state.run.interventions || [])] } : null;
        if (state.biases) this.biases = { ...state.biases };
        if (state.order) this.order = [...state.order];
        if (state.result !== undefined) this.result = state.result || null;
        if (state.settlementApplied !== undefined) this.settlementApplied = !!state.settlementApplied;
        this._clock = {
            at: this._now(),
            parade: Number(state.paradeElapsedMs) || 0,
            betting: Number(state.bettingRemainingMs) || 0,
            countdown: Number(state.countdownRemainingMs) || 0,
            race: Number(state.raceElapsedMs) || 0
        };
    }

    /**
     * 当前阶段的时间。主机按自己记的阶段起点算；客户端用"收到状态时的读数 + 本地流逝"——
     * 客户端的 _phaseStartedAt 是它自己建实例的时刻，拿来算会差出好几秒。
     * @returns {{ paradeElapsedMs, bettingRemainingMs, countdownRemainingMs, raceElapsedMs }}
     */
    getClock() {
        if (this._isHost()) {
            const now = this._now();
            const since = now - this._phaseStartedAt;
            return {
                paradeElapsedMs: this._phase === 'PARADE' ? since : 0,
                bettingRemainingMs: this._phase === 'BETTING' ? Math.max(0, (this.race?.betSeconds || 0) * 1000 - since) : 0,
                countdownRemainingMs: this._phase === 'COUNTDOWN' ? Math.max(0, COUNTDOWN_MS - since) : 0,
                raceElapsedMs: this._phase === 'RACING' && this._raceStartedAt ? now - this._raceStartedAt : 0
            };
        }
        const passed = this._now() - this._clock.at;
        return {
            paradeElapsedMs: this._clock.parade + passed,
            bettingRemainingMs: Math.max(0, this._clock.betting - passed),
            countdownRemainingMs: Math.max(0, this._clock.countdown - passed),
            raceElapsedMs: this._phase === 'RACING' ? this._clock.race + passed : 0
        };
    }

    _isHost() {
        const session = ParlorManager._sessions?.get?.(this.sessionId);
        return session ? !!session.isHostGM : !!game.user?.isGM;
    }

    // ───────── 动作入口 ─────────

    handlePlayerAction(userId, action, data) {
        switch (action) {
            case 'placeBet':
                return this._handlePlaceBet(userId, data);
            case 'clearBets':
                return this._handleClearBets(userId);
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    async handleGMAction(action, data = {}) {
        switch (action) {
            case 'skipParade':
                if (this._phase !== 'PARADE') return { ok: false, reason: 'phase' };
                this._enterBetting();
                await this._broadcastState();
                return { ok: true };
            case 'closeBetting':
                if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
                this._enterCountdown();
                await this._broadcastState();
                return { ok: true };
            case 'cheat':
                return this._handleCheat(data);
            case 'bias':
                return this._handleBias(data);
            case 'newRound':
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitSettlement();
                this._clearTimers();
                this._resetRound();
                this.round += 1;
                this._enterBetting();
                await this._broadcastState();
                return { ok: true };
            case 'finishGame':
                // 局中被强制散桌走这里会拿到 phase：不结账
                if (this._phase !== 'RESOLVING') return { ok: false, reason: 'phase' };
                await this._commitSettlement();
                this._clearTimers();
                return { ok: true };
            default:
                return { ok: false, reason: 'unknown-action' };
        }
    }

    _handlePlaceBet(userId, data) {
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
        if (!this.playerIds.has(userId)) return { ok: false, reason: 'not-player' };
        const balance = this._isExempt(userId) ? Infinity : Number(SettlementManager.getBalance(userId)) || 0;
        const outcome = applyBet({ race: this.race, bets: this.bets, participantId: userId, laneIndex: data?.lane, amount: data?.amount, balance });
        if (!outcome.ok) return outcome;
        this.bets = outcome.bets;
        this._broadcastState();
        return { ok: true };
    }

    _handleClearBets(userId) {
        if (this._phase !== 'BETTING') return { ok: false, reason: 'phase' };
        if (!this.playerIds.has(userId)) return { ok: false, reason: 'not-player' };
        this.bets = this.bets.filter(bet => bet.userId !== userId);
        this._broadcastState();
        return { ok: true };
    }

    // 作弊招：data = { lane, moveId }。招式从开局快照里找（DM 中途在工坊改的不影响这场）
    async _handleCheat(data) {
        if (this._phase !== 'RACING' || !this._sim) return { ok: false, reason: 'phase' };
        const lane = Number(data?.lane);
        if (!Number.isInteger(lane) || !this.race.lanes[lane]) return { ok: false, reason: 'invalid-lane' };
        if (this._sim.lanes[lane]?.done) return { ok: false, reason: 'finished' };
        const move = (this.race.cheats || []).find(entry => entry.id === data?.moveId);
        if (!move) return { ok: false, reason: 'invalid-move' };
        this._pushIntervention({ lane, kind: 'move', moveId: move.id, actionId: move.actionId, bubble: move.bubble, bubbles: move.bubbles, dur: move.dur, strength: move.strength });
        await this._broadcastState();
        return { ok: true };
    }

    // 暗调：data = { lane, mul }，mul=1 就是撤销
    async _handleBias(data) {
        if (this._phase !== 'RACING' || !this._sim) return { ok: false, reason: 'phase' };
        const lane = Number(data?.lane);
        if (!Number.isInteger(lane) || !this.race.lanes[lane]) return { ok: false, reason: 'invalid-lane' };
        const mul = Math.max(0.4, Math.min(1.8, Number(data?.mul) || 1));
        this.biases[lane] = mul;
        this._pushIntervention({ lane, kind: 'bias', mul });
        await this._broadcastState();
        return { ok: true };
    }

    _pushIntervention(entry) {
        // 主机先把自己的模拟推到"现在"，再往后排提前量，保证各端收到时这一步还没跑到
        this._advanceHostSim();
        const step = this._sim.step + INTERVENTION_LEAD_STEPS;
        this.run.interventions.push({ ...entry, step });
        this._sim.setInterventions(this.run.interventions);
    }

    // ───────── 阶段推进（只在主机跑） ─────────

    _enterParade() {
        this._transition('PARADE');
        this._phaseStartedAt = this._now();
        this.paradeIndex = 0;
        this._schedule(() => this._advanceParade(), PARADE_INTRO_MS + PARADE_STEP_MS);
    }

    _advanceParade() {
        if (this._phase !== 'PARADE' || !this._alive()) return;
        this.paradeIndex += 1;
        if (this.paradeIndex >= this.race.lanes.length) {
            this._enterBetting();
        } else {
            this._schedule(() => this._advanceParade(), PARADE_STEP_MS);
        }
        this._broadcastState();
    }

    _enterBetting() {
        this._clearTimers();
        if (this._phase !== 'BETTING') this._transition('BETTING');
        this._phaseStartedAt = this._now();
        this._schedule(() => {
            if (this._phase !== 'BETTING' || !this._alive()) return;
            this._enterCountdown();
            this._broadcastState();
        }, this.race.betSeconds * 1000);
    }

    _enterCountdown() {
        this._clearTimers();
        this._transition('COUNTDOWN');
        this._phaseStartedAt = this._now();
        this.run = { seed: Math.floor(this._rng() * 0xFFFFFFFF) >>> 0, interventions: [] };
        this._schedule(() => this._enterRacing(), COUNTDOWN_MS);
    }

    _enterRacing() {
        if (this._phase !== 'COUNTDOWN' || !this._alive()) return;
        this._transition('RACING');
        this._phaseStartedAt = this._now();
        this._raceStartedAt = this._now();
        this._sim = new BeetleRaceSim(buildSimSpec(this.race, this.run));
        this._tick = setInterval(() => this._onTick(), TICK_MS);
        this._broadcastState();
    }

    _advanceHostSim() {
        if (!this._sim) return;
        this._sim.advanceToWall((this._now() - this._raceStartedAt) / 1000);
    }

    _onTick() {
        if (this._phase !== 'RACING' || !this._alive()) {
            clearInterval(this._tick);
            this._tick = null;
            return;
        }
        this._advanceHostSim();
        if (!this._sim.settled) return;
        if (!this._settledAt) this._settledAt = this._now();
        if (this._now() - this._settledAt >= RESOLVE_GRACE_MS) this._resolve();
    }

    _resolve() {
        clearInterval(this._tick);
        this._tick = null;
        this.order = [...this._sim.finishedOrder];
        const settlement = computeSettlement({ race: this.race, bets: this.bets, order: this.order });
        this.result = { kind: 'finished', ...settlement };
        this._transition('RESOLVING');
        const winner = this.race.lanes[settlement.winnerLane];
        void BeetleRaceLibrary.recordResult(this.race.lanes.map(lane => lane.beetleId), winner?.beetleId || '').catch(() => {});
        this._broadcastState();
    }

    async _commitSettlement() {
        if (this.settlementApplied) return;
        this.settlementApplied = true;
        const deltas = (this.result?.rows || [])
            .filter(row => Number(row.net) !== 0 && !this._isExempt(row.id))
            .map(row => ({ userId: row.id, delta: Number(row.net) }));
        if (deltas.length) await SettlementManager.applyDeltas(deltas);
        await this._broadcastState();
    }

    // ───────── 杂项 ─────────

    /** 机器人 / NPC / 自测局的 DM：不进真实账户 */
    _isExempt(participantId) {
        return isBotParticipantId(participantId)
            || isNpcParticipantId(participantId)
            || this.exemptParticipantIds.includes(String(participantId || ''));
    }

    // 桌子已经散了还在等定时器的话，别对着死会话广播，也别在后台把比赛跑完记战绩。
    // 见过自己的会话之后它又没了 = 散桌；从来没挂过会话（单元测试里直接 new）照常跑
    _alive() {
        const session = ParlorManager._sessions?.get?.(this.sessionId);
        if (session) {
            this._seenSession = true;
            if (session.game === this) return true;
        } else if (!this._seenSession) {
            return true;
        }
        this._clearTimers();
        return false;
    }

    _schedule(fn, ms) {
        const id = setTimeout(() => { this._timers.delete(id); fn(); }, ms);
        this._timers.add(id);
    }

    _clearTimers() {
        for (const id of this._timers) clearTimeout(id);
        this._timers.clear();
        clearInterval(this._tick);
        this._tick = null;
    }
}
