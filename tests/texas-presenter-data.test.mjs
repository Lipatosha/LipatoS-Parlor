import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
    buildTexasHoldemHud,
    buildTexasHoldemSeatEntries,
    buildTexasHoldemStatus
} = await import('../scripts/games/texasholdem/TexasHoldemPresenterData.js');

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
        kind: 'user'
    };
}

function getSeatStatus(state, id) {
    const seat = state.playerStates?.[id] || null;
    if (state.currentPlayerId === id) return { text: 'Current', className: 'status-playing' };
    if (seat?.status === 'folded') return { text: 'Folded', className: 'status-push' };
    return { text: 'Waiting', className: 'status-live' };
}

const baseState = Object.freeze({
    street: 'turn',
    handNumber: 4,
    round: 2,
    phase: 'PLAYER_TURNS',
    currentPlayerId: 'actor:a',
    dealerButtonId: 'actor:b',
    smallBlindId: 'actor:a',
    bigBlindId: 'actor:b',
    smallBlind: 5,
    bigBlind: 10,
    currentBet: 40,
    minRaise: 20,
    seatIds: ['actor:a', 'actor:b', 'actor:c', 'actor:d', 'actor:e', 'actor:f', 'actor:g'],
    tableStacks: {
        'actor:a': 120,
        'actor:b': 80,
        'actor:c': 0
    },
    playerStates: {
        'actor:a': { status: 'active', committed: 20, streetCommitted: 10 },
        'actor:b': { status: 'folded', committed: 40, streetCommitted: 40 },
        'actor:c': { status: 'active', committed: 0, streetCommitted: 0 }
    }
});

describe('Texas Holdem presenter data mappers', () => {
    it('maps table seats into the Presenter API shape without rendering DOM', () => {
        const seats = buildTexasHoldemSeatEntries(baseState, {
            t,
            formatChips,
            getParticipantName,
            getDisplayParticipant,
            getSeatStatus
        });

        assert.equal(seats.length, 6);
        assert.deepEqual(seats[0], {
            id: 'actor:a',
            name: 'Ada',
            avatarHtml: '<img data-id="actor:a">',
            chips: 'PARLOR.TexasHoldem.Table.Stack:amount=#120',
            badges: [
                { label: 'PARLOR.TexasHoldem.Tag.SmallBlind', className: 'wax' },
                { label: 'PARLOR.TexasHoldem.Table.InPot:amount=#20' }
            ],
            statusText: 'Current',
            statusClass: 'status-playing',
            highlight: true,
            isSelf: true,
            className: ''
        });
        assert.deepEqual(seats[1].badges, [
            { label: 'PARLOR.TexasHoldem.Tag.Dealer', className: 'gold' },
            { label: 'PARLOR.TexasHoldem.Tag.BigBlind', className: 'wax' },
            { label: 'PARLOR.TexasHoldem.Table.InPot:amount=#40' }
        ]);
        assert.equal(seats[1].className, 'is-folded');
    });

    it('maps table-wide status from street, round, current player and blinds', () => {
        const status = buildTexasHoldemStatus(baseState, {
            t,
            formatChips,
            getParticipantName,
            getStreetLabel: (street) => `street:${street}`,
            getPhaseTitle: () => 'phase title'
        });

        assert.deepEqual(status, {
            phase: 'street:turn',
            round: 'PARLOR.Common.RoundCounter:round=4',
            title: 'PARLOR.TexasHoldem.Table.CurrentTurn:name=Ada',
            sub: 'PARLOR.TexasHoldem.Table.Blinds:small=#5,big=#10'
        });
    });

    it('normalizes the default street localization key', () => {
        const status = buildTexasHoldemStatus(baseState, {
            t,
            formatChips,
            getParticipantName,
            getPhaseTitle: () => 'phase title'
        });

        assert.equal(status.phase, 'PARLOR.TexasHoldem.Street.Turn');
    });

    it('maps the controlled participant HUD and action descriptors', async () => {
        const calls = [];
        const hud = buildTexasHoldemHud(baseState, {
            t,
            formatChips,
            getParticipantName,
            getDisplayParticipant,
            getSeatStatus,
            getControlledParticipantIds: () => ['actor:a'],
            resolveSelectedParticipantId: () => 'actor:a',
            getVisibleHoleCards: () => [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'hearts' }],
            getCallAmount: () => 30,
            getMinRaiseTo: () => 60,
            getMaxRaiseTo: () => 130,
            getRaiseShortcuts: () => ({ min: 60, half: 85, pot: 110, max: 130 }),
            requestAction: (action, data) => {
                calls.push({ action, data });
                return Promise.resolve({ ok: true });
            }
        });

        assert.equal(hud.ownerId, 'actor:a');
        assert.deepEqual(hud.topline, [
            'PARLOR.Games.TexasHoldem.Name',
            'PARLOR.Common.RoundCounter:round=4',
            'PARLOR.TexasHoldem.Street.Turn'
        ]);
        assert.equal(hud.identity.name, 'Ada');
        assert.equal(hud.cards.length, 2);
        assert.match(hud.asideHtml, /data-raise-quick="110"/u);
        assert.deepEqual(
            hud.actions.map(action => [action.label, action.icon, action.className || '', action.disabled || false]),
            [
                ['PARLOR.TexasHoldem.Action.CallAmount:amount=#30', 'fas fa-equals', '', false],
                ['PARLOR.TexasHoldem.Action.Fold', 'fas fa-times', 'fold', false],
                ['PARLOR.TexasHoldem.Action.Raise', 'fas fa-arrow-up', 'gold', false],
                ['PARLOR.TexasHoldem.Action.AllIn', 'fas fa-fire', '', false]
            ]
        );

        await hud.actions[0].onClick(null);
        assert.deepEqual(calls[0], {
            action: 'call',
            data: { participantId: 'actor:a' }
        });
    });
});
