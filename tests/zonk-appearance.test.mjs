import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const table = () => source('scripts/games/zonk/ZonkTable.js');
const css = () => source('styles/farkle-widescreen.css');

describe('Farkle widescreen 16:9 existing-game redesign', () => {
    it('removes Dice So Nice from Farkle and restores real Foundry dice.wav on every rollId', async () => {
        const code = await table();
        assert.ok(code.includes("src: 'sounds/dice.wav'"));
        assert.ok(code.includes('foundry?.audio?.AudioHelper'));
        assert.ok(code.includes('this._soundRollId !== state.rollId'));
        assert.ok(code.includes("state.turnPhase === 'choose' && state.currentDice?.length"));
        assert.ok(code.includes('this._playRollSound()'));
        assert.ok(!code.includes('Dsn3dBridge'));
        assert.ok(!code.includes('dice3d'));
        assert.ok(!code.includes('rollD6Visuals'));
        assert.ok(!code.includes('holdFarkleDice'));
        assert.ok(!code.includes('AudioContext'));
    });

    it('shows the existing 2D dice with clickable faces and synced choices', async () => {
        const code = await table();
        assert.ok(code.includes('renderFarkleDie as pipDie'));
        assert.ok(code.includes('data-zonk-die='));
        assert.ok(code.includes('aria-pressed='));
        assert.ok(code.includes('this._selected.add(index)'));
        assert.ok(code.includes('this._selected.delete(index)'));
        assert.ok(code.includes('this._selected.clear()'));
        assert.ok(code.includes("action === 'keep' ? { indices: [...this._selected] } : {}"));
        assert.ok(code.includes('SocketManager.requestGM('));
        assert.ok(code.includes('SOCKET_EVENTS.PLAYER_ACTION'));
        assert.ok(code.includes('SOCKET_EVENTS.GM_ACTION'));
        assert.ok(code.includes("is-new-roll"));
        assert.ok(!code.includes('parlor-zonk-dsn-choice'));
    });

    it('keeps exactly three action buttons Save, Roll dice and Skip turn', async () => {
        const code = await table();
        assert.ok(code.includes("actionButton('keep', t('Bank')"));
        assert.ok(code.includes("actionButton('bank', t('Bank')"));
        assert.ok(code.includes("actionButton('roll', hot ? t('BonusRoll') : t('Roll')"));
        assert.ok(code.includes("actionButton('skip', t('SkipTurn')"));
        assert.equal((code.match(/actionButton\('skip'/g) || []).length, 1);
        assert.ok(code.includes("game.user.isGM && !ended"));
        const styles = await css();
        assert.ok(styles.includes('grid-template-columns:repeat(3,minmax(0,1fr))'));
        assert.ok(styles.includes('.parlor-zonk-action.is-throw'));
    });

    it('draws one 16:9 frame, top toolbar and proportions 21/54/25', async () => {
        const styles = await css();
        assert.match(styles, /aspect-ratio:16 \/ 9/);
        assert.ok(styles.includes('width:min(1600px,'));
        assert.ok(styles.includes('grid-template-areas:"toolbar toolbar toolbar" "players center right"'));
        assert.ok(styles.includes('grid-template-columns:minmax(0,21fr) minmax(0,54fr) minmax(0,25fr)'));
        assert.ok(styles.includes('overflow:hidden !important'));
        assert.ok(styles.includes('grid-area:toolbar'));
        const code = await table();
        assert.ok(code.includes('parlor-zonk-toolbar-right'));
        assert.ok(code.includes('parlor-zonk-more'));
        assert.ok(code.includes('parlor-zonk-turn'));
        assert.ok(code.includes('parlor-zonk-round'));
        assert.ok(code.includes('data-zonk-action="rules"'));
        assert.ok(code.includes('data-zonk-action="sound"'));
        assert.ok(code.includes('data-zonk-action="close"'));
    });

    it('shows up to ten real players with progress, name, score and leader', async () => {
        const code = await table(), styles = await css();
        assert.ok(code.includes('standings.slice(0, 10).map'));
        assert.ok(code.includes('standings.length}/10'));
        assert.ok(code.includes('parlor-zonk-players-heading'));
        assert.ok(code.includes('parlor-zonk-progress-row'));
        assert.ok(code.includes('parlor-zonk-player'));
        assert.ok(code.includes('parlor-zonk-progress-foot'));
        assert.ok(styles.includes('grid-area:players'));
        assert.ok(styles.includes('.parlor-zonk-progress-row.is-current'));
        assert.ok(styles.includes('overflow-y:auto'));
        assert.ok(!code.includes('Math.max(6, standings.length)'));
    });

    it('places 62% dice field and 38% kept stairway side-by-side, left aligned', async () => {
        const code = await table(), styles = await css();
        assert.ok(styles.includes('grid-template-columns:minmax(0,62fr) minmax(0,38fr)'));
        assert.ok(styles.includes('.parlor-zonk-stair-row'));
        assert.ok(styles.includes('justify-content:flex-start !important'));
        assert.ok(code.includes('getFarkleRackDisplay(state.keptDiceRows)'));
        assert.ok(code.includes('rackRows.map'));
        assert.ok(code.includes('data-stair-row='));
        assert.ok(code.includes('data-stair-cell='));
        assert.ok(!code.includes('${savedCount}/21'));
        assert.ok(!code.includes('0/21'));
        const helper = await source('scripts/games/zonk/FarkleRack.js');
        assert.ok(helper.includes('[6, 5, 4, 3, 2, 1]'));
        assert.ok(helper.includes('.reverse()'));
    });

    it('moves independent scrolling scoring and history panels into right column', async () => {
        const code = await table(), styles = await css();
        assert.ok(code.includes('<aside class="parlor-zonk-right">'));
        const start = code.indexOf('<aside class="parlor-zonk-right">');
        const history = code.indexOf('<section class="parlor-zonk-history">', start);
        const combos = code.indexOf('<section class="parlor-zonk-combos">', start);
        assert.ok(start >= 0 && combos > start && history > combos);
        assert.equal((code.match(/<section class="parlor-zonk-history">/g) || []).length, 1);
        assert.equal((code.match(/<section class="parlor-zonk-combos">/g) || []).length, 1);
        assert.ok(styles.includes('grid-area:right'));
        assert.ok(styles.includes('grid-template-rows:minmax(0,62fr) minmax(0,38fr)'));
        assert.ok(styles.includes('overflow-y:auto !important'));
        assert.ok(code.includes("(state.history || []).slice(0, 100)"));
        assert.ok(code.includes('this._history(state)'));
        assert.ok(code.includes('this._combos({ showDescriptions: false })'));
    });

    it('retains all scoring groups, original dice images and rules dialogue', async () => {
        const code = await table();
        for (const entry of [
            "combo([1],100)", "combo([5],50)", "combo([1,1,1],1000)",
            "simpleKind(t('FourKind'),'×2')", "simpleKind(t('FiveKind'),'×4')",
            "simpleKind(t('SixKind'),'×8')", "combo([1,2,3,4,5],500)",
            "combo([2,3,4,5,6],750)", "combo([1,2,3,4,5,6],1500)",
            "anyDice([2,2,2],1500)", "anyDice([3,3],2500)", "anyDice([4,2],1500)"
        ]) assert.ok(code.includes(entry), 'Missing scoring combination '+entry);
        assert.ok(code.includes('renderD6Face(value, { className:'));
        assert.ok(code.includes('data-zonk-rule-backdrop'));
        assert.ok(code.includes('this._rules()'));
        assert.ok(code.includes('getGameGuide'));
    });

    it('does not touch pot, currency or wager calculations', async () => {
        const code = await table();
        assert.ok(code.includes('SettlementManager.formatAmount(state.pot, state)'));
        assert.ok(code.includes('SettlementManager.formatAmount(state.ante, state)'));
        assert.ok(code.includes('state.minBank || 300'));
        assert.ok(code.includes("action === 'finish' ? 'finishGame' : 'skipTurn'"));
        assert.ok(code.includes('RefundAndClose'));
        assert.ok(code.includes('DialogV2.confirm'));
    });

    it('registers new CSS last and includes translated new labels', async () => {
        const manifest = JSON.parse(await source('module.json'));
        assert.equal(manifest.styles.at(-1), 'styles/farkle-widescreen.css');
        for (const lang of ['ru','en','cn']) {
            const locale = JSON.parse(await source('languages/'+lang+'.json')).PARLOR.Zonk;
            for (const key of ['Players','ExtraActions','OnlyGM','RollField','DiceShort','Roll','Bank'])
                assert.ok(locale[key], lang+' missing '+key);
            assert.doesNotMatch(locale.RollZone, /Dice So Nice/i);
        }
    });
});
