/**
 * AppearanceConfig — 外观统一配置
 *
 * 这层后续维护默认按 Foundry V14 兼容优先来写。
 * 目前开放文字字体、牌面、牌背和声音；赌桌与玩家卡材质继续走固定方案。
 */

import { PresenterRegistry } from './PresenterRegistry.js';

const MODULE_ID = 'parlor';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

function moduleAssetPath(relativePath) {
    const cleanPath = String(relativePath || '').replace(/^\/+/u, '');
    const routePrefix = String(globalThis.ROUTE_PREFIX || '').trim().replace(/^\/+|\/+$/gu, '');
    const moduleRoot = routePrefix ? `/${routePrefix}/modules/${MODULE_ID}` : `/modules/${MODULE_ID}`;
    return `${moduleRoot}/${cleanPath}`;
}

const CUSTOM_CARD_ROOT = moduleAssetPath('assets/cards/runtime');
const CUSTOM_SOUND_ROOT = moduleAssetPath('assets/cards/Playing Cards/Playing Cards/Sounds');

const WOOD_SHELL = {
    shell: 'linear-gradient(180deg, rgba(210,163,87,0.98), rgba(130,82,28,0.96) 34%, rgba(65,38,12,0.98) 100%)',
    shellSoft: 'linear-gradient(180deg, rgba(228,190,112,0.96), rgba(138,90,32,0.94) 38%, rgba(73,42,13,0.96) 100%)'
};

const METAL_SHELL = {
    shell: 'linear-gradient(180deg, rgba(188,177,145,0.98), rgba(112,102,77,0.96) 34%, rgba(53,46,33,0.98) 100%)',
    shellSoft: 'linear-gradient(180deg, rgba(223,214,187,0.96), rgba(141,128,97,0.94) 38%, rgba(77,66,44,0.96) 100%)'
};

export const TABLE_FELT_OPTIONS = Object.freeze([
    {
        id: 'fabric037',
        labelKey: 'PARLOR.Appearance.Options.TableFelt.Fabric037',
        texture: moduleAssetPath('assets/materials/felt/fabric037/Fabric037_2K-PNG_Color.png')
    },
    {
        id: 'fabric040',
        labelKey: 'PARLOR.Appearance.Options.TableFelt.Fabric040',
        texture: moduleAssetPath('assets/materials/felt/fabric040/Fabric040_1K-PNG_Color.png')
    }
]);

export const TABLE_RAIL_OPTIONS = Object.freeze([
    {
        id: 'wood013',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Wood013',
        kind: 'wood',
        texture: moduleAssetPath('assets/materials/wood/wood013/Wood013_1K-PNG_Color.png'),
        ...WOOD_SHELL
    },
    {
        id: 'wood070',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Wood070',
        kind: 'wood',
        texture: moduleAssetPath('assets/materials/wood/wood070/Wood070_1K-PNG_Color.png'),
        ...WOOD_SHELL
    },
    {
        id: 'metal041a',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Metal041A',
        kind: 'metal',
        texture: moduleAssetPath('assets/materials/metal/metal041a/Metal041A_1K-PNG_Color.png'),
        ...METAL_SHELL
    },
    {
        id: 'metal048a',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Metal048A',
        kind: 'metal',
        texture: moduleAssetPath('assets/materials/metal/metal048a/Metal048A_1K-PNG_Color.png'),
        ...METAL_SHELL
    },
    {
        id: 'metal048c',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Metal048C',
        kind: 'metal',
        texture: moduleAssetPath('assets/materials/metal/metal048c/Metal048C_1K-PNG_Color.png'),
        ...METAL_SHELL
    },
    {
        id: 'metal057c',
        labelKey: 'PARLOR.Appearance.Options.TableRail.Metal057C',
        kind: 'metal',
        texture: moduleAssetPath('assets/materials/metal/metal057c/Metal057C_1K-PNG_Color.png'),
        ...METAL_SHELL
    }
]);

export const CARD_FACE_OPTIONS = Object.freeze([
    {
        id: 'custom-new-white',
        labelKey: 'PARLOR.Appearance.Options.CardFace.CustomNewWhite',
        kind: 'custom-new-white'
    },
    {
        id: 'custom-uploaded',
        labelKey: 'PARLOR.Appearance.Options.CardFace.Uploaded',
        kind: 'custom-uploaded'
    },
    {
        id: 'fvtt-light-soft',
        labelKey: 'PARLOR.Appearance.Options.CardFace.FvttLightSoft',
        kind: 'fvtt',
        root: 'cards/light-soft'
    },
    {
        id: 'fvtt-dark-gold',
        labelKey: 'PARLOR.Appearance.Options.CardFace.FvttDarkGold',
        kind: 'fvtt',
        root: 'cards/dark-gold'
    }
]);

export const CARD_BACK_OPTIONS = Object.freeze([
    {
        id: 'custom-new-blue',
        labelKey: 'PARLOR.Appearance.Options.CardBack.CustomNewBlue',
        path: `${CUSTOM_CARD_ROOT}/Card Backs/New Blue.png`
    },
    {
        id: 'custom-new-red',
        labelKey: 'PARLOR.Appearance.Options.CardBack.CustomNewRed',
        path: `${CUSTOM_CARD_ROOT}/Card Backs/New Red.png`
    },
    {
        id: 'custom-uploaded',
        labelKey: 'PARLOR.Appearance.Options.CardBack.Uploaded'
    },
    {
        id: 'fvtt-light-soft',
        labelKey: 'PARLOR.Appearance.Options.CardBack.FvttLightSoft',
        path: 'cards/backs/light-soft.webp'
    },
    {
        id: 'fvtt-dark-gold',
        labelKey: 'PARLOR.Appearance.Options.CardBack.FvttDarkGold',
        path: 'cards/backs/dark-gold.webp'
    }
]);

export const CARD_SOUND_OPTIONS = Object.freeze([
    {
        id: 'playing-cards',
        labelKey: 'PARLOR.Appearance.Options.Sound.PlayingCards',
        // 发牌声还是关掉，翻牌和落桌保留。
        deal: '',
        flip: `${CUSTOM_SOUND_ROOT}/Card Flip.wav`,
        placed: `${CUSTOM_SOUND_ROOT}/Card Placed.wav`
    },
    {
        id: 'none',
        labelKey: 'PARLOR.Appearance.Options.Sound.None',
        deal: '',
        flip: '',
        placed: ''
    }
]);

export const TEXT_FONT_OPTIONS = Object.freeze([
    {
        id: 'marcellus',
        labelKey: 'PARLOR.Appearance.Options.TextFont.Marcellus',
        stack: '"Parlor Marcellus", "Noto Serif SC", "Source Han Serif SC", Georgia, serif'
    },
    {
        id: 'forum',
        labelKey: 'PARLOR.Appearance.Options.TextFont.Forum',
        stack: '"Parlor Forum", "Noto Serif SC", "Source Han Serif SC", Georgia, serif'
    },
    {
        id: 'cormorant-sc',
        labelKey: 'PARLOR.Appearance.Options.TextFont.CormorantSC',
        stack: '"Parlor Cormorant SC", "Noto Serif SC", "Source Han Serif SC", Georgia, serif'
    },
    {
        id: 'cinzel-decorative',
        labelKey: 'PARLOR.Appearance.Options.TextFont.CinzelDecorative',
        stack: '"Parlor Cinzel Decorative", "Noto Serif SC", "Source Han Serif SC", Georgia, serif'
    }
]);

export const DEFAULT_APPEARANCE_CONFIG = Object.freeze({
    themeId: 'classic',
    textFontId: 'marcellus',
    feltId: 'fabric037',
    railId: 'wood013',
    cardFaceId: 'custom-new-white',
    cardBackId: 'custom-new-blue',
    customCardFaceFallbackId: 'custom-new-white',
    customCardFacePaths: {},
    customCardBackPath: '',
    tableBackdropPath: '',
    soundSetId: 'playing-cards',
    soundEnabled: true,
    soundVolume: 0.45
});

const CUSTOM_UPLOAD_FACE_ID = 'custom-uploaded';
const CUSTOM_UPLOAD_BACK_ID = 'custom-uploaded';

export const CUSTOM_CARD_IMAGE_SUITS = Object.freeze(['spades', 'hearts', 'diamonds', 'clubs']);
export const CUSTOM_CARD_IMAGE_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);

const CUSTOM_CARD_SUIT_SYMBOLS = Object.freeze({ spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' });
const CUSTOM_CARD_SUIT_LABEL_KEYS = Object.freeze({
    spades: 'PARLOR.Appearance.Card.Suits.Spades',
    hearts: 'PARLOR.Appearance.Card.Suits.Hearts',
    diamonds: 'PARLOR.Appearance.Card.Suits.Diamonds',
    clubs: 'PARLOR.Appearance.Card.Suits.Clubs'
});
const CUSTOM_CARD_KEY_PATTERN = /^(spades|hearts|diamonds|clubs):(A|2|3|4|5|6|7|8|9|10|J|Q|K)$/u;
const IMAGE_PATH_PATTERN = /\.(?:apng|avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu;
const VIDEO_PATH_PATTERN = /\.(?:webm|mp4|m4v)(?:[?#].*)?$/iu;

const CUSTOM_SUIT_DIRECTORY = Object.freeze({
    clubs: 'New Club White',
    diamonds: 'New Diamond White',
    hearts: 'New Heart White',
    spades: 'New Spade White'
});

const CUSTOM_RANK_FILE = Object.freeze({
    A: '1',
    J: 'Jack',
    Q: 'Queen',
    K: 'King'
});

const FVTT_RANK_FILE = Object.freeze({
    A: 'ace',
    J: 'jack',
    Q: 'queen',
    K: 'king'
});

function clampVolume(value) {
    const safeValue = Number(value);
    if (!Number.isFinite(safeValue)) return DEFAULT_APPEARANCE_CONFIG.soundVolume;
    return Math.max(0, Math.min(1, Math.round(safeValue * 100) / 100));
}

function buildOptionMap(entries) {
    return new Map(entries.map(entry => [entry.id, entry]));
}

function normalizeCardSuit(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'spades';
    const plural = raw.endsWith('s') ? raw : `${raw}s`;
    return CUSTOM_CARD_IMAGE_SUITS.includes(plural) ? plural : 'spades';
}

function normalizeCardRank(value) {
    const raw = String(value || '').trim().toUpperCase();
    const aliases = { 1: 'A', ACE: 'A', JACK: 'J', QUEEN: 'Q', KING: 'K' };
    const rank = aliases[raw] || raw;
    return CUSTOM_CARD_IMAGE_RANKS.includes(rank) ? rank : 'A';
}

function getCustomCardKey(card) {
    const suit = normalizeCardSuit(card?.suit);
    const rank = normalizeCardRank(card?.rank);
    return `${suit}:${rank}`;
}

function parseCustomCardKey(key) {
    const safeKey = String(key || '').trim();
    const match = safeKey.match(CUSTOM_CARD_KEY_PATTERN);
    if (!match) return null;
    return { key: safeKey, suit: match[1], rank: match[2] };
}

function sanitizeImagePath(value) {
    const path = String(value || '').trim().replace(/\\/gu, '/');
    if (!path) return '';
    if (/^(?:javascript|data|vbscript):/iu.test(path)) return '';
    if (/[<>"']/u.test(path)) return '';
    return IMAGE_PATH_PATTERN.test(path) ? path : '';
}

function sanitizeMediaPath(value) {
    const path = String(value || '').trim().replace(/\\/gu, '/');
    if (!path) return '';
    if (/^(?:javascript|data|vbscript):/iu.test(path)) return '';
    if (/[<>"']/u.test(path)) return '';
    return (IMAGE_PATH_PATTERN.test(path) || VIDEO_PATH_PATTERN.test(path)) ? path : '';
}

function sanitizeCustomCardFacePaths(paths) {
    const cleaned = {};
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return cleaned;

    for (const [rawKey, rawPath] of Object.entries(paths)) {
        const parsed = parseCustomCardKey(rawKey);
        if (!parsed) continue;
        const safePath = sanitizeImagePath(rawPath);
        if (!safePath) continue;
        cleaned[parsed.key] = safePath;
    }
    return cleaned;
}

function describeCustomCardKey(key) {
    const parsed = parseCustomCardKey(key);
    if (!parsed) return null;
    const suitLabel = t(CUSTOM_CARD_SUIT_LABEL_KEYS[parsed.suit]);
    const symbol = CUSTOM_CARD_SUIT_SYMBOLS[parsed.suit] || '';
    return {
        ...parsed,
        label: `${parsed.rank} ${symbol} ${suitLabel}`.trim()
    };
}

function localizeOption(entry) {
    if (!entry) return null;
    return {
        ...entry,
        label: entry.labelKey ? t(entry.labelKey) : (entry.label || '')
    };
}

const FELT_MAP = buildOptionMap(TABLE_FELT_OPTIONS);
const RAIL_MAP = buildOptionMap(TABLE_RAIL_OPTIONS);
const FACE_MAP = buildOptionMap(CARD_FACE_OPTIONS);
const BACK_MAP = buildOptionMap(CARD_BACK_OPTIONS);
const SOUND_MAP = buildOptionMap(CARD_SOUND_OPTIONS);
const FONT_MAP = buildOptionMap(TEXT_FONT_OPTIONS);
const FIXED_TABLE_FELT = TABLE_FELT_OPTIONS[0];
const FIXED_TABLE_RAIL = TABLE_RAIL_OPTIONS[0];
const CLASSIC_THEME_OPTION = Object.freeze({
    id: 'classic',
    labelKey: 'PARLOR.Appearance.Options.Theme.Classic'
});

function getPresenterThemeOptions() {
    return [
        CLASSIC_THEME_OPTION,
        ...PresenterRegistry.listThemes()
    ].map(localizeOption);
}

export class ParlorAppearance {
    static SETTING_KEY = 'appearanceConfig';
    static _lastSoundAt = { deal: 0, flip: 0, placed: 0 };

    static getAppearanceConfig() {
        if (!game?.settings?.settings?.has(`${MODULE_ID}.${this.SETTING_KEY}`)) {
            return foundry.utils.deepClone(DEFAULT_APPEARANCE_CONFIG);
        }
        const stored = game.settings.get(MODULE_ID, this.SETTING_KEY) || {};
        return this.sanitizeAppearanceConfig(stored);
    }

    static sanitizeAppearanceConfig(config = {}) {
        const safe = foundry.utils.mergeObject(
            foundry.utils.deepClone(DEFAULT_APPEARANCE_CONFIG),
            foundry.utils.deepClone(config || {}),
            { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
        );

        safe.themeId = String(safe.themeId || DEFAULT_APPEARANCE_CONFIG.themeId).trim() || DEFAULT_APPEARANCE_CONFIG.themeId;
        if (safe.themeId !== 'classic' && !PresenterRegistry.hasTheme(safe.themeId)) {
            safe.themeId = DEFAULT_APPEARANCE_CONFIG.themeId;
        }
        if (!FONT_MAP.has(safe.textFontId)) safe.textFontId = DEFAULT_APPEARANCE_CONFIG.textFontId;
        if (!FELT_MAP.has(safe.feltId)) safe.feltId = DEFAULT_APPEARANCE_CONFIG.feltId;
        if (!RAIL_MAP.has(safe.railId)) safe.railId = DEFAULT_APPEARANCE_CONFIG.railId;
        if (!FACE_MAP.has(safe.cardFaceId)) safe.cardFaceId = DEFAULT_APPEARANCE_CONFIG.cardFaceId;
        if (!BACK_MAP.has(safe.cardBackId)) safe.cardBackId = DEFAULT_APPEARANCE_CONFIG.cardBackId;
        if (!SOUND_MAP.has(safe.soundSetId)) safe.soundSetId = DEFAULT_APPEARANCE_CONFIG.soundSetId;
        if (!FACE_MAP.has(safe.customCardFaceFallbackId) || safe.customCardFaceFallbackId === CUSTOM_UPLOAD_FACE_ID) {
            safe.customCardFaceFallbackId = DEFAULT_APPEARANCE_CONFIG.customCardFaceFallbackId;
        }

        safe.customCardFacePaths = sanitizeCustomCardFacePaths(safe.customCardFacePaths);
        safe.customCardBackPath = sanitizeImagePath(safe.customCardBackPath);
        safe.tableBackdropPath = sanitizeMediaPath(safe.tableBackdropPath);
        safe.soundEnabled = safe.soundEnabled !== false;
        safe.soundVolume = clampVolume(safe.soundVolume);
        return safe;
    }

    static async setAppearanceConfig(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        await game.settings.set(MODULE_ID, this.SETTING_KEY, safe);
        return safe;
    }

    static resetAppearanceConfig() {
        return foundry.utils.deepClone(DEFAULT_APPEARANCE_CONFIG);
    }

    static getAppearanceChoices() {
        return {
            themes: getPresenterThemeOptions(),
            textFonts: TEXT_FONT_OPTIONS.map(localizeOption),
            cardFaces: CARD_FACE_OPTIONS.map(localizeOption),
            cardBacks: CARD_BACK_OPTIONS.map(localizeOption),
            sounds: CARD_SOUND_OPTIONS.map(localizeOption)
        };
    }

    static getActiveThemeId(config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        return safe.themeId;
    }

    static getTextFontOption(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        return localizeOption(FONT_MAP.get(safe.textFontId) || TEXT_FONT_OPTIONS[0]);
    }

    static getFeltOption(_config) {
        return localizeOption(FIXED_TABLE_FELT);
    }

    static getRailOption(_config) {
        return localizeOption(FIXED_TABLE_RAIL);
    }

    static getCardFaceOption(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        return localizeOption(FACE_MAP.get(safe.cardFaceId) || CARD_FACE_OPTIONS[0]);
    }

    static getCardBackOption(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        return localizeOption(BACK_MAP.get(safe.cardBackId) || CARD_BACK_OPTIONS[0]);
    }

    static getSoundOption(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        return localizeOption(SOUND_MAP.get(safe.soundSetId) || CARD_SOUND_OPTIONS[0]);
    }

    static sanitizeImagePath(value) {
        return sanitizeImagePath(value);
    }

    static sanitizeMediaPath(value) {
        return sanitizeMediaPath(value);
    }

    static getTableBackdrop(config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        if (!safe.tableBackdropPath) return null;
        return {
            path: safe.tableBackdropPath,
            isVideo: VIDEO_PATH_PATTERN.test(safe.tableBackdropPath)
        };
    }

    static getCustomCardKey(card) {
        return getCustomCardKey(card);
    }

    static getCustomCardTargetChoices() {
        return {
            ranks: CUSTOM_CARD_IMAGE_RANKS.map(rank => ({ id: rank, label: rank })),
            suits: CUSTOM_CARD_IMAGE_SUITS.map(suit => ({
                id: suit,
                label: `${CUSTOM_CARD_SUIT_SYMBOLS[suit]} ${t(CUSTOM_CARD_SUIT_LABEL_KEYS[suit])}`
            }))
        };
    }

    static getConfiguredCustomCardFaces(config) {
        const safe = this.sanitizeAppearanceConfig(config);
        return Object.entries(safe.customCardFacePaths)
            .map(([key, path]) => ({ ...describeCustomCardKey(key), path }))
            .filter(entry => entry.key)
            .sort((a, b) => {
                const suitDelta = CUSTOM_CARD_IMAGE_SUITS.indexOf(a.suit) - CUSTOM_CARD_IMAGE_SUITS.indexOf(b.suit);
                if (suitDelta) return suitDelta;
                return CUSTOM_CARD_IMAGE_RANKS.indexOf(a.rank) - CUSTOM_CARD_IMAGE_RANKS.indexOf(b.rank);
            });
    }

    static getTableTexturePaths(config) {
        const felt = this.getFeltOption(config);
        const rail = this.getRailOption(config);
        return {
            feltTexturePath: felt.texture,
            railTexturePath: rail.texture,
            railKind: rail.kind
        };
    }

    static getCssVariables(config) {
        const textFont = this.getTextFontOption(config);
        const felt = this.getFeltOption(config);
        const rail = this.getRailOption(config);
        const isMetal = rail.kind === 'metal';

        return {
            '--parlor-font-ui': textFont.stack,
            '--parlor-font-body': textFont.stack,
            '--parlor-font-display': textFont.stack,
            '--slot-font-display': textFont.stack,
            '--slot-font-body': textFont.stack,
            '--parlor-felt-texture': `url("${felt.texture}")`,
            '--parlor-rail-texture': `url("${rail.texture}")`,
            '--parlor-seat-felt': `url("${felt.texture}")`,
            '--parlor-seat-rail-texture': `url("${rail.texture}")`,
            '--parlor-seat-shell': rail.shell,
            '--parlor-seat-shell-soft': rail.shellSoft,
            '--parlor-rail-preview-glow': isMetal
                ? 'radial-gradient(circle at 50% 10%, rgba(218,231,244,0.16), transparent 28%)'
                : 'radial-gradient(circle at 50% 10%, rgba(255,224,152,0.12), transparent 28%)',
            '--parlor-rail-preview-gloss': isMetal
                ? 'linear-gradient(180deg, rgba(255,255,255,0.1), rgba(255,255,255,0.02) 24%, rgba(0,0,0,0.12) 100%)'
                : 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 26%, rgba(0,0,0,0.12) 100%)',
            '--parlor-table-mark-color': isMetal
                ? 'rgba(223,235,247,0.5)'
                : 'rgba(255,233,180,0.5)'
        };
    }

    static applyAppearanceToElement(element, config) {
        if (!element?.style) return;
        const vars = this.getCssVariables(config);
        for (const [key, value] of Object.entries(vars)) {
            element.style.setProperty(key, value);
        }
        if (element.dataset) {
            const rail = this.getRailOption(config);
            element.dataset.parlorRailKind = rail.kind || 'wood';
            element.dataset.parlorRailId = rail.id || '';
        }
    }

    static applyGlobalAppearance(config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        this.applyAppearanceToElement(document.documentElement, safe);
        return safe;
    }

    static handleAppearanceChange(config = null) {
        const safe = this.applyGlobalAppearance(config);
        Hooks.callAll('parlor.appearanceChanged', safe);
        return safe;
    }

    static getCardBackPath(config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        if (safe.cardBackId === CUSTOM_UPLOAD_BACK_ID && safe.customCardBackPath) {
            return safe.customCardBackPath;
        }
        const back = BACK_MAP.get(safe.cardBackId);
        return back?.path || BACK_MAP.get(DEFAULT_APPEARANCE_CONFIG.cardBackId).path;
    }

    static getCardFacePath(card, config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        const face = FACE_MAP.get(safe.cardFaceId) || FACE_MAP.get(DEFAULT_APPEARANCE_CONFIG.cardFaceId);

        if (face.kind === CUSTOM_UPLOAD_FACE_ID) {
            const customPath = safe.customCardFacePaths[getCustomCardKey(card)];
            if (customPath) return customPath;
            const fallbackFace = FACE_MAP.get(safe.customCardFaceFallbackId) || FACE_MAP.get(DEFAULT_APPEARANCE_CONFIG.cardFaceId);
            return this._getBuiltInCardFacePath(card, fallbackFace);
        }

        return this._getBuiltInCardFacePath(card, face);
    }

    static _getBuiltInCardFacePath(card, face) {
        const suit = normalizeCardSuit(card?.suit);
        const rawRank = normalizeCardRank(card?.rank);

        if (face.kind === 'custom-new-white') {
            const suitDir = CUSTOM_SUIT_DIRECTORY[suit] || CUSTOM_SUIT_DIRECTORY.spades;
            const rankFile = CUSTOM_RANK_FILE[rawRank] || rawRank;
            return `${CUSTOM_CARD_ROOT}/${suitDir}/${rankFile}.png`;
        }

        const fvttRank = FVTT_RANK_FILE[rawRank] || rawRank.padStart(2, '0');
        return `${face.root}/${suit}-${fvttRank}.webp`;
    }

    static getPreviewCards() {
        return [
            { rank: 'A', suit: 'spades' },
            { rank: 'Q', suit: 'hearts' }
        ];
    }

    static playCardSound(kind, config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        if (!safe.soundEnabled) return;

        const soundSet = this.getSoundOption(safe);
        const src = soundSet?.[kind];
        if (!src) return;

        const now = Date.now();
        if ((now - Number(this._lastSoundAt[kind] || 0)) < 60) return;
        this._lastSoundAt[kind] = now;

        try {
            const helper = globalThis.foundry?.audio?.AudioHelper;
            if (typeof helper?.play !== 'function') return;
            Promise.resolve(helper.play({ src, volume: safe.soundVolume, loop: false }, false)).catch(() => {});
        } catch (_err) {
            // 音效只是点缀，别因为一声牌响把主流程卡住。
        }
    }

    /**
     * 游戏自带的整套音效（甲虫赛跑那种）：跟牌声同一个开关、同一个音量滑杆，gain 是这一条自己的相对音量。
     * 走 Foundry 的"界面"声道，玩家在 Foundry 音量设置里也能单独压
     */
    static playEffect(src, gain = 1, config = null) {
        const safe = this.sanitizeAppearanceConfig(config || this.getAppearanceConfig());
        if (!safe.soundEnabled || !src) return;
        try {
            const helper = globalThis.foundry?.audio?.AudioHelper;
            if (typeof helper?.play !== 'function') return;
            // 牌声的默认音量（0.45）是按单张牌的轻响定的，整场音效要比它大一截才听得清
            const volume = Math.max(0, Math.min(1, safe.soundVolume * 1.6 * gain));
            Promise.resolve(helper.play({ src, volume, loop: false, channel: 'interface' }, false)).catch(() => {});
        } catch (_err) {
            // 同上：音效失败不影响游戏
        }
    }

    // 一批音效提前拉下来，第一次响的时候就不会慢半拍
    static preloadEffects(srcs = []) {
        const helper = globalThis.foundry?.audio?.AudioHelper;
        if (typeof helper?.preloadSound !== 'function') return;
        for (const src of srcs) Promise.resolve(helper.preloadSound(src)).catch(() => {});
    }
}
