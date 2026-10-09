/**
 * 甲虫赛跑 · 预制目录
 *
 * 这里只放写死在代码里的东西：动作表、性格、预制气泡 / 招式 / 甲虫 / 赛事卡。
 * 文字一律是 i18n 键，DM 自建的东西在 BeetleRaceLibrary 里存原文，两边在 Library 那层合流。
 *
 * 动作的 sim 字段是模拟层唯一认的东西——改了它就改了比赛结果，别随手调数。
 * 动画怎么演归 BeetleRaceRender，跟这里无关。
 */

export const TRACK_LENGTH = 1000;

// 运动效果的几种形状：
// mul     速度乘一个系数（冲刺、起飞）
// stop    速度压到 crawl 比例（原地表演类），settle 越大刹得越急
// reverse 往回走，speed 是相对基础速度的比例（负数）
// blink   原地停住，走到 jumpAt 那一刻瞬移 dist
// impulse 原地停住，走到 at 那一刻给一下冲量（impulse × 基础速度，负数 = 往后崩），然后按 settle 刹住
//
// dur 是默认时长。tune 决定 DM 在招式里能调什么：
// - strength 只调幅度（加速类、瞬间发生的动作）。加速类不开放时长，Reslin 定的：冲多久不重要，冲多快才是招式的个性
// - duration 只调时长（原地演的动作）。延长 = 中间那段多维持一会儿，入场收尾照原速，不是把动画放慢
// - both      慢慢挪的动作：持续多久、慢到什么程度都能调
// magic 标记法术：只是分组和配色用，模拟层不区分。
export const ACTIONS = Object.freeze({
    dash:     { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 1.8, dur: 1.4 } },
    fly:      { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 2.4, dur: 2.0 } },
    hop:      { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 1.5, dur: 1.5 } },
    blink:    { category: 'boost', tune: 'strength', sim: { kind: 'blink', dur: 0.9, jumpAt: 0.45, dist: 90 } },
    jet:      { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 2.0, dur: 1.0 } },
    brake:    { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 1.2, crawl: 0, settle: 9 } },
    spin:     { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 0.9, crawl: 0.1, settle: 6 } },
    flip:     { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 1.6, crawl: 0, settle: 12 } },
    snack:    { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 1.4, crawl: 0, settle: 6 } },
    nap:      { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 2.0, crawl: 0, settle: 4 } },
    moonwalk: { category: 'stall', tune: 'both', sim: { kind: 'reverse', speed: -0.4, dur: 1.2 } },
    wander:   { category: 'stall', tune: 'both', sim: { kind: 'mul', mul: 0.5, dur: 1.5 } },
    trip:     { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 0.8, crawl: 0, settle: 14 } },
    taunt:    { category: 'show',  tune: 'duration', sim: { kind: 'stop', dur: 1.2, crawl: 0, settle: 8 } },
    bow:      { category: 'show',  tune: 'duration', sim: { kind: 'stop', dur: 1.0, crawl: 0, settle: 8 } },
    cheer:    { category: 'show',  tune: 'duration', sim: { kind: 'stop', dur: 1.0, crawl: 0, settle: 8 } },
    roll:     { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 2.0, dur: 1.6 } },
    dig:      { category: 'boost', tune: 'strength', sim: { kind: 'mul', mul: 2.2, dur: 2.0 } },
    sneeze:   { category: 'stall', tune: 'strength', sim: { kind: 'impulse', dur: 1.1, at: 0.44, impulse: -2.2, settle: 5 } },
    mud:      { category: 'stall', tune: 'duration', sim: { kind: 'stop', dur: 1.8, crawl: 0.05, settle: 8 } },
    dungball: { category: 'stall', tune: 'both', sim: { kind: 'mul', mul: 0.35, dur: 2.0 } },
    dance:    { category: 'show',  tune: 'duration', sim: { kind: 'stop', dur: 1.6, crawl: 0, settle: 8 } },
    haste:    { category: 'boost', tune: 'strength', magic: true, sim: { kind: 'mul', mul: 1.9, dur: 2.2 } },
    enlarge:  { category: 'boost', tune: 'strength', magic: true, sim: { kind: 'mul', mul: 1.7, dur: 2.4 } },
    freeze:   { category: 'stall', tune: 'duration', magic: true, sim: { kind: 'stop', dur: 2.2, crawl: 0, settle: 20 } },
    zap:      { category: 'stall', tune: 'duration', magic: true, sim: { kind: 'stop', dur: 1.8, crawl: 0, settle: 16 } },
    snail:    { category: 'stall', tune: 'both', magic: true, sim: { kind: 'mul', mul: 0.2, dur: 3.0 } }
});

// 招式可调的范围：时长（秒）和强度（幅度倍数）。0 / 空 = 用动作默认
export const MOVE_LIMITS = Object.freeze({ minDuration: 0.5, maxDuration: 8, minStrength: 0.3, maxStrength: 3 });

/** 这个动作在招式里能调哪几样 */
export function actionTunables(actionId) {
    const tune = ACTIONS[actionId]?.tune;
    return { duration: tune === 'duration' || tune === 'both', strength: tune === 'strength' || tune === 'both' };
}

// 本版只开放这组动作；完整定义留着兼容已保存的自定义招式和正在进行的比赛快照。
export const ACTION_IDS = Object.freeze([
    'dash', 'fly', 'hop', 'blink',
    'brake', 'flip', 'snack', 'nap', 'moonwalk', 'trip',
    'taunt', 'bow', 'haste', 'freeze'
]);
export const IDLE_ACTION_IDS = Object.freeze(['bow', 'taunt', 'hop']);

// 性格：freq 是随机事件频率的倍数，prefer 里的动作权重 ×5，其余 ×1。
// sly 前半程几乎不出事、后半程偏爱冲刺，由 lateBias 表达（后半程 freq × lateBias）。
export const TEMPERAMENTS = Object.freeze({
    steady:  { freq: 0.6, prefer: ['dash'] },
    greedy:  { freq: 1.0, prefer: ['snack', 'dungball'] },
    hothead: { freq: 1.4, prefer: ['dash', 'jet', 'trip', 'roll'] },
    lazy:    { freq: 1.0, prefer: ['nap', 'wander'], slowStart: true },
    clumsy:  { freq: 1.4, prefer: ['spin', 'trip', 'flip', 'mud', 'sneeze'] },
    showoff: { freq: 1.0, prefer: ['taunt', 'bow', 'hop', 'cheer', 'dance'] },
    timid:   { freq: 1.0, prefer: ['brake', 'moonwalk', 'dig'] },
    sly:     { freq: 0.4, prefer: ['dash', 'dig'], lateBias: 3 }
});

export const TEMPERAMENT_IDS = Object.freeze(Object.keys(TEMPERAMENTS));

export const PATTERNS = Object.freeze(['plain', 'spots', 'stripes', 'stars', 'bands']);
export const HORNS = Object.freeze(['none', 'rhino', 'stag']);
export const EVENT_RATES = Object.freeze(['low', 'normal', 'high']);
export const POWER_DISPLAYS = Object.freeze(['number', 'stars', 'hidden']);

// 预制气泡：按"最适合配哪个动作"分组只是为了预制招式好挑，本身跟动作不绑
const BUBBLE_IDS = [
    'dash1', 'dash2', 'fly1', 'fly2', 'hop1', 'blink1', 'blink2', 'jet1', 'jet2',
    'brake1', 'brake2', 'spin1', 'spin2', 'flip1', 'flip2', 'snack1', 'snack2',
    'nap1', 'nap2', 'moonwalk1', 'moonwalk2', 'wander1', 'wander2', 'trip1', 'trip2',
    'taunt1', 'taunt2', 'bow1', 'cheer1', 'cheer2',
    'rigged1', 'rigged2', 'rigged3', 'sleepy1',
    'roll1', 'dig1', 'dig2', 'sneeze1', 'mud1', 'dung1', 'dance1',
    'haste1', 'enlarge1', 'freeze1', 'zap1', 'snail1', 'magic1',
    'hop2', 'bow2', 'haste2', 'freeze2'
];

export const PRESET_BUBBLES = Object.freeze(BUBBLE_IDS.map(id => Object.freeze({
    id: `preset:${id}`,
    textKey: `PARLOR.BeetleRace.Bubble.${id}`,
    preset: true
})));

// pool: random 进随机池 / cheat 只在 DM 作弊面板出现
const move = (id, actionId, bubble, pool, alternatives = []) => Object.freeze({
    id: `preset:${id}`,
    nameKey: `PARLOR.BeetleRace.Move.${id}`,
    actionId,
    bubbleId: bubble ? `preset:${bubble}` : '',
    bubbleIds: Object.freeze([bubble, ...alternatives].filter(Boolean).map(id => `preset:${id}`)),
    pool,
    preset: true
});

export const PRESET_MOVES = Object.freeze([
    move('dash', 'dash', 'dash1', 'random', ['dash2']),
    move('hop', 'hop', 'hop1', 'random', ['hop2']),
    move('jet', 'jet', 'jet2', 'random'),
    move('brake', 'brake', 'brake1', 'random', ['brake2']),
    move('spin', 'spin', 'spin1', 'random'),
    move('flip', 'flip', 'flip1', 'random', ['flip2']),
    move('snack', 'snack', 'snack1', 'random', ['snack2']),
    move('nap', 'nap', 'nap1', 'random', ['nap2']),
    move('moonwalk', 'moonwalk', 'moonwalk2', 'random', ['moonwalk1']),
    move('wander', 'wander', 'wander1', 'random'),
    move('trip', 'trip', 'trip1', 'random', ['trip2']),
    move('taunt', 'taunt', 'taunt1', 'random', ['taunt2']),
    move('bow', 'bow', 'bow1', 'random', ['bow2']),
    move('cheer', 'cheer', 'cheer2', 'random'),
    move('roll', 'roll', 'roll1', 'random'),
    move('dig', 'dig', 'dig1', 'random'),
    move('sneeze', 'sneeze', 'sneeze1', 'random'),
    move('mud', 'mud', 'mud1', 'random'),
    move('dungball', 'dungball', 'dung1', 'random'),
    move('dance', 'dance', 'dance1', 'random'),
    move('cheatFly', 'fly', 'fly2', 'cheat', ['fly1']),
    move('cheatBlink', 'blink', 'blink1', 'cheat', ['blink2']),
    move('cheatRocket', 'jet', 'rigged2', 'cheat'),
    move('cheatDash', 'dash', 'rigged1', 'cheat', ['dash2']),
    move('cheatNap', 'nap', 'sleepy1', 'cheat', ['nap2']),
    move('cheatFlip', 'flip', 'flip2', 'cheat', ['flip1']),
    move('cheatMoonwalk', 'moonwalk', 'rigged3', 'cheat', ['moonwalk2']),
    move('cheatTunnel', 'dig', 'dig2', 'cheat'),
    move('spellHaste', 'haste', 'haste1', 'cheat', ['haste2']),
    move('spellEnlarge', 'enlarge', 'enlarge1', 'cheat'),
    move('spellFreeze', 'freeze', 'freeze1', 'cheat', ['freeze2']),
    move('spellZap', 'zap', 'zap1', 'cheat'),
    move('spellSnail', 'snail', 'snail1', 'cheat')
]);

const beetle = (id, color, pattern, horn, power, temperament) => Object.freeze({
    id: `preset:${id}`,
    nameKey: `PARLOR.BeetleRace.Beetle.${id}.Name`,
    introKey: `PARLOR.BeetleRace.Beetle.${id}.Intro`,
    catchphraseKey: `PARLOR.BeetleRace.Beetle.${id}.Catchphrase`,
    color,
    pattern,
    horn,
    power,
    temperament,
    preset: true
});

export const PRESET_BEETLES = Object.freeze([
    beetle('copper', '#b4471f', 'plain', 'rhino', 7, 'hothead'),
    beetle('jade', '#2f8a4a', 'stripes', 'none', 6, 'sly'),
    beetle('indigo', '#3248a8', 'stars', 'stag', 5, 'steady'),
    beetle('golden', '#c28e1c', 'bands', 'rhino', 8, 'lazy'),
    beetle('ash', '#5d5750', 'spots', 'none', 4, 'clumsy'),
    beetle('amethyst', '#8a3aa8', 'plain', 'none', 5, 'showoff'),
    beetle('crimson', '#a8323c', 'spots', 'none', 3, 'greedy'),
    beetle('moss', '#5f7a2e', 'bands', 'stag', 6, 'timid')
]);

// 预制赛事卡顺手演示单虫倍率：热门低赔、冷门高赔
export const PRESET_RACES = Object.freeze([Object.freeze({
    id: 'preset:ravencup',
    nameKey: 'PARLOR.BeetleRace.Race.ravencup',
    beetleIds: ['preset:copper', 'preset:jade', 'preset:indigo', 'preset:golden', 'preset:ash', 'preset:amethyst'],
    durationSec: 30,
    betSeconds: 30,
    multiplier: 2,
    multipliers: Object.freeze({
        'preset:golden': 2,
        'preset:copper': 2.5,
        'preset:jade': 3,
        'preset:indigo': 4,
        'preset:amethyst': 4,
        'preset:ash': 5
    }),
    minBet: 1,
    maxBet: 0,
    powerDisplay: 'stars',
    eventRate: 'normal',
    parade: true,
    preset: true
})]);

export const RACE_LIMITS = Object.freeze({
    minLanes: 3,
    maxLanes: 8,
    minDuration: 15,
    maxDuration: 90,
    minBetSeconds: 5,
    maxBetSeconds: 180,
    minMultiplier: 1.1,
    maxMultiplier: 100,
    minPower: 1,
    maxPower: 10
});

export function isPresetId(id) {
    return String(id || '').startsWith('preset:');
}
