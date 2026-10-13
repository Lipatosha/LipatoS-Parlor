import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const source = async relative => readFile(new URL('../' + relative, import.meta.url), 'utf8');

describe('Zonk Foundry inventory redesign', () => {
    it('uses the original Foundry dice.wav, without generated audio or bundled copies', async () => {
        const code = await source('scripts/games/zonk/ZonkTable.js');
        assert.ok(code.includes("src: 'sounds/dice.wav'"));
        assert.ok(code.includes('foundry?.audio?.AudioHelper'));
        assert.doesNotMatch(code, /AudioContext|createBufferSource|oscillator|new Audio\(/);
    });

    it('uses illuminated scoring and rule pages with native Liars Dice pips', async () => {
        const code = await source('scripts/games/zonk/ZonkTable.js');
        const css = await source('styles/zonk-v14.css');
        assert.match(code, /parlor-zonk-manuscript/);
        assert.match(code, /parlor-zonk-rulebook-paper/);
        assert.match(code, /parlor-ld-die/);
        assert.match(css, /parlor-zonk-manuscript-columns/);
        assert.match(css, /parlor-zonk-rulebook-text/);
        assert.match(css, /--z-panel: #212329/);
    });

    it('keeps the scoring and player seat limits available in each language', async () => {
        const registry = await source('scripts/core/GameRegistry.js');
        assert.match(registry, /zonk:\s*\{[\s\S]*?maxParticipants: 10/);
        for (const lang of ['ru', 'en', 'cn']) {
            const data = JSON.parse(await source('languages/' + lang + '.json'));
            assert.ok(data.PARLOR.Lobby.Setup.ZonkParticipantsNote.includes('10'), lang);
            for (const key of ['SectionSingles', 'SectionTriples', 'SectionSpecial', 'SectionMultiples']) {
                assert.equal(typeof data.PARLOR.Zonk[key], 'string', lang + ':' + key);
            }
        }
    });

    it('uses native denim texture and one bronze type palette across the entire screen', async () => {
        const css = await source('styles/zonk-v14.css');
        const code = await source('scripts/games/zonk/ZonkTable.js');
        assert.match(css, /--z-ink: #9f9275/);
        assert.ok(css.includes('url("../../../ui/denim065.png")'));
        assert.match(css, /parlor-zonk-rulebook-paper/);
        assert.match(css, /parlor-zonk-manuscript/);
        assert.match(code, /parlor-zonk-staircase/);
        assert.match(code, /parlor-zonk-saved-area/);
        assert.match(code, /parlor-zonk-turn/);
        assert.match(code, /parlor-zonk-round/);
        assert.ok(!code.includes('☠ ЗОНК!'));
    });

    it('shows Farkle everywhere and uses full Russian gold settlement wording', async () => {
        const ru = JSON.parse(await source('languages/ru.json'));
        assert.equal(ru.PARLOR.Games.Zonk.Name, 'Farkle');
        assert.equal(ru.PARLOR.Zonk.Title, 'FARKLE');
        assert.equal(ru.PARLOR.Lobby.Setup.SettlementGold, 'Расчёт золотом D&D');
        assert.equal(ru.PARLOR.Zonk.Bust, 'Farkle');
    });
    it('fills a six-tier 21-slot staircase bottom up and lists only seated players', async () => {
        const code = await source('scripts/games/zonk/ZonkTable.js');
        const css = await source('styles/zonk-v14.css');
        assert.ok(code.includes('getFarkleRackDisplay(state.keptDiceRows)'));
        assert.ok(code.includes('rackRows.map'));
        assert.ok(code.includes('data-stair-cell='));
        assert.ok(code.includes('standings.slice(0, 10).map'));
        assert.ok(!code.includes('Math.max(6, standings.length)'));
        assert.ok(css.includes('width: 100vw'));
        assert.ok(css.includes('height: 100dvh'));
        assert.ok(css.includes('grid-template-columns: repeat(2,minmax(0,1fr))'));
    });

    it('matches photo paytable with # wildcards and no star tiles', async () => {
        const code = await source('scripts/games/zonk/ZonkTable.js');
        const ru = JSON.parse(await source('languages/ru.json'));
        assert.ok(code.includes('parlor-zonk-any-die'));
        assert.ok(code.includes('>#</span>'));
        assert.ok(code.includes('anyDice([2,2,2],1500)'));
        assert.ok(code.includes('anyDice([3,3],2500)'));
        assert.ok(code.includes('anyDice([4,2],1500)'));
        assert.ok(code.includes("combo([1],100) + combo([5],50)"));
        assert.ok(code.includes("simpleKind(t('FourKind'),'×2')"));
        assert.ok(code.includes("simpleKind(t('FiveKind'),'×4')"));
        assert.ok(code.includes("simpleKind(t('SixKind'),'×8')"));
        assert.ok(code.includes('combo([1,2,3,4,5],500)'));
        assert.ok(code.includes('combo([2,3,4,5,6],750)'));
        assert.ok(code.includes('combo([1,2,3,4,5,6],1500)'));
        assert.equal(ru.PARLOR.Zonk.SectionPartialStraight, 'Частичный стрит (два варианта)');
        assert.equal(ru.PARLOR.Zonk.FourKind, 'Четыре одинаковых');
        assert.equal(ru.PARLOR.Zonk.Multiplier, 'множитель');
        assert.ok(code.includes("${esc(label)} ${esc(t('Multiplier'))}"));
        assert.ok(code.includes("<b>${esc(multiplier)}</b>"));
        assert.ok(!code.includes("fmt(points)}</b></div>"));
        assert.ok(code.includes('_combos({ showDescriptions = false } = {})'));
        assert.ok(code.includes('_combos({ showDescriptions: true })'));

    });
    it('paints the dice hover and selected ring above its uploaded icon', async () => {
        const css = await source('styles/zonk-v14.css');
        const spriteCss = await source('styles/dice-faces.css');
        const markup = await source('scripts/games/zonk/ZonkTable.js');
        assert.ok(markup.includes('parlor-zonk-pick ${this._selected.has(index)'));
        assert.match(css, /button\.parlor-zonk-pick::after\s*\{[^}]*z-index:\s*3;[^}]*inset:\s*7px;[^}]*border:\s*3px solid/);
        assert.match(css, /button\.parlor-zonk-pick:not\(:disabled\):hover::after/);
        assert.match(css, /button\.parlor-zonk-pick\.is-selected::after/);
        assert.match(css, /pointer-events:\s*none;/);
        assert.ok(spriteCss.includes('background-image: url(\'../assets/dice/d6-white-faces.webp\')'));
    });

    it('uses full-icon clickable die bounds and a foreground ring without padding', async () => {
        const css = await source('styles/zonk-v14.css');
        assert.match(css, /\.parlor-zonk-dice-tray \.parlor-zonk-pick\s*\{[^}]*width:\s*var\(--z-die-size\);[^}]*height:\s*var\(--z-die-size\);/);
        assert.match(css, /\.parlor-zonk-dice-tray \.parlor-zonk-pick > \.parlor-d6-face\s*\{[^}]*width:\s*100% !important;[^}]*height:\s*100% !important;/);
        assert.match(css, /\.parlor-zonk-dice-tray button\.parlor-zonk-pick::after\s*\{[^}]*inset:\s*0;/);
        assert.match(css, /padding:\s*0 !important;/);
    });

    it('compacts the middle section and places the narrow scoring sidebar in one column', async () => {
        const css = await source('styles/zonk-v14.css');
        const code = await source('scripts/games/zonk/ZonkTable.js');
        assert.match(css, /\.parlor-zonk-lower-board\s*\{\s*display:\s*contents;/);
        assert.match(css, /\.parlor-zonk-history\s*\{\s*width:\s*57%;/);
        assert.match(css, /\.parlor-zonk-combos \.parlor-zonk-manuscript-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
        assert.match(css, /\.parlor-zonk-combos \.parlor-zonk-combo-list\s*\{[^}]*overflow:\s*hidden;/);
        assert.ok(code.includes('showDescriptions ?'));
        for (const lang of ['ru', 'en', 'cn']) {
            const data = JSON.parse(await source('languages/' + lang + '.json'));
            assert.equal(typeof data.PARLOR.Zonk.Multiplier, 'string');
        }
    });

    it('lays out the wide right Dice So Nice zone and compact left statistics / rack', async () => {
        const markup = await source('scripts/games/zonk/ZonkTable.js');
        const css = await source('styles/zonk-v14.css');
        assert.ok(markup.includes('class="parlor-zonk-roll-zone"'));
        assert.ok(markup.includes('class="parlor-zonk-lower-board"'));
        assert.ok(markup.includes('class="parlor-zonk-status-area"'));
        assert.ok(markup.includes('class="parlor-zonk-saved-area"'));
        assert.ok(markup.includes('data-zonk-roll-zone'));
        assert.match(css, /\.parlor-zonk-velvet\s*\{[^}]*grid-template-columns:\s*minmax\(245px, 32%\) minmax\(0, 1fr\)/);
        assert.match(css, /\.parlor-zonk-roll-zone\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;/);
        assert.match(css, /\.parlor-zonk-lower-board\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;/);
    });

    it('animates GM-authoritative dice via optional DSN and keeps results until the turn changes', async () => {
        const code = await source('scripts/games/zonk/ZonkTable.js');
        assert.match(code, /import \{ Dsn3dBridge \} from '\.\.\/\.\.\/core\/Dsn3dBridge\.js'/);
        assert.ok(code.includes('Dsn3dBridge.attachOverlay(`zonk:'));
        assert.ok(code.includes('Dsn3dBridge.detachOverlay(`zonk:'));
        assert.ok(code.includes("state.turnPhase === 'choose'"));
        assert.ok(code.includes('Dsn3dBridge.rollD6Visuals(state.currentDice'));
        assert.ok(code.includes('state.rollId'));
        assert.ok(code.includes('const dice = choosing'));
        assert.ok(code.includes(" : ''; // Nothing on the 3D roll surface until a real roll lands."));
        assert.ok(code.includes('data-zonk-die='));
        for (const lang of ['ru', 'en', 'cn']) {
            const locale = JSON.parse(await source('languages/' + lang + '.json'));
            assert.ok(locale.PARLOR.Zonk.RollZone);
            assert.ok(locale.PARLOR.Zonk.RollZoneHint);
        }
    });

});
