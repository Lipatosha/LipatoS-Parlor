import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

globalThis.foundry = {
    utils: {
        getProperty: () => null
    }
};

globalThis.game = {
    system: { id: 'generic' },
    user: { id: 'gm1', isGM: true },
    users: { get: () => null },
    actors: { get: () => null }
};

const { CardLuckPlan } = await import('../scripts/core/CardLuckPlan.js');
const { GameBase } = await import('../scripts/games/GameBase.js');

class TestBlackjackGame extends GameBase {
    static gameType = 'blackjack';

    get phases() { return ['IDLE']; }
    get transitions() { return { IDLE: [] }; }
}

describe('CardLuckPlan', () => {
    it('清洗每玩家牌运并过滤不在牌桌上的参与者', () => {
        const plan = CardLuckPlan.sanitize('blackjack', {
            luckByParticipantId: {
                p1: 'good',
                p2: 'bad',
                p3: 'good',
                p4: 'normal'
            },
            customHand: {
                participantId: 'p1',
                handType: 'natural-blackjack'
            }
        }, ['p1', 'p2', 'p4']);

        assert.deepEqual(plan.luckByParticipantId, {
            p1: 'good',
            p2: 'bad'
        });
        assert.deepEqual(plan.customHand, {
            participantId: 'p1',
            gameType: 'blackjack',
            handType: 'natural-blackjack',
            pending: true
        });
        assert.deepEqual(plan.errors, []);
    });

    it('把旧 win / lose 与旧定制值迁移到新模型', () => {
        const blackjack = CardLuckPlan.sanitize('blackjack', {
            entries: {
                p1: { mode: 'win' },
                p2: { mode: 'lose' },
                p3: { mode: 'blackjack' }
            }
        }, ['p1', 'p2', 'p3']);

        assert.deepEqual(blackjack.luckByParticipantId, {
            p1: 'good',
            p2: 'bad'
        });
        assert.equal(blackjack.customHand.participantId, 'p3');
        assert.equal(blackjack.customHand.handType, 'natural-blackjack');

        const texas = CardLuckPlan.sanitize('texasholdem', {
            entries: {
                p1: { mode: 'win' },
                p2: { mode: 'lose' },
                p3: { mode: 'hand', handType: 'full-house' }
            }
        }, ['p1', 'p2', 'p3']);

        assert.deepEqual(texas.luckByParticipantId, {
            p1: 'good',
            p2: 'bad'
        });
        assert.deepEqual(texas.customHand, {
            participantId: 'p3',
            gameType: 'texasholdem',
            handType: 'full-house',
            pending: true
        });
    });

    it('旧输入里出现多个定制目标时采用最后一项，等价于转移目标', () => {
        const plan = CardLuckPlan.sanitize('texasholdem', {
            entries: {
                p1: { mode: 'hand', handType: 'flush' },
                p2: { mode: 'royal-flush' }
            }
        }, ['p1', 'p2']);

        assert.equal(plan.customHand.participantId, 'p2');
        assert.equal(plan.customHand.handType, 'royal-flush');
        assert.deepEqual(plan.errors, []);
    });

    it('成功消费定制牌型但不改变长期牌运，失败时保留原计划', () => {
        const plan = CardLuckPlan.sanitize('texasholdem', {
            luckByParticipantId: { p1: 'bad', p2: 'good' },
            customHand: { participantId: 'p1', handType: 'flush' }
        }, ['p1', 'p2']);

        const unchanged = CardLuckPlan.consumeCustomHand(plan, { committed: false });
        assert.equal(unchanged, plan);
        assert.equal(unchanged.customHand.pending, true);

        const consumed = CardLuckPlan.consumeCustomHand(plan, { committed: true });
        assert.notEqual(consumed, plan);
        assert.equal(consumed.customHand, null);
        assert.deepEqual(consumed.luckByParticipantId, plan.luckByParticipantId);
        assert.equal(plan.customHand.pending, true);
    });

    it('提供默认正常牌运和可控状态判断', () => {
        const empty = CardLuckPlan.sanitize('blackjack', {}, ['p1']);
        assert.equal(CardLuckPlan.getLuck(empty, 'p1'), 'normal');
        assert.equal(CardLuckPlan.hasInfluence(empty), false);

        const influenced = CardLuckPlan.sanitize('blackjack', {
            luckByParticipantId: { p1: 'good' }
        }, ['p1']);
        assert.equal(CardLuckPlan.getLuck(influenced, 'p1'), 'good');
        assert.equal(CardLuckPlan.hasInfluence(influenced), true);
    });
});

describe('GameBase card luck privacy', () => {
    it('只把牌运计划保存在游戏实例，不进入公开状态', () => {
        const table = new TestBlackjackGame({
            sessionId: 'session-1',
            playerIds: ['p1'],
            participants: [{ id: 'p1', type: 'user', name: 'P1' }],
            gmOnlyOptions: {
                cardLuckPlan: {
                    luckByParticipantId: { p1: 'good' },
                    customHand: { participantId: 'p1', handType: 'natural-blackjack' }
                }
            }
        });

        assert.equal(table.cardLuckPlan.luckByParticipantId.p1, 'good');
        assert.equal(table.cardLuckPlan.customHand.participantId, 'p1');

        const publicState = table.getState();
        assert.equal(Object.hasOwn(publicState, 'cardLuckPlan'), false);
        assert.equal(Object.hasOwn(publicState, 'customHand'), false);
        assert.equal(Object.hasOwn(publicState, 'forcedOutcomePlan'), false);
    });
});
