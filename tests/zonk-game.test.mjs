import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'zonk-test',
        deepClone: value => structuredClone(value),
        getProperty: () => null
    }
};
globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true, active: true },
    users: { get: () => null, find: () => null },
    actors: { get: () => null },
    settings: { settings: new Map(), get: () => null },
    i18n: { localize: key => key, format: key => key }
};
globalThis.ui = { notifications: { warn: () => {} } };

const { scoreZonkDice, getZonkKeepOptions, canScoreZonkRoll } =
    await import('../scripts/games/zonk/ZonkRules.js');
const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { ZonkGame } = await import('../scripts/games/zonk/ZonkGame.js');

let applied = [];
let affordable = () => true;
SettlementManager.canAfford = id => affordable(id);
SettlementManager.applyDeltas = async entries => {
    applied.push(entries.map(entry => ({ ...entry })));
    return true;
};

function makeGame(sequence = [1, 1, 1, 2, 3, 4], options = {}) {
    let i = 0;
    const table = new ZonkGame({
        sessionId: 'zonk-test',
        playerIds: ['p1', 'p2'],
        participants: [
            { id: 'p1', type: 'user', name: 'One' },
            { id: 'p2', type: 'user', name: 'Two' }
        ],
        gameOptions: { ante: 10, targetScore: 5000, ...options },
        zonkRng: () => ((sequence[i++ % sequence.length] - 1) + 0.1) / 6
    });
    table._broadcastState = async () => {};
    return table;
}

beforeEach(() => {
    applied = [];
    affordable = () => true;
});

describe('Zonk scoring', () => {
    it('scores singles, triples, extra matches, two triples, and full-roll bonuses', () => {
        assert.equal(scoreZonkDice([1]), 100);
        assert.equal(scoreZonkDice([5, 5]), 100);
        assert.equal(scoreZonkDice([1, 1, 1]), 1000);
        assert.equal(scoreZonkDice([2, 2, 2]), 200);
        assert.equal(scoreZonkDice([6, 6, 6]), 600);
        assert.equal(scoreZonkDice([1, 1, 1, 1]), 2000);
        assert.equal(scoreZonkDice([5, 5, 5, 5, 5]), 2000);
        assert.equal(scoreZonkDice([6, 6, 6, 6, 6, 6]), 4800);
        assert.equal(scoreZonkDice([2, 2, 2, 3, 3, 3]), 2500);
        assert.equal(scoreZonkDice([2, 2, 3, 3, 4, 4]), 1500);
        assert.equal(scoreZonkDice([1, 2, 3, 4, 5, 6]), 1500);
        assert.equal(scoreZonkDice([1, 2, 3, 4, 5]), 500);
        assert.equal(scoreZonkDice([2, 2, 2, 2, 3, 3]), 1500);
        assert.equal(scoreZonkDice([1, 1, 1, 1, 1, 1]), 8000);
        assert.equal(scoreZonkDice([1, 2, 3, 4, 5, 5]), 550);
        assert.equal(scoreZonkDice([5]), 50);
        assert.equal(scoreZonkDice([2, 3, 4, 5, 6]), 750);
        assert.equal(scoreZonkDice([2, 2, 2, 2]), 400);
        assert.equal(scoreZonkDice([2, 2, 2, 2, 2]), 800);
        assert.equal(scoreZonkDice([2, 2, 2, 2, 2, 2]), 1600);
        assert.equal(scoreZonkDice([1, 1, 1, 1, 1]), 4000);
        assert.equal(scoreZonkDice([1, 1, 1, 1, 5, 5]), 1500, 'Four of a kind plus pair is exclusive');
        assert.equal(scoreZonkDice([1, 1, 2, 3, 4, 5]), 600);

    });

    it('rejects unscorable dice and detects true zonks', () => {
        assert.equal(scoreZonkDice([1, 2]), 0);
        assert.equal(scoreZonkDice([3, 3]), 0);
        assert.equal(scoreZonkDice([1, 7]), 0);
        assert.equal(scoreZonkDice([2, 3, 4, 6, 2, 3]), 0);
        assert.equal(canScoreZonkRoll([2, 3, 4, 6, 2, 3]), false);
        assert.equal(canScoreZonkRoll([2, 3, 4, 5]), true);
        const best = getZonkKeepOptions([1, 1, 1, 2, 3, 4])[0];
        assert.equal(best.points, 1000);
        assert.deepEqual(best.indices, [0, 1, 2]);
    });
});

describe('Zonk table flow and entry-fee settlement', () => {
    it('charges once, enforces current turn and minimum bank, allows hot dice', async () => {
        const table = makeGame([1, 1, 1, 1, 1, 1]);
        assert.deepEqual(await table.start(), { ok: true });
        assert.deepEqual(applied[0], [{ userId: 'p1', delta: -10 }, { userId: 'p2', delta: -10 }]);
        assert.equal(table.handlePlayerAction('p2', 'roll', {}).ok, false);
        assert.equal(table.handlePlayerAction('p1', 'bank', {}).ok, false);
        assert.equal(table.handlePlayerAction('p1', 'roll', {}).ok, true);
        assert.deepEqual(table.currentDice, [1, 1, 1, 1, 1, 1]);
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0, 0] }).ok, false);
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2, 3, 4, 5] }).ok, true);
        assert.equal(table.turnPoints, 8000);
        assert.equal(table.remainingDice, 6);
        assert.equal(table.handlePlayerAction('p1', 'roll', {}).ok, true);
    });

    it('burns only unbanked points on zonk, then advances the turn', async () => {
        const table = makeGame([1, 2, 3, 4, 5, 6]);
        await table.start();
        table.handlePlayerAction('p1', 'roll', {});
        table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2, 3, 4, 5] });
        assert.equal(table.turnPoints, 1500);
        table._rng = (() => {
            const rolls = [2, 3, 4, 6, 2, 3];
            let i = 0;
            return () => ((rolls[i++ % 6] - 1) + .1) / 6;
        })();
        table.handlePlayerAction('p1', 'roll', {});
        assert.equal(table.playerStates.p1.score, 0);
        assert.equal(table.playerStates.p1.zonks, 1);
        assert.equal(table.currentPlayerId, 'p2');
    });

    it('runs final opponent turn, names winner, and pays once', async () => {
        const table = makeGame([1, 1, 1, 2, 3, 4]);
        await table.start();
        table.playerStates.p1.score = 4800;
        table.handlePlayerAction('p1', 'roll', {});
        table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2] });
        table.handlePlayerAction('p1', 'bank', {});
        assert.equal(table.finalTurnsRemaining, 1);
        assert.equal(table.currentPlayerId, 'p2');
        assert.equal(table.phase, 'PLAYER_TURNS');
        table.handlePlayerAction('p2', 'roll', {});
        table.handlePlayerAction('p2', 'keep', { indices: [0, 1, 2] });
        table.handlePlayerAction('p2', 'bank', {});
        assert.equal(table.phase, 'FINISHED');
        assert.deepEqual(table.winnerIds, ['p1']);
        await table.handleGMAction('finishGame');
        await table.handleGMAction('finishGame');
        assert.equal(applied.length, 2);
        assert.deepEqual(applied[1], [{ userId: 'p1', delta: 20 }]);
    });

    it('returns entry fees once when GM cancels unfinished match', async () => {
        const table = makeGame();
        await table.start();
        await table.handleGMAction('finishGame');
        await table.handleGMAction('finishGame');
        assert.equal(applied.length, 2);
        assert.deepEqual(applied[1], [{ userId: 'p1', delta: 10 }, { userId: 'p2', delta: 10 }]);
    });

    it('rejects insufficient funds before any deduction', async () => {
        affordable = id => id !== 'p2';
        const table = makeGame();
        const result = await table.start();
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'funds');
        assert.equal(applied.length, 0);
    });
});

describe('Zonk table capacity', () => {
    it('accepts ten participants but rejects eleven before collecting stakes', async () => {
        const setup = count => {
            const ids = Array.from({ length: count }, (_, index) => `player-${index + 1}`);
            const table = new ZonkGame({
                sessionId: `capacity-${count}`,
                playerIds: ids,
                participants: ids.map(id => ({ id, name: id, type: 'user' })),
                gameOptions: { ante: 2, targetScore: 2000 }
            });
            table._broadcastState = async () => {};
            return table;
        };
        const ten = setup(10);
        assert.deepEqual(await ten.start(), { ok: true });
        assert.equal(ten.turnOrder.length, 10);
        assert.equal(applied[0].length, 10);
        const eleven = setup(11);
        assert.equal((await eleven.start()).reason, 'players');
        assert.equal(applied.length, 1, 'An over-capacity table must never debit currency');
    });
});

describe('Farkle kept-dice staircase state', () => {
    it('persists saved dice, resets after hot dice and clears on turn change', async () => {
        const table = makeGame([1, 1, 1, 2, 3, 4]);
        await table.start();
        assert.deepEqual(table.getState().keptDice, []);
        table.handlePlayerAction('p1', 'roll');
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2] }).ok, true);
        assert.deepEqual(table.getState().keptDice, [1, 1, 1]);
        assert.deepEqual(table.getState().keptDiceRows, [[1, 1, 1]]);
        assert.equal(table.remainingDice, 3);

        table.handlePlayerAction('p1', 'roll');
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2] }).ok, true);
        assert.deepEqual(table.getState().keptDice, [1, 1, 1, 1, 1, 1]);
        assert.deepEqual(table.getState().keptDiceRows, [[1, 1, 1], [1, 1, 1]], 'Second keep action must begin on next tier');
        assert.equal(table.remainingDice, 6);

        table.handlePlayerAction('p1', 'roll');
        assert.deepEqual(table.getState().keptDice, [1, 1, 1, 1, 1, 1], 'Hot dice preserve six bottom-tier dice');
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [3, 4, 5] }).ok, true);
        assert.deepEqual(table.getState().keptDice, Array(9).fill(1));
        assert.deepEqual(table.getState().keptDiceRows, [[1,1,1], [1,1,1], [1,1,1]], 'Third keep occupies third tier');
        table.handlePlayerAction('p1', 'bank');
        assert.equal(table.currentPlayerId, 'p2');
        assert.deepEqual(table.getState().keptDice, [], 'Staircase clears for the next participant');
        assert.deepEqual(table.getState().keptDiceRows, []);
    });
});

describe('Farkle visual grouping by keep action', () => {
    it('puts one kept die in the bottom row and the next in the five-slot row', async () => {
        const table = makeGame([1, 1, 2, 3, 4, 6]);
        await table.start();
        table.handlePlayerAction('p1', 'roll');
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0] }).ok, true);
        assert.deepEqual(table.getState().keptDiceRows, [[1]]);
        table.handlePlayerAction('p1', 'roll');
        assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0] }).ok, true);
        assert.deepEqual(table.getState().keptDiceRows, [[1], [1]]);
    });
});

describe('Farkle tier helper overflow and rollover', () => {
    it('keeps distinct saving actions on separate rows and does not lose dice', async () => {
        const { appendFarkleRackRow, getFarkleRackDisplay } = await import('../scripts/games/zonk/FarkleRack.js');
        let rows = appendFarkleRackRow([], [1,5]);
        rows = appendFarkleRackRow(rows, [5]);
        assert.deepEqual(rows, [[1,5],[5]]);
        assert.deepEqual(getFarkleRackDisplay(rows).map(row => row.capacity), [1,2,3,4,5,6]);
        assert.deepEqual(getFarkleRackDisplay(rows)[5].values, [1,5]);
        assert.deepEqual(getFarkleRackDisplay(rows)[4].values, [5]);
        rows = appendFarkleRackRow(rows, [1,1,1,1,1,1]);
        assert.deepEqual(rows, [[1,5],[5],[1,1,1,1],[1,1]],
            'Six dice may spill to next row, but must never be silently dropped');
        rows = appendFarkleRackRow(rows, [2,2,2,2,2,2]);
        assert.deepEqual(rows, [[2,2,2,2,2,2]],
            'Once upper tiers cannot hold a combination, restart visual rack');
    });
});

describe('Farkle six-level bonus-dice capacity', () => {
    it('fills all twenty-one cells from the bottom across repeated hot-dice throws', async () => {
        const table = makeGame([1, 1, 1, 1, 1, 1]);
        await table.start();
        for (const expected of [6, 6, 6, 6, 6]) {
            assert.equal(table.handlePlayerAction('p1', 'roll').ok, true);
            assert.equal(table.handlePlayerAction('p1', 'keep', { indices: [0, 1, 2, 3, 4, 5] }).ok, true);
            assert.equal(table.getState().keptDiceRows.flat().length, expected);
            assert.deepEqual(table.getState().keptDiceRows, [Array(6).fill(1)]);

        }
        table.handlePlayerAction('p1', 'bank');
        assert.deepEqual(table.getState().keptDice, []);
        assert.equal(table.currentPlayerId, 'p2');
    });
});
