import assert from 'node:assert/strict';
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
        randomID: () => 'ce-lobby-session',
        getProperty: () => null
    }
};

const gmUser = { id: 'gm1', name: 'GM', active: true, isGM: true, character: null };
globalThis.game = {
    user: gmUser,
    users: { filter: () => [], find: () => gmUser, get: () => null },
    actors: { get: () => null },
    system: { id: 'generic' },
    settings: { get: () => ({}), set: async () => {} },
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
const { getGameConfig } = await import('../scripts/core/GameRegistry.js');

const crazyEights = getGameConfig('crazyeights');

describe('疯狂八大厅接入', () => {
    it('注册表 lobby 元数据优先，老游戏照旧走写死分支', () => {
        const lobby = new GameLobby();
        assert.equal(lobby._getMaxParticipantCount(crazyEights), 8);
        assert.equal(lobby._getMinParticipantCount(crazyEights), 2);
        assert.equal(lobby._canIncludeGMPlayer(crazyEights), true);
        assert.equal(lobby._canAddNpcParticipants(crazyEights), true);
        assert.equal(lobby._shouldAutoFillBots(crazyEights), true);
        assert.equal(lobby._getParticipantsNote(crazyEights), 'PARLOR.Lobby.Setup.CrazyEightsParticipantsNote');

        assert.equal(lobby._getMaxParticipantCount({ id: 'texasholdem', dealerMode: 'gm' }), 6);
        assert.equal(lobby._getMaxParticipantCount({ id: 'blackjack', dealerMode: 'gm' }), 10);
        assert.equal(lobby._getMinParticipantCount({ id: 'blackjack', dealerMode: 'gm' }), 1);
        assert.equal(lobby._canIncludeGMPlayer({ id: 'blackjack', dealerMode: 'gm' }), false);
        assert.equal(lobby._canAddNpcParticipants({ id: 'slotmachine', dealerMode: 'gm' }), false);
        assert.equal(lobby._shouldAutoFillBots({ id: 'slotmachine', dealerMode: 'gm' }), false);
        assert.equal(lobby._getParticipantsNote({ id: 'bone21', dealerMode: 'gm' }), 'PARLOR.Lobby.Setup.Bone21ParticipantsNote');
    });

    it('谁都不勾直接开始 = DM 加 3 个机器人的自测局，DM 席位不动账', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        draft.gmParticipant = { id: 'user:gm1', type: 'user', actorId: null, userId: 'gm1', controllerId: 'gm1', name: 'GM' };
        lobby._syncGameSetupDraft(crazyEights, draft);

        assert.equal(lobby._isCrazyEightsSelfTest(draft, crazyEights), true);
        const seated = lobby._composeSetupParticipants(draft, crazyEights);
        assert.deepEqual(seated.map(entry => entry.id), ['user:gm1', 'bot_0', 'bot_1', 'bot_2']);
        assert.ok(seated.slice(1).every(entry => entry.type === 'bot'));
        assert.deepEqual(lobby._composeGameOptions(crazyEights, draft).exemptParticipantIds, ['user:gm1']);

        // 只勾了 DM 自己也算自测局；金币模式下 DM 没绑角色会被常规门拦住,这桌 GM 不进账,照样坐下
        draft.includeGMPlayer = true;
        draft.settlementMode = 'dnd5e-gold';
        assert.equal(lobby._isCrazyEightsSelfTest(draft, crazyEights), true);
        assert.equal(lobby._composeSetupParticipants(draft, crazyEights)[0].id, 'user:gm1');

        // 拖了 NPC 或勾了玩家就是正常局：不补机器人;GM 坐着就仍然豁免(想下多少下多少)
        draft.npcParticipants = [{ id: 'npc:goblin', type: 'npc', actorId: 'goblin', userId: null, controllerId: 'gm1', botMode: 'random', name: 'Goblin' }];
        assert.equal(lobby._isCrazyEightsSelfTest(draft, crazyEights), false);
        assert.deepEqual(lobby._composeSetupParticipants(draft, crazyEights).map(entry => entry.id), ['user:gm1', 'npc:goblin']);
        assert.deepEqual(lobby._composeGameOptions(crazyEights, draft).exemptParticipantIds, ['user:gm1']);

        // GM 不坐就没有豁免名单
        draft.includeGMPlayer = false;
        draft.settlementMode = 'chips';
        assert.deepEqual(lobby._composeSetupParticipants(draft, crazyEights).map(entry => entry.id), ['npc:goblin']);
        assert.deepEqual(lobby._composeGameOptions(crazyEights, draft).exemptParticipantIds, []);

        // 别的桌照旧:没人就补 5 个机器人,GM 不会被自动塞进去
        const other = lobby._createGameSetupDraft();
        other.gmParticipant = draft.gmParticipant;
        assert.equal(lobby._composeSetupParticipants(other, { id: 'bone21', dealerMode: 'gm' }).length, 5);
    });

    it('开桌参数：草稿有默认值，坏值被夹回，compose 出引擎认的四个字段', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        assert.equal(draft.crazyEightsAnte, 10);
        assert.equal(draft.crazyEightsPenaltyPerPoint, 0);
        assert.equal(draft.crazyEightsDrawRule, 'one');
        assert.equal(draft.crazyEightsActionCards, 'tavern');

        draft.crazyEightsAnte = '25';
        draft.crazyEightsPenaltyPerPoint = -4;
        draft.crazyEightsDrawRule = 'nope';
        draft.crazyEightsActionCards = 'classic';
        lobby._syncGameSetupDraft(crazyEights, draft);
        assert.equal(draft.crazyEightsAnte, 25);
        assert.equal(draft.crazyEightsPenaltyPerPoint, 0);
        assert.equal(draft.crazyEightsDrawRule, 'one');
        assert.equal(draft.crazyEightsActionCards, 'classic');

        const options = lobby._composeGameOptions(crazyEights, draft);
        assert.equal(options.ante, 25);
        assert.equal(options.penaltyPerPoint, 0);
        assert.equal(options.drawRule, 'one');
        assert.equal(options.actionCards, 'classic');
        assert.equal(options.settlementMode, 'chips');
        assert.equal('betLimits' in options, false);
    });
});
