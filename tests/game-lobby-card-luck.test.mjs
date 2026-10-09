import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

class ApplicationV2Stub {
    async _prepareContext() { return {}; }
    _onRender() {}
    close() {}
}

globalThis.foundry = {
    applications: {
        api: {
            ApplicationV2: ApplicationV2Stub,
            HandlebarsApplicationMixin: Base => class extends Base {},
            DialogV2: { wait: async () => null }
        }
    },
    utils: {
        deepClone: value => structuredClone(value),
        escapeHTML: value => String(value ?? ''),
        mergeObject: (target, source) => ({ ...(target || {}), ...(source || {}) }),
        randomID: () => 'lobby-card-luck-session',
        getProperty: () => null
    }
};

const gmUser = { id: 'gm1', name: 'GM', active: true, isGM: true, character: null };
globalThis.game = {
    user: gmUser,
    users: {
        filter: () => [],
        find: () => gmUser,
        get: () => null
    },
    actors: { get: () => null },
    system: { id: 'generic' },
    settings: {
        get: () => ({}),
        set: async () => {}
    },
    i18n: {
        localize: key => key,
        format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
    }
};

globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };
globalThis.Hooks = { callAll() {} };
globalThis.window = {
    setTimeout: callback => callback(),
    requestAnimationFrame: callback => callback()
};
globalThis.requestAnimationFrame = callback => callback();

const { GameLobby } = await import('../scripts/apps/GameLobby.js');

const blackjackConfig = { id: 'blackjack', dealerMode: 'none' };
const texasConfig = { id: 'texasholdem', dealerMode: 'none' };

function participants() {
    return [
        { id: 'p1', type: 'user', name: 'P1' },
        { id: 'p2', type: 'user', name: 'P2' },
        { id: 'p3', type: 'user', name: 'P3' }
    ];
}

describe('GameLobby card luck draft', () => {
    it('每名玩家独立保存手气，不会被其他玩家覆盖', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();

        lobby._setCardLuck(draft, 'p1', 'good');
        lobby._setCardLuck(draft, 'p2', 'bad');
        lobby._setCardLuck(draft, 'p3', 'normal');

        assert.equal(lobby._getCardLuck(draft, 'p1'), 'good');
        assert.equal(lobby._getCardLuck(draft, 'p2'), 'bad');
        assert.equal(lobby._getCardLuck(draft, 'p3'), 'normal');
    });

    it('新定制目标明确转移唯一名额，但不清除任何人的长期手气', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        lobby._setCardLuck(draft, 'p1', 'bad');
        lobby._setCardLuck(draft, 'p2', 'good');

        const first = lobby._setCustomHand(texasConfig, draft, 'p1', 'flush');
        const transferred = lobby._setCustomHand(texasConfig, draft, 'p2', 'full-house');

        assert.deepEqual(first, { transferredFromParticipantId: '' });
        assert.deepEqual(transferred, { transferredFromParticipantId: 'p1' });
        assert.deepEqual(draft.customHand, {
            participantId: 'p2',
            gameType: 'texasholdem',
            handType: 'full-house',
            pending: true
        });
        assert.equal(lobby._getCardLuck(draft, 'p1'), 'bad');
        assert.equal(lobby._getCardLuck(draft, 'p2'), 'good');
    });

    it('选择无只会清除当前目标，不误清另一个目标', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        lobby._setCustomHand(blackjackConfig, draft, 'p1', 'natural-blackjack');

        lobby._setCustomHand(blackjackConfig, draft, 'p2', 'none');
        assert.equal(draft.customHand.participantId, 'p1');

        lobby._setCustomHand(blackjackConfig, draft, 'p1', 'none');
        assert.equal(draft.customHand, null);
    });
});

describe('GameLobby card luck plan composition', () => {
    it('只提交新 cardLuckPlan 私密载荷', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        lobby._setCardLuck(draft, 'p1', 'good');
        lobby._setCardLuck(draft, 'p2', 'bad');
        lobby._setCustomHand(texasConfig, draft, 'p2', 'three-kind');

        const plan = lobby._composeCardLuckPlan(texasConfig, draft, participants());
        assert.deepEqual(plan.luckByParticipantId, { p1: 'good', p2: 'bad' });
        assert.equal(plan.customHand.participantId, 'p2');
        assert.equal(plan.customHand.handType, 'three-kind');

        const options = lobby._composeGMOnlyOptions(texasConfig, draft, participants());
        assert.deepEqual(options, { cardLuckPlan: plan });
        assert.equal(Object.hasOwn(options, 'forcedOutcomePlan'), false);
    });

    it('兼容旧草稿的 win / lose / hand 值但输出统一新模型', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        draft.forcedOutcomeEntries = {
            p1: { mode: 'win' },
            p2: { mode: 'lose' },
            p3: { mode: 'hand', handType: 'royal-flush' }
        };

        const plan = lobby._composeCardLuckPlan(texasConfig, draft, participants());

        assert.deepEqual(plan.luckByParticipantId, { p1: 'good', p2: 'bad' });
        assert.equal(plan.customHand.participantId, 'p3');
        assert.equal(plan.customHand.handType, 'royal-flush');
    });
});

describe('GameLobby card luck controls', () => {
    it('渲染独立手气和一次性定制控件，不再渲染旧强制结果字段', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        lobby._setCardLuck(draft, 'p1', 'good');
        lobby._setCustomHand(texasConfig, draft, 'p1', 'flush');

        const html = lobby._renderCardLuckControl(texasConfig, draft, 'p1');

        assert.match(html, /data-card-luck=/u);
        assert.match(html, /data-custom-hand=/u);
        assert.match(html, /PARLOR\.Lobby\.Setup\.CardLuck\.OneShot/u);
        assert.match(html, /PARLOR\.Lobby\.Setup\.CardLuck\.Help/u);
        assert.doesNotMatch(html, /data-forced-outcome/u);
    });
});

describe('GameLobby setup scrolling', () => {
    it('整个设置面板统一滚动，重绘后保留当前位置', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        draft.playerEntries = [{
            userId: 'p1',
            userName: 'P1',
            participant: { id: 'p1', type: 'user', name: 'P1', actorId: 'a1' },
            enabled: true
        }];
        draft.npcParticipants = [{
            id: 'npc1',
            type: 'npc',
            name: 'NPC 1',
            actorId: 'a2',
            avatar: '',
            botMode: 'random'
        }];

        let playerChangeListener = null;
        let npcModeChangeListener = null;
        let renderedHtml = '';
        const classes = new Set();
        const root = {
            scrollTop: 0,
            classList: {
                add(...names) {
                    names.forEach(name => classes.add(name));
                }
            },
            querySelector: () => null,
            querySelectorAll(selector) {
                if (selector === '[data-player-index]') {
                    return [{
                        checked: true,
                        dataset: { playerIndex: '0' },
                        addEventListener(type, listener) {
                            if (type === 'change') playerChangeListener = listener;
                        }
                    }];
                }
                if (selector === '[data-npc-mode]') {
                    return [{
                        dataset: { npcMode: 'npc1' },
                        value: 'win',
                        addEventListener(type, listener) {
                            if (type === 'change') npcModeChangeListener = listener;
                        }
                    }];
                }
                return [];
            }
        };
        Object.defineProperty(root, 'innerHTML', {
            get: () => renderedHtml,
            set: value => {
                renderedHtml = value;
                root.scrollTop = 0;
            }
        });

        lobby._mountGameSetupDialog({
            element: { querySelector: selector => selector === '#parlor-start-setup' ? root : null }
        }, { id: 'generic', dealerMode: 'none' }, draft);

        assert.equal(classes.has('parlor-game-setup-body'), true);
        assert.doesNotMatch(renderedHtml, /parlor-game-setup-scroll-list/u);
        assert.equal(typeof playerChangeListener, 'function');
        assert.equal(typeof npcModeChangeListener, 'function');

        root.scrollTop = 340;
        playerChangeListener({
            currentTarget: { checked: false, dataset: { playerIndex: '0' } }
        });
        assert.equal(root.scrollTop, 340);

        root.scrollTop = 420;
        npcModeChangeListener({
            currentTarget: { dataset: { npcMode: 'npc1' }, value: 'lose' }
        });
        assert.equal(root.scrollTop, 420);

        const css = readFileSync(new URL('../styles/parlor.css', import.meta.url), 'utf8');
        assert.match(css, /\.parlor-game-setup-body\s*\{[^}]*overflow-y:\s*auto;/su);
        assert.doesNotMatch(css, /\.parlor-game-setup-scroll-list/u);
    });
});
