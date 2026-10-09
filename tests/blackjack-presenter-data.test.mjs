import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
    buildBlackjackHud,
    buildBlackjackSeatEntries,
    buildBlackjackStatus
} = await import('../scripts/games/blackjack/BlackjackPresenterData.js');

function t(key, data = null) {
    if (!data) return key;
    return `${key}:${Object.entries(data).map(([name, value]) => `${name}=${value}`).join(',')}`;
}

function formatChips(value) {
    return `#${Number(value || 0)}`;
}

function getParticipantName(_state, id) {
    return id === 'actor:a' ? 'Ada' : (id === 'actor:b' ? 'Bryn' : id);
}

function getDisplayParticipant(_state, id) {
    return {
        avatarHtml: `<img data-id="${id}">`,
        isSelf: id === 'actor:a',
        kind: id === 'actor:b' ? 'bot' : 'user'
    };
}

const baseState = Object.freeze({
    phase: 'PLAYER_TURNS',
    round: 3,
    currentPlayerId: 'actor:a',
    turnOrder: ['actor:a', 'actor:b', 'actor:c'],
    playerIds: ['actor:a', 'actor:b', 'actor:c'],
    bettingPlayerIds: ['actor:a', 'actor:b', 'actor:c'],
    bets: [
        { userId: 'actor:a', amount: 15 },
        { userId: 'actor:b', amount: 20 }
    ],
    playerHands: {
        'actor:a': {
            status: 'playing',
            bet: 15,
            handCards: [{ rank: 'A', suit: 'spades' }, { rank: '9', suit: 'hearts' }],
            tableCards: []
        },
        'actor:b': {
            status: 'bust',
            bet: 20,
            handCards: [{ rank: 'K', suit: 'clubs' }, { rank: 'Q', suit: 'diamonds' }],
            tableCards: [{ rank: '5', suit: 'spades' }]
        },
        'actor:c': {
            status: 'awaiting_deal',
            bet: 0,
            handCards: []
        }
    },
    dealerHand: {
        status: 'playing',
        handCards: [{ rank: '7', suit: 'clubs' }, { rank: '8', suit: 'diamonds' }],
        tableCards: []
    },
    rules: { bustThreshold: 21 }
});

function helpers(overrides = {}) {
    const calls = [];
    return {
        calls,
        t,
        formatChips,
        getParticipantName,
        getDisplayParticipant,
        getSelfSeatParticipantId: () => 'actor:a',
        getActivePlayerIds: (state) => state.turnOrder,
        getBettingPlayerIds: (state) => state.bettingPlayerIds,
        getControlledParticipantIds: () => ['actor:a'],
        resolveSelectedParticipantId: () => 'actor:a',
        isGM: () => true,
        isDealerController: () => false,
        getPlayerHudCards: (_state, hand) => hand.handCards.map(card => ({ card, size: 'hud' })),
        getDealerHudCards: (_state, hand) => hand.handCards.map(card => ({ card, size: 'hud' })),
        getVisibleHandTotal: (hand) => [...(hand.handCards || []), ...(hand.tableCards || [])].length * 10,
        getBetDraftAmount: () => 10,
        isActionPending: () => false,
        requestAction: (action, data) => {
            calls.push({ action, data });
            return Promise.resolve({ ok: true });
        },
        ...overrides
    };
}

describe('Blackjack presenter data mappers', () => {
    it('maps seats into the Presenter API shape without touching native DOM', () => {
        const result = helpers();
        const seats = buildBlackjackSeatEntries(baseState, result);

        assert.equal(seats.length, 3);
        assert.equal(seats[0].id, 'actor:b');
        assert.equal(seats[0].name, 'Bryn');
        assert.equal(seats[0].avatarHtml, '<img data-id="actor:b">');
        assert.equal(seats[0].chips, '#20 GP');
        assert.equal(seats[0].statusText, 'PARLOR.Common.Bust');
        assert.equal(seats[0].statusClass, 'status-bust');
        assert.equal(seats[0].highlight, false);
        assert.equal(seats[0].isSelf, false);
        assert.equal(seats[0].className, 'is-bust');

        assert.equal(seats[1].id, 'actor:a');
        assert.equal(seats[1].highlight, true);
        assert.equal(seats[1].isSelf, true);
        assert.deepEqual(seats[1].badges, [
            { label: 'PARLOR.Common.Player', className: 'role' },
            { label: 'PARLOR.Common.Bet:amount=#15 GP', className: 'bet' }
        ]);
    });

    it('maps table-wide phase status from the current blackjack state', () => {
        const status = buildBlackjackStatus(baseState, helpers());

        assert.deepEqual(status, {
            phase: 'PARLOR.Blackjack.Hud.PhasePlayerTurn',
            round: 'PARLOR.Common.RoundCounter:round=3',
            title: 'PARLOR.Blackjack.Hud.PlayerTurnTitle:name=Ada',
            sub: 'PARLOR.Blackjack.Hud.PlayerTurnSub'
        });
    });

    it('maps the selected participant HUD and action descriptors', async () => {
        const result = helpers();
        const hud = buildBlackjackHud(baseState, result);

        assert.equal(hud.ownerId, 'actor:a');
        assert.deepEqual(hud.topline, [
            'PARLOR.Games.Blackjack.Name',
            'PARLOR.Common.RoundCounter:round=3'
        ]);
        assert.equal(hud.identity.name, 'Ada');
        assert.equal(hud.cards.length, 2);
        assert.match(hud.centerHtml, /PARLOR.Blackjack.PlayerHud.YourTurn/u);
        assert.deepEqual(
            hud.actions.map(action => [action.label, action.icon, action.disabled || false]),
            [
                ['PARLOR.Common.Hit', 'fas fa-plus', false],
                ['PARLOR.Common.Stand', 'fas fa-hand-paper', false]
            ]
        );

        await hud.actions[0].onClick(null);
        assert.deepEqual(result.calls[0], {
            action: 'requestHit',
            data: { participantId: 'actor:a' }
        });
    });

    it('keeps player actions available while hit cards wait on the table', () => {
        const state = {
            ...baseState,
            playerHands: {
                ...baseState.playerHands,
                'actor:a': {
                    ...baseState.playerHands['actor:a'],
                    status: 'awaiting_collect',
                    tableCards: [{ rank: '2', suit: 'spades' }]
                }
            }
        };
        const hud = buildBlackjackHud(state, helpers({
            canPlayerHit: () => true,
            canPlayerStand: () => true
        }));

        assert.deepEqual(
            hud.actions.map(action => action.label),
            ['PARLOR.Common.Hit', 'PARLOR.Common.Stand']
        );
    });
});
