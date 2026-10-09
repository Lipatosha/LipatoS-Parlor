import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const mainSource = readFileSync('scripts/main.js', 'utf8').replace(/\r\n/gu, '\n');
const en = JSON.parse(readFileSync('languages/en.json', 'utf8'));
const cn = JSON.parse(readFileSync('languages/cn.json', 'utf8'));

describe('debug presenter registration', () => {
    it('exposes dummy and crashing presenter registration helpers', () => {
        assert.match(mainSource, /class DummyTexasPresenter/u);
        assert.match(mainSource, /class CrashingTexasPresenter/u);
        assert.match(mainSource, /function registerDummyPresenter\(\)/u);
        assert.match(mainSource, /function registerCrashingPresenter\(\)/u);
        assert.match(mainSource, /id: 'presenter-smoke'/u);
        assert.match(mainSource, /id: 'presenter-crash'/u);
        assert.match(mainSource, /'table:texasholdem': DummyTexasPresenter/u);
        assert.match(mainSource, /'table:texasholdem': CrashingTexasPresenter/u);
        assert.match(mainSource, /registerDummyPresenter: \(\) => registerDummyPresenter\(\)/u);
        assert.match(mainSource, /registerCrashingPresenter: \(\) => registerCrashingPresenter\(\)/u);
    });

    it('renders real presenter seat and status data from the gameApi', () => {
        assert.match(mainSource, /this\.gameApi\.getState\(\)/u);
        assert.match(mainSource, /this\.gameApi\.getSeats\(\)/u);
        assert.match(mainSource, /this\.gameApi\.getStatus\(\)/u);
        assert.match(mainSource, /status\?\.phase/u);
        assert.match(mainSource, /seat\.statusText/u);
        assert.match(mainSource, /seat\.chips/u);
        assert.match(mainSource, /this\.gameApi\.requestClose\(\)/u);
    });

    it('has bilingual debug theme labels', () => {
        assert.equal(en.PARLOR.Debug.PresenterSmoke, 'Presenter smoke test');
        assert.equal(en.PARLOR.Debug.PresenterCrash, 'Presenter crash test');
        assert.equal(cn.PARLOR.Debug.PresenterSmoke, 'Presenter 冒烟测试');
        assert.equal(cn.PARLOR.Debug.PresenterCrash, 'Presenter 崩溃测试');
    });
});
