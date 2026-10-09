import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { BeetleRaceSim, rebuildSim, runToEnd, SIM_HZ } = await import('../scripts/games/beetlerace/BeetleRaceSim.js');
const { PRESET_MOVES, TRACK_LENGTH } = await import('../scripts/games/beetlerace/BeetleRaceCatalog.js');

const pool = PRESET_MOVES.filter(m => m.pool === 'random').map(m => ({ id: m.id, actionId: m.actionId, bubble: m.bubbleId }));

function spec(overrides = {}) {
    return {
        seed: 12345,
        durationSec: 30,
        eventRate: 'normal',
        lanes: [
            { power: 7, temperament: 'hothead' },
            { power: 6, temperament: 'sly' },
            { power: 5, temperament: 'steady' },
            { power: 8, temperament: 'lazy' },
            { power: 4, temperament: 'clumsy' },
            { power: 5, temperament: 'showoff' }
        ],
        pool,
        interventions: [],
        ...overrides
    };
}

function fingerprint(sim) {
    return JSON.stringify({ order: sim.finishedOrder, finish: sim.lanes.map(l => l.finishStep), step: sim.step, wall: sim.wall, events: sim.events });
}

describe('BeetleRaceSim', () => {
    it('同一份 spec 跑两次逐位相同', () => {
        assert.equal(fingerprint(runToEnd(spec())), fingerprint(runToEnd(spec())));
    });

    it('台词池随机抽多句，各端及晚到重算抽到同一句，动作持续中不再换句', () => {
        const lines = ['看我！', '再来一次！', '轮到我了！'];
        const next = spec({ durationSec: 60, eventRate: 'high', pool: [{ id: 'show', actionId: 'taunt', bubbles: lines }], interventions: [{ step: 450, lane: 0, kind: 'move', actionId: 'bow', bubbles: lines }] });
        const complete = runToEnd(next);
        assert.equal(fingerprint(runToEnd(next)), fingerprint(complete));
        const spoken = complete.events.filter(event => event.actionId).map(event => event.bubble);
        assert.ok(spoken.every(line => lines.includes(line)));
        assert.equal(new Set(spoken).size, lines.length);
        const rebuilt = rebuildSim(next, 451);
        const line = rebuilt.lanes[0].action.bubble;
        rebuilt.advanceToStep(465);
        assert.equal(rebuilt.lanes[0].action.bubble, line);
        while (rebuilt.advance()) { /* 跑到结束核对重算。 */ }
        assert.equal(fingerprint(rebuilt), fingerprint(complete));
    });

    it('只改台词池不改变动作抽签、比赛位置和冠军；旧单句和空池仍兼容', () => {
        const interventions = [{ step: 450, lane: 0, kind: 'move', actionId: 'taunt', bubble: '旧台词' }];
        const old = runToEnd(spec({ interventions }));
        const multi = runToEnd(spec({ pool: pool.map(move => ({ ...move, bubbles: ['甲', '乙', '丙'] })), interventions: interventions.map(move => ({ ...move, bubbles: ['丁', '戊'] })) }));
        const motion = sim => ({
            order: sim.finishedOrder,
            lanes: sim.lanes.map(lane => [lane.x, lane.v, lane.finishStep]),
            step: sim.step,
            wall: sim.wall,
            events: sim.events.map(({ bubble, ...event }) => event)
        });
        assert.deepEqual(motion(multi), motion(old));
        assert.equal(old.events.find(event => event.source === 'cheat').bubble, '旧台词');
        const silent = runToEnd(spec({ pool: [], interventions: interventions.map(move => ({ ...move, bubbles: [] })) }));
        assert.equal(silent.events.find(event => event.source === 'cheat').bubble, '');
    });

    it('不同种子跑出不同过程', () => {
        assert.notEqual(fingerprint(runToEnd(spec())), fingerprint(runToEnd(spec({ seed: 999 }))));
    });

    it('每只都会撞线，名次是完整的排列', () => {
        const sim = runToEnd(spec());
        assert.equal(sim.finishedOrder.length, 6);
        assert.deepEqual([...sim.finishedOrder].sort(), [0, 1, 2, 3, 4, 5]);
        sim.lanes.forEach(lane => assert.ok(lane.place >= 1 && lane.place <= 6));
        // 名次和撞线时刻一致
        const times = sim.finishedOrder.map(i => sim.lanes[i].finishStep);
        for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1]);
    });

    it('实际赛程落在目标时长附近', () => {
        for (const seed of [1, 2, 3, 4, 5]) {
            const sim = runToEnd(spec({ seed }));
            const first = sim.lanes[sim.finishedOrder[0]].finishStep / SIM_HZ;
            assert.ok(first > 20 && first < 40, `seed ${seed}: 冠军用时 ${first.toFixed(1)}s`);
        }
    });

    it('冲线前有慢镜：wall 时间比模拟时间长', () => {
        const sim = runToEnd(spec());
        assert.ok(sim.wall > sim.step / SIM_HZ + 0.5);
    });

    it('晚到的干预：从头重算和一路带着干预跑，结果一致', () => {
        const iv = [{ step: 600, lane: 4, kind: 'move', actionId: 'fly', moveId: 'preset:cheatFly', bubble: 'x' }];
        const straight = runToEnd(spec({ interventions: iv }));

        // 模拟客户端：先没干预跑到 700 步，收到干预后重算
        const early = new BeetleRaceSim(spec());
        early.advanceToStep(700);
        const rebuilt = rebuildSim(spec({ interventions: iv }), 700);
        let guard = 100000;
        while (guard-- > 0 && !rebuilt.settled) rebuilt.advance();
        assert.equal(fingerprint(rebuilt), fingerprint(straight));
    });

    it('一条道上作弊不影响别的道的随机事件序列（除了跟随领跑的那点牵引）', () => {
        const base = runToEnd(spec());
        const cheated = runToEnd(spec({ interventions: [{ step: 300, lane: 0, kind: 'bias', mul: 0.5 }] }));
        const lane2Events = sim => sim.events.filter(e => e.lane === 2).map(e => e.moveId);
        // 事件抽签用每道独立的随机流，前几次抽到的招式应该一样
        assert.deepEqual(lane2Events(cheated).slice(0, 2), lane2Events(base).slice(0, 2));
    });

    it('暗调减速能把冠军拉下来', () => {
        const base = runToEnd(spec());
        const winner = base.finishedOrder[0];
        const slowed = runToEnd(spec({ interventions: [{ step: 60, lane: winner, kind: 'bias', mul: 0.5 }] }));
        assert.notEqual(slowed.finishedOrder[0], winner);
        assert.equal(slowed.finishedOrder[5], winner);
    });

    it('闪现是瞬移：生效那一步位置跳一截', () => {
        const sim = new BeetleRaceSim(spec({ pool: [], interventions: [{ step: 300, lane: 1, kind: 'move', actionId: 'blink' }] }));
        sim.advanceToStep(299);
        let before = sim.lanes[1].x;
        let jumped = 0;
        for (let i = 0; i < 80; i++) {
            sim.advance();
            const now = sim.lanes[1].x;
            if (now - before > 50) jumped += 1;
            before = now;
        }
        assert.equal(jumped, 1);
    });

    it('起飞作弊能让最弱的那只赢（多试几个种子，大多数能赢）', () => {
        let wins = 0;
        for (const seed of [11, 22, 33, 44, 55, 66]) {
            const ivs = [900, 1200, 1500].map(step => ({ step, lane: 4, kind: 'move', actionId: 'fly' }));
            const sim = runToEnd(spec({ seed, interventions: ivs }));
            if (sim.finishedOrder[0] === 4) wins += 1;
        }
        assert.ok(wins >= 4, `只赢了 ${wins}/6`);
    });

    it('战力有用：10 战力对 1 战力，大样本里明显占优', () => {
        let strong = 0;
        for (let seed = 1; seed <= 60; seed++) {
            const sim = runToEnd({
                seed, durationSec: 20, eventRate: 'normal', pool,
                lanes: [{ power: 10, temperament: 'steady' }, { power: 1, temperament: 'steady' }]
            });
            if (sim.finishedOrder[0] === 0) strong += 1;
        }
        assert.ok(strong >= 45, `强的只赢了 ${strong}/60`);
    });

    it('招式时长覆盖：冰冻 6 秒就真的停 6 秒', () => {
        const sim = new BeetleRaceSim(spec({ pool: [], interventions: [{ step: 300, lane: 2, kind: 'move', actionId: 'freeze', dur: 6 }] }));
        sim.advanceToStep(301);
        const action = sim.lanes[2].action;
        assert.equal(action.end - action.start, 6 * SIM_HZ);
        const x0 = sim.lanes[2].x;
        sim.advanceToStep(300 + 6 * SIM_HZ - 5);
        assert.ok(sim.lanes[2].x - x0 < 15, '冻住期间几乎没挪');
    });

    it('强度放大幅度：闪现 ×2 瞬移两倍远', () => {
        const jump = (strength) => {
            const sim = new BeetleRaceSim(spec({ pool: [], interventions: [{ step: 300, lane: 1, kind: 'move', actionId: 'blink', strength }] }));
            sim.advanceToStep(299);
            let before = sim.lanes[1].x;
            let biggest = 0;
            for (let i = 0; i < 80; i++) { sim.advance(); biggest = Math.max(biggest, sim.lanes[1].x - before); before = sim.lanes[1].x; }
            return biggest;
        };
        const one = jump(1);
        const two = jump(2);
        assert.ok(Math.abs(two - one * 2) < 3, `${one} vs ${two}`);
    });

    it('打喷嚏是往后崩：那一下位置往回退', () => {
        const sim = new BeetleRaceSim(spec({ pool: [], interventions: [{ step: 300, lane: 0, kind: 'move', actionId: 'sneeze' }] }));
        sim.advanceToStep(300);
        const x0 = sim.lanes[0].x;
        sim.advanceToStep(300 + 60);
        assert.ok(sim.lanes[0].x < x0, '喷嚏之后比开始时还靠后');
    });

    it('加速类不开放时长：冲刺传了 6 秒也只冲默认那么久', async () => {
        const { ACTIONS } = await import('../scripts/games/beetlerace/BeetleRaceCatalog.js');
        const sim = new BeetleRaceSim(spec({ pool: [], interventions: [{ step: 300, lane: 2, kind: 'move', actionId: 'dash', dur: 6, strength: 1.5 }] }));
        sim.advanceToStep(301);
        const action = sim.lanes[2].action;
        assert.equal(action.end - action.start, Math.floor(ACTIONS.dash.sim.dur * SIM_HZ));
        assert.equal(action.strength, 1.5);
    });

    it('延长动作 = 拉长中间段：入场和收尾的秒数不变', async () => {
        const { remapProgress } = await import('../scripts/games/beetlerace/BeetleRaceRender.js');
        const d0 = 2.2;
        // 冰冻默认 2.2 秒，持续段 [0.1, 0.78]：入场 0.22 秒、收尾 0.484 秒
        assert.ok(Math.abs(remapProgress('freeze', 0.11, 6, d0) - 0.05) < 1e-9, '入场按原速');
        assert.ok(Math.abs(remapProgress('freeze', 6 - 0.242, 6, d0) - 0.89) < 1e-9, '收尾按原速');
        const mid = remapProgress('freeze', 3, 6, d0);
        assert.ok(mid > 0.1 && mid < 0.78, '中间停在持续段里');
        assert.equal(remapProgress('freeze', 1.1, d0, d0), 0.5, '默认时长时就是线性');
    });

    it('随机池空的时候不出随机事件', () => {
        const sim = runToEnd(spec({ pool: [] }));
        assert.equal(sim.events.length, 0);
    });

    it('撞线后滑行有上限，不会跑出板子', () => {
        const sim = runToEnd(spec());
        sim.getLanes().forEach(lane => assert.ok(lane.x <= TRACK_LENGTH + 60 + 1e-9));
    });
});
