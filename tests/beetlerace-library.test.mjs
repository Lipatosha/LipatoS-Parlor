import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';

const cn = JSON.parse(readFileSync(new URL('../languages/cn.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../languages/en.json', import.meta.url), 'utf8'));
const lookupIn = (dict, key) => key.split('.').reduce((node, part) => node?.[part], dict) ?? key;
const lookup = (key) => key.split('.').reduce((node, part) => node?.[part], cn) ?? key;
const format = (key, data = {}) => String(lookup(key)).replace(/\{(\w+)\}/gu, (m, name) => data[name] ?? m);

let store = null;
globalThis.foundry = { utils: { randomID: () => Math.random().toString(36).slice(2, 12) } };
globalThis.game = {
    user: { id: 'gm', isGM: true },
    i18n: { localize: lookup, format },
    settings: {
        settings: new Map([['parlor.beetleRace', {}]]),
        get: () => structuredClone(store),
        set: async (_m, _k, value) => { store = structuredClone(value); return value; }
    }
};
globalThis.ui = { notifications: { warn: () => {} } };

const { BeetleRaceLibrary, sanitizeRace, sanitizeBeetle } = await import('../scripts/games/beetlerace/BeetleRaceLibrary.js');
const { PRESET_BEETLES, PRESET_MOVES, PRESET_BUBBLES, PRESET_RACES, ACTIONS, ACTION_IDS, TEMPERAMENTS } = await import('../scripts/games/beetlerace/BeetleRaceCatalog.js');

describe('BeetleRaceLibrary', () => {
    beforeEach(() => { store = { beetles: [], bubbles: [], moves: [], races: [], stats: {} }; });

    it('本版开放 14 种动作，新赛事的预制招式不再抽到延期动作', () => {
        assert.equal(ACTION_IDS.length, 14);
        const moves = BeetleRaceLibrary.listMoves();
        assert.equal(moves.length, 18);
        const race = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.ok(race.cheats.every(move => ACTION_IDS.includes(move.actionId)));
        assert.ok(race.pool.every(move => ACTION_IDS.includes(move.actionId)));
        assert.ok(moves.some(move => ACTIONS[move.actionId].magic));
        assert.ok(moves.some(move => ACTIONS[move.actionId].category === 'show'));
    });

    it('延期动作的旧自定义招式仍能读取、编辑和用于赛事，精简预制目录不改世界数据', async () => {
        const old = await BeetleRaceLibrary.saveMove({ name: '旧舞步', actionId: 'dance', pool: 'random', duration: 4 });
        const before = structuredClone(store);
        assert.equal(BeetleRaceLibrary.listMoves().find(move => move.id === old.id).actionId, 'dance');
        const race = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.equal(race.pool.find(move => move.id === old.id).dur, 4);
        assert.deepEqual(store, before);
        const saved = await BeetleRaceLibrary.saveMove({ ...old, name: '旧舞步改名' });
        assert.equal(saved.actionId, 'dance');
        assert.equal(saved.duration, 4);
    });

    it('预制文字都有中文翻译，没有漏键', () => {
        const keys = [
            ...PRESET_BEETLES.flatMap(b => [b.nameKey, b.introKey, b.catchphraseKey]),
            ...PRESET_MOVES.map(m => m.nameKey),
            ...PRESET_BUBBLES.map(b => b.textKey),
            ...PRESET_RACES.map(r => r.nameKey),
            ...Object.keys(ACTIONS).flatMap(id => [`PARLOR.BeetleRace.Action.${id}.Name`, `PARLOR.BeetleRace.Action.${id}.Desc`]),
            ...Object.keys(TEMPERAMENTS).flatMap(id => [`PARLOR.BeetleRace.Temperament.${id}.Name`, `PARLOR.BeetleRace.Temperament.${id}.Intro`])
        ];
        assert.deepEqual(keys.filter(key => lookupIn(cn, key) === key), [], '中文漏键');
        assert.deepEqual(keys.filter(key => lookupIn(en, key) === key), [], '英文漏键');
    });

    it('招式的时长和强度：清洗夹紧，解析进快照；没设时长就用动作默认', async () => {
        const { sanitizeMove } = await import('../scripts/games/beetlerace/BeetleRaceLibrary.js');
        // 变蜗牛两样都能调：越界夹紧
        const snail = sanitizeMove({ actionId: 'snail', duration: 99, strength: 9 });
        assert.deepEqual([snail.duration, snail.strength], [8, 3]);
        // 冲刺只调强度：时长存不进去；冰冻只调时长：强度归 1
        assert.equal(sanitizeMove({ actionId: 'dash', duration: 5, strength: 2 }).duration, 0);
        assert.equal(sanitizeMove({ actionId: 'dash', duration: 5, strength: 2 }).strength, 2);
        assert.equal(sanitizeMove({ actionId: 'freeze', duration: 5, strength: 2 }).strength, 1);
        assert.equal(sanitizeMove({ actionId: 'snail', duration: 0 }).duration, 0);
        const saved = await BeetleRaceLibrary.saveMove({ name: '长冰冻', actionId: 'freeze', pool: 'cheat', duration: 6, strength: 1 });
        const snap = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.equal(snap.cheats.find(m => m.id === saved.id).dur, 6);
        assert.equal(snap.cheats.find(m => m.id === 'preset:spellFreeze').dur, ACTIONS.freeze.sim.dur);
    });

    it('预制招式引用的气泡都存在', () => {
        const bubbleIds = new Set(PRESET_BUBBLES.map(b => b.id));
        for (const move of PRESET_MOVES) for (const id of move.bubbleIds) assert.ok(bubbleIds.has(id), move.id);
        assert.ok(BeetleRaceLibrary.listMoves().every(move => move.bubbleIds.length >= 2), '开放的预制招式都有多句台词');
    });

    it('旧单句台词兼容多句池；显式空池不退回旧引用，重复和空引用会清理', async () => {
        const { sanitizeMove } = await import('../scripts/games/beetlerace/BeetleRaceLibrary.js');
        store.moves.push({ id: 'legacy', name: '旧招', actionId: 'dash', bubbleId: 'preset:dash1' });
        assert.deepEqual(BeetleRaceLibrary.listMoves().find(move => move.id === 'legacy').bubbleIds, ['preset:dash1']);
        assert.deepEqual(sanitizeMove({ bubbleId: 'old', bubbleIds: [] }).bubbleIds, []);
        const saved = await BeetleRaceLibrary.saveMove({ actionId: 'hop', bubbleIds: ['preset:hop1', '', ' preset:hop1 ', 'preset:hop2'] });
        assert.deepEqual(saved.bubbleIds, ['preset:hop1', 'preset:hop2']);
        assert.equal(saved.bubbleId, 'preset:hop1');
    });

    it('预制启停只改使用设置，新赛事排除停用招式，旧快照及预制参数不变', async () => {
        const definitions = structuredClone(PRESET_MOVES);
        const snapshot = BeetleRaceLibrary.resolveRace('preset:ravencup');
        await BeetleRaceLibrary.savePresetMoveOptions('preset:dash', { enabled: false, name: '改名', actionId: 'fly' });
        await BeetleRaceLibrary.savePresetMoveOptions('preset:cheatFly', { enabled: false });
        const next = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.ok(!next.pool.some(move => move.id === 'preset:dash'));
        assert.ok(!next.cheats.some(move => ['preset:dash', 'preset:cheatFly'].includes(move.id)));
        assert.ok(snapshot.pool.some(move => move.id === 'preset:dash'));
        assert.equal(BeetleRaceLibrary.listMoves().length, 18, '停用后仍可在工坊选中');
        const dash = BeetleRaceLibrary.listMoves().find(move => move.id === 'preset:dash');
        assert.equal(dash.name, '猛冲');
        assert.equal(dash.actionId, 'dash');
        assert.deepEqual(PRESET_MOVES, definitions);
        await BeetleRaceLibrary.savePresetMoveOptions('preset:dash', { enabled: true });
        assert.ok(BeetleRaceLibrary.resolveRace('preset:ravencup').pool.some(move => move.id === 'preset:dash'));
    });

    it('自加台词进入预制招式随机池，保存其他素材和战绩不丢设置；空池保持静默', async () => {
        const line = await BeetleRaceLibrary.saveBubble({ text: '再跳一下！' });
        await BeetleRaceLibrary.savePresetMoveOptions('preset:hop', { enabled: false, bubbleIds: ['preset:hop1', line.id, 'missing'] });
        await BeetleRaceLibrary.saveBeetle({ name: '新虫' });
        await BeetleRaceLibrary.recordResult(['preset:jade'], 'preset:jade');
        const hop = BeetleRaceLibrary.listMoves().find(move => move.id === 'preset:hop');
        assert.equal(hop.enabled, false);
        assert.deepEqual(hop.bubbleIds, ['preset:hop1', line.id, 'missing']);
        await BeetleRaceLibrary.savePresetMoveOptions(hop.id, { enabled: true });
        const snapshot = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.deepEqual(snapshot.pool.find(move => move.id === hop.id).bubbles, ['嘿！咻！哈！', '再跳一下！']);
        await BeetleRaceLibrary.savePresetMoveOptions(hop.id, { bubbleIds: [] });
        const silent = BeetleRaceLibrary.resolveRace('preset:ravencup').pool.find(move => move.id === hop.id);
        assert.equal(silent.bubble, '');
        assert.deepEqual(silent.bubbles, []);
        assert.equal(snapshot.pool.find(move => move.id === hop.id).bubbles.length, 2, '保存不改旧快照');
    });

    it('全部停用随机招仍可解析赛事，自定义招式也遵循启停', async () => {
        store.presetMoveOptions = Object.fromEntries(PRESET_MOVES.filter(move => move.pool === 'random').map(move => [move.id, { enabled: false }]));
        const move = await BeetleRaceLibrary.saveMove({ name: '自定义', actionId: 'dash', pool: 'random', enabled: false });
        const snapshot = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.deepEqual(snapshot.pool, []);
        assert.ok(!snapshot.cheats.some(entry => entry.id === move.id));
        assert.ok(snapshot.cheats.length > 0);
    });

    it('玩家不能保存预制使用设置，未知预制 id 不写入', async () => {
        const before = structuredClone(store);
        assert.equal(await BeetleRaceLibrary.savePresetMoveOptions('preset:unknown', { enabled: false }), null);
        game.user.isGM = false;
        try {
            assert.equal(await BeetleRaceLibrary.savePresetMoveOptions('preset:hop', { enabled: false }), null);
            assert.deepEqual(store, before);
        } finally {
            game.user.isGM = true;
        }
    });

    it('坏数据被清洗：越界夹紧、非法枚举回默认、颜色格式校验', () => {
        const beetle = sanitizeBeetle({ id: 'x', name: 'a'.repeat(99), power: 99, temperament: 'evil', color: 'red', pattern: '???' });
        assert.equal(beetle.name.length, 24);
        assert.equal(beetle.power, 10);
        assert.equal(beetle.temperament, 'steady');
        assert.equal(beetle.color, '#8a5a2a');
        assert.equal(beetle.pattern, 'plain');

        const race = sanitizeRace({ beetleIds: ['a', 'a', 'b'], multipliers: { a: 0.5, b: 3.14159, zzz: 9 }, durationSec: 5, minBet: 50, maxBet: 10 });
        assert.deepEqual(race.beetleIds, ['a', 'b']);
        assert.deepEqual(race.multipliers, { a: 1.1, b: 3.1 });
        assert.equal(race.durationSec, 15);
        assert.equal(race.maxBet, 50, '上限比下限小时抬到下限');
    });

    it('存自建甲虫会分配 id；预制 id 不能被覆盖', async () => {
        const saved = await BeetleRaceLibrary.saveBeetle({ id: 'preset:copper', name: '冒牌将军', power: 3 });
        assert.ok(saved.id && !saved.id.startsWith('preset:'));
        const list = BeetleRaceLibrary.listBeetles();
        assert.equal(list.find(b => b.id === 'preset:copper').name, '赤铜将军');
        assert.equal(list.find(b => b.id === saved.id).name, '冒牌将军');
        assert.equal(await BeetleRaceLibrary.removeBeetle('preset:copper'), false);
    });

    it('复制预制条目得到可编辑的草稿', () => {
        const draft = BeetleRaceLibrary.duplicateDraft('beetle', 'preset:golden');
        assert.equal(draft.id, '');
        assert.equal(draft.name, '金角老爹（副本）');
        assert.equal(draft.power, 8);
        assert.equal('preset' in draft, false);
    });

    it('预制赛事卡解析成完整快照：倍率、随机池、作弊面板', () => {
        const snap = BeetleRaceLibrary.resolveRace('preset:ravencup');
        assert.equal(snap.lanes.length, 6);
        assert.equal(snap.lanes.find(l => l.beetleId === 'preset:golden').multiplier, 2);
        assert.equal(snap.lanes.find(l => l.beetleId === 'preset:ash').multiplier, 5);
        assert.ok(snap.pool.length > 0 && snap.pool.every(m => m.pool === 'random'));
        assert.ok(snap.cheats.some(m => m.pool === 'cheat'));
        assert.equal(snap.cheats.find(m => m.id === 'preset:cheatFly').bubble, '拜拜了您嘞！');
    });

    it('赛事卡里的甲虫被删了就跳过；不够 3 只返回 null', async () => {
        const a = await BeetleRaceLibrary.saveBeetle({ name: 'A' });
        const b = await BeetleRaceLibrary.saveBeetle({ name: 'B' });
        const race = await BeetleRaceLibrary.saveRace({ name: 'T', beetleIds: [a.id, b.id, 'preset:ash'], multiplier: 3 });
        assert.equal(BeetleRaceLibrary.resolveRace(race.id).lanes.length, 3);
        await BeetleRaceLibrary.removeBeetle(b.id);
        assert.equal(BeetleRaceLibrary.resolveRace(race.id), null);
    });

    it('记战绩：上场 +1 场，冠军 +1 胜', async () => {
        await BeetleRaceLibrary.recordResult(['preset:ash', 'preset:jade'], 'preset:ash');
        await BeetleRaceLibrary.recordResult(['preset:ash', 'preset:jade'], 'preset:jade');
        const list = BeetleRaceLibrary.listBeetles();
        assert.deepEqual(list.find(b => b.id === 'preset:ash').stats, { races: 2, wins: 1 });
        assert.deepEqual(list.find(b => b.id === 'preset:indigo').stats, { races: 0, wins: 0 });
    });

    it('性格生成介绍会带上名字', () => {
        assert.equal(BeetleRaceLibrary.introFromTemperament('greedy', '小胖'), '小胖看见吃的就走不动道，比赛也不例外。');
    });
});
