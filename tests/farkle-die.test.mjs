import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { renderFarkleDie } from '../scripts/games/zonk/FarkleDie.js';

const read = async path => readFile(new URL('../' + path, import.meta.url), 'utf8');

describe('Farkle isolated D6 faces', () => {
    it('renders all six different values with actual white HTML face and correct black pips', () => {
        for (let face = 1; face <= 6; face++) {
            const html = renderFarkleDie(face);
            assert.ok(html.includes('data-face="' + face + '"'), 'Face id mismatch');
            assert.ok(html.includes('class="parlor-farkle-face"'), 'Missing independent wrapper');
            assert.ok(html.includes('class="parlor-farkle-face-white"'), 'Missing visible white area');
            assert.ok(html.includes('background:#ffffff'), 'Missing visible white fallback');
            assert.ok(html.includes('background:#2b2b2b'), 'Missing dark dots');
            assert.equal((html.match(/class="parlor-farkle-pip"/g) || []).length, face, 'Wrong dot count');
            assert.ok(!html.includes('parlor-d6-face'), 'No dependency on global sprite CSS');
            assert.ok(!html.includes('parlor-ld-die'), 'No dependency on legacy shared dice CSS');
            assert.ok(!html.includes('<svg'), 'No SVG subject to foreign DOM rules');
            assert.ok(!html.includes('<img'), 'No image URLs or cropping dependencies');
        }
    });

    it('keeps small dice visible in history and scores, with properly clamped values', () => {
        const small = renderFarkleDie(5, true);
        assert.ok(small.includes('parlor-farkle-face is-small'));
        assert.equal((small.match(/class="parlor-farkle-pip"/g) || []).length, 5);
        assert.ok(renderFarkleDie(0).includes('data-face="1"'));
        assert.ok(renderFarkleDie(9).includes('data-face="6"'));
    });

    it('does not share paint selectors with Parlor global dice styles', async () => {
        const [css, global] = await Promise.all([
            read('styles/zonk-v14.css'), read('styles/dice-faces.css')
        ]);
        assert.ok(css.includes('#parlor-zonk-overlay .parlor-farkle-face {'));
        assert.ok(css.includes('.parlor-zonk-roll-zone .parlor-zonk-dice-tray button.parlor-zonk-pick > .parlor-farkle-face'));
        assert.ok(css.includes('.parlor-zonk-stair-slot .parlor-farkle-face'));
        assert.ok(css.includes('.parlor-zonk-history-dice .parlor-farkle-face'));
        assert.ok(css.includes('.parlor-zonk-rules-combos .parlor-farkle-face'));
        assert.ok(!global.includes('.parlor-farkle-face'));
    });
});
