import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { scoreTexasStartingHand } = await import('../scripts/games/texasholdem/TexasStartingHand.js');

function hand(leftRank, rightRank, { suited = false } = {}) {
    return [
        { rank: leftRank, suit: 'spades' },
        { rank: rightRank, suit: suited ? 'spades' : 'hearts' }
    ];
}

describe('Texas starting hand score', () => {
    it('保持常见强弱顺序 AA > AKs > AKo > 72o', () => {
        const aa = scoreTexasStartingHand(hand('A', 'A'));
        const aceKingSuited = scoreTexasStartingHand(hand('A', 'K', { suited: true }));
        const aceKingOffsuit = scoreTexasStartingHand(hand('A', 'K'));
        const sevenTwoOffsuit = scoreTexasStartingHand(hand('7', '2'));

        assert.ok(aa > aceKingSuited);
        assert.ok(aceKingSuited > aceKingOffsuit);
        assert.ok(aceKingOffsuit > sevenTwoOffsuit);
    });

    it('奖励对子、同花与连张，惩罚大间隔低牌', () => {
        assert.ok(scoreTexasStartingHand(hand('9', '9')) > scoreTexasStartingHand(hand('9', '4')));
        assert.ok(
            scoreTexasStartingHand(hand('J', '9', { suited: true }))
            > scoreTexasStartingHand(hand('J', '9'))
        );
        assert.ok(scoreTexasStartingHand(hand('9', '8')) > scoreTexasStartingHand(hand('9', '3')));
        assert.ok(scoreTexasStartingHand(hand('6', '5')) > scoreTexasStartingHand(hand('6', '2')));
    });

    it('始终返回 0 到 1，缺牌时返回 0', () => {
        assert.equal(scoreTexasStartingHand([]), 0);
        assert.equal(scoreTexasStartingHand([{ rank: 'A', suit: 'spades' }]), 0);

        for (const cards of [
            hand('A', 'A'),
            hand('K', 'Q', { suited: true }),
            hand('7', '2')
        ]) {
            const score = scoreTexasStartingHand(cards);
            assert.ok(score >= 0 && score <= 1);
        }
    });
});
