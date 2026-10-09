import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'ce-bot-round',
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

const { BotManager } = await import('../scripts/core/BotManager.js');
const { ParlorManager } = await import('../scripts/core/ParlorManager.js');
const { SettlementManager } = await import('../scripts/core/SettlementManager.js');
const { CrazyEightsGame } = await import('../scripts/games/crazyeights/CrazyEightsGame.js');
const { sanitizeCrazyEightsOptions, sortHand, cardKey } = await import('../scripts/games/crazyeights/CrazyEightsRules.js');

const c = (rank, suit) => ({ rank, suit });
const rules = sanitizeCrazyEightsOptions({}).rules;
const baseCtx = { topCard: c('7', 'spades'), currentSuit: 'spades', rules, pendingDraw: 0, stockCount: 20, discardCount: 3 };
const always = value => () => value;

describe('疯狂八机器人决策', () => {
    it('win：甩高分牌，8 攥着', () => {
        const move = BotManager._chooseCrazyEightsMove(
            [c('8', 'hearts'), c('3', 'spades'), c('K', 'spades'), c('9', 'clubs')],
            baseCtx, 'win', [{ id: 'x', count: 5 }], always(0.5)
        );
        assert.equal(move.action, 'playCard');
        assert.equal(cardKey(move.data), 'K-spades');
    });

    it('win：只剩 8 能出时才出 8；下家快赢优先扔功能牌', () => {
        const onlyWild = BotManager._chooseCrazyEightsMove([c('8', 'hearts'), c('9', 'clubs')], baseCtx, 'win', [], always(0.5));
        assert.equal(cardKey(onlyWild.data), '8-hearts');

        const punish = BotManager._chooseCrazyEightsMove(
            [c('J', 'spades'), c('K', 'spades')],
            baseCtx, 'win', [{ id: 'x', count: 1 }], always(0.5)
        );
        assert.equal(cardKey(punish.data), 'J-spades');
    });

    it('win：选花色挑手里最多的；罚抽必叠', () => {
        const suit = BotManager._chooseCrazyEightsMove(
            [c('3', 'clubs'), c('9', 'clubs'), c('K', 'hearts')],
            { ...baseCtx, mustChooseSuit: true }, 'win', [], always(0.5)
        );
        assert.deepEqual(suit, { action: 'chooseSuit', data: { suit: 'clubs' } });

        const stack = BotManager._chooseCrazyEightsMove(
            [c('2', 'hearts'), c('K', 'spades')],
            { ...baseCtx, topCard: c('2', 'spades'), pendingDraw: 2 }, 'win', [], always(0.9)
        );
        assert.equal(move(stack), '2-hearts');

        const noTwo = BotManager._chooseCrazyEightsMove(
            [c('K', 'spades')],
            { ...baseCtx, topCard: c('2', 'spades'), pendingDraw: 2 }, 'win', [], always(0.9)
        );
        assert.equal(noTwo.action, 'draw');
    });

    it('没牌可出就抽，抽不了就过', () => {
        const draw = BotManager._chooseCrazyEightsMove([c('K', 'hearts')], baseCtx, 'win', [], always(0.5));
        assert.equal(draw.action, 'draw');

        const pass = BotManager._chooseCrazyEightsMove([c('K', 'hearts')], { ...baseCtx, stockCount: 0, discardCount: 1 }, 'win', [], always(0.5));
        assert.equal(pass.action, 'pass');
    });

    it('lose：早早扔 8，有牌也可能抽', () => {
        const dump = BotManager._chooseCrazyEightsMove([c('8', 'hearts'), c('K', 'spades')], baseCtx, 'lose', [], always(0.5));
        assert.equal(cardKey(dump.data), '8-hearts');

        const lazy = BotManager._chooseCrazyEightsMove([c('K', 'spades')], baseCtx, 'lose', [], always(0.1));
        assert.equal(lazy.action, 'draw');
    });
});

describe('疯狂八机器人上桌', () => {
    it('轮到机器人就出一次合法动作，并推进回合', async () => {
        SettlementManager.canAfford = () => true;
        SettlementManager.getBalance = () => 1000;
        BotManager._crazyEightsThink = async () => {};

        const table = new CrazyEightsGame({
            sessionId: 'ce-bot',
            playerIds: ['bot_0', 'p2'],
            participants: [
                { id: 'bot_0', type: 'bot', name: 'Bot', botMode: 'win' },
                { id: 'p2', type: 'user', name: 'P2' }
            ]
        });
        table._broadcastState = () => {};
        table.roundToken = 'tok';
        table.round = 1;
        table.roundPlayerIds = ['bot_0', 'p2'];
        table.turnOrder = ['bot_0', 'p2'];
        table.bets = [{ userId: 'bot_0', amount: 10 }, { userId: 'p2', amount: 10 }];
        table._privateHands = new Map([
            ['bot_0', { roundToken: 'tok', version: 1, cards: sortHand([c('K', 'spades'), c('3', 'hearts')]) }],
            ['p2', { roundToken: 'tok', version: 1, cards: [c('4', 'hearts')] }]
        ]);
        table._stock = [c('9', 'diamonds')];
        table._discard = [c('7', 'spades')];
        table.currentSuit = 'spades';
        table.currentPlayerId = 'bot_0';
        table._phase = 'PLAYER_TURNS';
        table._syncCounts();

        const state = table.getState();
        assert.equal(ParlorManager._hasPendingBotWork(state), true);

        await BotManager.executeBotActions(table);
        assert.equal(cardKey(table.discardTop), 'K-spades');
        assert.equal(table.currentPlayerId, 'p2');
        assert.equal(ParlorManager._hasPendingBotWork(table.getState()), false);
    });
});

function move(result) {
    return cardKey(result.data);
}
