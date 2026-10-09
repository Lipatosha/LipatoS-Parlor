import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class ApplicationV2Stub {
    async _prepareContext() { return {}; }
    _onRender() {}
    close() {}
}

const gmUser = {
    id: 'gm-user',
    name: 'Host GM',
    avatar: 'gm.png',
    active: true,
    isGM: true,
    character: null
};
const playerActor = {
    id: 'hero-a',
    name: 'Alice Hero',
    img: 'hero.png'
};
const playerUser = {
    id: 'player-a',
    name: 'Alice',
    avatar: 'alice.png',
    active: true,
    isGM: false,
    character: playerActor
};
const users = [gmUser, playerUser];
const actors = [playerActor];

globalThis.foundry = {
    applications: {
        api: {
            ApplicationV2: ApplicationV2Stub,
            HandlebarsApplicationMixin: Base => class extends Base {},
            DialogV2: { wait: async () => null }
        }
    },
    utils: {
        deepClone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
        escapeHTML: value => String(value ?? ''),
        mergeObject: (target, source) => ({ ...(target || {}), ...(source || {}) }),
        randomID: () => 'texas-gm-seat-session'
    }
};

globalThis.game = {
    user: gmUser,
    users: {
        filter: callback => users.filter(callback),
        find: callback => users.find(callback),
        get: id => users.find(user => user.id === id) || null
    },
    actors: {
        get: id => actors.find(actor => actor.id === id) || null
    },
    system: { id: 'dnd5e' },
    i18n: {
        localize: key => key,
        format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
    },
    settings: {
        get: (_moduleId, key) => key === 'defaultChips' ? 1000 : {},
        set: async () => {}
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
const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { TexasHoldemGame } = await import('../scripts/games/texasholdem/TexasHoldemGame.js');

const texasConfig = {
    id: 'texasholdem',
    dealerMode: 'none'
};

function makeTexasGame() {
    return new TexasHoldemGame({
        sessionId: 'texas-gm-seat-session',
        participants: [
            {
                id: 'actor:hero-a',
                type: 'user',
                actorId: 'hero-a',
                userId: 'player-a',
                controllerId: 'player-a',
                name: 'Alice Hero'
            },
            {
                id: 'user:gm-user',
                type: 'user',
                actorId: null,
                userId: 'gm-user',
                controllerId: 'gm-user',
                name: 'Host GM'
            }
        ],
        isPublic: true,
        gameOptions: {
            settlementMode: SettlementManager.MODES.DND5E_GOLD,
            smallBlind: 5,
            bigBlind: 10,
            buyIn: 200,
            gmParticipantId: 'user:gm-user',
            gmBuyIn: 350
        }
    });
}

function installSettlementSpies() {
    const originalCanAfford = SettlementManager.canAfford;
    const originalApplyDeltas = SettlementManager.applyDeltas;
    const canAffordCalls = [];
    const deltaCalls = [];

    SettlementManager.canAfford = (participantId, amount, context) => {
        canAffordCalls.push({ participantId, amount, context });
        return true;
    };
    SettlementManager.applyDeltas = async (entries, context) => {
        deltaCalls.push({
            entries: entries.map(entry => ({ ...entry })),
            context
        });
        return true;
    };

    return {
        canAffordCalls,
        deltaCalls,
        restore() {
            SettlementManager.canAfford = originalCanAfford;
            SettlementManager.applyDeltas = originalApplyDeltas;
        }
    };
}

describe('Texas Holdem GM table seat', () => {
    it('includes an actorless GM in gold mode and composes a table-only buy-in', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        draft.includeGMPlayer = true;
        draft.settlementMode = SettlementManager.MODES.DND5E_GOLD;
        draft.texasGmBuyIn = 350;

        const participants = lobby._getManualParticipants(draft, texasConfig);
        const options = lobby._composeGameOptions(texasConfig, draft);

        assert.deepEqual(participants.map(entry => entry.id), ['actor:hero-a', 'user:gm-user']);
        assert.equal(options.gmParticipantId, 'user:gm-user');
        assert.equal(options.gmBuyIn, 350);
        assert.deepEqual(
            lobby._getTexasBuyInPayers(participants, options).map(entry => entry.id),
            ['actor:hero-a']
        );
    });

    it('shows the GM buy-in field only after the GM seat is selected', () => {
        const lobby = new GameLobby();
        const draft = lobby._createGameSetupDraft();
        const root = {
            innerHTML: '',
            scrollTop: 0,
            classList: { add() {} },
            querySelectorAll: () => [],
            querySelector: () => null
        };
        const dialog = {
            element: {
                querySelector: selector => selector === '#parlor-start-setup' ? root : null
            }
        };

        lobby._mountGameSetupDialog(dialog, texasConfig, draft);
        assert.doesNotMatch(root.innerHTML, /data-texas-gm-buy-in/u);

        draft.includeGMPlayer = true;
        lobby._mountGameSetupDialog(dialog, texasConfig, draft);
        assert.match(root.innerHTML, /data-texas-gm-buy-in/u);
        assert.match(root.innerHTML, /PARLOR\.Lobby\.Setup\.TexasHoldemGMBuyIn/u);
    });

    it('seeds the GM stack without checking or deducting a persistent balance', async () => {
        const settlement = installSettlementSpies();
        const table = makeTexasGame();
        table._beginHand = async () => {};

        try {
            const result = await table.start();

            assert.deepEqual(result, { ok: true });
            assert.deepEqual(
                settlement.canAffordCalls.map(call => call.participantId),
                ['actor:hero-a']
            );
            assert.deepEqual(settlement.deltaCalls[0].entries, [
                { userId: 'actor:hero-a', delta: -200 }
            ]);
            assert.deepEqual(table.tableStacks, {
                'actor:hero-a': 200,
                'user:gm-user': 350
            });
        } finally {
            settlement.restore();
        }
    });

    it('returns ordinary stacks while dropping the GM session stack at table close', async () => {
        const settlement = installSettlementSpies();
        const table = makeTexasGame();
        table._phase = 'RESOLVING';
        table.tableStacks = {
            'actor:hero-a': 260,
            'user:gm-user': 140
        };
        table.playerStates = {
            'actor:hero-a': { stack: 260 },
            'user:gm-user': { stack: 140 }
        };
        table._broadcastState = async () => {};

        try {
            const returned = await table._returnTableStacks();

            assert.equal(returned, true);
            assert.deepEqual(settlement.deltaCalls[0].entries, [
                { userId: 'actor:hero-a', delta: 260 }
            ]);
            assert.deepEqual(table.tableStacks, {
                'actor:hero-a': 0,
                'user:gm-user': 0
            });
            assert.equal(table.tableSettled, true);
        } finally {
            settlement.restore();
        }
    });

    it('keeps the GM seat funding fields in synchronized table state', () => {
        const hostTable = makeTexasGame();
        const clientTable = new TexasHoldemGame({
            sessionId: 'texas-gm-seat-client',
            participants: hostTable.participants,
            gameOptions: {
                settlementMode: SettlementManager.MODES.DND5E_GOLD,
                smallBlind: 5,
                bigBlind: 10,
                buyIn: 200
            }
        });

        clientTable.setState(hostTable.getState());

        assert.equal(clientTable.gmParticipantId, 'user:gm-user');
        assert.equal(clientTable.gmBuyIn, 350);
    });
});
