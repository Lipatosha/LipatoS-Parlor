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
        randomID: () => 'npc-mixed-table-session',
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
const { BotManager } = await import('../scripts/core/BotManager.js');
const { ParlorManager } = await import('../scripts/core/ParlorManager.js');

const human = {
    id: 'actor:hero',
    type: 'user',
    actorId: 'hero',
    userId: 'player1',
    controllerId: 'player1',
    name: 'Hero'
};

const actorNpc = {
    id: 'bot:goblin',
    type: 'bot',
    actorId: 'goblin',
    userId: null,
    controllerId: null,
    botMode: 'random',
    name: 'Goblin'
};

function makeDraft() {
    return {
        playerEntries: [{ enabled: true, participant: human }],
        gmParticipant: null,
        includeGMPlayer: false,
        npcParticipants: [actorNpc],
        settlementMode: 'chips'
    };
}

function makeBlackjackState(status = 'playing') {
    return {
        gameType: 'blackjack',
        phase: 'PLAYER_TURNS',
        playerIds: [human.id, actorNpc.id],
        currentPlayerId: actorNpc.id,
        playerHands: {
            [actorNpc.id]: { status, handCards: [], tableCards: [] }
        },
        participants: [human, actorNpc]
    };
}

async function withoutBotDelay(task) {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = callback => {
        callback();
        return 0;
    };
    try {
        return await task();
    } finally {
        globalThis.setTimeout = originalSetTimeout;
    }
}

describe('GameLobby mixed NPC setup', () => {
    it('21 点和说谎骰保留真人与 Actor NPC 混合席位', () => {
        const lobby = new GameLobby();

        for (const gameConfig of [
            { id: 'blackjack', dealerMode: 'gm' },
            { id: 'liarsdice', dealerMode: 'gm' }
        ]) {
            const participants = lobby._getManualParticipants(makeDraft(), gameConfig);
            assert.deepEqual(participants.map(entry => entry.id), [human.id, actorNpc.id]);
        }
    });

    it('老虎机仍然拒绝 NPC 席位', () => {
        const lobby = new GameLobby();
        const participants = lobby._getManualParticipants(
            makeDraft(),
            { id: 'slotmachine', dealerMode: 'gm' }
        );

        assert.deepEqual(participants.map(entry => entry.id), [human.id]);
    });

    it('中英文说明不再把 21 点和说谎骰标成禁止 NPC', () => {
        const cn = JSON.parse(readFileSync(new URL('../languages/cn.json', import.meta.url), 'utf8'));
        const en = JSON.parse(readFileSync(new URL('../languages/en.json', import.meta.url), 'utf8'));

        assert.match(cn.PARLOR.Lobby.Setup.BlackjackParticipantsNote, /NPC/u);
        assert.match(cn.PARLOR.Lobby.Setup.LiarsDiceParticipantsNote, /NPC/u);
        assert.match(en.PARLOR.Lobby.Setup.BlackjackParticipantsNote, /NPC/u);
        assert.match(en.PARLOR.Lobby.Setup.LiarsDiceParticipantsNote, /NPC/u);
        assert.doesNotMatch(cn.PARLOR.Lobby.Setup.BlackjackParticipantsNote, /只允许玩家/u);
        assert.doesNotMatch(cn.PARLOR.Lobby.Setup.LiarsDiceParticipantsNote, /不能额外加入/u);
    });
});

describe('Actor NPC game automation', () => {
    it('21 点 NPC 等待 GM 发牌时不再被调度器反复唤醒', () => {
        assert.equal(ParlorManager._hasPendingBotWork(makeBlackjackState('awaiting_deal')), false);
        assert.equal(ParlorManager._hasPendingBotWork(makeBlackjackState('dealing')), false);
    });

    it('21 点 NPC 在可以决策时仍会继续行动', () => {
        assert.equal(ParlorManager._hasPendingBotWork(makeBlackjackState('playing')), true);
        assert.equal(ParlorManager._hasPendingBotWork(makeBlackjackState('awaiting_collect')), true);
    });

    it('21 点混合桌只为尚未下注的 NPC 自动下注', async () => {
        const actions = [];
        const state = {
            gameType: 'blackjack',
            phase: 'BETTING',
            playerIds: [human.id, actorNpc.id],
            participants: [human, actorNpc],
            bets: [{ userId: human.id, amount: 10 }]
        };
        const gameInstance = {
            gameType: 'blackjack',
            playerIds: new Set(state.playerIds),
            getState: () => state,
            handlePlayerAction: (...args) => actions.push(args)
        };

        await withoutBotDelay(() => BotManager.executeBotActions(gameInstance));

        assert.equal(actions.length, 1);
        assert.equal(actions[0][0], actorNpc.id);
        assert.equal(actions[0][1], 'placeBet');
        assert.ok(actions[0][2].amount > 0);
    });

    it('说谎骰混合桌轮到 NPC 时会形成合法叫价', async () => {
        const actions = [];
        const state = {
            gameType: 'liarsdice',
            phase: 'PLAYER_TURNS',
            playerIds: [human.id, actorNpc.id],
            participants: [human, actorNpc],
            currentPlayerId: actorNpc.id,
            diceCounts: { [human.id]: 5, [actorNpc.id]: 5 },
            lastClaim: null,
            onesCalled: false,
            revealed: false
        };
        const gameInstance = {
            gameType: 'liarsdice',
            getState: () => state,
            getPrivateDice: participantId => participantId === actorNpc.id ? [2, 2, 3, 4, 6] : [],
            handlePlayerAction: (...args) => actions.push(args)
        };

        await withoutBotDelay(() => BotManager.executeBotActions(gameInstance));

        assert.deepEqual(actions, [[actorNpc.id, 'makeClaim', { quantity: 2, face: 2 }]]);
    });
});
