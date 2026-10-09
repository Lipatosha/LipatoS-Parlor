import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function setupFoundryStubs() {
    globalThis.game = {
        user: { id: 'gm', isGM: true },
        users: { get() { return null; }, find() { return null; }, filter() { return []; } },
        actors: { get() { return null; } },
        system: { id: 'dnd5e' },
        i18n: {
            localize: key => key,
            format: (key, data = {}) => `${key}:${Object.entries(data).map(([name, value]) => `${name}=${value}`).join(',')}`
        }
    };
}

async function loadBlackjackGame() {
    setupFoundryStubs();
    const stamp = `${Date.now()}-${Math.random()}`;
    return import(`../scripts/games/blackjack/BlackjackGame.js?case=${stamp}`);
}

function withImmediateTimers(callback) {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn) => {
        fn();
        return 1;
    };
    globalThis.clearTimeout = () => {};
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        });
}

function withQuietConsole(callback) {
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            console.log = originalLog;
            console.warn = originalWarn;
        });
}

function card(rank, suit = 'clubs') {
    return { rank: String(rank), suit };
}

function makePlayingGame(BlackjackGame, { deckCards = [] } = {}) {
    const game = new BlackjackGame({
        sessionId: 'session-a',
        playerIds: ['actor:a'],
        participants: [{ id: 'actor:a', type: 'user', name: 'Ada' }]
    });
    game._phase = 'PLAYER_TURNS';
    game.turnOrder = ['actor:a'];
    game.currentTurnIndex = 0;
    game.playerHands = {
        'actor:a': {
            handCards: [card(6), card(5, 'hearts')],
            tableCards: [],
            bet: 10,
            status: 'playing',
            total: 11
        }
    };
    game.dealerHand = { handCards: [card(10), card(7, 'spades')], tableCards: [], status: 'waiting' };
    game.deck = {
        cards: [],
        deal: () => deckCards.shift() || card(2, 'diamonds')
    };
    game._broadcastState = async () => {};
    return game;
}

describe('BlackjackGame table hit cards', () => {
    it('keeps hit cards on the table until stand collects them together', async () => {
        const { BlackjackGame } = await loadBlackjackGame();
        const game = makePlayingGame(BlackjackGame, {
            deckCards: [card(3, 'diamonds'), card(2, 'spades')]
        });

        await withQuietConsole(() => withImmediateTimers(async () => {
            game.pendingAction = { userId: 'actor:a', action: 'hit', stage: 'requested' };
            await game.handleGMAction('confirmDeal');

            assert.equal(game.playerHands['actor:a'].handCards.length, 2);
            assert.equal(game.playerHands['actor:a'].tableCards.length, 1);
            assert.equal(game.playerHands['actor:a'].status, 'awaiting_collect');

            assert.deepEqual(game.handlePlayerAction('actor:a', 'requestHit'), { ok: true });
            await game.handleGMAction('confirmDeal');

            assert.equal(game.playerHands['actor:a'].handCards.length, 2);
            assert.equal(game.playerHands['actor:a'].tableCards.length, 2);
            assert.equal(game.playerHands['actor:a'].status, 'awaiting_collect');

            assert.deepEqual(game.handlePlayerAction('actor:a', 'requestStand'), { ok: true });
        }));

        assert.equal(game.playerHands['actor:a'].handCards.length, 4);
        assert.equal(game.playerHands['actor:a'].tableCards.length, 0);
        assert.equal(game.playerHands['actor:a'].status, 'stand');
        assert.equal(game.phase, 'DEALER_TURN');
    });
});
