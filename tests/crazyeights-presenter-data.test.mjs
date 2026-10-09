import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
    buildCrazyEightsHud,
    buildCrazyEightsSeatEntries,
    buildCrazyEightsStatus
} from '../scripts/games/crazyeights/CrazyEightsPresenterData.js';

const c = (rank, suit) => ({ rank, suit });

const baseState = Object.freeze({
    phase: 'PLAYER_TURNS',
    round: 2,
    roundToken: 'tok',
    playerIds: ['p1', 'p2', 'p3', 'p4'],
    roundPlayerIds: ['p1', 'p2', 'p3'],
    sittingOutPlayerIds: ['p4'],
    turnOrder: ['p1', 'p2', 'p3'],
    direction: -1,
    currentPlayerId: 'p1',
    turnStep: 4,
    turn: { mustChooseSuit: false, pendingDraw: 0, drawnThisTurn: false, drawCountThisTurn: 0 },
    handCounts: { p1: 3, p2: 1, p3: 6 },
    discardTop: c('7', 'spades'),
    discardCount: 4,
    currentSuit: 'spades',
    stockCount: 20,
    pot: 30,
    rules: { wildRank: '8', skipRank: 'J', reverseRank: 'Q', drawTwoRank: '2', drawRule: 'one', maxDrawPerTurn: 1, playAfterDraw: 'any' },
    lastActions: [{ type: 'play', participantId: 'p3', card: c('7', 'spades'), seq: 9 }],
    lastAction: { type: 'play', participantId: 'p3', card: c('7', 'spades'), seq: 9 },
    winnerIds: [],
    roundResult: null,
    revealedHands: {}
});

const hands = { p1: [c('7', 'hearts'), c('K', 'clubs'), c('8', 'diamonds')] };
const requests = [];

function makeHelpers(overrides = {}) {
    return {
        t: (key, data) => (data ? `${key}:${JSON.stringify(data)}` : key),
        formatChips: amount => `${amount}`,
        getParticipantName: (_state, id) => id.toUpperCase(),
        getDisplayParticipant: (_state, id) => ({ avatarHtml: `<img data-id="${id}">`, isSelf: id === 'p1' }),
        getControlledParticipantIds: () => ['p1'],
        resolveSelectedParticipantId: () => 'p1',
        getSelfSeatParticipantId: () => 'p1',
        isGM: () => false,
        getBalance: () => 120,
        getVisibleHand: id => hands[id] || null,
        getLegalActions: (_id, hand) => ({
            mustChooseSuit: false,
            playable: hand.filter(card => card.suit === 'spades' || card.rank === '7' || card.rank === '8'),
            canDraw: true,
            canPass: false,
            cardsAvailable: true
        }),
        isActionPending: () => false,
        requestAction: (action, data) => { requests.push([action, data]); return Promise.resolve({ ok: true }); },
        ...overrides
    };
}

describe('疯狂八 PresenterData', () => {
    it('纯函数：源码里没有 import', () => {
        const source = readFileSync('scripts/games/crazyeights/CrazyEightsPresenterData.js', 'utf8');
        assert.doesNotMatch(source, /^\s*import\s/mu);
    });

    it('座位：自己在右列首位，剩牌数是带单位的字符串，最后一张顶到首枚徽章', () => {
        const seats = buildCrazyEightsSeatEntries(baseState, makeHelpers());
        assert.deepEqual(seats.map(seat => seat.id), ['p2', 'p3', 'p1', 'p4']);
        const byId = Object.fromEntries(seats.map(seat => [seat.id, seat]));

        assert.equal(byId.p1.side, 'right');
        assert.equal(byId.p1.name, 'PARLOR.Common.You');
        assert.equal(byId.p1.highlight, true);
        assert.match(byId.p1.className, /is-current/u);
        assert.equal(byId.p1.chips, 'PARLOR.CrazyEights.Seat.CardsLeft:{"count":3}');

        assert.equal(byId.p2.badges[0].label, 'PARLOR.CrazyEights.Seat.LastCard');
        assert.equal(byId.p2.badges[0].className, 'wax');
        assert.match(byId.p2.className, /is-last-card/u);

        assert.equal(byId.p3.badges[0].label, '6');
        assert.equal(byId.p3.highlight, false);

        assert.equal(byId.p4.chips, '');
        assert.match(byId.p4.className, /is-sitting-out/u);
    });

    it('状态：标题跟着回合子状态走，副标题带花色/方向/牌堆', () => {
        const helpers = makeHelpers();
        const turn = buildCrazyEightsStatus(baseState, helpers);
        assert.equal(turn.phase, 'PARLOR.CrazyEights.Center.Phase.Turns');
        assert.equal(turn.title, 'PARLOR.CrazyEights.Center.TurnTitle:{"name":"P1"}');
        assert.match(turn.sub, /CurrentSuit/u);
        assert.match(turn.sub, /CounterClockwise/u);
        assert.match(turn.sub, /Stock:\{"count":20\}/u);

        const suit = buildCrazyEightsStatus({ ...baseState, turn: { ...baseState.turn, mustChooseSuit: true } }, helpers);
        assert.equal(suit.title, 'PARLOR.CrazyEights.Center.ChooseSuitTitle:{"name":"P1"}');

        const penalty = buildCrazyEightsStatus({ ...baseState, turn: { ...baseState.turn, pendingDraw: 4 } }, helpers);
        assert.equal(penalty.title, 'PARLOR.CrazyEights.Center.PendingDrawTitle:{"name":"P1","count":4}');

        const win = buildCrazyEightsStatus({
            ...baseState, phase: 'RESOLVING', winnerIds: ['p2'],
            roundResult: { kind: 'win', payoutPerWinner: 30 }
        }, helpers);
        assert.equal(win.title, 'PARLOR.CrazyEights.Center.WinnerTitle:{"name":"P2"}');
        assert.equal(win.sub, 'PARLOR.CrazyEights.Center.WinSub:{"amount":"30"}');
    });

    it('HUD：手牌带 playable/onClick，点击转成 playCard；动作只有抽牌和过', () => {
        requests.length = 0;
        const hud = buildCrazyEightsHud(baseState, makeHelpers());
        assert.equal(hud.ownerId, 'p1');
        assert.equal(hud.cards.length, 3);
        assert.deepEqual(hud.cards.map(entry => entry.playable), [true, false, true]);
        assert.equal(hud.cards[0].startFaceDown, false);

        hud.cards[0].onClick();
        assert.deepEqual(requests[0], ['playCard', { participantId: 'p1', suit: 'hearts', rank: '7' }]);

        assert.deepEqual(hud.actions.map(action => action.kind), ['draw']);
        assert.equal(hud.actions[0].disabled, false);
        hud.actions[0].onClick();
        assert.deepEqual(requests[1], ['draw', { participantId: 'p1' }]);
        assert.equal(hud.identity.sub, 'PARLOR.CrazyEights.Hud.HandSummary:{"count":3,"points":67}');
        assert.equal(hud.centerHtml, '');
        assert.equal(hud.table.direction, -1);
    });

    it('HUD：选花色时只给四个花色动作；不是自己的回合牌不高亮', () => {
        requests.length = 0;
        const choose = buildCrazyEightsHud({ ...baseState, turn: { ...baseState.turn, mustChooseSuit: true } }, makeHelpers());
        assert.deepEqual(choose.actions.map(action => action.kind), ['suit', 'suit', 'suit', 'suit']);
        assert.deepEqual(choose.actions.map(action => action.suit), ['hearts', 'diamonds', 'clubs', 'spades']);
        assert.ok(choose.cards.every(entry => entry.playable === false));
        choose.actions[2].onClick();
        assert.deepEqual(requests[0], ['chooseSuit', { participantId: 'p1', suit: 'clubs' }]);

        const waiting = buildCrazyEightsHud({ ...baseState, currentPlayerId: 'p2' }, makeHelpers());
        assert.ok(waiting.cards.every(entry => entry.playable === null));
        assert.deepEqual(waiting.actions, []);
    });

    it('HUD：待罚抽时抽牌按钮改成接罚；可过时出现过按钮', () => {
        const penalty = buildCrazyEightsHud({ ...baseState, turn: { ...baseState.turn, pendingDraw: 2 } }, makeHelpers());
        assert.equal(penalty.actions[0].label, 'PARLOR.CrazyEights.Action.TakePenalty:{"count":2}');

        const drawn = buildCrazyEightsHud(
            { ...baseState, turn: { ...baseState.turn, drawnThisTurn: true } },
            makeHelpers({ getLegalActions: (_id, hand) => ({ mustChooseSuit: false, playable: hand, canDraw: false, canPass: true, cardsAvailable: true }) })
        );
        assert.deepEqual(drawn.actions.map(action => action.kind), ['draw', 'pass']);
        assert.equal(drawn.actions[0].disabled, true);
    });

    it('HUD：GM 无席位时只在结算阶段拿到推进按钮；旁观者拿 null', () => {
        const gm = buildCrazyEightsHud(
            { ...baseState, phase: 'RESOLVING', winnerIds: ['p2'], roundResult: { kind: 'win', payoutPerWinner: 30 } },
            makeHelpers({ getControlledParticipantIds: () => [], resolveSelectedParticipantId: () => '', isGM: () => true, getVisibleHand: () => null })
        );
        assert.equal(gm.ownerId, 'gm');
        assert.deepEqual(gm.actions, [], '结算操作只出现在独立弹窗中');
        assert.deepEqual(gm.cards, []);

        const spectator = buildCrazyEightsHud(baseState, makeHelpers({ getControlledParticipantIds: () => [], resolveSelectedParticipantId: () => '', isGM: () => false }));
        assert.equal(spectator, null);
    });

    it('HUD：多控时 centerHtml 带席位下拉', () => {
        const hud = buildCrazyEightsHud(baseState, makeHelpers({ getControlledParticipantIds: () => ['p1', 'p3'] }));
        assert.match(hud.centerHtml, /<select id="c8-hud-participant">/u);
        assert.match(hud.centerHtml, /value="p3"/u);
    });
});
