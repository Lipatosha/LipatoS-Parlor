import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
    D6_SPRITE_PATH,
    normalizeD6,
    renderD6Face,
    applyD6Face
} from '../scripts/core/DiceFaces.js';

const source = async path => readFile(new URL('../' + path, import.meta.url), 'utf8');

describe('Shared user-supplied white D6 dice artwork', () => {
    it('packages a real lossless WebP containing all six uploaded dice', async () => {
        const blob = await readFile(new URL('../assets/dice/d6-white-faces.webp', import.meta.url));
        assert.equal(blob.toString('ascii', 0, 4), 'RIFF');
        assert.equal(blob.toString('ascii', 8, 12), 'WEBP');
        assert.ok(blob.length > 1000, 'The real image data is included, not a placeholder');
        assert.equal(D6_SPRITE_PATH, 'modules/parlor/assets/dice/d6-white-faces.webp');
        const manifest = JSON.parse(await source('module.json'));
        assert.ok(manifest.styles.includes('styles/dice-faces.css'));
        assert.ok(manifest.styles.indexOf('styles/dice-faces.css') < manifest.styles.indexOf('styles/farkle-widescreen.css'), 'Shared dice assets load before the final Farkle layout');
    });

    it('renders each physical die face in correct index order, not fabricated pips', () => {
        for (let value = 1; value <= 6; value++) {
            const html = renderD6Face(value, { className: 'parlor-ld-die', small: true });
            assert.ok(html.includes('--parlor-d6-index:' + (value - 1) + ';'));
            assert.ok(html.includes('data-value="' + value + '"'));
            assert.ok(html.includes('--parlor-d6-position:' + (value - 1) * 20 + '%'));
            assert.ok(html.includes('is-small'));
            assert.ok(!html.includes('parlor-ld-pip'));
        }
        assert.equal(normalizeD6(0), 1);
        assert.equal(normalizeD6(8), 6);
        assert.equal(normalizeD6(NaN), 1);
        assert.ok(!renderD6Face(1, { className: '<img src=x>' }).includes('<img'));
    });

    it('decorates tavern DOM elements with the same uploaded face sprite', () => {
        const classes = new Set();
        const styles = new Map();
        const attrs = {};
        const el = {
            classList: { add: name => classes.add(name) },
            dataset: {},
            style: { setProperty: (key, value) => styles.set(key, value) },
            setAttribute: (key, value) => { attrs[key] = value; }
        };
        assert.equal(applyD6Face(el, 4), el);
        assert.equal(styles.get('--parlor-d6-index'), '3');
        assert.equal(styles.get('--parlor-d6-position'), '60%');
        assert.equal(el.dataset.v, '4');
        assert.equal(attrs.role, 'img');
        assert.ok(classes.has('parlor-d6-face'));
    });

    it('uses uploaded sprites in other games while Farkle isolates its own visible dice', async () => {
        const paths = [
            'scripts/games/liarsdice/LiarsDiceTable.js',
            'scripts/games/liarsdice/LiarsDicePresenterData.js',
            'scripts/games/bone21/Bone21Table.js',
            'scripts/tavern/presenters/TavernTableShell.js',
            'scripts/tavern/presenters/Bone21TablePresenter.js'
        ];
        for (const path of paths) {
            const code = await source(path);
            assert.ok(/renderD6Face|applyD6Face/.test(code), 'Missing shared dice art: ' + path);
            assert.ok(!code.includes('DIE_PIPS'), 'Legacy drawn dots remain: ' + path);
        }
        const farkleTable = await source('scripts/games/zonk/ZonkTable.js');
        const farkleFaces = await source('scripts/games/zonk/FarkleDie.js');
        assert.ok(farkleTable.includes("renderFarkleDie as pipDie"));
        assert.ok(farkleFaces.includes("parlor-farkle-face"));
        assert.ok(!farkleFaces.includes("renderD6Face("),
            'Shared dice skin previously made Farkle faces invisible behind DSN');
        const css = await source('styles/dice-faces.css');
        assert.ok(css.includes("url('../assets/dice/d6-white-faces.webp')"));
        assert.ok(css.includes('background-size: 600% 100%'));
    });
});
