/**
 * 甲虫赛跑 · 音效
 *
 * 声音文件在 assets/beetlerace/sfx/，由 tools/beetle-sfx/ 离线合成（CC0 采样 + 合成器，见 ASSET_LICENSES.md）。
 * 这里两样东西：
 * - BEETLE_SOUNDS：名字 → 相对音量。各条之间的响度差在这张表里调
 * - BeetleRaceSoundDirector：每帧看一眼状态 / 主机时钟 / 本地模拟，决定这一刻该响什么。
 *   经典桌和各主题共用这一份，时机只看游戏本身，不看画面，所以两种皮听到的是同一套
 *
 * 各端各放各的：时机全从主机时钟和确定性模拟推出来，同一桌的人差不多同一刻听到，不走 socket。
 */

import { getBeetlePref, setBeetlePref } from './BeetleRacePrefs.js';

export const BEETLE_SOUND_ROOT = 'modules/parlor/assets/beetlerace/sfx';

export const BEETLE_SOUNDS = Object.freeze({
    intro: 0.9, curtain: 0.7, bell: 0.55,
    'entrance-a': 0.75, 'entrance-b': 0.75, 'entrance-c': 0.75,
    bet: 0.6, swish: 0.35, tick: 0.45,
    'count-3': 0.7, 'count-2': 0.7, 'count-1': 0.8, go: 0.95,
    final: 0.7, finish: 1, photo: 0.8, win: 0.95, lose: 0.85,
    'act-dash': 0.55, 'act-fly': 0.6, 'act-hop': 0.55, 'act-blink': 0.6, 'act-jet': 0.55,
    'act-brake': 0.5, 'act-spin': 0.5, 'act-flip': 0.6, 'act-snack': 0.6, 'act-nap': 0.6,
    'act-moonwalk': 0.6, 'act-wander': 0.5, 'act-trip': 0.6, 'act-taunt': 0.55, 'act-bow': 0.5,
    'act-cheer': 0.55, 'act-roll': 0.55, 'act-dig': 0.55, 'act-sneeze': 0.7, 'act-mud': 0.6,
    'act-dungball': 0.55, 'act-dance': 0.55,
    'act-haste': 0.85, 'act-enlarge': 0.85, 'act-freeze': 0.85, 'act-zap': 0.9, 'act-snail': 0.9
});

export const beetleSoundSrc = (name) => `${BEETLE_SOUND_ROOT}/${name}.ogg`;

// 全桌的开关：GM 定、记住上次的选择（见 BeetleRacePrefs）
export const isBeetleSoundOn = () => getBeetlePref('sound');
export const setBeetleSoundOn = (on) => setBeetlePref('sound', on);

const ENTRANCES = ['entrance-a', 'entrance-b', 'entrance-c'];
// 比赛里出状况太密时的最小间隔：六只虫同时犯傻会吵成一锅粥。DM 的法术不受这个限，必响
const ACTION_GAP_MS = 320;
// 开幕声要从头放才对得上拉幕；晚进来的人错过开头就别补了
const INTRO_LATE_MS = 700;
const RESULT_DELAY_MS = 650;
const PHOTO_STEPS = 12;
const FINAL_AT = 0.8;

export class BeetleRaceSoundDirector {
    /**
     * @param {object} deps
     * @param {(name: string) => void} deps.play
     * @param {number} deps.introMs / stepMs / countdownMs / trackLength   跟引擎同一套常数
     * @param {(lane: object) => string} deps.paradeActionFor
     * @param {(actionId: string) => boolean} deps.isMagic
     * @param {() => number} [deps.now]
     * @param {(fn: Function, ms: number) => any} [deps.later]
     */
    constructor({ play, introMs, stepMs, countdownMs, trackLength, paradeActionFor, isMagic, walkInMs = 900, actionAtMs = 1100, now = () => performance.now(), later = (fn, ms) => setTimeout(fn, ms) }) {
        Object.assign(this, { play, introMs, stepMs, countdownMs, trackLength, paradeActionFor, isMagic, walkInMs, actionAtMs, now, later });
        this._primed = false;
        this._phase = '';
        this._paradeIndex = -1;
        this._paradeLocal = 0;
        this._count = 0;
        this._tickSecond = 0;
        this._betKey = '';
        this._sim = null;
        this._heard = new Set();
        this._lastActionAt = -Infinity;
        this._raceFlags = { final: false, finish: false, photo: false };
    }

    /**
     * 每帧调一次
     * @param {object} frame { state, clock, sim, mine: 自己名下的参与者 id[] }
     */
    tick({ state, clock = {}, sim = null, mine = [] }) {
        if (!state?.race) return;
        const phase = state.phase || '';
        // 头一帧只记下现状不出声：中途打开桌子的人，别把之前发生过的全补一遍
        if (!this._primed) {
            this._primed = true;
            this._phase = phase;
            this._betKey = betKey(state);
            this._paradeIndex = Number(state.paradeIndex || 0);
            this._paradeLocal = this._localParade(state, clock);
            this._count = this._countNumber(phase, clock);
            this._adoptSim(sim, { silent: true });
            if (phase === 'PARADE' && Number(clock.paradeElapsedMs || 0) < INTRO_LATE_MS) this._say('intro');
            return;
        }
        if (phase !== this._phase) this._onPhase(this._phase, phase, state, mine);
        this._phase = phase;

        if (phase === 'PARADE') this._parade(state, clock);
        if (phase === 'BETTING') this._betting(state, clock);
        if (phase === 'COUNTDOWN') this._countdown(clock);
        if (phase === 'RACING' || phase === 'RESOLVING') this._race(sim);
    }

    _say(name) {
        if (BEETLE_SOUNDS[name] != null) this.play(name);
    }

    _onPhase(from, to, state, mine) {
        if (to === 'PARADE') this._say('intro');
        if (to === 'BETTING') {
            // 巡游之后接着下注：摇铃开盘；直接进下注（第二场起）那是大幕刚拉开
            this._say(from === 'PARADE' ? 'bell' : 'curtain');
            this._betKey = betKey(state);
            this._tickSecond = 0;
            this._resetRace();
        }
        if (to === 'COUNTDOWN') this._count = 0;
        if (to === 'RACING') this._say('go');
        if (to === 'RESOLVING') {
            // 撞线那一大声已经响过；进结算再补一句"你赢了 / 你输了"，没下注的人不打扰
            const rows = (state.result?.rows || []).filter(row => mine.includes(row.id) && Number(row.staked || 0) > 0);
            if (rows.length) {
                const won = rows.some(row => Number(row.payout || 0) > 0);
                this.later(() => this._say(won ? 'win' : 'lose'), RESULT_DELAY_MS);
            }
        }
    }

    _localParade(state, clock) {
        return Number(clock.paradeElapsedMs || 0) - this.introMs - Number(state.paradeIndex || 0) * this.stepMs;
    }

    // 每只甲虫：走到圆台中间"嗒哒"一声，接着演入场动作时配它那个动作的声
    _parade(state, clock) {
        const index = Number(state.paradeIndex || 0);
        const local = this._localParade(state, clock);
        if (index !== this._paradeIndex) {
            this._paradeIndex = index;
            this._paradeLocal = Math.min(local, 0);
        }
        const before = this._paradeLocal;
        this._paradeLocal = local;
        if (before < this.walkInMs && local >= this.walkInMs) this._say(ENTRANCES[index % ENTRANCES.length]);
        if (before < this.actionAtMs && local >= this.actionAtMs) {
            const lane = state.race.lanes[index];
            const actionId = lane ? this.paradeActionFor(lane) : '';
            if (actionId) this._say(`act-${actionId}`);
        }
    }

    _betting(state, clock) {
        // 谁下了注都"叮"一声（自己的、别人的、机器人的），改小、撤注不响
        const key = betKey(state);
        if (key !== this._betKey) {
            if (betTotal(state) > betTotalFromKey(this._betKey)) this._say('bet');
            this._betKey = key;
        }
        // 最后五秒钟表走字
        const left = Number(clock.bettingRemainingMs || 0);
        const second = Math.ceil(left / 1000);
        if (left > 0 && second <= 5 && second !== this._tickSecond) {
            this._tickSecond = second;
            this._say('tick');
        }
    }

    _countNumber(phase, clock) {
        if (phase !== 'COUNTDOWN') return 0;
        const left = Number(clock.countdownRemainingMs || 0);
        const total = this.countdownMs;
        return left > total * 2 / 3 ? 3 : (left > total / 3 ? 2 : 1);
    }

    _countdown(clock) {
        const n = this._countNumber('COUNTDOWN', clock);
        if (n !== this._count) {
            this._count = n;
            this._say(`count-${n}`);
        }
    }

    _resetRace() {
        this._sim = null;
        this._heard.clear();
        this._lastActionAt = -Infinity;
        this._raceFlags = { final: false, finish: false, photo: false };
    }

    // 模拟换了（晚到的干预会让本地从头重算）事件表会整个重来一遍：按"第几步 · 哪道 · 什么动作"记听过的，别重复响
    _adoptSim(sim, { silent = false } = {}) {
        if (!sim || sim === this._sim) return;
        this._sim = sim;
        if (silent) {
            for (const ev of sim.events || []) this._heard.add(eventKey(ev));
            const order = sim.finishedOrder || [];
            this._raceFlags.finish = order.length > 0;
            this._raceFlags.photo = order.length > 1;
            this._raceFlags.final = order.length > 0;
        }
    }

    _race(sim) {
        if (!sim) return;
        this._adoptSim(sim);
        const now = this.now();
        for (const ev of sim.events || []) {
            const key = eventKey(ev);
            if (this._heard.has(key)) continue;
            this._heard.add(key);
            // 暗调不出声：那本来就是瞒着人的
            if (ev.kind === 'bias' || !ev.actionId) continue;
            if (this.isMagic(ev.actionId)) {
                this._say(`act-${ev.actionId}`);
                continue;
            }
            if (now - this._lastActionAt < ACTION_GAP_MS) continue;
            this._lastActionAt = now;
            this._say(`act-${ev.actionId}`);
        }

        const order = sim.finishedOrder || [];
        if (!this._raceFlags.final && !order.length) {
            const lead = Math.max(0, ...(sim.getLanes?.() || []).map(lane => lane.x || 0));
            if (lead > this.trackLength * FINAL_AT) {
                this._raceFlags.final = true;
                this._say('final');
            }
        }
        if (order.length && !this._raceFlags.finish) {
            this._raceFlags.finish = true;
            this._say('finish');
        }
        if (order.length > 1 && !this._raceFlags.photo) {
            this._raceFlags.photo = true;
            const lanes = sim.lanes || sim.getLanes?.() || [];
            const gap = Math.abs(Number(lanes[order[1]]?.finishStep || 0) - Number(lanes[order[0]]?.finishStep || 0));
            if (gap < PHOTO_STEPS) this._say('photo');
        }
    }
}

function betKey(state) {
    return (state.bets || []).map(bet => `${bet.userId}:${bet.lane}:${Number(bet.amount || 0)}`).sort().join('|');
}

function betTotal(state) {
    return (state.bets || []).reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
}

function betTotalFromKey(key) {
    return key ? key.split('|').reduce((sum, part) => sum + Number(part.split(':')[2] || 0), 0) : 0;
}

function eventKey(ev) {
    return `${ev.step}:${ev.lane}:${ev.actionId || ev.kind || ''}`;
}
