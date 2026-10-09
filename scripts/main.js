import { registerBuiltInTavernTheme } from './tavern/main.js';
/**
 * Parlor — Casino Simulator for Foundry VTT
 * V14 兼容优先：主入口别再挂已经删掉的旧模板和旧 partial。
 */

const MODULE_ID = 'parlor';

import { BEETLE_PREFS } from './games/beetlerace/BeetleRacePrefs.js';
import { SocketManager } from './core/SocketManager.js';
import { ParlorManager } from './core/ParlorManager.js';
import { GameLobby } from './apps/GameLobby.js';
import { ChipManager } from './core/ChipManager.js';
import { migrateChipOwnerId } from './core/ParticipantRoster.js';
import { AppearanceConfigApp } from './apps/AppearanceConfigApp.js';
import { DEFAULT_APPEARANCE_CONFIG, ParlorAppearance } from './core/AppearanceConfig.js';
import { OutcomeInfluence } from './core/OutcomeInfluence.js';
import { OutcomeInfluenceConfigApp } from './apps/OutcomeInfluenceConfigApp.js';
import { ActorOutcomeInfluenceConfigApp } from './apps/ActorOutcomeInfluenceConfigApp.js';
import {
    addActorOutcomeContextOption,
    addActorOutcomeHeaderControl
} from './core/ActorOutcomeInfluenceMenu.js';
import { LocalResultFx } from './ui/LocalResultFx.js';
import { DEFAULT_SLOT_MACHINE_CONFIG, SlotMachineConfig } from './core/SlotMachineConfig.js';
import { SlotMachineConfigApp } from './apps/SlotMachineConfigApp.js';
import { Dsn3dBridge } from './core/Dsn3dBridge.js';
import { PresenterRegistry } from './core/PresenterRegistry.js';
import { TableDecks } from './core/TableDecks.js';
import { BeetleRaceLibrary } from './games/beetlerace/BeetleRaceLibrary.js';
import { BeetleRaceStudioApp } from './apps/BeetleRaceStudioApp.js';

// ─── 模组初始化 ──────────────────────────────────────────────

Hooks.once('init', async () => {
    console.log(`${MODULE_ID} | Initializing Parlor module`);
    // 契约姿势(presenter-api-v1.md §2):主题 mod 从 game.modules.get('parlor').api 取接口。
    // parlor 的 init 回调先于依赖它的主题 mod 执行,所以主题 init 时这里一定已挂好。
    const module = game.modules.get(MODULE_ID);
    if (module) module.api = window.Parlor.api;
    registerBuiltInTavernTheme();
    registerSettings();
    registerHandlebarsHelpers();
});

Hooks.once('ready', async () => {
    console.log(`${MODULE_ID} | Parlor module ready`);

    SocketManager.initialize(MODULE_ID);

    // 初始化管理器
    GameLobby.registerSocketHandlers();
    ParlorManager.initialize();
    ChipManager.initialize();
    await migrateLegacyChipData();
    ParlorAppearance.applyGlobalAppearance();
});

// ─── GM 场景控制按钮 ─────────────────────────────────────────

Hooks.on('getSceneControlButtons', (controls) => {
    if (!game.user.isGM) return;
    const tokenControls = controls.tokens;
    if (tokenControls?.tools) {
        tokenControls.tools['parlor'] = {
            name: 'parlor',
            title: game.i18n.localize('PARLOR.OpenCasino'),
            icon: 'fas fa-dice',
            visible: game.user.isGM,
            button: true,
            onClick: () => openParlorLobby()
        };
    }
});

// ─── GM 角色牌局熟练度入口 ───────────────────────────────────

Hooks.on('getHeaderControlsApplicationV2', (application, controls) => {
    addActorOutcomeHeaderControl(application, controls, openActorOutcomeInfluence);
});

Hooks.on('getActorContextOptions', (application, menuItems) => {
    addActorOutcomeContextOption(application, menuItems, openActorOutcomeInfluence);
});

function openActorOutcomeInfluence(actor) {
    if (!game.user.isGM || !actor) return false;
    new ActorOutcomeInfluenceConfigApp(actor).render(true);
    return true;
}

// ─── 设置注册 ─────────────────────────────────────────────────

function registerSettings() {
    // 旧 GP 数据存储（隐藏）
    game.settings.register(MODULE_ID, 'gpData', {
        scope: 'world', config: false, type: Object, default: {}
    });
    // V14 兼容优先：后面统一用 chipData，别再新逻辑里混 gpData
    game.settings.register(MODULE_ID, 'chipData', {
        scope: 'world', config: false, type: Object, default: {}
    });
    game.settings.register(MODULE_ID, 'defaultChips', {
        scope: 'world', config: false, type: Number, default: 0
    });
    // 活跃游戏存储（隐藏）
    game.settings.register(MODULE_ID, 'activeGames', {
        scope: 'world', config: false, type: Object, default: {}
    });

    // 赌桌预设(桌台工坊):DM 自定义桌角/毛毡/滤镜/摆件/桌名,主题呈现器消费
    TableDecks.registerSettings();

    // 甲虫赛跑素材库：DM 自建的甲虫 / 气泡 / 招式 / 赛事卡 + 战绩
    BeetleRaceLibrary.registerSettings();

    // V14 兼容优先：DSN 没装也要能跑，这里只决定愿不愿意调它
    game.settings.register(MODULE_ID, Dsn3dBridge.SETTING_KEY, {
        name: 'PARLOR.Settings.DsnIntegration.Name',
        hint: 'PARLOR.Settings.DsnIntegration.Hint',
        scope: 'client',
        config: true,
        type: String,
        choices: {
            auto: 'PARLOR.Settings.DsnIntegration.Auto',
            on: 'PARLOR.Settings.DsnIntegration.On',
            off: 'PARLOR.Settings.DsnIntegration.Off'
        },
        default: 'auto'
    });

    game.settings.register(MODULE_ID, 'alwaysRevealHandHud', {
        name: 'PARLOR.Settings.AlwaysRevealHandHud.Name',
        hint: 'PARLOR.Settings.AlwaysRevealHandHud.Hint',
        scope: 'client',
        config: true,
        type: Boolean,
        default: false,
        onChange: () => {
            if (!game.ready) return;
            ParlorManager.refreshOpenTables();
        }
    });

    // 甲虫赛跑的两项开桌偏好：音效、纯净桌面。GM 定、全桌一起、记住上次（Reslin 定的：开赛前在开桌对话里调）。
    // world 设置，改了所有客户端同时生效；比赛桌上 GM 的喇叭按钮改的也是音效这一项
    for (const [name, label] of [['sound', 'BeetleRaceSound'], ['cleanTable', 'BeetleRaceCleanTable']]) {
        game.settings.register(MODULE_ID, BEETLE_PREFS[name].key, {
            name: `PARLOR.Settings.${label}.Name`,
            hint: `PARLOR.Settings.${label}.Hint`,
            scope: 'world',
            config: true,
            type: Boolean,
            default: BEETLE_PREFS[name].fallback,
            onChange: () => {
                if (!game.ready) return;
                ParlorManager.refreshOpenTables();
            }
        });
    }

    game.settings.register(MODULE_ID, ParlorAppearance.SETTING_KEY, {
        scope: 'world',
        config: false,
        type: Object,
        default: foundry.utils.deepClone(DEFAULT_APPEARANCE_CONFIG),
        onChange: (value) => {
            // V14 兼容优先：改样式后立刻同步 CSS 变量，并把开着的牌桌重建掉。
            const safe = ParlorAppearance.handleAppearanceChange(value);
            if (!game.ready) return safe;
            ParlorManager.refreshOpenTables({ rebuild: true });
            return safe;
        }
    });

    game.settings.register(MODULE_ID, OutcomeInfluence.SETTING_KEY, {
        scope: 'world',
        config: false,
        type: Object,
        default: OutcomeInfluence.getDefaultConfig()
    });

    game.settings.register(MODULE_ID, SlotMachineConfig.SETTING_KEY, {
        scope: 'world',
        config: false,
        type: Object,
        default: foundry.utils.deepClone(DEFAULT_SLOT_MACHINE_CONFIG)
    });

    game.settings.registerMenu(MODULE_ID, 'appearanceConfigMenu', {
        name: 'PARLOR.Settings.AppearanceMenu.Name',
        label: 'PARLOR.Settings.AppearanceMenu.Label',
        hint: 'PARLOR.Settings.AppearanceMenu.Hint',
        icon: 'fas fa-palette',
        type: AppearanceConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, 'outcomeInfluenceConfigMenu', {
        name: 'PARLOR.Settings.OutcomeInfluenceMenu.Name',
        label: 'PARLOR.Settings.OutcomeInfluenceMenu.Label',
        hint: 'PARLOR.Settings.OutcomeInfluenceMenu.Hint',
        icon: 'fas fa-sliders-h',
        type: OutcomeInfluenceConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, 'slotMachineConfigMenu', {
        name: 'PARLOR.Settings.SlotMachineMenu.Name',
        label: 'PARLOR.Settings.SlotMachineMenu.Label',
        hint: 'PARLOR.Settings.SlotMachineMenu.Hint',
        icon: 'fas fa-sliders',
        type: SlotMachineConfigApp,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, 'beetleRaceStudioMenu', {
        name: 'PARLOR.Settings.BeetleRaceMenu.Name',
        label: 'PARLOR.Settings.BeetleRaceMenu.Label',
        hint: 'PARLOR.Settings.BeetleRaceMenu.Hint',
        icon: 'fas fa-bug',
        type: BeetleRaceStudioApp,
        restricted: true
    });
}

// ─── Handlebars 辅助函数 ──────────────────────────────────────

function registerHandlebarsHelpers() {
    Handlebars.registerHelper('eq', (a, b) => a === b);
    Handlebars.registerHelper('neq', (a, b) => a !== b);
    Handlebars.registerHelper('gt', (a, b) => a > b);
    Handlebars.registerHelper('gte', (a, b) => a >= b);
    Handlebars.registerHelper('lt', (a, b) => a < b);
    Handlebars.registerHelper('not', (a) => !a);
    Handlebars.registerHelper('or', (a, b) => a || b);
    Handlebars.registerHelper('and', (a, b) => a && b);
    Handlebars.registerHelper('sum', (...args) => { args.pop(); return args.reduce((s, v) => s + Number(v), 0); });
    Handlebars.registerHelper('multiply', (...args) => { args.pop(); return args.reduce((p, v) => p * Number(v), 1); });
    Handlebars.registerHelper('json', (obj) => JSON.stringify(obj));
}

async function migrateLegacyChipData() {
    // V14 兼容优先：老世界如果只有 gpData，就顺手搬一次，别让结算全掉地上。
    const chipData = game.settings.get(MODULE_ID, 'chipData') || {};
    const legacyData = game.settings.get(MODULE_ID, 'gpData') || {};
    let nextData = Object.keys(chipData).length > 0
        ? foundry.utils.deepClone(chipData)
        : foundry.utils.deepClone(legacyData);
    if (!Object.keys(nextData).length) return;

    // V14 兼容优先：筹码现在挂在玩家绑定角色上，老世界里按 userId 存的这里顺手迁掉。
    const migrated = {};
    for (const [rawId, value] of Object.entries(nextData)) {
        const ownerId = migrateChipOwnerId(rawId);
        if (!ownerId) continue;
        migrated[ownerId] = Number(migrated[ownerId] || 0) + Number(value || 0);
    }

    const changed = JSON.stringify(migrated) !== JSON.stringify(chipData);
    if (!changed) return;

    await game.settings.set(MODULE_ID, 'chipData', migrated);
    console.log(`${MODULE_ID} | Migrated chip data to character-bound owners`);
}

function listDebugSessions() {
    return [...ParlorManager._sessions.entries()].map(([sessionId, entry]) => {
        const state = entry?.game?.getState?.() || {};
        const isOverlayUi = Object.prototype.hasOwnProperty.call(entry?.ui || {}, '_overlay');
        const isOpen = isOverlayUi ? !!entry?.ui?._overlay : !!entry?.ui?.rendered;
        return {
            sessionId,
            gameType: state.gameType || entry?.game?.gameType || 'unknown',
            phase: state.phase || 'unknown',
            open: isOpen
        };
    });
}

function getBlackjackDebugTarget(sessionId = null) {
    const entries = [...ParlorManager._sessions.entries()];
    if (sessionId) {
        const target = entries.find(([id]) => id === sessionId);
        if (!target) return null;
        const [, entry] = target;
        return entry?.game?.gameType === 'blackjack' ? { sessionId, ...entry } : null;
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const [id, entry] = entries[i];
        if (entry?.game?.gameType !== 'blackjack') continue;
        if (entry?.ui?._overlay) return { sessionId: id, ...entry };
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const [id, entry] = entries[i];
        if (entry?.game?.gameType !== 'blackjack') continue;
        return { sessionId: id, ...entry };
    }

    return null;
}

function getOverlayDebugTarget({ sessionId = null, gameType = null } = {}) {
    const entries = [...ParlorManager._sessions.entries()];
    if (sessionId) {
        const target = entries.find(([id]) => id === sessionId);
        if (!target) return null;
        const [, entry] = target;
        if (gameType && entry?.game?.gameType !== gameType) return null;
        return { sessionId, ...entry };
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const [id, entry] = entries[i];
        if (gameType && entry?.game?.gameType !== gameType) continue;
        if (entry?.ui?._overlay) return { sessionId: id, ...entry };
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const [id, entry] = entries[i];
        if (gameType && entry?.game?.gameType !== gameType) continue;
        if (entry?.ui) return { sessionId: id, ...entry };
    }

    return null;
}

async function getDebugOverlay(options = {}) {
    const target = getOverlayDebugTarget(options);
    if (!target?.ui) return null;

    if (!target.ui._overlay && typeof target.ui.render === 'function') {
        target.ui.render(true);
    }

    return target.ui._overlay || null;
}

async function playBlackjackDebugFx({ sessionId = null, names = ['测试玩家'], repeat = 1, gap = 2200 } = {}) {
    const target = getBlackjackDebugTarget(sessionId);
    if (!target?.ui) {
        ui.notifications?.warn('没有找到可用的 21 点桌面。');
        return false;
    }

    // 桌面被关掉时顺手拉起来，省得调试还要先手动开一次。
    if (!target.ui._overlay && typeof target.ui.render === 'function') {
        target.ui.render(true);
    }

    if (!target.ui._overlay || typeof target.ui._playBlackjackFx !== 'function') {
        ui.notifications?.warn('当前 21 点桌面还没准备好。');
        return false;
    }

    const safeNames = Array.isArray(names) ? names : [names];
    const cleanedNames = safeNames
        .map(name => String(name ?? '').trim())
        .filter(Boolean);
    const safeRepeat = Math.max(1, Number.parseInt(repeat, 10) || 1);
    const safeGap = Math.max(1200, Number.parseInt(gap, 10) || 2200);

    for (let index = 0; index < safeRepeat; index++) {
        const stamp = `${Date.now()}:${index}`;
        const hits = (cleanedNames.length ? cleanedNames : ['测试玩家']).map((name, hitIndex) => ({
            key: `debug:${stamp}:${hitIndex}`,
            name
        }));
        target.ui._playBlackjackFx(hits);
        if (index < safeRepeat - 1) {
            await new Promise(resolve => setTimeout(resolve, safeGap));
        }
    }

    return true;
}

async function playResultDebugFx({ sessionId = null, gameType = null, tone = 'win', sub = '', duration = 1460 } = {}) {
    const overlay = await getDebugOverlay({ sessionId, gameType });
    if (!overlay) {
        ui.notifications?.warn('先打开任意一桌牌桌，再测这个结果特效。');
        return false;
    }

    const safeTone = ['win', 'lose', 'push'].includes(tone) ? tone : 'win';
    const titleKey = safeTone === 'win'
        ? 'PARLOR.ResultFx.WinTitle'
        : (safeTone === 'lose' ? 'PARLOR.ResultFx.LoseTitle' : 'PARLOR.ResultFx.PushTitle');
    const defaultSub = safeTone === 'win'
        ? '测试玩家 · +25 GP'
        : (safeTone === 'lose' ? '测试玩家 · -25 GP' : '测试玩家 · 0 GP');

    LocalResultFx.clear(overlay);
    LocalResultFx.enqueue(overlay, [{
        key: `debug:${safeTone}:${Date.now()}`,
        tone: safeTone,
        icon: safeTone === 'win' ? '✦' : (safeTone === 'lose' ? '✕' : '○'),
        title: game.i18n.localize(titleKey),
        sub: String(sub || defaultSub),
        duration: Math.max(900, Number(duration) || 1460)
    }]);

    return true;
}

async function clearDebugFx({ sessionId = null, gameType = null } = {}) {
    const entries = sessionId
        ? [getOverlayDebugTarget({ sessionId, gameType })].filter(Boolean)
        : [...ParlorManager._sessions.entries()].map(([id, entry]) => ({ sessionId: id, ...entry }))
            .filter(entry => !gameType || entry?.game?.gameType === gameType);

    let cleared = 0;
    for (const entry of entries) {
        const overlay = entry?.ui?._overlay;
        if (!overlay) continue;
        entry.ui?._stopBlackjackFx?.();
        entry.ui?._clearSeatBustFx?.();
        LocalResultFx.clear(overlay);
        cleared++;
    }

    return cleared;
}

class DummyTexasPresenter {
    mount(root, gameApi) {
        this.root = root;
        this.gameApi = gameApi;
        this.phaseLine = document.createElement('div');
        this.roundLine = document.createElement('div');
        this.statusLine = document.createElement('div');
        this.seatsList = document.createElement('ul');
        this.closeButton = document.createElement('button');
        this.closeButton.type = 'button';
        this.closeButton.textContent = this.gameApi.t('PARLOR.Common.Close');
        this._onClose = () => this.gameApi.requestClose();
        this.closeButton.addEventListener('click', this._onClose);

        const panel = document.createElement('div');
        panel.append(this.phaseLine, this.roundLine, this.statusLine, this.seatsList, this.closeButton);
        this.root.replaceChildren(panel);
        this.refresh(this.gameApi.getState());
    }

    refresh(state = this.gameApi.getState()) {
        const status = this.gameApi.getStatus();
        const seats = this.gameApi.getSeats();
        this.phaseLine.textContent = `phase: ${status?.phase || state?.phase || 'unknown'}`;
        this.roundLine.textContent = `round: ${status?.round ?? state?.round ?? '-'}`;
        this.statusLine.textContent = `status: ${status?.title || '-'} / ${status?.sub || '-'}`;
        this.seatsList.replaceChildren(...seats.map(seat => {
            const item = document.createElement('li');
            item.textContent = `${seat.name} | ${seat.chips} | ${seat.statusText}`;
            return item;
        }));
    }

    destroy() {
        this.closeButton?.removeEventListener('click', this._onClose);
        this.root?.replaceChildren();
        this.root = null;
        this.gameApi = null;
    }
}

class CrashingTexasPresenter {
    mount() {
        throw new Error('parlor debug crashing presenter');
    }
}

function registerDummyPresenter() {
    return PresenterRegistry.register({
        id: 'presenter-smoke',
        labelKey: 'PARLOR.Debug.PresenterSmoke',
        presenterApiVersion: PresenterRegistry.apiVersion,
        surfaces: {
            'table:texasholdem': DummyTexasPresenter
        }
    });
}

function registerCrashingPresenter() {
    return PresenterRegistry.register({
        id: 'presenter-crash',
        labelKey: 'PARLOR.Debug.PresenterCrash',
        presenterApiVersion: PresenterRegistry.apiVersion,
        surfaces: {
            'table:texasholdem': CrashingTexasPresenter
        }
    });
}

// ─── 公共 API ─────────────────────────────────────────────────

window.Parlor = {
    MODULE_ID,
    open: () => openParlorLobby(),
    openGame: (gameId) => GameLobby.openGame(gameId),
    openTexasHoldem: () => GameLobby.openGame('texasholdem'),
    openDndGoldTools: () => GameLobby.openDndGoldTools(),
    openGoldChipExchange: () => GameLobby.openPlayerGoldExchange(),
    promptGoldChipExchange: () => GameLobby.promptPlayerGoldExchange(),
    macros: {
        texasHoldem: () => GameLobby.openGame('texasholdem'),
        dndGoldTools: () => GameLobby.openDndGoldTools(),
        goldChipExchange: () => GameLobby.openPlayerGoldExchange(),
        promptGoldChipExchange: () => GameLobby.promptPlayerGoldExchange()
    },
    api: {
        SocketManager,
        ParlorManager,
        GameLobby,
        ParlorAppearance,
        OutcomeInfluence,
        registerThemePresenter: (profile) => PresenterRegistry.register(profile),
        // 赌桌预设 CRUD(写操作 GM 才生效):主题大厅/编辑器经此存取
        tableDecks: TableDecks,
        // 甲虫赛跑素材库（写操作 GM 才生效）
        beetleRace: BeetleRaceLibrary,
        openBeetleRaceStudio: (tab) => BeetleRaceStudioApp.open({ tab })
    },
    debug: {
        listSessions: () => listDebugSessions(),
        playBlackjackFx: (options) => playBlackjackDebugFx(options),
        playResultFx: (options) => playResultDebugFx(options),
        clearFx: (options) => clearDebugFx(options),
        registerDummyPresenter: () => registerDummyPresenter(),
        registerCrashingPresenter: () => registerCrashingPresenter()
    }
};

function openParlorLobby() {
    if (ParlorManager.notifyActiveSessionRunning()) return false;
    GameLobby.open();
    return true;
}
