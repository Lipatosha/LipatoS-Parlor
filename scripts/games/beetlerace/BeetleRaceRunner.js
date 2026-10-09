/**
 * 甲虫赛跑 · 本地模拟的驾驶员
 *
 * 各端画比赛都靠自己跑一份 BeetleRaceSim（跟主机同一份 spec）。经典桌和主题呈现器都走这一个类，
 * 两边追帧、补干预、结算前追到终局的规矩就只写一遍，不会一边改了另一边忘了。
 *
 * - sync(state)：收到新状态时调。换了种子就新建；干预变多了能接就接，有晚到的就从头重算
 * - advance(state, clock, dt)：每帧调。比赛中按主机时钟走；进了结算还没跑完就快进追上
 */

import { BeetleRaceSim, rebuildSim } from './BeetleRaceSim.js';
import { buildSimSpec } from './BeetleRaceRules.js';

export class BeetleRaceRunner {
    constructor() {
        this.reset();
    }

    reset() {
        this.sim = null;
        this._seed = null;
        this._ivCount = 0;
    }

    /** @returns {'none'|'created'|'rebuilt'|'kept'} 解说这类按事件游标读的，看到 created 要把游标归零 */
    sync(state) {
        const run = state?.run;
        if (!run) {
            this.reset();
            return 'none';
        }
        const spec = buildSimSpec(state.race, run);
        if (!this.sim || this._seed !== run.seed) {
            this.sim = new BeetleRaceSim(spec);
            this._seed = run.seed;
            this._ivCount = run.interventions.length;
            return 'created';
        }
        if (run.interventions.length === this._ivCount) return 'kept';
        this._ivCount = run.interventions.length;
        if (this.sim.setInterventions(run.interventions)) return 'kept';
        // 有晚到的（生效步已经跑过了）：从头重算到当前步，画面最多跳一下
        this.sim = rebuildSim(spec, this.sim.step);
        return 'rebuilt';
    }

    advance(state, clock, dt) {
        const sim = this.sim;
        if (!sim) return null;
        if (state.phase === 'RACING') {
            sim.advanceToWall(clock.raceElapsedMs / 1000);
        } else if (state.phase === 'RESOLVING' && !sim.settled) {
            if (sim.step === 0) {
                // 结算阶段才打开（刷新了页面）：结果已经定了，直接跑到终局，别让人干等十几秒
                let guard = sim.maxSteps + 10;
                while (guard-- > 0 && !sim.settled) sim.advance();
            } else {
                // 这一端落后了一点：快一点追到终局，别卡在半路
                sim.advanceToWall(sim.wall + dt * 3);
            }
        }
        return sim;
    }

    /** 这一端的画面是不是已经跑完（没有模拟也算跑完，结算不用等） */
    get settled() {
        return !this.sim || this.sim.settled;
    }
}
