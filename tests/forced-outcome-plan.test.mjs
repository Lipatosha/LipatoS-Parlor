import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

globalThis.foundry = {
    utils: {
        randomID: () => 'sid-forced-outcome'
    }
};

globalThis.game = {
    user: { id: 'gm1', isGM: true },
    users: { get: () => null },
    actors: { get: () => null },
    i18n: {
        localize: key => key,
        format: key => key
    }
};

const { ForcedOutcomePlan } = await import('../scripts/core/ForcedOutcomePlan.js');
const { ParlorManager } = await import('../scripts/core/ParlorManager.js');
const { SocketManager } = await import('../scripts/core/SocketManager.js');

describe('ForcedOutcomePlan', () => {
    it('把旧 win / lose / hand 输入迁移到新牌运模型', () => {
        const blackjack = ForcedOutcomePlan.sanitize('blackjack', {
            entries: {
                p1: { mode: 'blackjack' },
                p2: { mode: 'win' },
                p3: { mode: 'lose' }
            }
        });

        assert.deepEqual(blackjack.luckByParticipantId, {
            p2: 'good',
            p3: 'bad'
        });
        assert.equal(blackjack.customHand.participantId, 'p1');
        assert.equal(blackjack.customHand.handType, 'natural-blackjack');

        const texas = ForcedOutcomePlan.sanitize('texasholdem', {
            entries: {
                p1: { mode: 'win' },
                p2: { mode: 'hand', handType: 'royal-flush' }
            }
        });

        assert.deepEqual(texas.luckByParticipantId, { p1: 'good' });
        assert.equal(texas.customHand.participantId, 'p2');
        assert.equal(texas.customHand.handType, 'royal-flush');
        assert.deepEqual(texas.errors, []);
    });

    it('不再暴露固定开牌、固定庄家或固定德州模板构建器', () => {
        assert.equal(ForcedOutcomePlan.buildBlackjackOpeningHand, undefined);
        assert.equal(ForcedOutcomePlan.buildBlackjackDealerOpeningHand, undefined);
        assert.equal(ForcedOutcomePlan.pickBlackjackHitCard, undefined);
        assert.equal(ForcedOutcomePlan.buildTexasHoldemDealPlan, undefined);
    });

    it('迁移旧 Texas 设置时不修改调用方输入', () => {
        const legacy = {
            entries: {
                p1: { mode: 'hand', handType: 'royal-flush' },
                p2: { mode: 'lose' },
                p3: { mode: 'normal' }
            }
        };
        const before = structuredClone(legacy);
        const plan = ForcedOutcomePlan.sanitize('texasholdem', legacy, ['p1', 'p2', 'p3']);

        assert.deepEqual(legacy, before);
        assert.deepEqual(plan.luckByParticipantId, { p2: 'bad' });
        assert.equal(plan.customHand.participantId, 'p1');
        assert.equal(plan.customHand.handType, 'royal-flush');
    });
});

describe('ParlorManager card luck privacy', () => {
    beforeEach(() => {
        ParlorManager._sessions.clear();
        ParlorManager._pendingPrivateStartOptions.clear();
    });

    it('牌运设置只进入 host 私密启动选项，不进入公开广播', async () => {
        let capturedEvent = null;
        let capturedPayload = null;
        SocketManager._socket = {
            executeForEveryone: async (eventName, payload) => {
                capturedEvent = eventName;
                capturedPayload = payload;
            }
        };

        const cardLuckPlan = {
            gameType: 'blackjack',
            luckByParticipantId: { 'actor:p1': 'good' },
            customHand: {
                participantId: 'actor:p1',
                gameType: 'blackjack',
                handType: 'natural-blackjack',
                pending: true
            },
            errors: []
        };
        const gameOptions = { settlementMode: 'chips', betLimits: { min: 5, max: 0 } };

        await ParlorManager.startGame(
            'blackjack',
            [{ id: 'actor:p1', type: 'user', name: 'P1' }],
            true,
            null,
            gameOptions,
            { cardLuckPlan }
        );

        assert.equal(capturedEvent, 'startGame');
        assert.deepEqual(capturedPayload.gameOptions, gameOptions);
        assert.equal(Object.hasOwn(capturedPayload, 'gmOnlyOptions'), false);
        assert.equal(Object.hasOwn(capturedPayload.gameOptions, 'cardLuckPlan'), false);
        assert.equal(Object.hasOwn(capturedPayload.gameOptions, 'customHand'), false);
        assert.deepEqual(
            ParlorManager._pendingPrivateStartOptions.get('sid-forced-outcome'),
            { cardLuckPlan }
        );
    });
});
