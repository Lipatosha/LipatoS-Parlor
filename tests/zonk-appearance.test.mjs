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
        assert.ok(code.includes("['choose', 'zonked'].includes(state.turnPhase) && state.currentDice?.length"));
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
        const code = await table(), styles = await css();
        assert.ok(code.includes("actionButton('keep', t('Bank')"));
        assert.ok(code.includes("actionButton('bank', t('Bank')"));
        assert.ok(code.includes("actionButton('roll', hot ? t('BonusRoll') : t('Roll')"));
        assert.ok(code.includes("actionButton('skip', t('SkipTurn')"));
        assert.equal((code.match(/actionButton\('skip'/g) || []).length, 1);
        const foot = code.indexOf('<div class="parlor-zonk-progress-foot">');
        const footEnd = code.indexOf('</aside>', foot);
        const skip = code.indexOf("actionButton('skip'", foot);
        assert.ok(foot >= 0 && skip > foot && skip < footEnd);
        assert.ok(code.includes('game.user.isGM && !ended && !pending'));
        assert.equal(code.slice(code.indexOf('<div class="parlor-zonk-buttons">')).split('</div>')[0].match(/actionButton\('/g)?.length, 3,
            'Save is either keep or bank, followed by Roll; Skip is outside this group');
        assert.ok(styles.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
        assert.ok(styles.includes('.parlor-zonk-progress-foot .parlor-zonk-action.is-skip'));
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
        assert.ok(!code.includes("esc(t('Leader'))"));
        assert.ok(styles.includes('grid-area:players'));
        assert.ok(styles.includes('.parlor-zonk-progress-row.is-current'));
        assert.ok(styles.includes('margin-top:auto'));
        assert.ok(styles.includes('overflow-y:auto'));
        assert.ok(!code.includes('Math.max(6, standings.length)'));
    });

    it('removes only the kept-dice panel while giving the center roll field full width', async () => {
        const code = await table(), styles = await css();
        assert.ok(code.includes('class="parlor-zonk-roll-zone"'));
        assert.ok(!code.includes('class="parlor-zonk-saved-area"'));
        assert.ok(!code.includes('getFarkleRackDisplay'));
        assert.ok(!code.includes('data-stair-row='));
        assert.ok(!code.includes('data-stair-cell='));
        assert.ok(styles.includes('grid-template-columns:minmax(0,1fr) !important'));
        assert.ok(styles.includes('grid-column:1 / -1 !important'));
        assert.ok(styles.includes('.parlor-zonk-velvet > .parlor-zonk-roll-zone'));
        const gameCode = await source('scripts/games/zonk/ZonkGame.js');
        assert.ok(gameCode.includes('appendFarkleRackRow'));
        assert.ok(gameCode.includes('this.keptDiceRows = appendFarkleRackRow'));
    });

    it('moves history into center while scoring alone fills the right column', async () => {
        const code = await table(), styles = await css();
        const center = code.indexOf('<main class="parlor-zonk-center">');
        const right = code.indexOf('<aside class="parlor-zonk-right">');
        const history = code.indexOf('<section class="parlor-zonk-history">');
        const combos = code.indexOf('<section class="parlor-zonk-combos">');
        const board = code.indexOf('<div class="parlor-zonk-velvet">');
        assert.ok(center >= 0 && board > center && history > board && history < right);
        assert.ok(combos > right);
        assert.equal((code.match(/<section class="parlor-zonk-history">/g) || []).length, 1);
        assert.equal((code.match(/<section class="parlor-zonk-combos">/g) || []).length, 1);
        assert.ok(styles.includes('grid-area:right'));
        assert.ok(styles.includes('grid-template-rows:minmax(0,1fr)'));
        assert.ok(styles.includes('.parlor-zonk-center > .parlor-zonk-history'));
        assert.ok(styles.includes('grid-row:5'));
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
        assert.ok(code.includes('canPlay && ready && Number(state.turnPoints || 0) >= 0'));
        assert.ok(!code.includes("esc(t('MinBank'))"));
        assert.ok(code.includes("${esc(t('EntryFee'))}: ${esc(bet)}"));
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
    it('enlarges the full-height scoring reference without cutting the final combinations', async () => {
        const styles = await css(), code = await table();
        assert.ok(styles.includes('.parlor-zonk-right > .parlor-zonk-combos'));
        assert.ok(styles.includes('height:100%'));
        assert.ok(styles.includes('overflow-y:auto !important'));
        assert.ok(styles.includes('padding:10px 11px 16px'));
        assert.ok(styles.includes('font-size:16px'));
        assert.ok(styles.includes('width:25px !important'));
        assert.ok(styles.includes('height:25px !important'));
        assert.ok(styles.includes('font-size:15px'));
        assert.ok(styles.includes('text-align:right'));
        assert.ok(code.includes("simpleKind(t('FourKind'),'×2')"));
        assert.ok(code.includes("simpleKind(t('FiveKind'),'×4')"));
        assert.ok(code.includes("simpleKind(t('SixKind'),'×8')"));
    });

    it('preserves the fixed widescreen 16:9 proportions and no outer scrolling', async () => {
        const styles = await css();
        assert.ok(styles.includes('aspect-ratio:16 / 9'));
        assert.ok(styles.includes('grid-template-columns:minmax(0,21fr) minmax(0,54fr) minmax(0,25fr)'));
        assert.ok(styles.includes('overflow:hidden !important'));
        assert.ok(styles.includes('grid-template-rows:54px minmax(0,53fr) 34px 20px minmax(0,47fr)'));
        assert.ok(styles.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
    });

    it('shows winner notification once, an in-table game-over result, and a GM-only replay menu', async () => {
        const code = await table(), styles = await css();
        assert.ok(code.includes('this._winnerNoticeShown = true'));
        assert.ok(code.includes('ui.notifications?.info('));
        assert.ok(code.includes('parlor-zonk-victory-overlay'));
        assert.ok(code.includes('state.winnerIds?.length'));
        assert.ok(code.includes("actionButton('rematch', t('Rematch')"));
        assert.ok(code.includes("action === 'hide-victory'"));
        assert.ok(code.includes("action === 'rematch'"));
        assert.ok(code.includes("action: 'rematchZonk'"));
        assert.ok(code.includes('RematchAnte'));
        assert.ok(code.includes('RematchCurrency'));
        assert.ok(code.includes('RematchTarget'));
        assert.ok(styles.includes('.parlor-zonk-victory-overlay'));
        assert.ok(styles.includes('.parlor-zonk-rematch-form'));
        for (const lang of ['ru','en','cn']) {
            const locale = JSON.parse(await source('languages/'+lang+'.json')).PARLOR.Zonk;
            for (const key of ['VictoryNotice','VictoryTitle','Rematch','RematchAnte','RematchCurrency','RematchTarget','RematchFailed'])
                assert.ok(locale[key], lang+' missing '+key);
        }
    });

    it('holds bot dice for three seconds measured from the authoritative roll timestamp', async () => {
        const rules = await source('scripts/games/zonk/ZonkGame.js');
        const bot = await source('scripts/core/BotManager.js');
        assert.ok(rules.includes('this.rollTimestamp = Date.now()'));
        assert.ok(rules.includes('rollTimestamp: this.rollTimestamp'));
        assert.ok(rules.includes("'rollId', 'rollTimestamp'"));
        assert.ok(bot.includes('3000 - (Date.now() - startedAt)'));
        assert.ok(bot.includes('latest.currentPlayerId !== id'));
        assert.ok(bot.includes('latest.rollId !== state.rollId'));
        assert.ok(bot.includes('getZonkKeepOptions(latest.currentDice'));
    });

    it('starts a new session only after paying the winner and validating the new stakes', async () => {
        const manager = await source('scripts/core/ParlorManager.js');
        assert.ok(manager.includes("action === 'rematchZonk'"));
        assert.ok(manager.includes("current.phase !== 'FINISHED'"));
        assert.ok(manager.includes('this._rematchesInProgress.has(sessionId)'));
        assert.ok(manager.includes("await current.handleGMAction('finishGame')"));
        assert.ok(manager.includes('if (!current.settlementApplied)'));
        assert.ok(manager.includes('SettlementManager.canAfford(id, ante, gameOptions)'));
        const settle = manager.indexOf("await current.handleGMAction('finishGame')");
        const end = manager.indexOf('await this.endGame(sessionId, { settleBeforeEnd: false })', settle);
        const start = manager.indexOf("await this.startGame('zonk'", end);
        assert.ok(settle >= 0 && end > settle && start > end);
    });

    it('shows a distinct numeric round-order indicator only on remaining seats', async () => {
        const code = await table(), styles = await css();
        assert.ok(code.includes('getUpcomingZonkTurns(state)'));
        assert.ok(code.includes("upcoming ? 'is-upcoming' : 'is-played'"));
        assert.ok(code.includes('parlor-zonk-turn-order'));
        assert.ok(code.includes('aria-label='));
        assert.ok(styles.includes('.parlor-zonk-progress-row.is-played .parlor-zonk-player'));
        assert.ok(styles.includes('grid-column:2 / 4'));
        assert.ok(styles.includes('.parlor-zonk-progress-row.is-current .parlor-zonk-turn-order'));
        for (const lang of ['ru','en','cn']) {
            const locale = JSON.parse(await source('languages/'+lang+'.json')).PARLOR.Zonk;
            assert.ok(locale.UpcomingTurn?.includes('{number}'));
        }
    });

    it('spaces three pairs, two triplets and four-plus-pair groups apart', async () => {
        const code = await table(), styles = await css();
        for(const shape of ["anyDice([2,2,2],1500)", "anyDice([3,3],2500)", "anyDice([4,2],1500)"]) {
            assert.ok(code.includes(shape));
        }
        assert.ok(styles.includes('.parlor-zonk-right .parlor-zonk-any-groups'));
        assert.ok(styles.includes('gap:1.2em !important'));
        assert.ok(styles.includes('flex-wrap:nowrap'));
        assert.ok(code.includes('parlor-zonk-any-group'));
        assert.ok(code.includes('displaySelection.has(index)'));
        assert.ok(code.includes("state.turnPhase === 'zonked'"));
        assert.ok(code.includes("const dice = (choosing || zonked)"));
    });

    it('stretches a 100-entry scrolling history to the bottom of the center column', async () => {
        const code = await table(), styles = await css();
        const core = await source('scripts/games/zonk/ZonkGame.js');
        assert.ok(core.includes('this.history = [entry, ...this.history].slice(0, 100)'));
        assert.ok(code.includes("(state.history || []).slice(0, 100)"));
        assert.ok(styles.includes('grid-template-rows:68px minmax(0,40fr) 42px 22px minmax(0,60fr) !important'));
        assert.ok(styles.includes('height:100% !important'));
        assert.ok(styles.includes('overflow-y:auto !important'));
    });

    it('removes 300-point minimum from the rules and bots as well as the score button', async () => {
        const rules = await source('scripts/games/zonk/ZonkRules.js');
        const bot = await source('scripts/core/BotManager.js');
        const registry = await source('scripts/core/GameRegistry.js');
        const ruGuide = await source('scripts/core/GameGuideRu.js');
        assert.ok(rules.includes('export const ZONK_MIN_BANK = 0'));
        assert.ok(bot.includes('points >= Number(state.minBank ?? 0)'));
        assert.ok(!registry.includes('After reaching 300 unbanked points'));
        assert.ok(!ruGuide.includes('не менее 300 очков'));
        const code = await table();
        assert.ok(!code.includes('state.minBank || 300'));
        assert.ok(!code.includes("t('MinBank')"));
    });

});
