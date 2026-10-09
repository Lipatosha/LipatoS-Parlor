import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAME_GUIDE_RU, BACCARAT_DRAW_GUIDE_RU } from '../scripts/core/GameGuideRu.js';

globalThis.game = { i18n: { lang: 'ru', localize: key => key } };
const { getGameGuide, GAME_REGISTRY } = await import('../scripts/core/GameRegistry.js');

const gameIds = Object.keys(GAME_REGISTRY);
const hasRussian = text => /[А-Яа-яЁё]/u.test(text);

describe('Russian game rules', () => {
    it('provides Russian rules for all registered games, including hidden tables', () => {
        assert.equal(gameIds.length, 12);
        assert.deepEqual(Object.keys(GAME_GUIDE_RU).sort(), gameIds.sort());
        for (const id of gameIds) {
            const guide = getGameGuide(id);
            assert.ok(guide, id);
            assert.ok(hasRussian(guide.summary), `${id}: summary is not Russian`);
            assert.ok(guide.paragraphs.length > 0, `${id}: no game rules`);
            assert.ok(guide.paragraphs.every(hasRussian), `${id}: untranslated paragraph`);
            if (id === 'liarsdice') assert.ok(hasRussian(guide.note), 'Liar’s Dice note');
        }
    });

    it('translates the baccarat third-card reference for the GM', () => {
        const guide = getGameGuide('baccarat');
        assert.equal(guide.accordion, BACCARAT_DRAW_GUIDE_RU);
        assert.equal(guide.accordion.items.length, 6);
        assert.ok(hasRussian(guide.accordion.title));
        assert.ok(guide.accordion.items.every(hasRussian));
    });

    it('supports Russian with a region suffix, and preserves English fallback', () => {
        game.i18n.lang = 'ru-RU';
        assert.match(getGameGuide('baccarat').summary, /Баккара/u);
        game.i18n.lang = 'en';
        assert.match(getGameGuide('baccarat').summary, /^Baccarat is/u);
        game.i18n.lang = 'fr';
        assert.match(getGameGuide('baccarat').summary, /^Baccarat is/u);
        game.i18n.lang = 'ru';
    });

    it('preserves detailed rule paragraphs for Crazy Eights and Beetle Derby', () => {
        assert.equal(getGameGuide('crazyeights').paragraphs.length, 7);
        assert.equal(getGameGuide('beetlerace').paragraphs.length, 4);
    });
});
