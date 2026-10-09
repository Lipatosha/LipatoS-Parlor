import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { curtainMotion } from '../scripts/games/beetlerace/BeetleRaceOpening.js';

describe('甲虫赛跑 · 拉幕节奏', () => {
    it('开头合幕，结束时整幅移出画面；赛事名先淡出，布料只轻微收褶', () => {
        assert.equal(curtainMotion(0).shift, 0);
        assert.equal(curtainMotion(0).titleOpacity, 1);
        assert.equal(curtainMotion(0.4).titleOpacity, 0);
        assert.ok(curtainMotion(0.4).open < 1);
        assert.ok(curtainMotion(1).shift > 100);
        assert.ok(curtainMotion(1).gather > 0.9);
        assert.ok(Math.abs(curtainMotion(1).sway) < 1e-10);
    });

    it('拉幕单调且连续，迟到、重播及越界进度都可直接定位', () => {
        let previous = 0;
        for (let i = 0; i <= 100; i++) {
            const pose = curtainMotion(i / 100);
            assert.ok(pose.open >= previous);
            assert.ok(pose.open - previous < 0.03);
            previous = pose.open;
        }
        assert.deepEqual(curtainMotion(-1), curtainMotion(0));
        assert.deepEqual(curtainMotion(2), curtainMotion(1));
    });
});
