import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
    buildLiarsDiceHud,
    buildLiarsDiceSeatEntries,
    buildLiarsDiceStatus
} = await import('../scripts/games/liarsdice/LiarsDicePresenterData.js');

function t(key, data = null) {
    if (!data) return key;
    return `${key}:${Object.entries(data).map(([name, value]) => `${name}=${value}`).join(',')}`;
}

function getParticipantName(_state, id) {
    return id === 'actor:a' ? 'Ada' : (id === 'actor:b' ? 'Bryn' : 'Cy');
}

function getDisplayParticipant(_state, id) {
    return {
        avatarHtml: `<img data-id="${id}">`,
        isSelf: id === 'actor:a',
        kind: 'user'
    };
}

const baseState = Object.freeze({
    phase: 'PLAYER_TURNS',
    round: 2,
    roundToken: 'r2',
    currentPlayerId: 'actor:a',
    roundStarterId: 'actor:b',
    playerIds: ['actor:a', 'actor:b', 'actor:c'],
    diceCounts: {
        'actor:a': 5,
        'actor:b': 4,
        'actor:c': 0
    },
    lastClaim: {
        userId: 'actor:b',
        quantity: 2,
        face: 4
    },
    revealedDice: {
        'actor:b': [2, 4, 4]
    }
});

function helpers(overrides = {}) {
    const calls = [];
    return {
        calls,
        t,
        getParticipantName,
        getDisplayParticipant,
        getSelfSeatParticipantId: () => 'actor:a',
        getActivePlayerIds: (state) => (state.playerIds || []).filter(id => Number(state.diceCounts?.[id] || 0) > 0),
        getSelectableParticipantIds: () => ['actor:a'],
        resolveSelectedParticipantId: () => 'actor:a',
        getVisibleDice: () => [1, 3, 6],
        getSeatStatus: (state, id) => {
            if (Number(state.diceCounts?.[id] || 0) < 1) return { text: 'Out', className: 'status-folded' };
            if (state.currentPlayerId === id) return { text: 'Current', className: 'status-live' };
            return { text: 'Waiting', className: 'status-live' };
        },
        getSeatNote: (_state, id) => id === 'actor:b' ? 'last claim' : 'note',
        formatClaim: (quantity, face) => `${quantity}x${face}`,
        getSuggestedClaimQuantity: () => 2,
        isClaimAvailable: (_state, claim) => claim.quantity >= 2,
        isActionPending: () => false,
        requestAction: (action, data) => {
            calls.push({ action, data });
            return Promise.resolve({ ok: true });
        },
        isGM: () => false,
        ...overrides
    };
}

describe('Liars Dice presenter data mappers', () => {
    it('maps seats into the Presenter API shape without DSN or DOM work', () => {
        const seats = buildLiarsDiceSeatEntries(baseState, helpers());

        assert.equal(seats.length, 3);
        assert.equal(seats[0].id, 'actor:b');
        assert.equal(seats[0].name, 'Bryn');
        assert.equal(seats[0].chips, '4');
        assert.equal(seats[0].statusText, 'Waiting');
        assert.equal(seats[0].extraHtml.includes('data-value="4"'), true);

        assert.equal(seats[1].id, 'actor:a');
        assert.equal(seats[1].highlight, true);
        assert.equal(seats[1].isSelf, true);

        assert.equal(seats[2].id, 'actor:c');
        assert.equal(seats[2].statusClass, 'status-folded');
        assert.equal(seats[2].className, 'is-out');
    });

    it('maps table-wide status from turn and claim state', () => {
        const status = buildLiarsDiceStatus(baseState, helpers());

        assert.deepEqual(status, {
            phase: 'PARLOR.LiarsDice.Center.Phase.Turns',
            round: 'PARLOR.Common.RoundCounter:round=2',
            title: 'PARLOR.LiarsDice.Center.TurnsTitleRespond:name=Ada',
            sub: 'PARLOR.LiarsDice.Center.TurnsSubRespond'
        });
    });

    it('maps the selected participant HUD and action descriptors', async () => {
        const result = helpers();
        const hud = buildLiarsDiceHud(baseState, result);

        assert.equal(hud.ownerId, 'actor:a');
        assert.deepEqual(hud.topline, [
            'PARLOR.Games.LiarsDice.Name',
            'PARLOR.Common.RoundCounter:round=2'
        ]);
        assert.equal(hud.identity.name, 'Ada');
        assert.match(hud.centerHtml, /data-value="6"/u);
        assert.deepEqual(hud.claimDraft, {
            quantity: 2,
            label: 'PARLOR.LiarsDice.Footer.ClaimCount',
            hint: 'PARLOR.LiarsDice.Footer.ClaimCountHint'
        });
        assert.equal(hud.actions[0].label, 'PARLOR.LiarsDice.Action.Open');
        assert.equal(hud.actions[0].kind, 'open');
        assert.equal(hud.actions.at(-1).label, '2x6');

        const faceOne = hud.actions.find(action => action.kind === 'claim' && action.face === 1);
        assert.equal(faceOne.minQuantity, 3);

        // 输入框里的数量就是玩家要喊的数量；非法组合交给按钮禁用，不能静默改成另一口价。
        await faceOne.onClick(null, { amount: 2 });
        assert.deepEqual(result.calls[0], {
            action: 'claim',
            data: { participantId: 'actor:a', quantity: 2, face: 1 }
        });
    });
});
