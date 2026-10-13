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
});
