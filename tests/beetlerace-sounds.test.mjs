import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BEETLE_SOUNDS, BeetleRaceSoundDirector, beetleSoundSrc, isBeetleSoundOn, setBeetleSoundOn } from '../scripts/games/beetlerace/BeetleRaceSounds.js';
import { ACTIONS } from '../scripts/games/beetlerace/BeetleRaceCatalog.js';
import { getBeetlePref } from '../scripts/games/beetlerace/BeetleRacePrefs.js';

const INTRO = 2400;
const STEP = 4200;
const COUNT = 3200;
const LANES = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }];

function director() {
    const heard = [];
    const later = [];
    let now = 0;
    const d = new BeetleRaceSoundDirector({
        play: (name) => heard.push(name),
        introMs: INTRO, stepMs: STEP, countdownMs: COUNT, trackLength: 1000,
        paradeActionFor: () => 'bow',
        isMagic: (id) => !!ACTIONS[id]?.magic,
        now: () => now,
        later: (fn) => later.push(fn)
    });
    return {
        d, heard, later,
        at(ms) { now = ms; },
        tick(state, clock = {}, sim = null, mine = []) { d.tick({ state: { race: { lanes: LANES }, bets: [], ...state }, clock, sim, mine }); }
    };
}

function fakeSim({ events = [], order = [], lanes = [] } = {}) {
    return { events, finishedOrder: order, lanes, getLanes: () => lanes };
}

describe('甲虫赛跑音效 · 素材', () => {
    it('音量表里每一条都有文件，27 个动作每个都有自己的声', () => {
        for (const name of Object.keys(BEETLE_SOUNDS)) {
            const file = fileURLToPath(new URL(`../${beetleSoundSrc(name).replace('modules/parlor/', '')}`, import.meta.url));
            assert.ok(existsSync(file), `缺 ${name}.ogg`);
        }
        for (const id of Object.keys(ACTIONS)) assert.ok(BEETLE_SOUNDS[`act-${id}`] != null, `动作 ${id} 没配声`);
    });
});

describe('甲虫赛跑音效 · 时机', () => {
    it('巡游刚开始打开：放开幕；中途才打开：不补', () => {
        const fresh = director();
        fresh.tick({ phase: 'PARADE', paradeIndex: 0 }, { paradeElapsedMs: 100 });
        assert.deepEqual(fresh.heard, ['intro']);
        const late = director();
        late.tick({ phase: 'PARADE', paradeIndex: 2 }, { paradeElapsedMs: 13000 });
        assert.deepEqual(late.heard, []);
    });

    it('每只站上圆台"嗒哒"一声，接着配入场动作；三个调轮着用', () => {
        const x = director();
        x.tick({ phase: 'PARADE', paradeIndex: 0 }, { paradeElapsedMs: 100 });
        x.heard.length = 0;
        for (const [index, local] of [[0, 500], [0, 950], [0, 1200], [1, 100], [1, 950], [1, 1200]]) {
            x.tick({ phase: 'PARADE', paradeIndex: index }, { paradeElapsedMs: INTRO + index * STEP + local });
        }
        assert.deepEqual(x.heard, ['entrance-a', 'act-bow', 'entrance-b', 'act-bow']);
    });

    it('下注：谁押都叮一声，撤注不响；最后五秒每秒一下钟', () => {
        const x = director();
        x.tick({ phase: 'BETTING', bets: [] }, { bettingRemainingMs: 20000 });
        x.tick({ phase: 'BETTING', bets: [{ userId: 'u1', lane: 0, amount: 10 }] }, { bettingRemainingMs: 19000 });
        x.tick({ phase: 'BETTING', bets: [] }, { bettingRemainingMs: 18000 });
        assert.deepEqual(x.heard, ['bet']);
        x.heard.length = 0;
        for (const ms of [5400, 4900, 4800, 3900, 2100, 900]) x.tick({ phase: 'BETTING' }, { bettingRemainingMs: ms });
        assert.deepEqual(x.heard, ['tick', 'tick', 'tick', 'tick']);
    });

    it('巡游接下注摇铃，直接进下注是拉幕；倒数 3-2-1 之后开闸', () => {
        const x = director();
        x.tick({ phase: 'PARADE', paradeIndex: 5 }, { paradeElapsedMs: 30000 });
        x.tick({ phase: 'BETTING' }, { bettingRemainingMs: 30000 });
        x.tick({ phase: 'COUNTDOWN' }, { countdownRemainingMs: 3100 });
        x.tick({ phase: 'COUNTDOWN' }, { countdownRemainingMs: 1900 });
        x.tick({ phase: 'COUNTDOWN' }, { countdownRemainingMs: 600 });
        x.tick({ phase: 'RACING' }, {}, fakeSim());
        x.tick({ phase: 'RESOLVING', result: { rows: [] } }, {}, fakeSim());
        x.tick({ phase: 'BETTING' }, { bettingRemainingMs: 30000 });
        assert.deepEqual(x.heard, ['bell', 'count-3', 'count-2', 'count-1', 'go', 'curtain']);
    });

    it('比赛里：法术必响，普通状况限流，暗调不响；重算的事件表不重复响', () => {
        const x = director();
        x.tick({ phase: 'RACING' }, {}, fakeSim());
        const events = [
            { step: 10, lane: 0, actionId: 'dash' },
            { step: 11, lane: 1, actionId: 'sneeze' },
            { step: 12, lane: 2, actionId: 'zap' },
            { step: 13, lane: 3, kind: 'bias' }
        ];
        x.at(1000);
        x.tick({ phase: 'RACING' }, {}, fakeSim({ events }));
        assert.deepEqual(x.heard, ['act-dash', 'act-zap']);
        // 晚到的干预让本地从头重算：新对象、同一串历史，不该再响一遍
        x.at(2000);
        x.tick({ phase: 'RACING' }, {}, fakeSim({ events: [...events, { step: 40, lane: 1, actionId: 'nap' }] }));
        assert.deepEqual(x.heard, ['act-dash', 'act-zap', 'act-nap']);
    });

    it('领头过八成放冲刺；撞线一次；前两名差不到 12 步再补快门', () => {
        const x = director();
        x.tick({ phase: 'RACING' }, {}, fakeSim());
        x.tick({ phase: 'RACING' }, {}, fakeSim({ lanes: [{ x: 850 }, { x: 700 }] }));
        const lanes = [{ x: 1000, finishStep: 500 }, { x: 1000, finishStep: 505 }];
        x.tick({ phase: 'RACING' }, {}, fakeSim({ order: [0], lanes }));
        x.tick({ phase: 'RACING' }, {}, fakeSim({ order: [0, 1], lanes }));
        x.tick({ phase: 'RACING' }, {}, fakeSim({ order: [0, 1], lanes }));
        assert.deepEqual(x.heard, ['final', 'finish', 'photo']);
    });

    it('结算：自己押了才说输赢，没下注的人不打扰', () => {
        const rows = [{ id: 'me', staked: 10, payout: 0 }, { id: 'you', staked: 20, payout: 60 }];
        const lose = director();
        lose.tick({ phase: 'RACING' }, {}, fakeSim());
        lose.tick({ phase: 'RESOLVING', result: { rows } }, {}, fakeSim(), ['me']);
        lose.later.forEach(fn => fn());
        assert.deepEqual(lose.heard, ['lose']);
        const win = director();
        win.tick({ phase: 'RACING' }, {}, fakeSim());
        win.tick({ phase: 'RESOLVING', result: { rows } }, {}, fakeSim(), ['you']);
        win.later.forEach(fn => fn());
        assert.deepEqual(win.heard, ['win']);
        const watcher = director();
        watcher.tick({ phase: 'RACING' }, {}, fakeSim());
        watcher.tick({ phase: 'RESOLVING', result: { rows } }, {}, fakeSim(), ['nobody']);
        assert.equal(watcher.later.length, 0);
    });
});

describe('甲虫赛跑音效 · 自己的静音开关', () => {
    it('没注册设置当开着；注册了按 GM 定的值；只有 GM 改得动', async () => {
        const saved = globalThis.game;
        try {
            globalThis.game = { settings: { settings: new Map(), get: () => false, set: async () => {} } };
            assert.equal(isBeetleSoundOn(), true);
            assert.equal(getBeetlePref('cleanTable'), false, '纯净桌面默认不开');
            const store = { value: true };
            globalThis.game = { user: { isGM: false }, settings: {
                settings: new Map([['parlor.beetleRaceSound', {}]]),
                get: (_m, key) => (key === 'beetleRaceSound' ? store.value : undefined),
                set: async (_m, key, value) => { if (key === 'beetleRaceSound') store.value = value; }
            } };
            assert.equal(isBeetleSoundOn(), true);
            await setBeetleSoundOn(false);
            assert.equal(store.value, true, '玩家改不动全桌的开关');
            globalThis.game.user.isGM = true;
            await setBeetleSoundOn(false);
            assert.equal(store.value, false);
            assert.equal(isBeetleSoundOn(), false);
        } finally {
            globalThis.game = saved;
        }
    });
});
