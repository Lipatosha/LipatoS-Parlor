/**
 * 甲虫赛跑 · 素材库（world setting）
 *
 * 保存 DM 自建素材、战绩和预制招式的使用设置；预制定义留在 Catalog，不能直接改参数。
 * 预制条目的 id 都带 `preset:` 前缀，启停和台词池单独存，改动作参数仍须复制成自定义。
 *
 * resolveRace 会把一张赛事卡连同上场甲虫、随机池、作弊招整个解析成快照塞进开局参数——
 * 比赛期间 DM 再去工坊改名字改台词，不会把正在跑的这场搞乱，各端看到的也一定是同一份。
 */

import {
    ACTIONS,
    ACTION_IDS,
    MOVE_LIMITS,
    actionTunables,
    TEMPERAMENTS,
    PATTERNS,
    HORNS,
    EVENT_RATES,
    POWER_DISPLAYS,
    RACE_LIMITS,
    PRESET_BEETLES,
    PRESET_BUBBLES,
    PRESET_MOVES,
    PRESET_RACES,
    isPresetId
} from './BeetleRaceCatalog.js';

const MODULE_ID = 'parlor';
const SETTING_KEY = 'beetleRace';
const CHANGE_HOOK = 'parlorBeetleRaceChanged';
const MAX_ITEMS = 200;

const EMPTY = Object.freeze({ beetles: [], bubbles: [], moves: [], races: [], stats: {}, presetMoveOptions: {} });

const localize = (key, data) => {
    const i18n = globalThis.game?.i18n;
    if (!i18n) return key;
    return data ? i18n.format(key, data) : i18n.localize(key);
};

function text(value, max) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function num(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function oneOf(value, list, fallback) {
    return list.includes(value) ? value : fallback;
}

function color(value, fallback = '#8a5a2a') {
    const safe = String(value || '').trim();
    return /^#[0-9a-f]{6}$/iu.test(safe) ? safe.toLowerCase() : fallback;
}

function newId(kind) {
    const random = globalThis.foundry?.utils?.randomID?.(10) || Math.random().toString(36).slice(2, 12);
    return `${kind}-${random}`;
}

// ───────── 清洗（存进去之前和读出来之后都过一遍） ─────────

export function sanitizeBeetle(raw = {}) {
    return {
        id: text(raw.id, 60),
        name: text(raw.name, 24),
        intro: text(raw.intro, 160),
        catchphrase: text(raw.catchphrase, 40),
        color: color(raw.color),
        pattern: oneOf(raw.pattern, PATTERNS, 'plain'),
        horn: oneOf(raw.horn, HORNS, 'none'),
        power: Math.round(num(raw.power, 5, RACE_LIMITS.minPower, RACE_LIMITS.maxPower)),
        temperament: oneOf(raw.temperament, Object.keys(TEMPERAMENTS), 'steady')
    };
}

export function sanitizeBubble(raw = {}) {
    return { id: text(raw.id, 60), text: text(raw.text, 60) };
}

function moveBubbleIds(raw) {
    // 明确的空数组代表不说话；旧世界的单句引用仍能读入，不能用 || 把空池换回默认。
    const ids = Array.isArray(raw.bubbleIds) ? raw.bubbleIds : [raw.bubbleId];
    return [...new Set(ids.map(id => text(id, 60)).filter(Boolean))].slice(0, MAX_ITEMS);
}

function sanitizePresetMoveOptions(raw = {}) {
    const options = {};
    for (const { id } of PRESET_MOVES) {
        const entry = raw?.[id];
        if (!entry || typeof entry !== 'object') continue;
        options[id] = { enabled: entry.enabled !== false };
        if (Array.isArray(entry.bubbleIds)) options[id].bubbleIds = moveBubbleIds(entry);
    }
    return options;
}

// duration 0 = 用动作默认时长；strength 1 = 默认幅度。动作没开放的那一项一律归默认，别存着误导人
export function sanitizeMove(raw = {}) {
    const actionId = oneOf(raw.actionId, Object.keys(ACTIONS), 'dash');
    const tunable = actionTunables(actionId);
    const duration = Number(raw.duration);
    const bubbleIds = moveBubbleIds(raw);
    return {
        id: text(raw.id, 60),
        name: text(raw.name, 24),
        actionId,
        bubbleId: bubbleIds[0] || '',
        bubbleIds,
        enabled: raw.enabled !== false,
        pool: oneOf(raw.pool, ['random', 'cheat'], 'cheat'),
        duration: tunable.duration && duration > 0 ? Math.round(num(duration, 0, MOVE_LIMITS.minDuration, MOVE_LIMITS.maxDuration) * 10) / 10 : 0,
        strength: tunable.strength ? Math.round(num(raw.strength, 1, MOVE_LIMITS.minStrength, MOVE_LIMITS.maxStrength) * 10) / 10 : 1
    };
}

export function sanitizeRace(raw = {}) {
    const beetleIds = [...new Set((Array.isArray(raw.beetleIds) ? raw.beetleIds : []).map(id => text(id, 60)).filter(Boolean))]
        .slice(0, RACE_LIMITS.maxLanes);
    const multipliers = {};
    for (const [id, value] of Object.entries(raw.multipliers || {})) {
        const n = Number(value);
        if (!beetleIds.includes(id) || !Number.isFinite(n) || n <= 0) continue;
        multipliers[id] = Math.round(num(n, 2, RACE_LIMITS.minMultiplier, RACE_LIMITS.maxMultiplier) * 10) / 10;
    }
    const minBet = Math.floor(num(raw.minBet, 1, 1, 1e9));
    const maxBet = Math.floor(num(raw.maxBet, 0, 0, 1e9));
    return {
        id: text(raw.id, 60),
        name: text(raw.name, 40),
        beetleIds,
        durationSec: Math.round(num(raw.durationSec, 30, RACE_LIMITS.minDuration, RACE_LIMITS.maxDuration)),
        betSeconds: Math.round(num(raw.betSeconds, 30, RACE_LIMITS.minBetSeconds, RACE_LIMITS.maxBetSeconds)),
        multiplier: Math.round(num(raw.multiplier, 2, RACE_LIMITS.minMultiplier, RACE_LIMITS.maxMultiplier) * 10) / 10,
        multipliers,
        minBet,
        // 0 = 不设上限；设了就不能比下限还小
        maxBet: maxBet > 0 ? Math.max(minBet, maxBet) : 0,
        powerDisplay: oneOf(raw.powerDisplay, POWER_DISPLAYS, 'stars'),
        eventRate: oneOf(raw.eventRate, EVENT_RATES, 'normal'),
        parade: raw.parade !== false
    };
}

function sanitizeStats(raw = {}) {
    const out = {};
    for (const [id, entry] of Object.entries(raw || {})) {
        const races = Math.floor(num(entry?.races, 0, 0, 1e7));
        const wins = Math.floor(num(entry?.wins, 0, 0, races));
        if (races > 0) out[text(id, 60)] = { races, wins };
    }
    return out;
}

// ───────── 预制条目 → 界面用的形状 ─────────

function presetBeetle(entry, t) {
    return {
        id: entry.id,
        name: t(entry.nameKey),
        intro: t(entry.introKey),
        catchphrase: t(entry.catchphraseKey),
        color: entry.color,
        pattern: entry.pattern,
        horn: entry.horn,
        power: entry.power,
        temperament: entry.temperament,
        preset: true
    };
}

function presetBubble(entry, t) {
    return { id: entry.id, text: t(entry.textKey), preset: true };
}

function presetMove(entry, t, options = {}) {
    const bubbleIds = [...(options.bubbleIds ?? entry.bubbleIds)];
    return { id: entry.id, name: t(entry.nameKey), actionId: entry.actionId, bubbleId: bubbleIds[0] || '', bubbleIds, enabled: options.enabled !== false, pool: entry.pool, duration: 0, strength: 1, preset: true };
}

function presetRace(entry, t) {
    return { ...sanitizeRace(entry), id: entry.id, name: t(entry.nameKey), preset: true };
}

export class BeetleRaceLibrary {
    static SETTING_KEY = SETTING_KEY;
    static CHANGE_HOOK = CHANGE_HOOK;

    static registerSettings() {
        game.settings.register(MODULE_ID, SETTING_KEY, {
            scope: 'world',
            config: false,
            type: Object,
            default: structuredClone(EMPTY),
            onChange: () => Hooks.callAll(CHANGE_HOOK)
        });
    }

    static _read() {
        const registered = globalThis.game?.settings?.settings?.has?.(`${MODULE_ID}.${SETTING_KEY}`);
        const stored = registered ? game.settings.get(MODULE_ID, SETTING_KEY) : null;
        const list = (key, sanitize) => (Array.isArray(stored?.[key]) ? stored[key] : [])
            .map(entry => sanitize(entry))
            .filter(entry => entry.id && !isPresetId(entry.id));
        return {
            beetles: list('beetles', sanitizeBeetle),
            bubbles: list('bubbles', sanitizeBubble),
            moves: list('moves', sanitizeMove),
            races: list('races', sanitizeRace),
            stats: sanitizeStats(stored?.stats),
            presetMoveOptions: sanitizePresetMoveOptions(stored?.presetMoveOptions)
        };
    }

    static async _write(data) {
        if (!game.user?.isGM) {
            ui.notifications?.warn(localize('PARLOR.BeetleRace.Studio.GMOnly'));
            return false;
        }
        await game.settings.set(MODULE_ID, SETTING_KEY, data);
        return true;
    }

    // ───────── 列表（预制在前、自建在后） ─────────

    static listBeetles(t = localize) {
        const data = this._read();
        return [
            ...PRESET_BEETLES.map(entry => presetBeetle(entry, t)),
            ...data.beetles.map(entry => ({ ...entry, preset: false }))
        ].map(entry => ({ ...entry, stats: data.stats[entry.id] || { races: 0, wins: 0 } }));
    }

    static listBubbles(t = localize) {
        return [
            ...PRESET_BUBBLES.map(entry => presetBubble(entry, t)),
            ...this._read().bubbles.map(entry => ({ ...entry, preset: false }))
        ];
    }

    static listMoves(t = localize) {
        const data = this._read();
        return [
            ...PRESET_MOVES.filter(entry => ACTION_IDS.includes(entry.actionId)).map(entry => presetMove(entry, t, data.presetMoveOptions[entry.id])),
            ...data.moves.map(entry => ({ ...entry, preset: false }))
        ];
    }

    static listRaces(t = localize) {
        return [
            ...PRESET_RACES.map(entry => presetRace(entry, t)),
            ...this._read().races.map(entry => ({ ...entry, preset: false }))
        ];
    }

    static getRace(id, t = localize) {
        return this.listRaces(t).find(entry => entry.id === id) || null;
    }

    // ───────── 写（GM） ─────────

    static async _saveInto(key, sanitize, kind, raw) {
        const clean = sanitize(raw);
        if (!clean.id || isPresetId(clean.id)) clean.id = newId(kind);
        const data = this._read();
        const list = data[key];
        const index = list.findIndex(entry => entry.id === clean.id);
        if (index >= 0) list[index] = clean;
        else {
            if (list.length >= MAX_ITEMS) return null;
            list.push(clean);
        }
        return (await this._write(data)) ? clean : null;
    }

    static async _removeFrom(key, id) {
        if (isPresetId(id)) return false;
        const data = this._read();
        data[key] = data[key].filter(entry => entry.id !== id);
        return this._write(data);
    }

    static saveBeetle(raw) { return this._saveInto('beetles', sanitizeBeetle, 'beetle', raw); }
    static saveBubble(raw) { return this._saveInto('bubbles', sanitizeBubble, 'bubble', raw); }
    static saveMove(raw) { return this._saveInto('moves', sanitizeMove, 'move', raw); }
    static async savePresetMoveOptions(id, options) {
        if (!PRESET_MOVES.some(entry => entry.id === id)) return null;
        const data = this._read();
        data.presetMoveOptions = sanitizePresetMoveOptions({
            ...data.presetMoveOptions,
            [id]: { ...data.presetMoveOptions[id], ...options }
        });
        return (await this._write(data)) ? this.listMoves().find(entry => entry.id === id) || null : null;
    }
    static saveRace(raw) { return this._saveInto('races', sanitizeRace, 'race', raw); }
    static removeBeetle(id) { return this._removeFrom('beetles', id); }
    static removeBubble(id) { return this._removeFrom('bubbles', id); }
    static removeMove(id) { return this._removeFrom('moves', id); }
    static removeRace(id) { return this._removeFrom('races', id); }

    /** 预制条目复制成一份可以改的自定义（名字加个"（副本）"） */
    static duplicateDraft(kind, id, t = localize) {
        const source = {
            beetle: () => this.listBeetles(t),
            bubble: () => this.listBubbles(t),
            move: () => this.listMoves(t),
            race: () => this.listRaces(t)
        }[kind]?.().find(entry => entry.id === id);
        if (!source) return null;
        const copy = { ...structuredClone(source), id: '' };
        delete copy.preset;
        delete copy.stats;
        const suffix = t('PARLOR.BeetleRace.Studio.CopySuffix');
        if ('name' in copy) copy.name = `${copy.name}${suffix}`.slice(0, 40);
        return copy;
    }

    /** 一场比赛打完记战绩：上场的每只 +1 场，冠军 +1 胜 */
    static async recordResult(beetleIds = [], winnerId = '') {
        if (!game.user?.isGM) return false;
        const data = this._read();
        for (const id of beetleIds) {
            const entry = data.stats[id] || { races: 0, wins: 0 };
            entry.races += 1;
            if (id === winnerId) entry.wins += 1;
            data.stats[id] = entry;
        }
        await game.settings.set(MODULE_ID, SETTING_KEY, data);
        return true;
    }

    /** 性格 → 一段现成的介绍，DM 图省事点一下就行，填完还能改 */
    static introFromTemperament(temperament, name, t = localize) {
        const safe = TEMPERAMENTS[temperament] ? temperament : 'steady';
        return t(`PARLOR.BeetleRace.Temperament.${safe}.Intro`, { name: name || t('PARLOR.BeetleRace.Studio.ThisBeetle') });
    }

    /**
     * 开桌用：赛事卡 → 完整快照。上场甲虫缺了（被删了）就跳过；凑不够 3 只返回 null。
     * pool 只收随机招；cheats 收作弊招 + 随机招（DM 用随机招当暗招，玩家看不出来）。
     */
    static resolveRace(raceId, t = localize) {
        const race = this.getRace(raceId, t);
        if (!race) return null;
        const beetles = new Map(this.listBeetles(t).map(entry => [entry.id, entry]));
        const bubbles = new Map(this.listBubbles(t).map(entry => [entry.id, entry.text]));
        const moves = this.listMoves(t).filter(entry => entry.enabled);

        const lanes = race.beetleIds
            .map(id => beetles.get(id))
            .filter(Boolean)
            .map(entry => ({
                beetleId: entry.id,
                name: entry.name || t('PARLOR.BeetleRace.Studio.Unnamed'),
                intro: entry.intro,
                catchphrase: entry.catchphrase,
                color: entry.color,
                pattern: entry.pattern,
                horn: entry.horn,
                power: entry.power,
                temperament: entry.temperament,
                stats: entry.stats,
                multiplier: race.multipliers[entry.id] ?? race.multiplier
            }));
        if (lanes.length < RACE_LIMITS.minLanes) return null;

        const resolveMove = entry => {
            const lines = [...new Set(entry.bubbleIds.map(id => bubbles.get(id)).filter(Boolean))];
            return {
                id: entry.id,
                name: entry.name,
                actionId: entry.actionId,
                bubble: lines[0] || '',
                bubbles: lines,
                pool: entry.pool,
                dur: entry.duration || ACTIONS[entry.actionId].sim.dur,
                strength: entry.strength || 1
            };
        };

        return {
            raceId: race.id,
            name: race.name,
            durationSec: race.durationSec,
            betSeconds: race.betSeconds,
            minBet: race.minBet,
            maxBet: race.maxBet,
            powerDisplay: race.powerDisplay,
            eventRate: race.eventRate,
            parade: race.parade,
            lanes,
            pool: moves.filter(entry => entry.pool === 'random').map(resolveMove),
            cheats: moves.map(resolveMove)
        };
    }
}
