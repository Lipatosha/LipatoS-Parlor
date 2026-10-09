/**
 * 甲虫赛跑 · 确定性模拟
 *
 * 主机和每个客户端各跑一份，同一份 spec 跑出来必须逐位相同，所以这里有几条硬规矩：
 * - 只用 + - * / 和 Math.floor/min/max/imul 这类精确运算。Math.sin/exp/pow 在不同浏览器里末位可能不一样，
 *   几千步一累积就能换掉冠军。随机起伏用"每 3 秒一个随机节点、中间线性插值"。
 * - 每条道独立抽节奏、事件、冲线劲头和台词，改台词不能改变赛果，作弊不能扰乱其他道的随机序列。
 * - 慢镜也在这里算（wall 时间和模拟步的换算），这样全桌看到的是同一段慢镜，主机也不会在别人还在慢镜时就结算。
 *
 * 干预（作弊）按步号生效。客户端晚收到了，就用 rebuild 从头重算，几千步毫秒级。
 */

import { ACTIONS, TEMPERAMENTS, TRACK_LENGTH, MOVE_LIMITS, actionTunables } from './BeetleRaceCatalog.js';

export const SIM_HZ = 60;
const DT = 1 / SIM_HZ;
// 干预提前量：主机收到作弊请求后往后排这么多步再生效，给广播留出路上的时间
export const INTERVENTION_LEAD_STEPS = 36;
// 撞线后还能往前滑的距离（画面上别一头撞出板子）
export const OVERSHOOT = 60;

const PACE_KNOT_STEPS = 180;
const PACE_SWING = 0.16;
const START_RAMP_STEPS = 30;
const LAZY_RAMP_STEPS = 90;
const FIRST_EVENT_STEP = 90;
const EVENT_MEAN_SEC = { low: 22, normal: 14, high: 8 };
const EVENT_CUTOFF = 0.9;
const RUBBER_GAP = 60;
const RUBBER_MAX = 0.08;
const KICK_FROM = 0.72;

const SLOW_DISTANCE = 35;
const SLOW_SCALE = 0.3;
const SLOW_HOLD_STEPS = 30;
const SLOW_RAMP_STEPS = 24;
const STOP_SPEED = 0.5;
// 随机事件的"找补"：随机招只负责制造戏剧性，不该决定胜负。演完之后按欠下的距离慢慢追回（多跑的慢慢吐回去），
// 最后 10% 赛程不再抽随机招，免得来不及找补。作弊招不找补——DM 动手就是要改结果。
const DEBT_KEEP = 1;
const DEBT_RATE = 0.6;
const DEBT_MAX_GAIN = 0.45;
const DEBT_MAX_LOSS = 0.3;

function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 从主种子派生每条道的子种子；整数运算，跨端一致
function laneSeed(seed, lane, salt) {
    return (Math.imul((seed >>> 0) ^ 0x9E3779B9, lane + 1) + Math.imul(salt, 0x85EBCA6B)) >>> 0;
}

function clamp(value, min, max) {
    return value < min ? min : (value > max ? max : value);
}

function powerFactor(power) {
    const p = clamp(Math.floor(Number(power) || 5), 1, 10);
    return 0.95 + (p - 1) * (0.1 / 9);
}

export function normalizeInterventions(list = []) {
    return (Array.isArray(list) ? list : [])
        .map((entry, index) => ({ ...entry, step: Math.max(1, Math.floor(Number(entry?.step) || 0)), order: index }))
        .sort((a, b) => (a.step - b.step) || (a.order - b.order));
}

export class BeetleRaceSim {
    /**
     * @param {object} spec
     * @param {number} spec.seed
     * @param {number} spec.durationSec  目标赛程（秒），事件多了实际会长一点
     * @param {string} spec.eventRate    low | normal | high
     * @param {{power:number, temperament:string}[]} spec.lanes
     * @param {{id:string, actionId:string, bubble?:string, bubbles?:string[]}[]} spec.pool  随机池（已解析好的招式）
     * @param {object[]} spec.interventions
     */
    constructor(spec) {
        this.spec = spec;
        this.seed = Math.floor(Number(spec?.seed) || 0) >>> 0;
        const duration = clamp(Number(spec?.durationSec) || 30, 5, 600);
        this.baseSpeed = TRACK_LENGTH / duration;
        this.eventMean = EVENT_MEAN_SEC[spec?.eventRate] ?? EVENT_MEAN_SEC.normal;
        this.pool = (Array.isArray(spec?.pool) ? spec.pool : []).filter(entry => ACTIONS[entry?.actionId]);
        this.maxSteps = Math.floor(duration * SIM_HZ * 4);
        this.interventions = normalizeInterventions(spec?.interventions);
        this._ivCursor = 0;

        this.step = 0;
        this.wall = 0;
        this.firstFinishStep = null;
        this.finishedOrder = [];
        this.events = [];
        this.lanes = (Array.isArray(spec?.lanes) ? spec.lanes : []).map((entry, index) => this._createLane(entry, index));
    }

    _createLane(entry, index) {
        const temperament = TEMPERAMENTS[entry?.temperament] ? entry.temperament : 'steady';
        const paceRng = makeRng(laneSeed(this.seed, index, 1));
        const eventRng = makeRng(laneSeed(this.seed, index, 2));
        const kickRng = makeRng(laneSeed(this.seed, index, 3));
        const lane = {
            index,
            temperament,
            base: this.baseSpeed * powerFactor(entry?.power),
            x: 0,
            prevX: 0,
            v: 0,
            drift: 0,
            done: false,
            finishStep: null,
            place: 0,
            bias: 1,
            debt: 0,
            action: null,
            knots: [],
            paceRng,
            eventRng,
            bubbleRng: makeRng(laneSeed(this.seed, index, 4)),
            kick: temperament === 'sly' ? 0.97 + kickRng() * 0.18 : 0.94 + kickRng() * 0.2,
            nextEventStep: 0
        };
        lane.nextEventStep = FIRST_EVENT_STEP + this._eventGap(lane);
        return lane;
    }

    _knot(lane, k) {
        while (lane.knots.length <= k) lane.knots.push(lane.paceRng() * 2 - 1);
        return lane.knots[k];
    }

    _pace(lane, step) {
        const k = Math.floor(step / PACE_KNOT_STEPS);
        const frac = (step - k * PACE_KNOT_STEPS) / PACE_KNOT_STEPS;
        const p = this._knot(lane, k) * (1 - frac) + this._knot(lane, k + 1) * frac;
        return 1 + PACE_SWING * p;
    }

    _eventFreq(lane) {
        const temper = TEMPERAMENTS[lane.temperament];
        let freq = temper.freq;
        if (temper.lateBias && lane.x > TRACK_LENGTH / 2) freq *= temper.lateBias;
        return freq;
    }

    _eventGap(lane) {
        const mean = this.eventMean / Math.max(0.05, this._eventFreq(lane));
        return Math.floor(mean * SIM_HZ * (0.5 + lane.eventRng()));
    }

    _pickRandomMove(lane) {
        if (!this.pool.length) return null;
        const prefer = TEMPERAMENTS[lane.temperament].prefer;
        let total = 0;
        const weights = this.pool.map(entry => {
            const w = prefer.includes(entry.actionId) ? 5 : 1;
            total += w;
            return w;
        });
        let roll = lane.eventRng() * total;
        for (let i = 0; i < this.pool.length; i++) {
            roll -= weights[i];
            if (roll < 0) return this.pool[i];
        }
        return this.pool[this.pool.length - 1];
    }

    // 招式可以覆盖时长（秒）和强度，但只认这个动作开放的那几样（见 Catalog 的 tune）；没给就用默认
    _startAction(lane, { actionId, moveId = '', bubble = '', bubbles, source, dur = 0, strength = 1 }) {
        const def = ACTIONS[actionId];
        if (!def) return;
        const tunable = actionTunables(actionId);
        const seconds = tunable.duration && Number(dur) > 0 ? clamp(Number(dur), MOVE_LIMITS.minDuration, MOVE_LIMITS.maxDuration) : def.sim.dur;
        const durSteps = Math.max(1, Math.floor(seconds * SIM_HZ));
        // 独立随机流保证各端抽到同一句，又不会因台词数量变化改掉事件时间或冠军。
        if (Array.isArray(bubbles)) bubble = bubbles.length ? bubbles[Math.floor(lane.bubbleRng() * bubbles.length)] : '';
        lane.action = {
            actionId,
            moveId,
            bubble,
            source,
            strength: tunable.strength ? clamp(Number(strength) || 1, MOVE_LIMITS.minStrength, MOVE_LIMITS.maxStrength) : 1,
            start: this.step,
            end: this.step + durSteps,
            jumped: false
        };
        this.events.push({ step: this.step, lane: lane.index, actionId, moveId, bubble, source, durSteps });
    }

    _applyInterventions() {
        while (this._ivCursor < this.interventions.length && this.interventions[this._ivCursor].step <= this.step) {
            const iv = this.interventions[this._ivCursor++];
            const lane = this.lanes[iv.lane];
            if (!lane || lane.done) continue;
            if (iv.kind === 'bias') {
                lane.bias = clamp(Number(iv.mul) || 1, 0.4, 1.8);
                this.events.push({ step: this.step, lane: lane.index, kind: 'bias', mul: lane.bias, source: 'cheat', covert: true });
            } else if (iv.kind === 'move' && ACTIONS[iv.actionId]) {
                // 作弊招直接顶掉正在演的动作，欠账也一笔勾销，免得找补把作弊效果吃回去
                lane.debt = 0;
                this._startAction(lane, { actionId: iv.actionId, moveId: iv.moveId || '', bubble: iv.bubble || '', bubbles: iv.bubbles, source: 'cheat', dur: iv.dur, strength: iv.strength });
            }
        }
    }

    _leadX() {
        let lead = 0;
        for (const lane of this.lanes) if (!lane.done && lane.x > lead) lead = lane.x;
        return lead;
    }

    _timeScale(leadX) {
        if (this.firstFinishStep === null) {
            const remain = TRACK_LENGTH - leadX;
            if (remain < SLOW_DISTANCE) return SLOW_SCALE;
            if (remain < SLOW_DISTANCE * 2) {
                const t = (SLOW_DISTANCE * 2 - remain) / SLOW_DISTANCE;
                return 1 - (1 - SLOW_SCALE) * t;
            }
            return 1;
        }
        const since = this.step - this.firstFinishStep;
        if (since < SLOW_HOLD_STEPS) return SLOW_SCALE;
        if (since < SLOW_HOLD_STEPS + SLOW_RAMP_STEPS) {
            return SLOW_SCALE + (1 - SLOW_SCALE) * ((since - SLOW_HOLD_STEPS) / SLOW_RAMP_STEPS);
        }
        return 1;
    }

    /** 下一步会落在哪个 wall 时刻（播放端按这个决定要不要推进） */
    get nextWall() {
        return this.wall + DT / this._timeScale(this._leadX());
    }

    advance() {
        if (this.settled) return false;
        const scale = this._timeScale(this._leadX());
        this.step += 1;
        const step = this.step;
        this._applyInterventions();
        const leadX = this._leadX();
        const finishers = [];

        for (const lane of this.lanes) {
            if (lane.done) {
                lane.v = Math.max(0, lane.v - lane.base * 3 * DT);
                lane.drift = Math.min(OVERSHOOT, lane.drift + lane.v * DT);
                continue;
            }

            // 本步起点：撞线插值用它，闪现的瞬移也算在本步位移里
            lane.prevX = lane.x;
            if (lane.action && step >= lane.action.end) {
                if (lane.action.source === 'random') lane.debt *= DEBT_KEEP;
                lane.action = null;
            }
            if (step >= lane.nextEventStep) {
                if (lane.action) {
                    lane.nextEventStep = lane.action.end + 30;
                } else {
                    if (lane.x < TRACK_LENGTH * EVENT_CUTOFF) {
                        const picked = this._pickRandomMove(lane);
                        if (picked) this._startAction(lane, { actionId: picked.actionId, moveId: picked.id, bubble: picked.bubble || '', bubbles: picked.bubbles, source: 'random', dur: picked.dur, strength: picked.strength });
                    }
                    lane.nextEventStep = step + this._eventGap(lane);
                }
            }

            let target = lane.base * this._pace(lane, step) * lane.bias;
            const gap = leadX - lane.x;
            if (gap > RUBBER_GAP) target *= 1 + Math.min(RUBBER_MAX, (gap - RUBBER_GAP) / 2000);
            if (gap < 0.5) target *= 0.985;
            if (lane.x > TRACK_LENGTH * KICK_FROM) target *= lane.kick;
            if (step < START_RAMP_STEPS) target *= step / START_RAMP_STEPS;

            const normal = target;
            // 懒散的起步慢算性格表演，跟随机招一样记账找补，不该白白吃亏
            if (TEMPERAMENTS[lane.temperament].slowStart && step < LAZY_RAMP_STEPS) {
                target *= 0.6 + 0.4 * (step / LAZY_RAMP_STEPS);
            }
            if (!lane.action && lane.debt !== 0) {
                const extra = clamp(lane.debt * DEBT_RATE, -lane.base * DEBT_MAX_LOSS, lane.base * DEBT_MAX_GAIN);
                target += extra;
            }

            let settle = 4;
            const action = lane.action;
            if (action) {
                const sim = ACTIONS[action.actionId].sim;
                const k = action.strength;
                // 减速类加强度会越放越慢，别放成倒车
                if (sim.kind === 'mul') target *= Math.max(0.02, 1 + (sim.mul - 1) * k);
                else if (sim.kind === 'stop') { target = lane.base * sim.crawl; settle = sim.settle; }
                else if (sim.kind === 'reverse') { target = lane.base * sim.speed * k; settle = 8; }
                else if (sim.kind === 'blink' || sim.kind === 'impulse') {
                    target = 0;
                    settle = sim.kind === 'blink' ? 20 : sim.settle;
                    const at = sim.kind === 'blink' ? sim.jumpAt : sim.at;
                    const fireStep = action.start + Math.floor((action.end - action.start) * at);
                    if (!action.jumped && step >= fireStep) {
                        action.jumped = true;
                        if (sim.kind === 'blink') lane.x += sim.dist * k;
                        else { lane.v = lane.base * sim.impulse * k; action.kickedAt = step; }
                    }
                }
            }

            // 冲量那一步别被平滑吃掉，从下一步开始再刹
            if (action?.kickedAt !== step) lane.v += (target - lane.v) * Math.min(1, DT * settle);
            const before = lane.x;
            lane.x = Math.max(0, lane.x + lane.v * DT);
            // 欠账 = 正常该跑的距离 - 实际跑的；随机招期间记账，平时往回还
            if (!action || action.source === 'random') lane.debt += normal * DT - (lane.x - before);

            if (lane.x >= TRACK_LENGTH) {
                const moved = lane.x - lane.prevX;
                const frac = moved > 0 ? (TRACK_LENGTH - lane.prevX) / moved : 1;
                lane.finishStep = step - 1 + clamp(frac, 0, 1);
                lane.drift = lane.x - TRACK_LENGTH;
                lane.x = TRACK_LENGTH;
                lane.done = true;
                lane.action = null;
                finishers.push(lane);
            }
        }

        if (finishers.length) this._assignPlaces(finishers);
        if (step >= this.maxSteps) this._forceFinish();
        this.wall += DT / scale;
        return true;
    }

    _assignPlaces(finishers) {
        finishers.sort((a, b) => (a.finishStep - b.finishStep) || (a.index - b.index));
        for (const lane of finishers) {
            this.finishedOrder.push(lane.index);
            lane.place = this.finishedOrder.length;
        }
        if (this.firstFinishStep === null) this.firstFinishStep = this.step;
    }

    // 兜底：跑了四倍赛程还没到（比如 DM 把谁调得太慢），按当前位置排完
    _forceFinish() {
        const rest = this.lanes.filter(lane => !lane.done).sort((a, b) => (b.x - a.x) || (a.index - b.index));
        for (const lane of rest) {
            lane.done = true;
            lane.finishStep = this.step;
            lane.action = null;
            this.finishedOrder.push(lane.index);
            lane.place = this.finishedOrder.length;
        }
        if (this.firstFinishStep === null) this.firstFinishStep = this.step;
    }

    /**
     * 换一份干预列表。新增的都排在当前步之后就原地接上；有任何一条已经"过期"（生效步 ≤ 当前步）返回 false，
     * 调用方得 rebuildSim 从头重算，不然这一端跟主机就岔开了。
     */
    setInterventions(list) {
        const next = normalizeInterventions(list);
        const applied = this.interventions.slice(0, this._ivCursor);
        const sameHead = applied.every((iv, i) => next[i] && next[i].step === iv.step && next[i].lane === iv.lane && next[i].kind === iv.kind);
        const lateTail = next.slice(this._ivCursor).some(iv => iv.step <= this.step);
        if (!sameHead || lateTail) return false;
        this.interventions = next;
        return true;
    }

    advanceToStep(step) {
        while (this.step < step && this.advance()) { /* 推进 */ }
    }

    /** 按 wall 秒数推进（播放端 / 主机计时器都走这个） */
    advanceToWall(seconds) {
        let guard = this.maxSteps + 10;
        while (guard-- > 0 && !this.settled && this.nextWall <= seconds) this.advance();
    }

    get finished() {
        return this.lanes.every(lane => lane.done);
    }

    get settled() {
        return this.finished && this.lanes.every(lane => lane.v <= STOP_SPEED);
    }

    /** 给画面用的快照：位置含撞线后的滑行 */
    getLanes() {
        return this.lanes.map(lane => ({
            index: lane.index,
            x: lane.x + lane.drift,
            v: lane.v,
            done: lane.done,
            place: lane.place,
            finishStep: lane.finishStep,
            // 画面要的是"过了几秒 / 一共几秒"，动画自己按持续段拉长（见 Render.remapProgress）
            action: lane.action ? {
                ...lane.action,
                elapsed: (this.step - lane.action.start) / SIM_HZ,
                duration: (lane.action.end - lane.action.start) / SIM_HZ
            } : null
        }));
    }

    get timeScale() {
        return this._timeScale(this._leadX());
    }
}

/** 从头重算到指定步（客户端收到晚到干预时用） */
export function rebuildSim(spec, step) {
    const sim = new BeetleRaceSim(spec);
    sim.advanceToStep(step);
    return sim;
}

/** 整场跑完，拿名次（主机离线预判、测试用） */
export function runToEnd(spec) {
    const sim = new BeetleRaceSim(spec);
    let guard = sim.maxSteps + 10;
    while (guard-- > 0 && !sim.settled) sim.advance();
    return sim;
}
