import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

const actors = new Map();
globalThis.foundry = {
    utils: {
        randomID: () => 'zonk-money',
        deepClone: value => structuredClone(value),
        getProperty: (obj, path) => path.split('.').reduce((part, key) => part?.[key], obj)
    }
};
globalThis.game = {
    system: { id: 'dnd5e' },
    user: { id: 'gm', isGM: true, active: true },
    users: { get: () => null, find: () => null },
    actors: { get: id => actors.get(id) || null },
    settings: { settings: new Map(), get: () => null },
    i18n: {
        lang: 'ru',
        localize: key => ({
            'PARLOR.Currency.Gold': 'Золото',
            'PARLOR.Currency.Silver': 'Серебро',
            'PARLOR.Currency.Copper': 'Медь',
            'PARLOR.Currency.Chips': 'Фишки'
        }[key] || key)
    }
};
globalThis.ui = { notifications: { warn: () => {} } };

const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { ZonkGame } = await import('../scripts/games/zonk/ZonkGame.js');

function addActor(id, gp = 10, sp = 30, cp = 75) {
    const actor = {
        id,
        system: { currency: { gp, sp, cp } },
        updates: [],
        async update(patch) {
            this.updates.push(patch);
            for (const [path, value] of Object.entries(patch)) {
                const keys = path.split('.');
                let target = this;
                for (const key of keys.slice(0, -1)) target = target[key];
                target[keys[keys.length - 1]] = value;
            }
        }
    };
    actors.set(id, actor);
    return actor;
}

beforeEach(() => {
    actors.clear();
    SettlementManager._activeMode = SettlementManager.MODES.CHIPS;
});

describe('D&D coin denomination modes', () => {
    it('selects an independent currency balance and writes only that coin field', async () => {
        const a = addActor('a1');
        const participantId = 'actor:a1';
        const modes = [
            [SettlementManager.MODES.DND5E_COPPER, 'cp', 75],
            [SettlementManager.MODES.DND5E_SILVER, 'sp', 30],
            [SettlementManager.MODES.DND5E_GOLD, 'gp', 10]
        ];
        for (const [mode, coin, initial] of modes) {
            const context = { settlementMode: mode };
            assert.equal(SettlementManager.getBalance(participantId, context), initial);
            assert.equal(SettlementManager.canAfford(participantId, initial + 1, context), false);
            assert.equal(SettlementManager.canAfford(participantId, initial, context), true);
            assert.equal(await SettlementManager.applyDeltas([{ userId: participantId, delta: -2 }], context), true);
            assert.deepEqual(a.updates.at(-1), { [`system.currency.${coin}`]: initial - 2 });
            assert.equal(a.system.currency[coin], initial - 2);
        }
        assert.deepEqual(a.system.currency, { gp: 8, sp: 28, cp: 73 });
    });

    it('formats full Russian denominations without gp/sp/cp abbreviations', () => {
        assert.equal(SettlementManager.formatAmount(5, { settlementMode: 'dnd5e-gold' }), '5 Золото');
        assert.equal(SettlementManager.formatAmount(12, { settlementMode: 'dnd5e-silver' }), '12 Серебро');
        assert.equal(SettlementManager.formatAmount(40, { settlementMode: 'dnd5e-copper' }), '40 Медь');
    });

    it('does not offer D&D coin modes on a non-D&D system', () => {
        game.system.id = 'generic';
        assert.equal(SettlementManager.normalizeMode('dnd5e-copper'), 'chips');
        assert.equal(SettlementManager.normalizeMode('dnd5e-silver'), 'chips');
        game.system.id = 'dnd5e';
    });

    it('charges Zonk players and credits the winner with the selected denomination', async () => {
        const alice = addActor('a1', 15, 50, 90);
        const bob = addActor('b1', 15, 50, 90);
        const gameInstance = new ZonkGame({
            sessionId: 'money-test',
            playerIds: ['actor:a1', 'actor:b1'],
            participants: [
                { id: 'actor:a1', type: 'user', actorId: 'a1' },
                { id: 'actor:b1', type: 'user', actorId: 'b1' }
            ],
            gameOptions: { ante: 12, targetScore: 2000, settlementMode: 'dnd5e-silver' }
        });
        gameInstance._broadcastState = async () => {};
        assert.deepEqual(await gameInstance.start(), { ok: true });
        assert.equal(alice.system.currency.sp, 38);
        assert.equal(bob.system.currency.sp, 38);
        gameInstance.playerStates['actor:a1'].score = 2400;
        gameInstance.playerStates['actor:b1'].score = 300;
        gameInstance._finishMatch();
        await gameInstance._settlementPromise;
        assert.equal(alice.system.currency.sp, 62, 'Prize paid automatically');
        await gameInstance.handleGMAction('finishGame');
        assert.equal(alice.updates.length, 2, 'Do not pay twice after manual close');
        assert.equal(alice.system.currency.sp, 62);
        assert.equal(bob.system.currency.sp, 38);
        assert.equal(alice.system.currency.gp, 15);
        assert.equal(alice.system.currency.cp, 90);
    });
    it('automatically pays gold and copper winnings without GM interaction', async () => {
        for (const [coin, mode] of [['gp', 'dnd5e-gold'], ['cp', 'dnd5e-copper']]) {
            const first = addActor('a1', 100, 100, 100);
            const second = addActor('b1', 100, 100, 100);
            const match = new ZonkGame({
                sessionId: 'prize-' + coin,
                playerIds: ['actor:a1', 'actor:b1'],
                participants: [{ id: 'actor:a1' }, { id: 'actor:b1' }],
                gameOptions: { ante: 10, targetScore: 2000, settlementMode: mode }
            });
            match._broadcastState = async () => {};
            assert.deepEqual(await match.start(), { ok: true });
            match.playerStates['actor:a1'].score = 2000;
            match._finishMatch();
            await match._settlementPromise;
            assert.equal(first.system.currency[coin], 110);
            assert.equal(second.system.currency[coin], 90);
            assert.equal(match.settlementApplied, true);
            await match.handleGMAction('finishGame');
            assert.equal(first.system.currency[coin], 110, 'Prize paid exactly once');
        }
    });

});
