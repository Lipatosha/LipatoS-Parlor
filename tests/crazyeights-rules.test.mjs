import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    sanitizeCrazyEightsOptions,
    getDeckCount,
    getHandSize,
    buildStock,
    sortHand,
    cardKey,
    cardPoints,
    handPoints,
    canPlayCard,
    getLegalActions,
    resolvePlayEffect,
    getNextIndex,
    reshuffleDiscardIntoStock,
    takeFromStock,
    isDeadRound,
    rankLowestHands,
    chooseBestSuit,
    computeSettlement
} from '../scripts/games/crazyeights/CrazyEightsRules.js';

const c = (rank, suit) => ({ rank, suit });
const tavern = sanitizeCrazyEightsOptions({}).rules;
const classic = sanitizeCrazyEightsOptions({ actionCards: 'classic' }).rules;
const untilPlayable = sanitizeCrazyEightsOptions({ drawRule: 'untilPlayable' }).rules;

function sequenceRng(values) {
    let i = 0;
    return () => values[i++ % values.length];
}

describe('疯狂八规则：开桌参数', () => {
    it('默认值与预设翻译成标志位', () => {
        const options = sanitizeCrazyEightsOptions({});
        assert.equal(options.ante, 10);
        assert.equal(options.penaltyPerPoint, 0);
        assert.equal(options.drawRule, 'one');
        assert.equal(options.actionCards, 'tavern');
        assert.deepEqual(options.rules, {
            wildRank: '8', skipRank: 'J', reverseRank: 'Q', drawTwoRank: '2',
            drawRule: 'one', maxDrawPerTurn: 1, playAfterDraw: 'any'
        });
    });

    it('经典预设只有 8 万能，抽到能出上限三张', () => {
        const options = sanitizeCrazyEightsOptions({ actionCards: 'classic', drawRule: 'untilPlayable', ante: '25', penaltyPerPoint: 2.7 });
        assert.equal(options.rules.skipRank, null);
        assert.equal(options.rules.reverseRank, null);
        assert.equal(options.rules.drawTwoRank, null);
        assert.equal(options.rules.maxDrawPerTurn, 3);
        assert.equal(options.ante, 25);
        assert.equal(options.penaltyPerPoint, 2);
    });

    it('坏值回默认', () => {
        const options = sanitizeCrazyEightsOptions({ ante: -3, penaltyPerPoint: 'x', drawRule: 'nope', actionCards: 'uno' });
        assert.equal(options.ante, 10);
        assert.equal(options.penaltyPerPoint, 0);
        assert.equal(options.drawRule, 'one');
        assert.equal(options.actionCards, 'tavern');
    });
});

describe('疯狂八规则：牌与手牌', () => {
    it('5 人以内一副，6 人起两副；2 人 7 张，3 人起 5 张', () => {
        assert.equal(getDeckCount(2), 1);
        assert.equal(getDeckCount(5), 1);
        assert.equal(getDeckCount(6), 2);
        assert.equal(getDeckCount(8), 2);
        assert.equal(getHandSize(2), 7);
        assert.equal(getHandSize(3), 5);
        assert.equal(getHandSize(8), 5);
    });

    it('buildStock 按注入随机源确定，两副牌每张各两份', () => {
        const a = buildStock(1, sequenceRng([0.1, 0.7, 0.3]));
        const b = buildStock(1, sequenceRng([0.1, 0.7, 0.3]));
        assert.equal(a.length, 52);
        assert.deepEqual(a.map(cardKey), b.map(cardKey));
        assert.equal(new Set(a.map(cardKey)).size, 52);

        const two = buildStock(2, sequenceRng([0.5]));
        assert.equal(two.length, 104);
        const counts = {};
        for (const card of two) counts[cardKey(card)] = (counts[cardKey(card)] || 0) + 1;
        assert.ok(Object.values(counts).every(n => n === 2));
    });

    it('sortHand 花色序再点数序', () => {
        const sorted = sortHand([c('K', 'spades'), c('2', 'hearts'), c('A', 'hearts'), c('10', 'clubs'), c('8', 'diamonds')]);
        assert.deepEqual(sorted.map(cardKey), ['A-hearts', '2-hearts', '8-diamonds', '10-clubs', 'K-spades']);
    });

    it('点数：8=50，JQK=10，A=1，其余面值', () => {
        assert.equal(cardPoints(c('8', 'hearts'), tavern), 50);
        assert.equal(cardPoints(c('K', 'hearts'), tavern), 10);
        assert.equal(cardPoints(c('A', 'hearts'), tavern), 1);
        assert.equal(cardPoints(c('10', 'hearts'), tavern), 10);
        assert.equal(cardPoints(c('7', 'hearts'), tavern), 7);
        assert.equal(handPoints([c('8', 'hearts'), c('A', 'clubs'), c('4', 'clubs')], tavern), 55);
    });
});

describe('疯狂八规则：能不能出', () => {
    const top = c('7', 'spades');

    it('同花色 / 同点数 / 8 万能', () => {
        assert.ok(canPlayCard(c('K', 'spades'), { topCard: top, currentSuit: 'spades', rules: tavern }));
        assert.ok(canPlayCard(c('7', 'hearts'), { topCard: top, currentSuit: 'spades', rules: tavern }));
        assert.ok(canPlayCard(c('8', 'hearts'), { topCard: top, currentSuit: 'spades', rules: tavern }));
        assert.equal(canPlayCard(c('K', 'hearts'), { topCard: top, currentSuit: 'spades', rules: tavern }), false);
    });

    it('出过 8 之后看指定花色，不看 8 本身的花色', () => {
        const eight = c('8', 'spades');
        assert.ok(canPlayCard(c('K', 'hearts'), { topCard: eight, currentSuit: 'hearts', rules: tavern }));
        assert.equal(canPlayCard(c('K', 'spades'), { topCard: eight, currentSuit: 'hearts', rules: tavern }), false);
        assert.ok(canPlayCard(c('8', 'clubs'), { topCard: eight, currentSuit: 'hearts', rules: tavern }));
    });

    it('头上压着罚抽只能出 2，8 也不行', () => {
        const ctx = { topCard: c('2', 'spades'), currentSuit: 'spades', rules: tavern, pendingDraw: 2 };
        assert.ok(canPlayCard(c('2', 'hearts'), ctx));
        assert.equal(canPlayCard(c('8', 'spades'), ctx), false);
        assert.equal(canPlayCard(c('K', 'spades'), ctx), false);
    });
});

describe('疯狂八规则：合法动作', () => {
    const top = c('7', 'spades');
    const base = { topCard: top, currentSuit: 'spades', rules: tavern, stockCount: 10, discardCount: 3 };

    it('抽一张规则：回合开始能抽不能过；抽完只能出或过', () => {
        const fresh = getLegalActions([c('K', 'hearts')], base);
        assert.equal(fresh.canDraw, true);
        assert.equal(fresh.canPass, false);

        const drawn = getLegalActions([c('K', 'hearts'), c('7', 'diamonds')], { ...base, drawnThisTurn: true, drawCountThisTurn: 1 });
        assert.equal(drawn.canDraw, false);
        assert.equal(drawn.canPass, true);
        assert.equal(drawn.playable.length, 1);
    });

    it('牌堆和弃牌堆都空了：不能抽，可以过', () => {
        const legal = getLegalActions([c('K', 'hearts')], { ...base, stockCount: 0, discardCount: 1 });
        assert.equal(legal.cardsAvailable, false);
        assert.equal(legal.canDraw, false);
        assert.equal(legal.canPass, true);
    });

    it('待选花色时什么都不能做', () => {
        const legal = getLegalActions([c('K', 'spades')], { ...base, mustChooseSuit: true });
        assert.equal(legal.mustChooseSuit, true);
        assert.equal(legal.playable.length, 0);
        assert.equal(legal.canDraw, false);
        assert.equal(legal.canPass, false);
    });

    it('待罚抽：能出的只有 2，抽=接罚，不能过', () => {
        const legal = getLegalActions([c('2', 'hearts'), c('7', 'hearts')], { ...base, topCard: c('2', 'spades'), pendingDraw: 2 });
        assert.deepEqual(legal.playable.map(cardKey), ['2-hearts']);
        assert.equal(legal.canDraw, true);
        assert.equal(legal.canPass, false);
    });

    it('抽到能出规则：有牌能出就必须出；三张后仍无才可过', () => {
        const ctx = { ...base, rules: untilPlayable };
        const mustPlay = getLegalActions([c('7', 'hearts')], { ...ctx, drawCountThisTurn: 1 });
        assert.equal(mustPlay.canDraw, false);
        assert.equal(mustPlay.canPass, false);

        const keepDrawing = getLegalActions([c('K', 'hearts')], { ...ctx, drawCountThisTurn: 2 });
        assert.equal(keepDrawing.canDraw, true);
        assert.equal(keepDrawing.canPass, false);

        const exhausted = getLegalActions([c('K', 'hearts')], { ...ctx, drawCountThisTurn: 3 });
        assert.equal(exhausted.canDraw, false);
        assert.equal(exhausted.canPass, true);

        const noCards = getLegalActions([c('K', 'hearts')], { ...ctx, stockCount: 0, discardCount: 1 });
        assert.equal(noCards.canDraw, false);
        assert.equal(noCards.canPass, true);
    });
});

describe('疯狂八规则：功能牌与轮转', () => {
    it('酒馆规矩：J 跳过、Q 反转、2 罚抽、8 万能', () => {
        assert.deepEqual(resolvePlayEffect(c('J', 'hearts'), { rules: tavern, playerCount: 3 }), { wild: false, addDraw: 0, skipNext: true, reverse: false });
        assert.deepEqual(resolvePlayEffect(c('Q', 'hearts'), { rules: tavern, playerCount: 3 }), { wild: false, addDraw: 0, skipNext: false, reverse: true });
        assert.deepEqual(resolvePlayEffect(c('2', 'hearts'), { rules: tavern, playerCount: 3 }), { wild: false, addDraw: 2, skipNext: false, reverse: false });
        assert.deepEqual(resolvePlayEffect(c('8', 'hearts'), { rules: tavern, playerCount: 3 }), { wild: true, addDraw: 0, skipNext: false, reverse: false });
    });

    it('2 人局 Q 当跳过，方向不翻', () => {
        assert.deepEqual(resolvePlayEffect(c('Q', 'hearts'), { rules: tavern, playerCount: 2 }), { wild: false, addDraw: 0, skipNext: true, reverse: false });
    });

    it('经典预设 J/Q/2 都是普通牌', () => {
        for (const rank of ['J', 'Q', '2']) {
            assert.deepEqual(resolvePlayEffect(c(rank, 'hearts'), { rules: classic, playerCount: 3 }), { wild: false, addDraw: 0, skipNext: false, reverse: false });
        }
    });

    it('getNextIndex 环绕与反向', () => {
        assert.equal(getNextIndex(5, 4, 1, 1), 0);
        assert.equal(getNextIndex(5, 0, -1, 1), 4);
        assert.equal(getNextIndex(2, 0, 1, 2), 0);
        assert.equal(getNextIndex(3, 1, -1, 2), 2);
    });
});

describe('疯狂八规则：牌堆', () => {
    it('牌堆空了洗弃牌堆、顶牌留下；只剩顶牌就不洗', () => {
        const result = reshuffleDiscardIntoStock({ stock: [], discard: [c('3', 'hearts'), c('4', 'hearts'), c('7', 'spades')] }, sequenceRng([0.2]));
        assert.equal(result.reshuffled, true);
        assert.equal(result.stock.length, 2);
        assert.deepEqual(result.discard.map(cardKey), ['7-spades']);

        const untouched = reshuffleDiscardIntoStock({ stock: [], discard: [c('7', 'spades')] }, sequenceRng([0.2]));
        assert.equal(untouched.reshuffled, false);
        assert.equal(untouched.stock.length, 0);
    });

    it('takeFromStock 从栈顶拿，不够就少给', () => {
        const stock = [c('3', 'hearts'), c('4', 'hearts')];
        const one = takeFromStock({ stock, discard: [c('7', 'spades')] }, 1);
        assert.deepEqual(one.cards.map(cardKey), ['4-hearts']);
        assert.equal(one.stock.length, 1);

        const short = takeFromStock({ stock: [c('3', 'hearts')], discard: [c('7', 'spades')] }, 4, sequenceRng([0.1]));
        assert.deepEqual(short.cards.map(cardKey), ['3-hearts']);
        assert.equal(short.stock.length, 0);
        assert.equal(short.reshuffled, false);

        const across = takeFromStock({ stock: [c('3', 'hearts')], discard: [c('5', 'clubs'), c('6', 'clubs'), c('7', 'spades')] }, 3, sequenceRng([0.1]));
        assert.equal(across.cards.length, 3);
        assert.equal(across.reshuffled, true);
        assert.deepEqual(across.discard.map(cardKey), ['7-spades']);
    });

    it('流局判定：牌堆空、弃牌堆只剩顶牌、一整圈没人能出', () => {
        assert.equal(isDeadRound({ stockCount: 0, discardCount: 1, passStreak: 3, playerCount: 3 }), true);
        assert.equal(isDeadRound({ stockCount: 0, discardCount: 1, passStreak: 2, playerCount: 3 }), false);
        assert.equal(isDeadRound({ stockCount: 1, discardCount: 1, passStreak: 3, playerCount: 3 }), false);
        assert.equal(isDeadRound({ stockCount: 0, discardCount: 2, passStreak: 3, playerCount: 3 }), false);
    });
});

describe('疯狂八规则：判胜与结算', () => {
    it('最低点数并列全算赢家', () => {
        const result = rankLowestHands({ a: [c('8', 'hearts')], b: [c('5', 'clubs')], c: [c('2', 'clubs'), c('3', 'clubs')] }, tavern);
        assert.deepEqual(result.winnerIds, ['b', 'c']);
        assert.equal(result.pointsById.a, 50);
    });

    it('chooseBestSuit 取手里最多的花色，8 不计，并列按顺序', () => {
        assert.equal(chooseBestSuit([c('3', 'clubs'), c('9', 'clubs'), c('K', 'hearts'), c('8', 'hearts')], tavern), 'clubs');
        assert.equal(chooseBestSuit([c('8', 'hearts')], tavern), 'hearts');
        assert.equal(chooseBestSuit([c('3', 'diamonds'), c('9', 'spades')], tavern), 'diamonds');
    });

    it('单赢家：底注入池 + 尾牌罚金封顶在余额减底注，无限席位不封顶', () => {
        const result = computeSettlement({
            kind: 'win',
            winnerIds: ['w'],
            playerIds: ['w', 'poor', 'bot_1'],
            handsById: { w: [], poor: [c('8', 'hearts'), c('K', 'clubs')], bot_1: [c('8', 'spades')] },
            ante: 10,
            penaltyPerPoint: 1,
            rules: tavern,
            getBalance: id => (id === 'poor' ? 15 : 1000),
            isUnlimited: id => id === 'bot_1'
        });
        assert.equal(result.pot, 30);
        const rows = Object.fromEntries(result.rows.map(row => [row.id, row]));
        assert.equal(rows.poor.points, 60);
        assert.equal(rows.poor.penalty, 5);
        assert.equal(rows.bot_1.penalty, 50);
        assert.equal(rows.w.payout, 85);
        assert.equal(rows.w.net, 75);
        assert.equal(rows.poor.net, -15);
        assert.equal(rows.bot_1.net, -60);
        assert.equal(result.deltas.reduce((sum, entry) => sum + entry.delta, 0), 0);
    });

    it('单价为 0 就没有罚金', () => {
        const result = computeSettlement({
            kind: 'win', winnerIds: ['w'], playerIds: ['w', 'l'],
            handsById: { w: [], l: [c('8', 'hearts')] }, ante: 10, penaltyPerPoint: 0, rules: tavern
        });
        assert.equal(result.rows.find(row => row.id === 'l').penalty, 0);
        assert.equal(result.rows.find(row => row.id === 'w').net, 10);
    });

    it('流局平分底注池，不算罚金', () => {
        const result = computeSettlement({
            kind: 'dead', winnerIds: ['a', 'b'], playerIds: ['a', 'b', 'c'],
            handsById: { a: [c('3', 'hearts')], b: [c('3', 'clubs')], c: [c('8', 'clubs')] },
            ante: 10, penaltyPerPoint: 5, rules: tavern
        });
        assert.equal(result.payoutPerWinner, 15);
        const rows = Object.fromEntries(result.rows.map(row => [row.id, row]));
        assert.equal(rows.a.net, 5);
        assert.equal(rows.b.net, 5);
        assert.equal(rows.c.net, -10);
        assert.equal(rows.c.penalty, 0);
    });
});
