/**
 * 游戏大厅面板
 *
 * 大厅现在按“参赛角色”来收，不再直接拿用户编号当座位。
 * 玩家默认吃自己绑定角色；主持人也能拖角色进来当非玩家席位。
 */

import { ParlorManager } from '../core/ParlorManager.js';
import { getGameConfig, getGameGuide, getGameList } from '../core/GameRegistry.js';
import { ParlorAppearance } from '../core/AppearanceConfig.js';
import { PresenterRegistry } from '../core/PresenterRegistry.js';
import { PresenterHost } from '../ui/PresenterHost.js';
import { TableDecks } from '../core/TableDecks.js';
import { BotManager } from '../core/BotManager.js';
import { ChipManager } from '../core/ChipManager.js';
import { SettlementManager } from '../core/SettlementManager.js';
import { normalizeBetLimits, supportsCardBetLimits } from '../core/BetLimits.js';
import { CardLuckPlan } from '../core/CardLuckPlan.js';
import { SocketManager, SOCKET_EVENTS } from '../core/SocketManager.js';
import { DEFAULT_CRAZY_EIGHTS_OPTIONS, sanitizeCrazyEightsOptions } from '../games/crazyeights/CrazyEightsRules.js';
import { BeetleRaceLibrary } from '../games/beetlerace/BeetleRaceLibrary.js';
import { BeetleRaceStudioApp } from './BeetleRaceStudioApp.js';
import { deriveShades } from '../games/beetlerace/BeetleRaceRender.js';
import { getBeetlePref, setBeetlePref } from '../games/beetlerace/BeetleRacePrefs.js';
import {
    buildDealerProfileFromParticipant,
    createNpcBotParticipant,
    createUserParticipant,
    getParticipantLabel
} from '../core/ParticipantRoster.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
const BOT_MODE_OPTIONS = ['random', 'win', 'lose'];
// 疯狂八自测局:DM 一个人开桌时陪打的机器人数
const CRAZY_EIGHTS_SELF_TEST_BOTS = 3;
const TEXAS_CUSTOM_HAND_TYPES = ['royal-flush', 'straight-flush', 'full-house', 'three-kind', 'flush'];
const BLACKJACK_CUSTOM_HAND_TYPES = ['natural-blackjack'];
const PLAYER_EXCHANGE_MACRO = 'await Parlor.openGoldChipExchange();';
const escapeHtml = (value) => foundry.utils.escapeHTML(String(value ?? ''));

// 开桌对话里反复出现的三种块：带标题的分区、带标签的输入项、一行参赛者
function setupSection({ title, note = '', aside = '', body = '' }) {
    return `
        <section class="parlor-setup-section">
            <header class="parlor-setup-head">
                <div class="parlor-setup-head-text">
                    <div class="parlor-setup-title">${escapeHtml(title)}</div>
                    ${note ? `<div class="parlor-setup-note">${escapeHtml(note)}</div>` : ''}
                </div>
                ${aside}
            </header>
            ${body}
        </section>
    `;
}

function setupField({ label, control, hint = '', compact = false }) {
    return `
        <label class="parlor-setup-field${compact ? ' is-compact' : ''}">
            <span>${escapeHtml(label)}</span>
            ${control}
            ${hint ? `<small>${escapeHtml(hint)}</small>` : ''}
        </label>
    `;
}

// 勾选框、头像、名字包在一个 label 里，点整块都能勾；右边的下拉放在 label 外面——
// 以前整行一个 label 再套下拉的 label，点下拉会顺手把勾选框也点掉，只能靠 stopPropagation 硬拦
function setupPerson({ toggle = '', avatar = '', fallbackIcon = 'fas fa-user', name, meta = '', state = '', controls = '', attrs = '' }) {
    const picture = avatar
        ? `<img class="parlor-setup-avatar" src="${escapeHtml(avatar)}" alt="">`
        : `<span class="parlor-setup-avatar is-empty"><i class="${fallbackIcon}"></i></span>`;
    const main = `
        ${toggle}${picture}
        <span class="parlor-setup-person-text">
            <b>${escapeHtml(name)}</b>
            ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
        </span>
    `;
    return `
        <div class="parlor-setup-person${state ? ` ${state}` : ''}" ${attrs}>
            ${toggle ? `<label class="parlor-setup-person-main">${main}</label>` : `<div class="parlor-setup-person-main">${main}</div>`}
            ${controls ? `<div class="parlor-setup-person-controls">${controls}</div>` : ''}
        </div>
    `;
}

export class GameLobby extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: 'parlor-lobby', tag: 'div', classes: ['parlor-lobby'],
        window: { title: 'PARLOR.Lobby.Title', icon: 'fas fa-dice', resizable: false },
        position: { width: 840, height: 'auto' }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/game-lobby.hbs` }
    };

    static _instance = null;
    static _exchangeSocketRegistered = false;
    static _lobbyHost = null;

    static open() {
        const themeId = ParlorAppearance.getActiveThemeId();
        const PresenterClass = PresenterRegistry.resolve(themeId, 'lobby');
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, 'lobby')) {
            return this._openLobbyPresenter(PresenterClass, themeId);
        }
        return this._openNativeLobby();
    }

    static _openNativeLobby() {
        if (ParlorManager.notifyActiveSessionRunning()) return false;
        if (!this._instance) this._instance = new GameLobby();
        this._instance.render(true);
        return true;
    }

    static _openLobbyPresenter(PresenterClass, themeId) {
        if (ParlorManager.notifyActiveSessionRunning()) return false;
        if (this._lobbyHost?.root?.isConnected) {
            this._lobbyHost.refresh(null);
            return true;
        }
        let host = null;
        host = new PresenterHost({
            surface: 'lobby',
            hostId: 'parlor-lobby-presenter',
            themeId,
            gameApi: this._createLobbyGameApi(() => {
                if (this._lobbyHost === host) {
                    this._lobbyHost.destroy();
                    this._lobbyHost = null;
                }
            }),
            PresenterClass,
            onFallback: () => {
                if (this._lobbyHost === host) this._lobbyHost = null;
                this._openNativeLobby();
            }
        });
        this._lobbyHost = host;
        host.open(null);
        return true;
    }

    // 大厅数据面:游戏列表 / 开某桌(开桌配置对话仍走本体,契约 §5)/ 赌桌预设 / 筹码工具。
    // 筹码与指南全桥回本体对话——主题只换门面,功能一个不吞
    static _createLobbyGameApi(requestClose) {
        const inst = () => this._instance || (this._instance = new GameLobby());
        return Object.freeze({
            getGames: () => getGameList(),
            openGame: async (gameId) => {
                requestClose(); // 进桌前先收大厅,别叠两层全屏
                return GameLobby.openGame(gameId);
            },
            openGameGuide: (gameId) => inst()._openGameGuide(gameId),
            openChipManage: () => inst()._openChipAllocationDialog(),
            openChipSettle: () => inst()._openChipSettlementDialog(),
            openGoldAdmin: () => inst()._openDndGoldAdminDialog(),
            promptPlayerExchange: () => inst()._promptPlayerGoldExchange(),
            openPlayerExchange: () => inst()._openPlayerGoldExchangeDialog(),
            getTableDecks: () => ({
                decks: TableDecks.list(),
                activeDeckId: TableDecks.getActive()?.id || ''
            }),
            setActiveDeck: (id) => TableDecks.setActive(id),
            saveDeck: (deck) => TableDecks.save(deck),
            removeDeck: (id) => TableDecks.remove(id),
            isGM: () => game.user.isGM,
            requestClose,
            t: (key, data) => t(key, data)
        });
    }

    static async openGame(gameId) {
        if (ParlorManager.notifyActiveSessionRunning()) return false;
        const lobby = this._instance || new GameLobby();
        return lobby._onGameSelect(gameId);
    }

    static async openDndGoldTools() {
        const lobby = this._instance || new GameLobby();
        return lobby._openDndGoldAdminDialog();
    }

    static async openPlayerGoldExchange() {
        const lobby = this._instance || new GameLobby();
        return lobby._openPlayerGoldExchangeDialog();
    }

    static async promptPlayerGoldExchange() {
        const lobby = this._instance || new GameLobby();
        return lobby._promptPlayerGoldExchange();
    }

    static registerSocketHandlers() {
        if (this._exchangeSocketRegistered) return;

        SocketManager.on(SOCKET_EVENTS.OPEN_GOLD_CHIP_EXCHANGE, (data = {}) => {
            const targetUserIds = Array.isArray(data.targetUserIds) ? data.targetUserIds : [];
            if (game.user.isGM) return false;
            if (targetUserIds.length && !targetUserIds.includes(game.user.id)) return false;
            return this.openPlayerGoldExchange();
        });

        SocketManager.on(SOCKET_EVENTS.APPLY_GOLD_CHIP_EXCHANGE, (data = {}) => {
            if (!game.user.isGM) return { ok: false, reason: 'not-gm' };
            return SettlementManager.applySelfServiceDndGoldExchange(data);
        });

        this._exchangeSocketRegistered = true;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        context.games = getGameList();
        context.isGM = game.user.isGM;
        context.showDndGoldTools = game.user.isGM && SettlementManager.canUseDnd5eGold();
        context.showPlayerExchangeTool = SettlementManager.canUseDnd5eGold() && !!game.user.character;
        return context;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        if (!html) return;

        html.querySelectorAll('.parlor-game-card').forEach(card => {
            card.addEventListener('click', () => this._onGameSelect(card.dataset.gameId));
            card.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                this._onGameSelect(card.dataset.gameId);
            });
        });
        html.querySelectorAll('[data-game-guide]').forEach(button => {
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._openGameGuide(button.dataset.gameGuide);
            });
        });
        html.querySelector('[data-chip-action="manage"]')?.addEventListener('click', () => this._openChipAllocationDialog());
        html.querySelector('[data-chip-action="settle"]')?.addEventListener('click', () => this._openChipSettlementDialog());
        html.querySelector('[data-chip-action="gold-admin"]')?.addEventListener('click', () => this._openDndGoldAdminDialog());
        html.querySelector('[data-chip-action="prompt-player-exchange"]')?.addEventListener('click', () => this._promptPlayerGoldExchange());
        html.querySelector('[data-chip-action="player-exchange"]')?.addEventListener('click', () => this._openPlayerGoldExchangeDialog());
    }

    async _openGameGuide(gameId) {
        const gameConfig = getGameConfig(gameId);
        if (!gameConfig) return;

        const guide = getGameGuide(gameId);
        const result = await foundry.applications.api.DialogV2.wait({
            window: {
                title: t('PARLOR.Lobby.GameGuide.WindowTitle', { game: gameConfig.nameText }),
                icon: 'fas fa-book-open'
            },
            content: this._buildGameGuideHtml(gameConfig, guide),
            render: (_event, dialog) => {
                this._decorateParlorDialog(dialog);
                this._liftDialogAboveTables(dialog);
            },
            buttons: [
                {
                    action: 'start',
                    label: t('PARLOR.Common.Start'),
                    icon: 'fas fa-play',
                    default: true,
                    callback: () => 'start'
                },
                {
                    action: 'close',
                    label: t('PARLOR.Common.Close'),
                    callback: () => 'close'
                }
            ],
            rejectClose: false
        });

        if (result === 'start') {
            await this._onGameSelect(gameId);
        }
    }

    _buildGameGuideHtml(gameConfig, guide) {
        const escape = (value) => foundry.utils.escapeHTML(String(value ?? ''));
        const missingText = t('PARLOR.Lobby.GameGuide.Missing');
        const summary = guide?.summary || gameConfig.descText || missingText;
        const paragraphs = Array.isArray(guide?.paragraphs) ? guide.paragraphs.filter(Boolean) : [];
        const note = guide?.note || '';
        const accordion = guide?.accordion || null;
        const bodyHtml = paragraphs.length
            ? paragraphs.map(text => `<p class="parlor-game-guide-body">${escape(text)}</p>`).join('')
            : `<div class="parlor-game-guide-empty">${escape(missingText)}</div>`;
        const noteHtml = note
            ? `<div class="parlor-game-guide-note">${escape(note)}</div>`
            : '';
        const accordionHtml = accordion?.title && Array.isArray(accordion.items) && accordion.items.length
            ? `
                <details class="parlor-game-guide-accordion">
                    <summary class="parlor-game-guide-accordion-summary">${escape(accordion.title)}</summary>
                    <div class="parlor-game-guide-accordion-body">
                        <ul class="parlor-game-guide-accordion-list">
                            ${accordion.items.map(text => `<li>${escape(text)}</li>`).join('')}
                        </ul>
                    </div>
                </details>
            `
            : '';

        return `
            <div class="parlor-game-guide">
                <div class="parlor-game-guide-head">
                    <div class="parlor-game-guide-kicker">PARLOR</div>
                    <div class="parlor-game-guide-title">${escape(gameConfig.nameText)}</div>
                    <p class="parlor-game-guide-summary">${escape(summary)}</p>
                </div>
                <div class="parlor-game-guide-section">
                    ${bodyHtml}
                    ${noteHtml}
                    ${accordionHtml}
                </div>
            </div>
        `;
    }

    _liftDialogAboveTables(dialog) {
        const root = dialog?.element ?? dialog;
        if (!root) return;

        const apply = () => {
            root.classList?.add('parlor-overlay-dialog');
            root.style.zIndex = '3200';
        };

        apply();
        requestAnimationFrame(apply);
        window.setTimeout(apply, 60);
    }

    async _onGameSelect(gameId) {
        const gameConfig = getGameConfig(gameId);
        if (!gameConfig) return;

        const draft = this._createGameSetupDraft();
        this._syncGameSetupDraft(gameConfig, draft);

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Lobby.StartWindowTitle', { game: gameConfig.nameText }) },
            // 定宽：auto 会按每个游戏的内容撑出不一样的宽度，切游戏时对话框忽大忽小
            position: { width: 680 },
            content: '<div id="parlor-start-setup"></div>',
            render: (_event, dialog) => this._mountGameSetupDialog(dialog, gameConfig, draft),
            buttons: [{
                label: t('PARLOR.Lobby.Start'),
                action: 'start',
                icon: 'fas fa-play',
                callback: () => {
                    const participants = this._composeStartParticipants(gameConfig, draft);
                    return {
                        participants,
                        dealerId: draft.dealerId || '',
                        isPublic: draft.isPublic,
                        gameOptions: this._composeGameOptions(gameConfig, draft),
                        gmOnlyOptions: this._composeGMOnlyOptions(gameConfig, draft, participants)
                    };
                }
            }, {
                label: t('PARLOR.Common.Cancel'),
                action: 'cancel'
            }],
            rejectClose: false
        });

        if (!result || result === 'cancel') return;

        const participants = result.participants || [];
        if (!participants.length) {
            ui.notifications.warn(t('PARLOR.Lobby.Errors.NeedParticipant'));
            return;
        }

        // 骨骰21：在大厅就先把真实玩家能不能付底注卡掉，免得 GM 进桌才发现开不了局。
        // 这里走结算门面，金币模式会查角色卡，筹码模式仍查 Parlor 自己的筹码池。
        if (gameConfig.id === 'bone21') {
            const ante = result.gameOptions?.ante || 0;
            const shortNames = participants
                .filter(p => p.type === 'user')
                .filter(p => !SettlementManager.canAfford(p.id, ante, result.gameOptions))
                .map(p => getParticipantLabel(p));
            if (shortNames.length) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.Bone21AnteShort', {
                    amount: ante,
                    names: shortNames.join('、')
                }));
                return;
            }
        }

        if (gameConfig.id === 'crazyeights') {
            const minCount = this._getMinParticipantCount(gameConfig);
            const maxCount = this._getMaxParticipantCount(gameConfig);
            if (participants.length < minCount || participants.length > maxCount) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.CrazyEightsNeedPlayers', { minCount, maxCount }));
                return;
            }

            // 底注只卡真实玩家(自测局的 DM 席位不动账,跳过);罚金结算时封顶在余额,开桌不用预检
            const ante = result.gameOptions?.ante || 0;
            const exempt = new Set(result.gameOptions?.exemptParticipantIds || []);
            const shortNames = participants
                .filter(p => p.type === 'user' && !exempt.has(p.id))
                .filter(p => !SettlementManager.canAfford(p.id, ante, result.gameOptions))
                .map(p => getParticipantLabel(p));
            if (shortNames.length) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.CrazyEightsAnteShort', {
                    amount: ante,
                    names: shortNames.join('、')
                }));
                return;
            }
        }

        if (gameConfig.id === 'beetlerace') {
            // 赛事卡里的甲虫可能被删得不够三只了，开桌前就拦下来，别进桌才发现跑不起来
            if (!result.gameOptions?.race) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.BeetleRaceInvalid'));
                return;
            }
            const maxCount = this._getMaxParticipantCount(gameConfig);
            if (participants.length > maxCount) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.MaxParticipants', { maxCount }));
                return;
            }
            // 这两项是全桌偏好（GM 定、记住上次），开桌确认了才写回去；中途取消对话框不动它
            await setBeetlePref('sound', draft.beetleRaceSound !== false);
            await setBeetlePref('cleanTable', !!draft.beetleRaceCleanTable);
        }

        if (gameConfig.id === 'texasholdem') {
            const maxCount = this._getMaxParticipantCount(gameConfig);
            if (participants.length < 2) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.TexasHoldemNeedPlayers'));
                return;
            }
            if (participants.length > maxCount) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.MaxParticipants', { maxCount }));
                return;
            }

            const buyIn = result.gameOptions?.buyIn || 0;
            // GM 用的是本场临时 stack，不能拿普通玩家的钱包校验把主持人挡在桌外。
            const shortNames = this._getTexasBuyInPayers(participants, result.gameOptions)
                .filter(p => !SettlementManager.canAfford(p.id, buyIn, result.gameOptions))
                .map(p => getParticipantLabel(p));
            if (shortNames.length) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.TexasHoldemBuyInShort', {
                    amount: buyIn,
                    names: shortNames.join('、')
                }));
                return;
            }
        }

        let dealerProfile = null;
        if (this._isBlackjackTable(gameConfig)) {
            dealerProfile = this._buildGMDealerProfile();
        } else if (gameConfig.dealerMode === 'required') {
            const dealer = participants.find(entry => entry.id === result.dealerId) || null;
            if (!dealer) {
                ui.notifications.warn(t('PARLOR.Lobby.Errors.NeedDealer'));
                return;
            }
            dealerProfile = buildDealerProfileFromParticipant(dealer);
        }

        const cardLuckPlan = result.gmOnlyOptions?.cardLuckPlan || null;
        if (cardLuckPlan?.errors?.length) {
            ui.notifications.warn(t('PARLOR.Lobby.Errors.CardLuckInvalid'));
            return;
        }

        const started = await ParlorManager.startGame(
            gameId,
            participants,
            !!result.isPublic,
            dealerProfile,
            result.gameOptions || null,
            result.gmOnlyOptions || null
        );
        if (started) this.close();
    }

    _createGameSetupDraft() {
        const users = game.users.filter(user => user.active && !user.isGM);
        const playerEntries = users.map(user => ({
            userId: user.id,
            userName: user.name,
            participant: createUserParticipant(user),
            enabled: true
        }));

        const gmParticipant = createUserParticipant(game.user);
        const missingUsers = playerEntries.filter(entry => !entry.participant);

        return {
            playerEntries,
            gmParticipant,
            includeGMPlayer: false,
            npcParticipants: [],
            isPublic: true,
            dealerId: '',
            slotOperatorId: '',
            slotSpinCost: 5,
            bone21Ante: 10,
            crazyEightsAnte: DEFAULT_CRAZY_EIGHTS_OPTIONS.ante,
            crazyEightsPenaltyPerPoint: DEFAULT_CRAZY_EIGHTS_OPTIONS.penaltyPerPoint,
            crazyEightsDrawRule: DEFAULT_CRAZY_EIGHTS_OPTIONS.drawRule,
            crazyEightsActionCards: DEFAULT_CRAZY_EIGHTS_OPTIONS.actionCards,
            beetleRaceId: BeetleRaceLibrary.listRaces()[0]?.id || '',
            beetleRaceSound: getBeetlePref('sound'),
            beetleRaceCleanTable: getBeetlePref('cleanTable'),
            betLimitMin: 1,
            betLimitMax: 0,
            texasSmallBlind: 5,
            texasBigBlind: 10,
            texasBuyIn: 200,
            texasGmBuyIn: 200,
            cardLuckByParticipantId: {},
            customHand: null,
            settlementMode: SettlementManager.canUseDnd5eGold()
                ? SettlementManager.MODES.DND5E_GOLD
                : SettlementManager.MODES.CHIPS,
            missingUsers
        };
    }

    _isBlackjackTable(gameConfig) {
        return gameConfig?.id === 'blackjack';
    }

    _isLiarsDiceTable(gameConfig) {
        return gameConfig?.id === 'liarsdice';
    }

    _isBone21Table(gameConfig) {
        return gameConfig?.id === 'bone21';
    }

    _isTexasHoldemTable(gameConfig) {
        return gameConfig?.id === 'texasholdem';
    }

    _isSlotMachineTable(gameConfig) {
        return gameConfig?.id === 'slotmachine';
    }

    _supportsCardBetLimits(gameConfig) {
        return supportsCardBetLimits(gameConfig?.id);
    }

    _supportsCardLuck(gameConfig) {
        return this._isBlackjackTable(gameConfig) || this._isTexasHoldemTable(gameConfig);
    }

    _getCardLuck(draft, participantId) {
        const explicit = draft.cardLuckByParticipantId?.[participantId];
        if (['good', 'bad'].includes(explicit)) return explicit;
        const legacyMode = draft.forcedOutcomeEntries?.[participantId]?.mode;
        if (legacyMode === 'win') return 'good';
        if (legacyMode === 'lose') return 'bad';
        return 'normal';
    }

    _getCardLuckLabel(mode) {
        const safeMode = ['normal', 'good', 'bad'].includes(mode) ? mode : 'normal';
        return t('PARLOR.Lobby.Setup.CardLuck.Modes.' + safeMode);
    }

    _getCustomHandTypes(gameConfig) {
        if (this._isBlackjackTable(gameConfig)) return BLACKJACK_CUSTOM_HAND_TYPES;
        if (this._isTexasHoldemTable(gameConfig)) return TEXAS_CUSTOM_HAND_TYPES;
        return [];
    }

    _getCustomHandLabel(gameConfig, handType) {
        const types = this._getCustomHandTypes(gameConfig);
        const safeType = types.includes(handType) ? handType : 'none';
        return t('PARLOR.Lobby.Setup.CardLuck.CustomHands.' + safeType);
    }

    _getLegacyCustomHand(gameConfig, draft, activeIds = null) {
        const activeSet = activeIds
            ? new Set(activeIds)
            : null;
        let customHand = null;
        for (const [participantId, entry] of Object.entries(draft.forcedOutcomeEntries || {})) {
            if (activeSet && !activeSet.has(participantId)) continue;
            const mode = String(entry?.mode || '');
            let handType = '';
            if (this._isBlackjackTable(gameConfig) && ['blackjack', 'natural-blackjack'].includes(mode)) {
                handType = 'natural-blackjack';
            } else if (this._isTexasHoldemTable(gameConfig)) {
                if (mode === 'hand') {
                    handType = TEXAS_CUSTOM_HAND_TYPES.includes(entry?.handType) ? entry.handType : 'flush';
                } else if (TEXAS_CUSTOM_HAND_TYPES.includes(mode)) {
                    handType = mode;
                }
            }
            if (!handType) continue;
            customHand = {
                participantId,
                gameType: gameConfig.id,
                handType,
                pending: true
            };
        }
        return customHand;
    }

    _setCardLuck(draft, participantId, mode) {
        if (!participantId) return;
        if (!draft.cardLuckByParticipantId) draft.cardLuckByParticipantId = {};
        const safeMode = ['good', 'bad'].includes(mode) ? mode : 'normal';
        if (safeMode === 'normal') delete draft.cardLuckByParticipantId[participantId];
        else draft.cardLuckByParticipantId[participantId] = safeMode;
    }

    _setCustomHand(gameConfig, draft, participantId, handType) {
        if (!participantId) return { transferredFromParticipantId: '' };
        const previousId = draft.customHand?.participantId || '';
        const types = this._getCustomHandTypes(gameConfig);

        for (const [legacyId, entry] of Object.entries(draft.forcedOutcomeEntries || {})) {
            const mode = String(entry?.mode || '');
            const legacyCustom = this._isBlackjackTable(gameConfig)
                ? ['blackjack', 'natural-blackjack'].includes(mode)
                : mode === 'hand' || TEXAS_CUSTOM_HAND_TYPES.includes(mode);
            if (legacyCustom) delete draft.forcedOutcomeEntries[legacyId];
        }

        if (handType === 'none') {
            if (previousId === participantId) draft.customHand = null;
            return { transferredFromParticipantId: '' };
        }
        if (!types.includes(handType)) return { transferredFromParticipantId: '' };

        draft.customHand = {
            participantId,
            gameType: gameConfig.id,
            handType,
            pending: true
        };
        return {
            transferredFromParticipantId: previousId && previousId !== participantId ? previousId : ''
        };
    }

    _getDraftParticipantLabel(draft, participantId) {
        const rows = [
            ...(draft.playerEntries || []).map(entry => entry.participant),
            draft.gmParticipant,
            ...(draft.npcParticipants || [])
        ].filter(Boolean);
        return rows.find(entry => entry.id === participantId)?.name || participantId;
    }

    _renderCardLuckControl(gameConfig, draft, participantId, { disabled = false } = {}) {
        if (!this._supportsCardLuck(gameConfig) || !participantId) return '';
        const luck = this._getCardLuck(draft, participantId);
        const customHand = draft.customHand || this._getLegacyCustomHand(gameConfig, draft);
        const customType = customHand?.participantId === participantId
            ? customHand.handType
            : 'none';
        const luckOptions = ['normal', 'good', 'bad'].map(mode => `
            <option value="${mode}" ${luck === mode ? 'selected' : ''}>${escapeHtml(this._getCardLuckLabel(mode))}</option>
        `).join('');
        const customOptions = ['none', ...this._getCustomHandTypes(gameConfig)].map(handType => `
            <option value="${handType}" ${customType === handType ? 'selected' : ''}>${escapeHtml(this._getCustomHandLabel(gameConfig, handType))}</option>
        `).join('');

        // 说明文字在分区顶上讲过一遍了，这里只留悬停提示
        return `
            <div class="parlor-setup-luck" data-card-luck-control data-tooltip="${escapeHtml(t('PARLOR.Lobby.Setup.CardLuck.Help'))}">
                ${setupField({
                    label: t('PARLOR.Lobby.Setup.CardLuck.Label'),
                    compact: true,
                    control: `<select data-card-luck="${escapeHtml(participantId)}" ${disabled ? 'disabled' : ''}>${luckOptions}</select>`
                })}
                ${setupField({
                    label: `${t('PARLOR.Lobby.Setup.CardLuck.CustomLabel')} · ${t('PARLOR.Lobby.Setup.CardLuck.OneShot')}`,
                    compact: true,
                    control: `<select data-custom-hand="${escapeHtml(participantId)}" ${disabled ? 'disabled' : ''}>${customOptions}</select>`
                })}
            </div>
        `;
    }

    _composeCardLuckPlan(gameConfig, draft, participants = null) {
        if (!this._supportsCardLuck(gameConfig)) return null;
        const startParticipants = participants || this._composeStartParticipants(gameConfig, draft);
        const activeIds = startParticipants.map(entry => entry.id).filter(Boolean);
        const luckByParticipantId = {};
        for (const participantId of activeIds) {
            const luck = this._getCardLuck(draft, participantId);
            if (luck !== 'normal') luckByParticipantId[participantId] = luck;
        }
        const customSource = draft.customHand || this._getLegacyCustomHand(gameConfig, draft, activeIds);
        const customHand = customSource && activeIds.includes(customSource.participantId)
            ? customSource
            : null;
        const plan = CardLuckPlan.sanitize(
            gameConfig.id,
            { luckByParticipantId, customHand },
            activeIds
        );
        return CardLuckPlan.hasInfluence(plan) || plan.errors.length ? plan : null;
    }

    _composeGMOnlyOptions(gameConfig, draft, participants = null) {
        const cardLuckPlan = this._composeCardLuckPlan(gameConfig, draft, participants);
        return cardLuckPlan ? { cardLuckPlan } : null;
    }

    // 注册表里带 lobby 块的游戏（目前只有疯狂八）从这里拿大厅规则；没带的照旧走下面按 id 写死的分支
    _getLobbyMeta(gameConfig) {
        const meta = gameConfig?.lobby;
        return meta && typeof meta === 'object' ? meta : null;
    }

    _canIncludeGMPlayer(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        if (typeof meta?.allowGM === 'boolean') return meta.allowGM;
        return this._isLiarsDiceTable(gameConfig)
            || this._isBone21Table(gameConfig)
            || this._isTexasHoldemTable(gameConfig)
            || this._isSlotMachineTable(gameConfig);
    }

    _canAddNpcParticipants(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        if (typeof meta?.allowNpc === 'boolean') return meta.allowNpc;
        return !this._isSlotMachineTable(gameConfig);
    }

    _getParticipantsNote(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        if (meta?.participantsNoteKey) return t(meta.participantsNoteKey);
        if (this._isBlackjackTable(gameConfig)) return t('PARLOR.Lobby.Setup.BlackjackParticipantsNote');
        if (this._isLiarsDiceTable(gameConfig)) return t('PARLOR.Lobby.Setup.LiarsDiceParticipantsNote');
        if (this._isBone21Table(gameConfig)) return t('PARLOR.Lobby.Setup.Bone21ParticipantsNote');
        if (this._isTexasHoldemTable(gameConfig)) return t('PARLOR.Lobby.Setup.TexasHoldemParticipantsNote');
        if (this._isSlotMachineTable(gameConfig)) return t('PARLOR.Lobby.Setup.SlotParticipantsNote');
        return t('PARLOR.Lobby.Setup.ParticipantsNote');
    }

    _getMaxParticipantCount(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        if (Number.isFinite(meta?.maxParticipants)) return meta.maxParticipants;
        if (this._isTexasHoldemTable(gameConfig)) return 6;
        return gameConfig?.dealerMode === 'required' ? 11 : 10;
    }

    _getMinParticipantCount(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        return Number.isFinite(meta?.minParticipants) ? meta.minParticipants : 1;
    }

    _shouldAutoFillBots(gameConfig) {
        const meta = this._getLobbyMeta(gameConfig);
        if (typeof meta?.autoFillBots === 'boolean') return meta.autoFillBots;
        return gameConfig?.id !== 'slotmachine';
    }

    _canUsePlayerEntry(gameConfig, entry, draft = null) {
        if (!entry?.participant) return false;
        if (SettlementManager.isGoldMode(draft) && !entry.participant.actorId) return false;
        if (this._isBlackjackTable(gameConfig)) return !!entry.participant.actorId;
        return true;
    }

    _buildGMDealerProfile() {
        return {
            type: 'gm',
            participantId: null,
            actorId: null,
            userId: game.user?.id || null,
            controllerId: game.user?.id || null,
            name: t('PARLOR.Common.Dealer'),
            avatar: null,
            ownerName: game.user?.name || t('PARLOR.Common.DM')
        };
    }

    _normalizeBotMode(botMode) {
        return BOT_MODE_OPTIONS.includes(botMode) ? botMode : 'random';
    }

    _getBotModeLabel(botMode) {
        return t(`PARLOR.Lobby.Setup.BotMode.${this._normalizeBotMode(botMode)}`);
    }

    _getManualParticipants(draft, gameConfig = null) {
        const participants = draft.playerEntries
            .filter(entry => entry.enabled && this._canUsePlayerEntry(gameConfig, entry, draft))
            .map(entry => entry.participant);

        // 德州里的 GM 是桌务席位，买入只生成本场 stack；注册表标了 gmExempt 的桌 GM 席位干脆不进账。
        // 这两种都别再让角色卡或结算模式决定他能不能坐下。
        const gmUsesTableStack = this._isTexasHoldemTable(gameConfig) || this._isGmExemptTable(gameConfig);
        const gmCanJoin = gmUsesTableStack || !SettlementManager.isGoldMode(draft) || !!draft.gmParticipant?.actorId;
        if (this._canIncludeGMPlayer(gameConfig) && draft.includeGMPlayer && draft.gmParticipant && gmCanJoin) {
            participants.push(draft.gmParticipant);
        }

        if (this._canAddNpcParticipants(gameConfig)) {
            participants.push(...draft.npcParticipants);
        }

        const seen = new Set();
        return participants.filter(entry => {
            if (!entry?.id || seen.has(entry.id)) return false;
            seen.add(entry.id);
            return true;
        });
    }

    _getTexasBuyInPayers(participants, gameOptions = null) {
        const gmParticipantId = String(gameOptions?.gmParticipantId || '');
        return (participants || []).filter(entry => (
            entry?.type === 'user' && entry.id !== gmParticipantId
        ));
    }

    _composeSetupParticipants(draft, gameConfig = null) {
        const participants = this._getManualParticipants(draft, gameConfig);

        // 甲虫赛跑：谁都没勾 = DM 自己看甲虫、试作弊招，只坐 DM 一个（不进账），不塞机器人抢戏
        if (gameConfig?.id === 'beetlerace' && !participants.length && draft.gmParticipant) {
            return [draft.gmParticipant];
        }

        // 疯狂八：谁都没勾就开桌 = DM 自己试玩,自动坐下 DM 加 3 个机器人(只勾了 DM 自己也一样补齐)
        if (this._isCrazyEightsSelfTest(draft, gameConfig)) {
            const bots = BotManager.createBotIds(CRAZY_EIGHTS_SELF_TEST_BOTS).map(botId => this._buildFillerBot(botId, 'random'));
            return [draft.gmParticipant, ...bots];
        }

        if (!participants.length && this._shouldAutoFillBots(gameConfig)) {
            return BotManager.createBotIds(5).map(botId => this._buildFillerBot(botId, 'random'));
        }

        return participants;
    }

    _isGmExemptTable(gameConfig) {
        return this._getLobbyMeta(gameConfig)?.gmExempt === true;
    }

    // GM 坐在桌上(自测局自动坐,或自己勾了)且这桌 GM 不进账 → 这个席位要告诉引擎豁免。
    // 按最终开局名单判断，自测局自动补进来的 DM 和手动勾的 DM 一视同仁
    _getExemptParticipantIds(draft, gameConfig) {
        if (!this._isGmExemptTable(gameConfig) || !draft?.gmParticipant) return [];
        const gmId = draft.gmParticipant.id;
        const seated = this._composeSetupParticipants(draft, gameConfig).some(entry => entry.id === gmId);
        return seated ? [gmId] : [];
    }

    // 除 DM 之外一个人都没勾(玩家/NPC 都没有)才算自测局
    _isCrazyEightsSelfTest(draft, gameConfig) {
        if (gameConfig?.id !== 'crazyeights' || !draft?.gmParticipant) return false;
        const gmId = draft.gmParticipant.id;
        const others = this._getManualParticipants(draft, gameConfig).filter(entry => entry.id !== gmId);
        return !others.length;
    }

    _buildFillerBot(botId, botMode = 'random') {
        return {
            id: botId,
            type: 'bot',
            actorId: null,
            userId: null,
            controllerId: null,
            botMode: this._normalizeBotMode(botMode),
            name: BotManager.getBotName(botId),
            avatar: null,
            ownerName: ''
        };
    }

    _composeStartParticipants(gameConfig, draft) {
        if (gameConfig?.id !== 'slotmachine') {
            return this._composeSetupParticipants(draft, gameConfig);
        }

        const manualParticipants = this._getManualParticipants(draft, gameConfig)
            .filter(entry => entry.type === 'user');
        const operator = manualParticipants.find(entry => entry.id === draft.slotOperatorId) || manualParticipants[0] || null;
        return operator ? [operator] : [];
    }

    _composeGameOptions(gameConfig, draft) {
        const gameOptions = {
            settlementMode: SettlementManager.getMode(draft)
        };

        if (this._supportsCardBetLimits(gameConfig)) {
            gameOptions.betLimits = normalizeBetLimits({
                min: draft.betLimitMin,
                max: draft.betLimitMax
            });
        }

        if (gameConfig?.id === 'slotmachine') {
            return {
                ...gameOptions,
                spinCost: Math.max(1, Math.floor(Number(draft.slotSpinCost || 0)) || 5)
            };
        }
        if (gameConfig?.id === 'bone21') {
            return {
                ...gameOptions,
                ante: Math.max(1, Math.floor(Number(draft.bone21Ante || 0)) || 10)
            };
        }
        if (gameConfig?.id === 'crazyeights') {
            const options = sanitizeCrazyEightsOptions({
                ante: draft.crazyEightsAnte,
                penaltyPerPoint: draft.crazyEightsPenaltyPerPoint,
                drawRule: draft.crazyEightsDrawRule,
                actionCards: draft.crazyEightsActionCards
            });
            return {
                ...gameOptions,
                ante: options.ante,
                penaltyPerPoint: options.penaltyPerPoint,
                drawRule: options.drawRule,
                actionCards: options.actionCards,
                // GM 席位不进账:底注不查、结算不扣
                exemptParticipantIds: this._getExemptParticipantIds(draft, gameConfig)
            };
        }
        if (gameConfig?.id === 'beetlerace') {
            // 赛事卡整个解析成快照随开局广播：比赛中 DM 再去改素材，不影响正在跑的这场
            const race = BeetleRaceLibrary.resolveRace(draft.beetleRaceId);
            return {
                ...gameOptions,
                race,
                betLimits: normalizeBetLimits({ min: race?.minBet ?? 1, max: race?.maxBet ?? 0 }),
                exemptParticipantIds: this._getExemptParticipantIds(draft, gameConfig)
            };
        }
        if (gameConfig?.id === 'texasholdem') {
            const smallBlind = Math.max(1, Math.floor(Number(draft.texasSmallBlind || 0)) || 5);
            const bigBlind = Math.max(smallBlind, Math.floor(Number(draft.texasBigBlind || 0)) || 10);
            const buyIn = Math.max(bigBlind * 10, Math.floor(Number(draft.texasBuyIn || 0)) || 200);
            const gmParticipantId = draft.includeGMPlayer ? draft.gmParticipant?.id || '' : '';
            const gmBuyIn = Math.max(bigBlind * 10, Math.floor(Number(draft.texasGmBuyIn || 0)) || buyIn);
            return {
                ...gameOptions,
                smallBlind,
                bigBlind,
                buyIn,
                ...(gmParticipantId ? { gmParticipantId, gmBuyIn } : {})
            };
        }
        return gameOptions;
    }

    _syncGameSetupDraft(gameConfig, draft) {
        draft.settlementMode = SettlementManager.getMode(draft);

        if (this._supportsCardBetLimits(gameConfig)) {
            const betLimits = normalizeBetLimits({
                min: draft.betLimitMin,
                max: draft.betLimitMax
            });
            draft.betLimitMin = betLimits.min;
            draft.betLimitMax = betLimits.max;
        }

        if (!this._canIncludeGMPlayer(gameConfig)) {
            draft.includeGMPlayer = false;
        }

        if (!this._canAddNpcParticipants(gameConfig)) {
            draft.npcParticipants = [];
        }

        if (this._isBlackjackTable(gameConfig)) {
            draft.dealerId = '';
        }

        const participants = this._composeSetupParticipants(draft, gameConfig);
        const dealerOptions = participants.filter(entry => entry.actorId);

        if (gameConfig.id === 'slotmachine') {
            const slotOperators = this._getManualParticipants(draft, gameConfig)
                .filter(entry => entry.type === 'user');
            if (!slotOperators.some(entry => entry.id === draft.slotOperatorId)) {
                draft.slotOperatorId = slotOperators[0]?.id || '';
            }
            draft.slotSpinCost = Math.max(1, Math.floor(Number(draft.slotSpinCost || 0)) || 5);
        }

        if (gameConfig.id === 'bone21') {
            draft.bone21Ante = Math.max(1, Math.floor(Number(draft.bone21Ante || 0)) || 10);
        }

        if (gameConfig.id === 'crazyeights') {
            const options = sanitizeCrazyEightsOptions({
                ante: draft.crazyEightsAnte,
                penaltyPerPoint: draft.crazyEightsPenaltyPerPoint,
                drawRule: draft.crazyEightsDrawRule,
                actionCards: draft.crazyEightsActionCards
            });
            draft.crazyEightsAnte = options.ante;
            draft.crazyEightsPenaltyPerPoint = options.penaltyPerPoint;
            draft.crazyEightsDrawRule = options.drawRule;
            draft.crazyEightsActionCards = options.actionCards;
        }

        if (gameConfig.id === 'beetlerace') {
            const races = BeetleRaceLibrary.listRaces();
            if (!races.some(race => race.id === draft.beetleRaceId)) draft.beetleRaceId = races[0]?.id || '';
        }

        if (gameConfig.id === 'texasholdem') {
            draft.texasSmallBlind = Math.max(1, Math.floor(Number(draft.texasSmallBlind || 0)) || 5);
            draft.texasBigBlind = Math.max(draft.texasSmallBlind, Math.floor(Number(draft.texasBigBlind || 0)) || 10);
            draft.texasBuyIn = Math.max(draft.texasBigBlind * 10, Math.floor(Number(draft.texasBuyIn || 0)) || 200);
            draft.texasGmBuyIn = Math.max(draft.texasBigBlind * 10, Math.floor(Number(draft.texasGmBuyIn || 0)) || draft.texasBuyIn);
        }

        if (gameConfig.dealerMode !== 'required') {
            draft.dealerId = '';
            return;
        }

        if (!dealerOptions.some(entry => entry.id === draft.dealerId)) {
            draft.dealerId = dealerOptions[0]?.id || '';
        }
    }

    _mountGameSetupDialog(dialog, gameConfig, draft) {
        const root = dialog.element?.querySelector('#parlor-start-setup');
        if (!root) return;
        root.classList.add('parlor-game-setup-body');
        this._decorateParlorDialog(dialog);

        const renderDraft = () => {
            const scrollTop = root.scrollTop;
            this._syncGameSetupDraft(gameConfig, draft);
            root.innerHTML = this._renderGameSetup(gameConfig, draft);
            // 每次改选项都整块重画，滚动位置得自己还回去，不然勾一下就跳回顶上
            root.scrollTop = scrollTop;
            this._bindGameSetup(root, gameConfig, draft, renderDraft);
        };

        renderDraft();
    }

    // ───────── 开桌对话：各分区的 HTML ─────────

    _renderGameSetup(gameConfig, draft) {
        return `
            <div class="parlor-setup">
                ${this._renderSetupPeople(gameConfig, draft)}
                ${this._canAddNpcParticipants(gameConfig) ? this._renderSetupNpcs(gameConfig, draft) : ''}
                ${gameConfig.dealerMode === 'required' ? this._renderSetupDealer(gameConfig, draft) : ''}
                ${this._renderSetupGameOptions(gameConfig, draft)}
                ${this._supportsCardBetLimits(gameConfig) ? this._renderSetupBetLimits(draft) : ''}
                ${SettlementManager.canUseDnd5eGold() ? this._renderSetupSettlement(draft) : ''}
                ${this._renderSetupFooter(gameConfig, draft)}
            </div>
        `;
    }

    _renderSetupPeople(gameConfig, draft) {
        const players = draft.playerEntries.map((entry, index) => this._renderSetupPlayerRow(gameConfig, draft, entry, index)).join('');
        const gmRow = this._canIncludeGMPlayer(gameConfig) && draft.gmParticipant ? this._renderSetupGmRow(gameConfig, draft) : '';
        // 手气说明原来每行挂一遍，挪到分区说明里说一次就够
        const note = [this._getParticipantsNote(gameConfig), this._supportsCardLuck(gameConfig) ? t('PARLOR.Lobby.Setup.CardLuck.Help') : '']
            .filter(Boolean)
            .join(' ');
        return setupSection({
            title: t('PARLOR.Lobby.Setup.ParticipantsTitle'),
            note,
            body: `
                <div class="parlor-setup-people">
                    ${players || `<div class="parlor-setup-empty">${escapeHtml(t('PARLOR.Lobby.Setup.NoOnlinePlayers'))}</div>`}
                    ${gmRow}
                </div>
            `
        });
    }

    _renderSetupPlayerRow(gameConfig, draft, entry, index) {
        const canJoin = this._canUsePlayerEntry(gameConfig, entry, draft);
        let meta = t('PARLOR.Lobby.Setup.PlayerOwner', { userName: entry.userName });
        if (!canJoin) {
            meta = SettlementManager.isGoldMode(draft) && entry.participant && !entry.participant.actorId
                ? t('PARLOR.Lobby.Setup.PlayerMissingGoldActor')
                : t('PARLOR.Lobby.Setup.PlayerMissingCharacter');
        }
        return setupPerson({
            toggle: `<input type="checkbox" data-player-index="${index}" ${entry.enabled && canJoin ? 'checked' : ''} ${canJoin ? '' : 'disabled'}>`,
            avatar: entry.participant?.avatar,
            name: entry.participant ? entry.participant.name : entry.userName,
            meta,
            state: canJoin ? '' : 'is-blocked',
            controls: this._renderCardLuckControl(gameConfig, draft, entry.participant?.id, { disabled: !canJoin || !entry.enabled })
        });
    }

    _renderSetupGmRow(gameConfig, draft) {
        const isTexas = this._isTexasHoldemTable(gameConfig);
        const row = setupPerson({
            toggle: `<input type="checkbox" data-include-gm ${draft.includeGMPlayer ? 'checked' : ''}>`,
            avatar: draft.gmParticipant.avatar,
            fallbackIcon: 'fas fa-crown',
            name: draft.gmParticipant.name,
            meta: isTexas ? t('PARLOR.Lobby.Setup.TexasHoldemGMSeat') : t('PARLOR.Lobby.Setup.GMCharacter'),
            controls: this._renderCardLuckControl(gameConfig, draft, draft.gmParticipant?.id, { disabled: !draft.includeGMPlayer })
        });
        if (!isTexas || !draft.includeGMPlayer) return row;
        // 德扑 GM 席位的本场筹码，只在勾了 GM 之后挂在它下面
        return `
            ${row}
            <label class="parlor-setup-subfield">
                <span>${escapeHtml(t('PARLOR.Lobby.Setup.TexasHoldemGMBuyIn'))}</span>
                <input type="number" min="${draft.texasBigBlind * 10}" step="1" value="${draft.texasGmBuyIn}" data-texas-gm-buy-in>
                <small>${escapeHtml(t('PARLOR.Lobby.Setup.TexasHoldemGMBuyInHint'))}</small>
            </label>
        `;
    }

    _renderSetupNpcs(gameConfig, draft) {
        const rows = draft.npcParticipants.map(entry => setupPerson({
            attrs: `data-npc-id="${escapeHtml(entry.id)}"`,
            avatar: entry.avatar,
            fallbackIcon: 'fas fa-robot',
            name: entry.name,
            meta: `${t('PARLOR.Lobby.Setup.NpcControlled')} · ${this._getBotModeLabel(entry.botMode)}`,
            controls: `
                ${setupField({
                    label: t('PARLOR.Lobby.Setup.BotModeLabel'),
                    compact: true,
                    control: `<select data-npc-mode="${escapeHtml(entry.id)}">${BOT_MODE_OPTIONS.map(mode => `
                        <option value="${mode}" ${this._normalizeBotMode(entry.botMode) === mode ? 'selected' : ''}>${escapeHtml(this._getBotModeLabel(mode))}</option>
                    `).join('')}</select>`
                })}
                ${this._renderCardLuckControl(gameConfig, draft, entry.id)}
                <button type="button" class="parlor-setup-remove" data-remove-npc="${escapeHtml(entry.id)}" data-tooltip="${escapeHtml(t('PARLOR.Lobby.Setup.RemoveNpc'))}" aria-label="${escapeHtml(t('PARLOR.Lobby.Setup.RemoveNpc'))}"><i class="fas fa-times"></i></button>
            `
        })).join('');
        return setupSection({
            title: t('PARLOR.Lobby.Setup.NpcTitle'),
            note: t('PARLOR.Lobby.Setup.NpcNote'),
            body: `
                <div class="parlor-setup-dropzone" data-npc-dropzone><i class="fas fa-user-plus"></i> ${escapeHtml(t('PARLOR.Lobby.Setup.NpcDropHint'))}</div>
                <div class="parlor-setup-people">${rows || `<div class="parlor-setup-empty">${escapeHtml(t('PARLOR.Lobby.Setup.NoNpc'))}</div>`}</div>
            `
        });
    }

    _renderSetupDealer(gameConfig, draft) {
        const dealerOptions = this._composeSetupParticipants(draft, gameConfig).filter(entry => entry.actorId);
        return setupSection({
            title: t('PARLOR.Lobby.Setup.DealerTitle'),
            note: t('PARLOR.Lobby.Setup.DealerRequired'),
            body: `
                <select data-dealer-select>
                    ${dealerOptions.map(entry => `<option value="${escapeHtml(entry.id)}" ${draft.dealerId === entry.id ? 'selected' : ''}>${escapeHtml(getParticipantLabel(entry))}</option>`).join('')}
                </select>
                ${dealerOptions.length ? '' : `<div class="parlor-setup-warn">${escapeHtml(t('PARLOR.Lobby.Setup.DealerNeedParticipant'))}</div>`}
            `
        });
    }

    _renderSetupGameOptions(gameConfig, draft) {
        switch (gameConfig.id) {
            case 'slotmachine': return this._renderSlotSetup(gameConfig, draft);
            case 'bone21': return this._renderBone21Setup(draft);
            case 'crazyeights': return this._renderCrazyEightsSetup(draft);
            case 'beetlerace': return this._renderBeetleRaceSetup(draft);
            case 'texasholdem': return this._renderTexasSetup(draft);
            default: return '';
        }
    }

    _renderSlotSetup(gameConfig, draft) {
        const operators = this._getManualParticipants(draft, gameConfig).filter(entry => entry.type === 'user');
        const options = operators.map(entry => `<option value="${escapeHtml(entry.id)}" ${draft.slotOperatorId === entry.id ? 'selected' : ''}>${escapeHtml(getParticipantLabel(entry))}</option>`).join('');
        return setupSection({
            title: t('PARLOR.Lobby.Setup.SlotTitle'),
            note: t('PARLOR.Lobby.Setup.SlotNote'),
            body: `
                <div class="parlor-setup-fields is-2">
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.SlotOperator'),
                        control: `<select data-slot-operator ${options ? '' : 'disabled'}>${options || `<option value="">${escapeHtml(t('PARLOR.Lobby.Setup.SlotNeedOperator'))}</option>`}</select>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.SlotSpinCost'),
                        control: `<input type="number" min="1" step="1" value="${draft.slotSpinCost}" data-slot-spin-cost>`
                    })}
                </div>
                <div class="parlor-setup-note">${escapeHtml(t('PARLOR.Lobby.Setup.SlotPublicNote'))}</div>
            `
        });
    }

    _renderBone21Setup(draft) {
        return setupSection({
            title: t('PARLOR.Lobby.Setup.Bone21Title'),
            note: t('PARLOR.Lobby.Setup.Bone21Note'),
            body: `
                <div class="parlor-setup-fields is-2">
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.Bone21Ante'),
                        control: `<input type="number" min="1" step="1" value="${draft.bone21Ante}" data-bone21-ante>`
                    })}
                </div>
            `
        });
    }

    _renderCrazyEightsSetup(draft) {
        const option = (value, current, key) => `<option value="${value}" ${current === value ? 'selected' : ''}>${escapeHtml(t(key))}</option>`;
        return setupSection({
            title: t('PARLOR.Lobby.Setup.CrazyEightsTitle'),
            note: t('PARLOR.Lobby.Setup.CrazyEightsNote'),
            body: `
                <div class="parlor-setup-fields is-2">
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.CrazyEightsAnte'),
                        control: `<input type="number" min="1" step="1" value="${draft.crazyEightsAnte}" data-c8-ante>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.CrazyEightsPenaltyPerPoint'),
                        control: `<input type="number" min="0" step="1" value="${draft.crazyEightsPenaltyPerPoint}" data-c8-penalty>`,
                        hint: t('PARLOR.Lobby.Setup.CrazyEightsPenaltyHint')
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.CrazyEightsDrawRule'),
                        control: `<select data-c8-draw-rule>
                            ${option('one', draft.crazyEightsDrawRule, 'PARLOR.Lobby.Setup.CrazyEightsDrawRuleOne')}
                            ${option('untilPlayable', draft.crazyEightsDrawRule, 'PARLOR.Lobby.Setup.CrazyEightsDrawRuleUntilPlayable')}
                        </select>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.CrazyEightsActionCards'),
                        control: `<select data-c8-action-cards>
                            ${option('tavern', draft.crazyEightsActionCards, 'PARLOR.Lobby.Setup.CrazyEightsActionCardsTavern')}
                            ${option('classic', draft.crazyEightsActionCards, 'PARLOR.Lobby.Setup.CrazyEightsActionCardsClassic')}
                        </select>`
                    })}
                </div>
            `
        });
    }

    // 甲虫赛跑：选赛事卡 + 一眼看清这张卡上场谁、各赔多少、跑多久
    _renderBeetleRaceSetup(draft) {
        const races = BeetleRaceLibrary.listRaces();
        const snapshot = BeetleRaceLibrary.resolveRace(draft.beetleRaceId);
        const options = races.map(race => `
            <option value="${escapeHtml(race.id)}" ${race.id === draft.beetleRaceId ? 'selected' : ''}>${escapeHtml(race.name || t('PARLOR.BeetleRace.Studio.UnnamedRace'))}${race.preset ? ` · ${escapeHtml(t('PARLOR.BeetleRace.Studio.PresetTag'))}` : ''}</option>
        `).join('');
        const lanes = (snapshot?.lanes || []).map((lane, index) => `
            <li class="parlor-br-setup-lane">
                <span class="parlor-br-setup-dot" style="background:${escapeHtml(lane.color)};box-shadow:inset 0 0 0 2px ${escapeHtml(deriveShades(lane.color).dark)}">${index + 1}</span>
                <span class="parlor-br-setup-name">${escapeHtml(lane.name)}</span>
                <span class="parlor-br-setup-odds">×${Number(lane.multiplier).toFixed(1)}</span>
            </li>
        `).join('');
        const facts = snapshot ? [
            t('PARLOR.Lobby.Setup.BeetleRaceFactDuration', { seconds: snapshot.durationSec }),
            t('PARLOR.Lobby.Setup.BeetleRaceFactBetting', { seconds: snapshot.betSeconds }),
            snapshot.maxBet > 0
                ? t('PARLOR.Lobby.Setup.BetLimitsRange', { min: snapshot.minBet, max: snapshot.maxBet })
                : t('PARLOR.Lobby.Setup.BetLimitsNoMax', { min: snapshot.minBet }),
            t(`PARLOR.Lobby.Setup.BeetleRacePower.${snapshot.powerDisplay}`)
        ] : [];
        return setupSection({
            title: t('PARLOR.Lobby.Setup.BeetleRaceTitle'),
            note: t('PARLOR.Lobby.Setup.BeetleRaceNote'),
            aside: game.user.isGM
                ? `<button type="button" class="parlor-setup-aside-button" data-br-studio><i class="fas fa-screwdriver-wrench"></i> ${escapeHtml(t('PARLOR.Lobby.Setup.BeetleRaceStudio'))}</button>`
                : '',
            body: `
                ${setupField({ label: t('PARLOR.Lobby.Setup.BeetleRaceCard'), control: `<select data-br-race>${options}</select>` })}
                <div class="parlor-br-setup-prefs">
                    <label class="parlor-setup-check">
                        <input type="checkbox" data-br-sound ${draft.beetleRaceSound !== false ? 'checked' : ''}>
                        <span>${escapeHtml(t('PARLOR.Lobby.Setup.BeetleRaceSound'))}</span>
                    </label>
                    <label class="parlor-setup-check">
                        <input type="checkbox" data-br-clean ${draft.beetleRaceCleanTable ? 'checked' : ''}>
                        <span>${escapeHtml(t('PARLOR.Lobby.Setup.BeetleRaceCleanTable'))}</span>
                    </label>
                    <p class="parlor-setup-hint">${escapeHtml(t('PARLOR.Lobby.Setup.BeetleRacePrefsHint'))}</p>
                </div>
                ${snapshot
                    ? `<ol class="parlor-br-setup-lanes">${lanes}</ol>
                       <div class="parlor-setup-chips">${facts.map(fact => `<span>${escapeHtml(fact)}</span>`).join('')}</div>`
                    : `<div class="parlor-setup-warn">${escapeHtml(t('PARLOR.Lobby.Errors.BeetleRaceInvalid'))}</div>`}
            `
        });
    }

    _renderTexasSetup(draft) {
        return setupSection({
            title: t('PARLOR.Lobby.Setup.TexasHoldemTitle'),
            note: t('PARLOR.Lobby.Setup.TexasHoldemNote'),
            body: `
                <div class="parlor-setup-fields is-3">
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.TexasHoldemSmallBlind'),
                        control: `<input type="number" min="1" step="1" value="${draft.texasSmallBlind}" data-texas-small-blind>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.TexasHoldemBigBlind'),
                        control: `<input type="number" min="1" step="1" value="${draft.texasBigBlind}" data-texas-big-blind>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.TexasHoldemBuyIn'),
                        control: `<input type="number" min="1" step="1" value="${draft.texasBuyIn}" data-texas-buy-in>`,
                        hint: t('PARLOR.Lobby.Setup.TexasHoldemBuyInHint', { amount: draft.texasBigBlind * 10 })
                    })}
                </div>
            `
        });
    }

    _renderSetupBetLimits(draft) {
        const summary = draft.betLimitMax > 0
            ? t('PARLOR.Lobby.Setup.BetLimitsRange', { min: draft.betLimitMin, max: draft.betLimitMax })
            : t('PARLOR.Lobby.Setup.BetLimitsNoMax', { min: draft.betLimitMin });
        return setupSection({
            title: t('PARLOR.Lobby.Setup.BetLimitsTitle'),
            note: t('PARLOR.Lobby.Setup.BetLimitsNote'),
            body: `
                <div class="parlor-setup-fields is-2">
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.BetLimitMin'),
                        control: `<input type="number" min="1" step="1" value="${draft.betLimitMin}" data-bet-limit-min>`
                    })}
                    ${setupField({
                        label: t('PARLOR.Lobby.Setup.BetLimitMaxNoLimit'),
                        control: `<input type="number" min="0" step="1" value="${draft.betLimitMax}" data-bet-limit-max>`
                    })}
                </div>
                <div class="parlor-setup-summary">${escapeHtml(summary)}</div>
            `
        });
    }

    _renderSetupSettlement(draft) {
        const choice = (mode, labelKey, hintKey) => `
            <label class="parlor-setup-choice">
                <input type="radio" name="parlor-settlement-mode" value="${mode}" data-settlement-mode ${draft.settlementMode === mode ? 'checked' : ''}>
                <span><b>${escapeHtml(t(labelKey))}</b><small>${escapeHtml(t(hintKey))}</small></span>
            </label>
        `;
        return setupSection({
            title: t('PARLOR.Lobby.Setup.SettlementTitle'),
            note: t('PARLOR.Lobby.Setup.SettlementNote'),
            body: `
                <div class="parlor-setup-choices">
                    ${choice(SettlementManager.MODES.CHIPS, 'PARLOR.Lobby.Setup.SettlementChips', 'PARLOR.Lobby.Setup.SettlementChipsHint')}
                    ${choice(SettlementManager.MODES.DND5E_GOLD, 'PARLOR.Lobby.Setup.SettlementGold', 'PARLOR.Lobby.Setup.SettlementGoldHint')}
                </div>
            `
        });
    }

    _renderSetupFooter(gameConfig, draft) {
        const isSlot = gameConfig.id === 'slotmachine';
        const participants = this._composeSetupParticipants(draft, gameConfig);
        const count = isSlot ? this._composeStartParticipants(gameConfig, draft).length : participants.length;
        const maxCount = this._getMaxParticipantCount(gameConfig);
        const autoFillBots = !this._getManualParticipants(draft, gameConfig).length && this._shouldAutoFillBots(gameConfig);
        const extra = this._isCrazyEightsSelfTest(draft, gameConfig)
            ? t('PARLOR.Lobby.Setup.CrazyEightsSelfTest')
            : (autoFillBots ? t('PARLOR.Lobby.Setup.AutoFillBots') : '');
        return `
            <div class="parlor-setup-footer">
                <label class="parlor-setup-check">
                    <input type="checkbox" data-public-toggle ${draft.isPublic ? 'checked' : ''}>
                    <span>${escapeHtml(t('PARLOR.Lobby.Setup.PublicToggle'))}</span>
                </label>
                <div class="parlor-setup-count">
                    <b>${escapeHtml(t('PARLOR.Lobby.Setup.ParticipantCount', { count }))}</b>
                    ${participants.length > maxCount ? `<span class="is-warn">${escapeHtml(t('PARLOR.Lobby.Setup.OverLimit', { maxCount }))}</span>` : ''}
                    ${extra ? `<span>${escapeHtml(extra)}</span>` : ''}
                    ${isSlot ? `<span>${escapeHtml(t('PARLOR.Lobby.Setup.SlotCountNote'))}</span>` : ''}
                </div>
            </div>
        `;
    }

    // ───────── 开桌对话：事件 ─────────

    _bindGameSetup(root, gameConfig, draft, renderDraft) {
        const onChange = (selector, handler, { all = false } = {}) => {
            const nodes = all ? root.querySelectorAll(selector) : [root.querySelector(selector)].filter(Boolean);
            nodes.forEach(node => node.addEventListener('change', handler));
        };

        onChange('[data-player-index]', (event) => {
            const index = Number(event.currentTarget.dataset.playerIndex);
            draft.playerEntries[index].enabled = !!event.currentTarget.checked;
            renderDraft();
        }, { all: true });

        onChange('[data-include-gm]', (event) => {
            draft.includeGMPlayer = !!event.currentTarget.checked;
            renderDraft();
        });

        onChange('[data-public-toggle]', (event) => {
            draft.isPublic = !!event.currentTarget.checked;
        });

        onChange('[data-settlement-mode]', (event) => {
            if (!event.currentTarget.checked) return;
            draft.settlementMode = SettlementManager.normalizeMode(event.currentTarget.value);
            renderDraft();
        }, { all: true });

        onChange('[data-slot-operator]', (event) => {
            draft.slotOperatorId = event.currentTarget.value || '';
        });

        onChange('[data-slot-spin-cost]', (event) => {
            const value = Math.max(1, Math.floor(Number(event.currentTarget.value || 0)) || 5);
            draft.slotSpinCost = value;
            event.currentTarget.value = String(value);
        });

        onChange('[data-bone21-ante]', (event) => {
            const value = Math.max(1, Math.floor(Number(event.currentTarget.value || 0)) || 10);
            draft.bone21Ante = value;
            event.currentTarget.value = String(value);
        });

        onChange('[data-br-race]', (event) => {
            draft.beetleRaceId = event.currentTarget.value || '';
            renderDraft();
        });

        onChange('[data-br-sound]', (event) => {
            draft.beetleRaceSound = !!event.currentTarget.checked;
        });
        onChange('[data-br-clean]', (event) => {
            draft.beetleRaceCleanTable = !!event.currentTarget.checked;
        });

        // 工坊里存完东西回来刷一下；对话已经关了就算了
        root.querySelector('[data-br-studio]')?.addEventListener('click', () => {
            BeetleRaceStudioApp.open({ tab: 'race', onChanged: () => { if (root.isConnected) renderDraft(); } });
        });

        onChange('[data-c8-ante]', (event) => {
            draft.crazyEightsAnte = sanitizeCrazyEightsOptions({ ante: event.currentTarget.value }).ante;
            event.currentTarget.value = String(draft.crazyEightsAnte);
        });

        onChange('[data-c8-penalty]', (event) => {
            draft.crazyEightsPenaltyPerPoint = sanitizeCrazyEightsOptions({ penaltyPerPoint: event.currentTarget.value }).penaltyPerPoint;
            event.currentTarget.value = String(draft.crazyEightsPenaltyPerPoint);
        });

        onChange('[data-c8-draw-rule]', (event) => {
            draft.crazyEightsDrawRule = sanitizeCrazyEightsOptions({ drawRule: event.currentTarget.value }).drawRule;
        });

        onChange('[data-c8-action-cards]', (event) => {
            draft.crazyEightsActionCards = sanitizeCrazyEightsOptions({ actionCards: event.currentTarget.value }).actionCards;
        });

        const setBetLimit = (key) => (event) => {
            draft[key] = Number(event.currentTarget.value || 0);
            const betLimits = normalizeBetLimits({ min: draft.betLimitMin, max: draft.betLimitMax });
            draft.betLimitMin = betLimits.min;
            draft.betLimitMax = betLimits.max;
            renderDraft();
        };
        onChange('[data-bet-limit-min]', setBetLimit('betLimitMin'));
        onChange('[data-bet-limit-max]', setBetLimit('betLimitMax'));

        // 德扑四个数互相牵制（大盲不小于小盲、买入不少于十个大盲），改哪个都整体过一遍
        const setTexas = (key) => (event) => {
            draft[key] = Number(event.currentTarget.value || 0);
            draft.texasSmallBlind = Math.max(1, Math.floor(Number(draft.texasSmallBlind || 0)) || 5);
            draft.texasBigBlind = Math.max(draft.texasSmallBlind, Math.floor(Number(draft.texasBigBlind || 0)) || 10);
            draft.texasBuyIn = Math.max(draft.texasBigBlind * 10, Math.floor(Number(draft.texasBuyIn || 0)) || 200);
            draft.texasGmBuyIn = Math.max(draft.texasBigBlind * 10, Math.floor(Number(draft.texasGmBuyIn || 0)) || draft.texasBuyIn);
            renderDraft();
        };
        onChange('[data-texas-small-blind]', setTexas('texasSmallBlind'));
        onChange('[data-texas-big-blind]', setTexas('texasBigBlind'));
        onChange('[data-texas-buy-in]', setTexas('texasBuyIn'));
        onChange('[data-texas-gm-buy-in]', setTexas('texasGmBuyIn'));

        onChange('[data-dealer-select]', (event) => {
            draft.dealerId = event.currentTarget.value || '';
        });

        root.querySelectorAll('[data-remove-npc]').forEach(button => {
            button.addEventListener('click', () => {
                draft.npcParticipants = draft.npcParticipants.filter(entry => entry.id !== button.dataset.removeNpc);
                renderDraft();
            });
        });

        onChange('[data-npc-mode]', (event) => {
            const participantId = event.currentTarget.dataset.npcMode;
            const nextMode = this._normalizeBotMode(event.currentTarget.value);
            draft.npcParticipants = draft.npcParticipants.map(entry => (entry.id === participantId ? { ...entry, botMode: nextMode } : entry));
            renderDraft();
        }, { all: true });

        onChange('[data-card-luck]', (event) => {
            this._setCardLuck(draft, event.currentTarget.dataset.cardLuck || '', event.currentTarget.value);
            renderDraft();
        }, { all: true });

        onChange('[data-custom-hand]', (event) => {
            const participantId = event.currentTarget.dataset.customHand || '';
            const transfer = this._setCustomHand(gameConfig, draft, participantId, event.currentTarget.value || 'none');
            if (transfer.transferredFromParticipantId) {
                const from = this._getDraftParticipantLabel(draft, transfer.transferredFromParticipantId);
                const to = this._getDraftParticipantLabel(draft, participantId);
                ui.notifications.info(t('PARLOR.Lobby.Setup.CardLuck.Transferred', { from, to }));
            }
            renderDraft();
        }, { all: true });

        this._bindNpcDropzone(root.querySelector('[data-npc-dropzone]'), gameConfig, draft, renderDraft);
    }

    _bindNpcDropzone(dropzone, gameConfig, draft, renderDraft) {
        if (!dropzone) return;
        dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropzone.classList.add('is-over');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
        dropzone.addEventListener('drop', async (event) => {
            event.preventDefault();
            dropzone.classList.remove('is-over');

            try {
                const data = TextEditor.getDragEventData(event);
                const actor = Actor.implementation?.fromDropData
                    ? await Actor.implementation.fromDropData(data)
                    : await Actor.fromDropData(data);
                if (!actor) return;

                const participantsNow = this._composeSetupParticipants(draft, gameConfig);
                if (participantsNow.some(entry => entry.actorId === actor.id)) {
                    ui.notifications.warn(t('PARLOR.Lobby.Errors.DuplicateActor'));
                    return;
                }

                const maxCount = this._getMaxParticipantCount(gameConfig);
                if (participantsNow.length >= maxCount) {
                    ui.notifications.warn(t('PARLOR.Lobby.Errors.MaxParticipants', { maxCount }));
                    return;
                }

                draft.npcParticipants.push(createNpcBotParticipant(actor, { botMode: 'random' }));
                renderDraft();
            } catch (err) {
                console.warn(`${MODULE_ID} | Failed to add NPC participant`, err);
                ui.notifications.warn(t('PARLOR.Lobby.Errors.InvalidDroppedActor'));
            }
        });
    }

    // 大厅弹出来的对话框统一挂 parlor 皮：底色、输入框配色、主按钮金色（样式见 parlor.css 的 .parlor-dialog）。
    // 测试替身的 element 没有 classList，别让它炸
    _decorateParlorDialog(dialog) {
        (dialog?.element ?? dialog)?.classList?.add('parlor-dialog');
    }

    // 筹码 / 金币对账用的小表：第一列名字，后面几列右对齐的数
    _renderLedger(headers, rows, emptyText) {
        const head = headers.map(({ label, numeric }) => `<th class="${numeric ? 'is-num' : ''}">${escapeHtml(label)}</th>`).join('');
        const body = rows.length
            ? rows.join('')
            : `<tr><td class="parlor-ledger-empty" colspan="${headers.length}">${escapeHtml(emptyText)}</td></tr>`;
        return `<table class="parlor-ledger"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }

    _getDialogRoot(button, dialog) {
        return dialog?.querySelector ? dialog : button?.closest?.('.dialog') || dialog?.element || null;
    }

    _collectExchangeEntries(root, attribute) {
        if (!root) return [];
        return [...root.querySelectorAll(`[${attribute}]`)]
            .map(input => ({
                participantId: input.getAttribute(attribute) || '',
                amount: Math.floor(Number(input.value || 0)) || 0
            }))
            .filter(entry => entry.participantId && entry.amount > 0);
    }

    _hasExchangeEntries(result) {
        return ['grants', 'goldToChip', 'chipToGold'].some(key => Array.isArray(result?.[key]) && result[key].length);
    }

    _buildDndGoldAdminHtml(rows) {
        const bodyRows = rows.map(row => `
            <tr>
                <td>
                    <b>${escapeHtml(row.name)}</b>
                    <small class="${row.canExchange ? '' : 'is-warn'}">${escapeHtml(t(row.canExchange ? 'PARLOR.Lobby.GoldExchange.LinkedActor' : 'PARLOR.Lobby.GoldExchange.MissingActor'))}</small>
                </td>
                <td class="is-num">${escapeHtml(row.gold)}</td>
                <td class="is-num">${escapeHtml(row.chips)}</td>
                <td><input type="number" min="0" step="1" value="0" data-gold-to-chip="${escapeHtml(row.id)}" ${row.canExchange ? '' : 'disabled'}></td>
                <td><input type="number" min="0" step="1" value="0" data-chip-to-gold="${escapeHtml(row.id)}" ${row.canExchange ? '' : 'disabled'}></td>
            </tr>
        `);
        const ledger = this._renderLedger([
            { label: t('PARLOR.Lobby.GoldExchange.Character') },
            { label: t('PARLOR.Lobby.GoldExchange.Gold'), numeric: true },
            { label: t('PARLOR.Lobby.GoldExchange.Chips'), numeric: true },
            { label: t('PARLOR.Lobby.GoldExchange.GoldToChip') },
            { label: t('PARLOR.Lobby.GoldExchange.ChipToGold') }
        ], bodyRows, t('PARLOR.Lobby.GoldExchange.NoPlayers'));

        return `
            <div class="parlor-setup">
                <div class="parlor-setup-note">${escapeHtml(t('PARLOR.Lobby.GoldExchange.AdminHint'))}</div>
                ${ledger}
                <div class="parlor-setup-summary">${escapeHtml(t('PARLOR.Lobby.GoldExchange.RateNote'))}</div>
                ${setupSection({
                    title: t('PARLOR.Lobby.GoldExchange.PlayerMacroTitle'),
                    note: t('PARLOR.Lobby.GoldExchange.PlayerMacroHint'),
                    body: `
                        <div class="parlor-macro-row">
                            <code class="parlor-macro-code" data-player-exchange-macro>${escapeHtml(PLAYER_EXCHANGE_MACRO)}</code>
                            <button type="button" class="parlor-setup-aside-button" data-copy-player-exchange-macro>
                                <i class="fas fa-copy"></i> ${escapeHtml(t('PARLOR.Lobby.GoldExchange.PlayerMacroCopy'))}
                            </button>
                        </div>
                    `
                })}
            </div>
        `;
    }

    _buildPlayerExchangeHtml(row) {
        const choice = (value, labelKey, checked) => `
            <label class="parlor-setup-choice">
                <input type="radio" name="parlor-exchange-direction" value="${value}" ${checked ? 'checked' : ''}>
                <span><b>${escapeHtml(t(labelKey))}</b></span>
            </label>
        `;
        return `
            <div class="parlor-setup">
                <div class="parlor-setup-person">
                    <div class="parlor-setup-person-main">
                        <span class="parlor-setup-avatar is-empty"><i class="fas fa-coins"></i></span>
                        <span class="parlor-setup-person-text">
                            <b>${escapeHtml(row.name)}</b>
                            <small>${escapeHtml(t('PARLOR.Lobby.GoldExchange.CurrentBalance', { gold: row.gold, chips: row.chips }))}</small>
                        </span>
                    </div>
                </div>
                <div class="parlor-setup-choices">
                    ${choice('gold-to-chip', 'PARLOR.Lobby.GoldExchange.GoldToChipSelf', true)}
                    ${choice('chip-to-gold', 'PARLOR.Lobby.GoldExchange.ChipToGoldSelf', false)}
                </div>
                ${setupField({
                    label: t('PARLOR.Lobby.GoldExchange.Amount'),
                    control: '<input type="number" name="amount" min="1" step="1" value="1">'
                })}
                <div class="parlor-setup-summary">${escapeHtml(t('PARLOR.Lobby.GoldExchange.RateNote'))}</div>
            </div>
        `;
    }

    _bindPlayerMacroCopy(dialog) {
        const root = dialog?.element ?? dialog;
        const button = root?.querySelector?.('[data-copy-player-exchange-macro]');
        if (!button) return;

        button.addEventListener('click', async () => {
            const ok = await this._copyTextToClipboard(PLAYER_EXCHANGE_MACRO);
            if (ok) {
                ui.notifications.info(t('PARLOR.Lobby.GoldExchange.PlayerMacroCopied'));
            } else {
                ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.PlayerMacroCopyFailed'));
            }
        });
    }

    async _copyTextToClipboard(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | Clipboard API failed`, err);
        }

        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (err) {
            console.warn(`${MODULE_ID} | Clipboard fallback failed`, err);
        } finally {
            textarea.remove();
        }
        return copied;
    }

    async _openDndGoldAdminDialog() {
        if (!game.user.isGM) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.GMOnly'));
            return false;
        }
        if (!SettlementManager.canUseDnd5eGold()) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.NeedDnd5e'));
            return false;
        }

        const rows = SettlementManager.getDndGoldExchangeRows({ includeGM: false, includeInactive: false });
        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Lobby.GoldExchange.AdminTitle'), icon: 'fas fa-coins' },
            position: { width: 760 },
            content: this._buildDndGoldAdminHtml(rows),
            render: (_event, dialog) => {
                this._decorateParlorDialog(dialog);
                this._bindPlayerMacroCopy(dialog);
            },
            buttons: [{
                label: t('PARLOR.Lobby.GoldExchange.Apply'),
                action: 'apply',
                icon: 'fas fa-exchange-alt',
                callback: (event, button, dialog) => {
                    const root = this._getDialogRoot(button, dialog);
                    return {
                        goldToChip: this._collectExchangeEntries(root, 'data-gold-to-chip'),
                        chipToGold: this._collectExchangeEntries(root, 'data-chip-to-gold')
                    };
                }
            }, {
                label: t('PARLOR.Common.Cancel'),
                action: 'cancel'
            }],
            rejectClose: false
        });

        if (!result || result === 'cancel') return false;
        if (!this._hasExchangeEntries(result)) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.NoEffect'));
            return false;
        }

        const outcome = await SettlementManager.applyDndGoldExchange(result);
        this._notifyGoldExchangeOutcome(outcome);
        this.render();
        return outcome?.ok || false;
    }

    async _promptPlayerGoldExchange() {
        if (!game.user.isGM) return false;
        if (!SettlementManager.canUseDnd5eGold()) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.NeedDnd5e'));
            return false;
        }

        const targetUserIds = [...new Set(SettlementManager.getDndGoldExchangeRows({ includeGM: false, includeInactive: false })
            .filter(row => row.canExchange && row.userId)
            .map(row => row.userId))];
        if (!targetUserIds.length) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.NoPlayers'));
            return false;
        }

        await SocketManager.broadcast(SOCKET_EVENTS.OPEN_GOLD_CHIP_EXCHANGE, { targetUserIds });
        ui.notifications.info(t('PARLOR.Lobby.GoldExchange.PromptedPlayers', { count: targetUserIds.length }));
        return true;
    }

    async _openPlayerGoldExchangeDialog() {
        if (!SettlementManager.canUseDnd5eGold()) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.NeedDnd5e'));
            return false;
        }

        const row = SettlementManager.getDndGoldExchangeRows({ includeGM: true, user: game.user })[0] || null;
        if (!row?.canExchange) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.MissingSelfActor'));
            return false;
        }

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Lobby.GoldExchange.PlayerTitle'), icon: 'fas fa-exchange-alt' },
            position: { width: 440 },
            content: this._buildPlayerExchangeHtml(row),
            render: (_event, dialog) => this._decorateParlorDialog(dialog),
            buttons: [{
                label: t('PARLOR.Lobby.GoldExchange.Exchange'),
                action: 'exchange',
                icon: 'fas fa-coins',
                callback: (event, button, dialog) => {
                    const root = this._getDialogRoot(button, dialog);
                    return {
                        direction: root?.querySelector('input[name="parlor-exchange-direction"]:checked')?.value || 'gold-to-chip',
                        amount: Math.floor(Number(root?.querySelector('input[name="amount"]')?.value || 0)) || 0
                    };
                }
            }, {
                label: t('PARLOR.Common.Cancel'),
                action: 'cancel'
            }],
            rejectClose: false
        });

        if (!result || result === 'cancel') return false;
        if (!result.amount) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.NoEffect'));
            return false;
        }

        const payload = { userId: game.user.id, direction: result.direction, amount: result.amount };
        let outcome = null;
        try {
            outcome = game.user.isGM
                ? await SettlementManager.applySelfServiceDndGoldExchange(payload)
                : await SocketManager.requestGM(SOCKET_EVENTS.APPLY_GOLD_CHIP_EXCHANGE, payload);
        } catch (err) {
            console.warn(`${MODULE_ID} | Failed to request gold/chip exchange`, err);
        }
        if (!outcome) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.GMUnavailable'));
            return false;
        }

        this._notifyGoldExchangeOutcome(outcome);
        return outcome?.ok || false;
    }

    _notifyGoldExchangeOutcome(outcome) {
        if (!outcome) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.Unknown'));
            return;
        }
        if (outcome.reason === 'missing-actor') {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.MissingSelfActor'));
            return;
        }
        if (outcome.reason === 'not-dnd5e') {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.Errors.NeedDnd5e'));
            return;
        }
        if (outcome.shortGoldRows?.length || outcome.shortChipRows?.length) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.PartialShort'));
        }
        if (outcome.failedActors?.length) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.PartialFailed'));
        }
        if (!outcome.actorUpdates?.length) {
            ui.notifications.warn(t('PARLOR.Lobby.GoldExchange.NoEffect'));
            return;
        }

        ui.notifications.info(t('PARLOR.Lobby.GoldExchange.Updated', {
            buy: outcome.totalGoldToChip || 0,
            sell: outcome.totalChipToGold || 0
        }));
    }
    async _openChipAllocationDialog() {
        const rows = ChipManager.getChipRows({ includeGM: true, includeInactiveTracked: false });
        const roleName = (row) => `${row.name}${row.isGM ? `（${t('PARLOR.Lobby.Bank.GMTag')}）` : ''}`;
        const userOptions = rows.map(row =>
            `<option value="${escapeHtml(row.id)}">${escapeHtml(roleName(row))} · ${escapeHtml(row.balanceLabel)}</option>`
        ).join('');
        const ledger = this._renderLedger([
            { label: t('PARLOR.Lobby.ChipSettlement.Role') },
            { label: t('PARLOR.Lobby.ChipAllocation.CurrentChips'), numeric: true }
        ], rows.map(row => `<tr><td>${escapeHtml(roleName(row))}</td><td class="is-num">${escapeHtml(row.balanceLabel)}</td></tr>`), t('PARLOR.Lobby.ChipAllocation.EmptyRoles'));

        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Lobby.ChipAllocation.Title'), icon: 'fas fa-coins' },
            position: { width: 560 },
            render: (_event, dialog) => this._decorateParlorDialog(dialog),
            content: `
                <div class="parlor-setup">
                    <div class="parlor-setup-fields is-alloc">
                        ${setupField({
                            label: t('PARLOR.Lobby.ChipAllocation.TargetRole'),
                            control: `<select name="targetId"><option value="__all__">${escapeHtml(t('PARLOR.Lobby.ChipAllocation.AllOnlineRoles'))}</option>${userOptions}</select>`
                        })}
                        ${setupField({
                            label: t('PARLOR.Lobby.ChipAllocation.Mode'),
                            control: `<select name="mode">
                                <option value="grant">${escapeHtml(t('PARLOR.Lobby.ChipAllocation.Modes.Grant'))}</option>
                                <option value="deduct">${escapeHtml(t('PARLOR.Lobby.ChipAllocation.Modes.Deduct'))}</option>
                                <option value="set">${escapeHtml(t('PARLOR.Lobby.ChipAllocation.Modes.Set'))}</option>
                            </select>`
                        })}
                        ${setupField({
                            label: t('PARLOR.Lobby.ChipAllocation.Amount'),
                            control: '<input type="number" name="amount" value="100" min="0">'
                        })}
                    </div>
                    ${ledger}
                    <div class="parlor-setup-note">${escapeHtml(t('PARLOR.Lobby.ChipAllocation.NpcNote'))}</div>
                </div>
            `,
            buttons: [{
                label: t('PARLOR.Lobby.ChipAllocation.Apply'),
                action: 'apply',
                icon: 'fas fa-coins',
                callback: (event, button, dialog) => {
                    const form = dialog.querySelector ? dialog : button.closest('.dialog');
                    return {
                        targetId: form.querySelector('select[name="targetId"]')?.value || '',
                        mode: form.querySelector('select[name="mode"]')?.value || 'grant',
                        amount: parseInt(form.querySelector('input[name="amount"]')?.value) || 0
                    };
                }
            }, {
                label: t('PARLOR.Common.Cancel'),
                action: 'cancel'
            }],
            rejectClose: false
        });

        if (!result || result === 'cancel') return;

        const targetIds = result.targetId === '__all__'
            ? rows.map(row => row.id)
            : [result.targetId];
        const ok = await ChipManager.applyAllocation(targetIds, result.mode, result.amount);
        if (!ok) {
            ui.notifications.warn(t('PARLOR.Lobby.Errors.AllocationNoEffect'));
            return;
        }

        ui.notifications.info(t('PARLOR.Lobby.ChipAllocation.Updated'));
        this.render();
    }

    async _openChipSettlementDialog() {
        const rows = ChipManager.getChipRows({ includeGM: true, includeInactiveTracked: true })
            .filter(row => Number.isFinite(row.balance));
        const ledger = this._renderLedger([
            { label: t('PARLOR.Lobby.ChipSettlement.Role') },
            { label: t('PARLOR.Lobby.ChipSettlement.CurrentChips'), numeric: true }
        ], rows.map(row => `<tr><td>${escapeHtml(row.name)}${row.isGM ? escapeHtml(`（${t('PARLOR.Lobby.Bank.GMTag')}）`) : ''}</td><td class="is-num">${escapeHtml(row.balance)}</td></tr>`), t('PARLOR.Lobby.ChipSettlement.Empty'));

        const confirmed = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Lobby.ChipSettlement.Title'), icon: 'fas fa-file-invoice-dollar' },
            position: { width: 480 },
            render: (_event, dialog) => this._decorateParlorDialog(dialog),
            content: `
                <div class="parlor-setup">
                    <div class="parlor-setup-note">${escapeHtml(t('PARLOR.Lobby.ChipSettlement.ConfirmText'))}</div>
                    ${ledger}
                </div>
            `,
            buttons: [{
                label: t('PARLOR.Lobby.ChipSettlement.Submit'),
                action: 'settle',
                icon: 'fas fa-file-invoice-dollar',
                callback: () => true
            }, {
                label: t('PARLOR.Common.Cancel'),
                action: 'cancel'
            }],
            rejectClose: false
        });

        if (!confirmed || confirmed === 'cancel') return;

        const settledRows = await ChipManager.settleAllPlayerChips({ includeGM: true });
        if (!settledRows.length) {
            ui.notifications.info(t('PARLOR.Lobby.ChipSettlement.NothingToSettle'));
            this.render();
            return;
        }

        ui.notifications.info(t('PARLOR.Lobby.ChipSettlement.Done'));
        this.render();
    }
}
