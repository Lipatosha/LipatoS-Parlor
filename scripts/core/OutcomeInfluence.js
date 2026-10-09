/**
 * 玩家属性影响牌局结果。
 * 这里先收一层通用逻辑，各桌按自己的节奏接进来。
 */

import { getParticipant } from './ParticipantRoster.js';
import { takeWeightedBlackjackCard } from '../games/blackjack/BlackjackCardLuck.js';
import { evaluateThreeCardPokerHand } from '../games/threecardpoker/ThreeCardPokerRules.js';
import {
    canPlayCard as canPlayCrazyEightsCard,
    handPoints as crazyEightsHandPoints,
    isWild as isCrazyEightsWild
} from '../games/crazyeights/CrazyEightsRules.js';

const MODULE_ID = 'parlor';
const OUTCOME_STEP_PERCENT = 5;

const RATE_GAME_IDS = Object.freeze([
    'blackjack',
    'texasholdem',
    'threecardpoker',
    'liarsdice',
    'bone21',
    'crazyeights'
]);

export const OUTCOME_INFLUENCE_GAME_IDS = Object.freeze([
    ...RATE_GAME_IDS,
    'baccarat'
]);

const GAME_MODE_KEYS = Object.freeze({
    blackjack: 'PARLOR.OutcomeInfluence.GameMode.HandBias',
    texasholdem: 'PARLOR.OutcomeInfluence.GameMode.StartingHandBias',
    threecardpoker: 'PARLOR.OutcomeInfluence.GameMode.HandBias',
    liarsdice: 'PARLOR.OutcomeInfluence.GameMode.DiceBias',
    bone21: 'PARLOR.OutcomeInfluence.GameMode.InitialDiceBias',
    crazyeights: 'PARLOR.OutcomeInfluence.GameMode.HandAndDrawBias',
    baccarat: 'PARLOR.OutcomeInfluence.GameMode.PayoutSwing'
});

export const DEFAULT_OUTCOME_INFLUENCE_CONFIG = Object.freeze({
    enabled: true,
    minWinRate: 5,
    maxWinRate: 95,
    games: {
        blackjack: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        texasholdem: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        threecardpoker: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        liarsdice: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        bone21: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        crazyeights: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 }
    },
    baccarat: {
        attributePath: '',
        lossReductionPercent: 0,
        winBoostPercent: 0,
        pointsPerPercent: 10
    }
});

function clampNumber(value, min, max, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(min, Math.min(max, numeric));
}

function clampRate(value, minRate, maxRate, fallback = 50) {
    return clampNumber(value, minRate, maxRate, fallback);
}

function toSafePath(value) {
    return String(value || '').trim();
}

function readConfiguredAttributePath(source, fallback = '') {
    if (source && Object.prototype.hasOwnProperty.call(source, 'attributePath')) {
        return toSafePath(source.attributePath);
    }
    return toSafePath(fallback);
}

function roundChip(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function readFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function randomUnit(rng = Math.random) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
}

function sampleIndices(total, count) {
    const picks = new Set();
    const safeTotal = Math.max(0, Number(total || 0));
    const safeCount = Math.max(0, Math.min(safeTotal, Number(count || 0)));

    while (picks.size < safeCount) {
        picks.add(Math.floor(Math.random() * safeTotal));
    }

    return [...picks];
}

// 同 sampleIndices，但随机源可注入，疯狂八的种子测试要用
function sampleIndicesWith(rng, total, count) {
    const picks = new Set();
    const safeTotal = Math.max(0, Number(total || 0));
    const safeCount = Math.max(0, Math.min(safeTotal, Number(count || 0)));
    let guard = safeTotal * 8 + 8;

    while (picks.size < safeCount && guard-- > 0) {
        picks.add(Math.floor(randomUnit(rng) * safeTotal));
    }
    // 注入的 rng 若是常数序列会一直撞同一个下标，补齐时顺序扫
    for (let i = 0; picks.size < safeCount && i < safeTotal; i++) picks.add(i);

    return [...picks];
}

function takeDeckCardAt(deck, index) {
    if (!deck?.cards?.length) return null;
    const safeIndex = Number.isInteger(index) ? index : deck.cards.length - 1;
    if (safeIndex < 0 || safeIndex >= deck.cards.length) {
        return deck.deal();
    }
    return deck.cards.splice(safeIndex, 1)[0] || null;
}

function takeDeckCardsAt(deck, indices = []) {
    const sorted = [...indices]
        .filter(index => Number.isInteger(index))
        .sort((a, b) => b - a);
    const taken = [];

    for (const index of sorted) {
        const card = takeDeckCardAt(deck, index);
        if (card) taken.unshift(card);
    }

    while (taken.length < indices.length) {
        taken.push(deck.deal());
    }

    return taken;
}

function scoreThreeCardHand(cards) {
    const handRank = evaluateThreeCardPokerHand(cards);
    const compare = Array.isArray(handRank?.compare) ? handRank.compare : [];
    const c0 = Number(compare[0] || 0);
    const c1 = Number(compare[1] || 0);
    const c2 = Number(compare[2] || 0);
    return (Number(handRank?.categoryValue || 0) * 100000)
        + (handRank?.isMiniRoyal ? 50000 : 0)
        + (c0 * 100)
        + (c1 * 4)
        + c2;
}

function buildSpreadFaces(count) {
    const faces = [1, 2, 3, 4, 5, 6];
    for (let i = faces.length - 1; i > 0; i--) {
        const swapIndex = Math.floor(Math.random() * (i + 1));
        [faces[i], faces[swapIndex]] = [faces[swapIndex], faces[i]];
    }

    const result = [];
    for (let i = 0; i < count; i++) {
        result.push(faces[i % faces.length]);
    }
    return result;
}

export class OutcomeInfluence {
    static SETTING_KEY = 'outcomeInfluenceConfig';
    static ACTOR_OVERRIDE_FLAG = 'outcomeInfluenceOverrides';

    static getDefaultConfig() {
        return foundry.utils.deepClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
    }

    static sanitizeConfig(config = {}) {
        const defaults = this.getDefaultConfig();
        const legacyAttributePath = toSafePath(config.attributePath);
        const minWinRate = clampNumber(config.minWinRate, 0, 99, defaults.minWinRate);
        const maxWinRate = clampNumber(config.maxWinRate, minWinRate + 1, 100, defaults.maxWinRate);
        const safe = {
            enabled: config.enabled !== false,
            minWinRate,
            maxWinRate,
            games: {},
            baccarat: {}
        };

        for (const gameId of RATE_GAME_IDS) {
            const source = config.games?.[gameId] || {};
            safe.games[gameId] = {
                attributePath: readConfiguredAttributePath(source, legacyAttributePath),
                baseWinRate: clampRate(source?.baseWinRate, minWinRate, maxWinRate, defaults.games[gameId].baseWinRate),
                pointsPerWinRate: clampNumber(source?.pointsPerWinRate, 0.1, 9999, defaults.games[gameId].pointsPerWinRate)
            };
        }

        const baccaratSource = config.baccarat || {};
        // 兼容旧档：之前百家乐也塞在 games 里，这里顺手接一下旧换算值。
        const legacyBaccarat = config.games?.baccarat || {};
        safe.baccarat = {
            attributePath: readConfiguredAttributePath(baccaratSource, legacyAttributePath),
            lossReductionPercent: clampNumber(
                baccaratSource.lossReductionPercent,
                0,
                100,
                defaults.baccarat.lossReductionPercent
            ),
            winBoostPercent: clampNumber(
                baccaratSource.winBoostPercent,
                0,
                100,
                defaults.baccarat.winBoostPercent
            ),
            pointsPerPercent: clampNumber(
                baccaratSource.pointsPerPercent,
                0.1,
                9999,
                clampNumber(legacyBaccarat?.pointsPerWinRate, 0.1, 9999, defaults.baccarat.pointsPerPercent)
            )
        };

        return safe;
    }

    static getConfig() {
        if (!game?.settings?.settings?.has(`${MODULE_ID}.${this.SETTING_KEY}`)) {
            return this.getDefaultConfig();
        }
        const stored = game.settings.get(MODULE_ID, this.SETTING_KEY) || {};
        return this.sanitizeConfig(stored);
    }

    static async setConfig(config = {}) {
        const safe = this.sanitizeConfig(config);
        await game.settings.set(MODULE_ID, this.SETTING_KEY, safe);
        return safe;
    }

    static resetConfig() {
        return this.getDefaultConfig();
    }

    static getConfigRows(config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        return RATE_GAME_IDS.map(gameId => ({
            id: gameId,
            label: this.getGameLabel(gameId),
            modeLabel: game.i18n.localize(GAME_MODE_KEYS[gameId] || ''),
            attributePath: safe.games[gameId].attributePath,
            baseWinRate: safe.games[gameId].baseWinRate,
            pointsPerWinRate: safe.games[gameId].pointsPerWinRate
        }));
    }

    static getBaccaratRow(config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        return {
            modeLabel: game.i18n.localize(GAME_MODE_KEYS.baccarat),
            attributePath: safe.baccarat.attributePath,
            lossReductionPercent: safe.baccarat.lossReductionPercent,
            winBoostPercent: safe.baccarat.winBoostPercent,
            pointsPerPercent: safe.baccarat.pointsPerPercent
        };
    }

    static _getGameLabelKey(gameId) {
        switch (gameId) {
            case 'blackjack': return 'Blackjack';
            case 'texasholdem': return 'TexasHoldem';
            case 'threecardpoker': return 'ThreeCardPoker';
            case 'liarsdice': return 'LiarsDice';
            case 'bone21': return 'Bone21';
            case 'crazyeights': return 'CrazyEights';
            case 'baccarat': return 'Baccarat';
            default: return 'Blackjack';
        }
    }

    static getGameLabel(gameId) {
        return game.i18n.localize(`PARLOR.Games.${this._getGameLabelKey(gameId)}.Name`);
    }

    static _getActor(source, participantId) {
        const participant = getParticipant(source, participantId);
        if (!participant) return null;

        if (participant.actorId) {
            return game.actors?.get(participant.actorId) || null;
        }

        if (participant.userId) {
            const user = game.users?.get(participant.userId);
            return user?.character || null;
        }

        return null;
    }

    static getActorManualOverrides(actor) {
        const stored = actor?.getFlag?.(MODULE_ID, this.ACTOR_OVERRIDE_FLAG);
        return this.sanitizeActorManualOverrides(stored);
    }

    static sanitizeActorManualOverrides(overrides = {}) {
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return {};

        const safe = {};
        for (const gameId of OUTCOME_INFLUENCE_GAME_IDS) {
            if (!Object.prototype.hasOwnProperty.call(overrides, gameId)) continue;
            const value = overrides[gameId];
            if (typeof value === 'number' && Number.isFinite(value)) safe[gameId] = value;
        }
        return safe;
    }

    static async setActorManualOverrides(actor, overrides = {}) {
        if (!game?.user?.isGM) {
            throw new Error('Only a GM can edit Parlor outcome overrides.');
        }
        if (!actor?.setFlag) {
            throw new Error('A writable Actor is required to save Parlor outcome overrides.');
        }

        const safe = this.sanitizeActorManualOverrides(overrides);
        await actor.setFlag(MODULE_ID, this.ACTOR_OVERRIDE_FLAG, safe);
        return safe;
    }

    static getActorManualOverride(actor, gameType) {
        const overrides = this.getActorManualOverrides(actor);
        return Object.prototype.hasOwnProperty.call(overrides, gameType)
            ? overrides[gameType]
            : null;
    }

    static readActorAttributeValue(actor, attributePath) {
        const path = toSafePath(attributePath);
        if (!actor || !path) return null;

        try {
            const rollData = actor.getRollData?.();
            if (rollData) {
                const rollValue = readFiniteNumber(foundry.utils.getProperty(rollData, path));
                if (rollValue != null) return rollValue;
            }

            return readFiniteNumber(foundry.utils.getProperty(actor, path));
        } catch (error) {
            console.warn(`${MODULE_ID} | Failed to read outcome influence attribute path:`, path, error);
            return null;
        }
    }

    static _readAttributeValue(source, participantId, attributePath, config) {
        if (!config?.enabled) return 0;
        const actor = this._getActor(source, participantId);
        return this.readActorAttributeValue(actor, attributePath) ?? 0;
    }

    static getGameInfluenceInput(source, gameType, participantId, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        if (!safe.enabled) return { value: 0, source: 'baseline' };

        const gameConfig = gameType === 'baccarat'
            ? safe.baccarat
            : safe.games?.[gameType];
        if (!gameConfig) return { value: 0, source: 'baseline' };

        const actor = this._getActor(source, participantId);
        if (!actor) return { value: 0, source: 'baseline' };

        const manualValue = this.getActorManualOverride(actor, gameType);
        if (manualValue != null) return { value: manualValue, source: 'manual' };

        const automaticValue = this.readActorAttributeValue(actor, gameConfig.attributePath);
        if (automaticValue != null) return { value: automaticValue, source: 'automatic' };
        return { value: 0, source: 'baseline' };
    }

    static getGameAttributeValue(source, gameType, participantId, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        const gameConfig = gameType === 'baccarat'
            ? safe.baccarat
            : safe.games?.[gameType];
        return this._readAttributeValue(source, participantId, gameConfig?.attributePath, safe);
    }

    static getAttributeValue(source, participantId, config = null) {
        const raw = config || this.getConfig();
        const safe = this.sanitizeConfig(raw);
        const paths = [
            ...RATE_GAME_IDS.map(gameId => safe.games[gameId].attributePath),
            safe.baccarat.attributePath
        ];
        // 旧 API 没有游戏参数。路径还一致时可以照常读，分开配置后就不能替调用方猜。
        const sharedPath = paths.every(path => path === paths[0]) ? paths[0] : '';
        return this._readAttributeValue(
            source,
            participantId,
            toSafePath(raw?.attributePath) || sharedPath,
            safe
        );
    }

    static getEffectiveWinRate(source, gameType, participantId, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        const attributeValue = this.getGameInfluenceInput(source, gameType, participantId, safe).value;
        return this.getEffectiveWinRateFromValue(gameType, attributeValue, safe);
    }

    static getEffectiveWinRateFromValue(gameType, attributeValue, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        if (!safe.enabled) return 50;

        const gameConfig = safe.games?.[gameType];
        if (!gameConfig) return 50;

        let rate = Number(gameConfig.baseWinRate || 50);
        if (Number.isFinite(attributeValue) && Number(gameConfig.pointsPerWinRate || 0) > 0) {
            rate += (attributeValue / Number(gameConfig.pointsPerWinRate || 1)) * OUTCOME_STEP_PERCENT;
        }

        return clampRate(rate, safe.minWinRate, safe.maxWinRate, 50);
    }

    static getLuckOffset(source, gameType, participantId, config = null) {
        return this.getEffectiveWinRate(source, gameType, participantId, config) - 50;
    }

    static getStrengthFromRate(rate) {
        return Math.max(0, Math.min(1, Math.abs(Number(rate || 50) - 50) / 45));
    }

    static rollRateLuckMode(source, gameType, participantId, { config = null, rng = Math.random } = {}) {
        const rate = this.getEffectiveWinRate(source, gameType, participantId, config);
        const strength = this.getStrengthFromRate(rate);
        if (!strength || randomUnit(rng) >= strength) return 'normal';
        return rate > 50 ? 'good' : 'bad';
    }

    static _chooseCandidate(candidates, rate, scoreFn) {
        const safeCandidates = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
        if (!safeCandidates.length) return null;
        if (safeCandidates.length === 1) return safeCandidates[0];

        const strength = this.getStrengthFromRate(rate);
        const direction = Number(rate || 50) >= 50 ? 1 : -1;
        const scored = safeCandidates
            .map(candidate => ({
                candidate,
                score: Number(scoreFn(candidate) || 0)
            }))
            .sort((left, right) => direction * (right.score - left.score));

        if (strength < 0.18) {
            return scored[Math.floor(Math.random() * scored.length)]?.candidate || scored[0]?.candidate || null;
        }

        if (strength < 0.58) {
            const poolSize = Math.max(2, Math.ceil(scored.length * 0.5));
            const pool = scored.slice(0, poolSize);
            return pool[Math.floor(Math.random() * pool.length)]?.candidate || pool[0]?.candidate || null;
        }

        return scored[0]?.candidate || null;
    }

    static pickBlackjackCard(source, deck, participantId, currentCards = [], rules = {}) {
        if (!deck?.cards?.length) return deck?.deal?.() || null;

        const rate = this.getEffectiveWinRate(source, 'blackjack', participantId);
        return takeWeightedBlackjackCard(deck, currentCards, {
            rate,
            rules
        });
    }

    static pickThreeCardHand(source, deck, participantId) {
        if (!deck?.cards?.length || deck.cards.length < 3) {
            return deck?.dealMany?.(3) || [];
        }

        const rate = this.getEffectiveWinRate(source, 'threecardpoker', participantId);
        const strength = this.getStrengthFromRate(rate);
        if (strength < 0.08) return deck.dealMany(3);

        const candidateCount = Math.max(2, 3 + Math.ceil(strength * 4));
        const candidates = [];

        for (let i = 0; i < candidateCount; i++) {
            const indices = sampleIndices(deck.cards.length, 3);
            const cards = indices.map(index => deck.cards[index]);
            candidates.push({
                indices,
                score: scoreThreeCardHand(cards)
            });
        }

        const pick = this._chooseCandidate(candidates, rate, candidate => candidate.score);
        return takeDeckCardsAt(deck, pick?.indices || []);
    }

    static rollLiarsDice(source, participantId, count) {
        const safeCount = Math.max(0, Number(count || 0));
        const dice = Array.from({ length: safeCount }, () => Math.floor(Math.random() * 6) + 1);
        if (!safeCount) return dice;

        const rate = this.getEffectiveWinRate(source, 'liarsdice', participantId);
        const strength = this.getStrengthFromRate(rate);
        if (strength < 0.12) return dice;

        if (rate >= 50) {
            const anchor = dice[Math.floor(Math.random() * dice.length)] || (Math.floor(Math.random() * 6) + 1);
            const touched = Math.max(1, Math.min(safeCount, Math.ceil(strength * safeCount)));
            const indices = sampleIndices(safeCount, touched);
            for (const index of indices) {
                dice[index] = anchor;
            }
            return dice;
        }

        const spread = buildSpreadFaces(safeCount);
        const touched = Math.max(1, Math.min(safeCount, Math.ceil(strength * safeCount)));
        const indices = sampleIndices(safeCount, touched);
        for (let i = 0; i < indices.length; i++) {
            dice[indices[i]] = spread[i % spread.length];
        }
        return dice;
    }

    static rollBone21InitialDice(
        source,
        participantId,
        count,
        { config = null, rng = Math.random } = {}
    ) {
        const safeCount = Math.max(0, Math.floor(Number(count || 0)));
        const mode = this.rollRateLuckMode(source, 'bone21', participantId, { config, rng });
        return Array.from({ length: safeCount }, () => {
            const first = Math.floor(randomUnit(rng) * 6) + 1;
            if (mode === 'normal') return first;

            const second = Math.floor(randomUnit(rng) * 6) + 1;
            return mode === 'good'
                ? Math.max(first, second)
                : Math.min(first, second);
        });
    }

    /**
     * 疯狂八发牌运：从牌堆里给这位发 handSize 张。
     * normal 时逐张从栈顶拿，跟不开干预完全一样（种子测试靠这条保证）；
     * good / bad 采样几组候选，按"带 8 / 点数低 / 花色集中"打分取最好或最差。是倾斜不是必中。
     * 直接改传入的 stock 数组。
     */
    static pickCrazyEightsHand(
        source,
        stock,
        participantId,
        handSize,
        { config = null, rng = Math.random, rules = {} } = {}
    ) {
        const size = Math.max(0, Math.floor(Number(handSize) || 0));
        if (!Array.isArray(stock) || !size) return [];

        const plainDeal = () => {
            const out = [];
            while (out.length < size && stock.length) out.push(stock.pop());
            return out;
        };

        const mode = this.rollRateLuckMode(source, 'crazyeights', participantId, { config, rng });
        if (mode === 'normal' || stock.length <= size) return plainDeal();

        const rate = this.getEffectiveWinRate(source, 'crazyeights', participantId, config);
        const strength = this.getStrengthFromRate(rate);
        const candidateCount = 3 + Math.ceil(strength * 3);
        const scoreHand = cards => {
            const suitCounts = {};
            let maxSuit = 0;
            let hasWild = false;
            for (const card of cards) {
                if (isCrazyEightsWild(card, rules)) { hasWild = true; continue; }
                suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
                maxSuit = Math.max(maxSuit, suitCounts[card.suit]);
            }
            return (hasWild ? 40 : 0) - crazyEightsHandPoints(cards, rules) / 2 + maxSuit * 6;
        };

        let best = null;
        for (let i = 0; i < candidateCount; i++) {
            const indices = sampleIndicesWith(rng, stock.length, size);
            const cards = indices.map(index => stock[index]);
            const score = scoreHand(cards);
            const better = !best
                || (mode === 'good' ? score > best.score : score < best.score);
            if (better) best = { indices, score };
        }

        const picked = [...best.indices]
            .sort((a, b) => b - a)
            .map(index => stock.splice(index, 1)[0])
            .filter(Boolean);
        return picked;
    }

    /**
     * 疯狂八抽牌运：主动抽一张时，按倾斜率有概率把"能出 / 不能出"的牌从牌堆里挑出来当顶牌。
     * normal 时纯 pop，50% 的率永远是 normal。罚抽不走这里。直接改传入的 stock 数组。
     */
    static pickCrazyEightsDraw(
        source,
        stock,
        participantId,
        { topCard = null, currentSuit = '', rules = {}, pendingDraw = 0, config = null, rng = Math.random } = {}
    ) {
        if (!Array.isArray(stock) || !stock.length) return null;

        const mode = this.rollRateLuckMode(source, 'crazyeights', participantId, { config, rng });
        if (mode === 'normal') return stock.pop();

        const wantPlayable = mode === 'good';
        const matches = [];
        for (let i = 0; i < stock.length; i++) {
            const playable = canPlayCrazyEightsCard(stock[i], { topCard, currentSuit, rules, pendingDraw });
            if (playable === wantPlayable) matches.push(i);
        }
        if (!matches.length) return stock.pop();

        const index = matches[Math.floor(randomUnit(rng) * matches.length)];
        return stock.splice(index, 1)[0] || null;
    }

    static adjustBaccaratPayout(source, participantId, stake, payout) {
        const safeStake = roundChip(stake);
        const safePayout = roundChip(payout);
        const delta = roundChip(safePayout - safeStake);
        if (!delta) return safePayout;

        const swing = this.getBaccaratSwing(source, participantId);
        const adjustedDelta = delta < 0
            ? roundChip(delta * (1 - (swing.lossReductionPercent / 100)))
            : roundChip(delta * (1 + (swing.winBoostPercent / 100)));
        return Math.max(0, roundChip(safeStake + adjustedDelta));
    }

    static getBaccaratSwing(source, participantId, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        const attributeValue = this.getGameInfluenceInput(
            source,
            'baccarat',
            participantId,
            safe
        ).value;
        return this.getBaccaratSwingFromValue(attributeValue, safe);
    }

    static getBaccaratSwingFromValue(attributeValue, config = null) {
        const safe = this.sanitizeConfig(config || this.getConfig());
        if (!safe.enabled) {
            return {
                lossReductionPercent: 0,
                winBoostPercent: 0
            };
        }

        const extraPercent = Number.isFinite(attributeValue) && Number(safe.baccarat.pointsPerPercent || 0) > 0
            ? (attributeValue / Number(safe.baccarat.pointsPerPercent || 1)) * OUTCOME_STEP_PERCENT
            : 0;

        return {
            lossReductionPercent: clampNumber(
                Number(safe.baccarat.lossReductionPercent || 0) + extraPercent,
                0,
                100,
                0
            ),
            winBoostPercent: clampNumber(
                Number(safe.baccarat.winBoostPercent || 0) + extraPercent,
                0,
                100,
                0
            )
        };
    }
}
