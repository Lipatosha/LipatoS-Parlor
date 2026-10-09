import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('scripts/games/texasholdem/TexasHoldemTable.js', 'utf8').replace(/\r\n/gu, '\n');

function assertSourceContains(label, block) {
    assert.equal(source.includes(block), true, `${label} block changed or missing`);
}

describe('TexasHoldemTable presenter mount point', () => {
    it('keeps the native open/close/refresh bodies as mechanical extractions', () => {
        assertSourceContains('native open', `    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) {
            this.refresh();
            return;
        }

        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-th-layout'
        });
        this._viewportFit.attach();
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }`);

        assertSourceContains('native close', `    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._handHUD.destroy();
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-th-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        this._communityCardSigns = [];
        this._communityHandToken = '';
    }`);

        assertSourceContains('native refresh', `    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._renderCommunity(state);
        this._renderSeats(state);
        this._renderStatusDock(state);
        this._renderHandHUD(state);
        this._syncSettlement(state);
        this._viewportFit?.update();
    }`);
    });

    it('routes Texas Holdem through PresenterHost only when the active theme claims the surface', () => {
        assert.match(source, /import \{ PresenterHost \} from '\.\.\/\.\.\/ui\/PresenterHost\.js';/u);
        assert.match(source, /import \{ PresenterRegistry \} from '\.\.\/\.\.\/core\/PresenterRegistry\.js';/u);
        assert.match(source, /const themeId = ParlorAppearance\.getActiveThemeId\(\);/u);
        assert.match(source, /PresenterRegistry\.resolve\(themeId, 'table:texasholdem'\)/u);
        assert.match(source, /new PresenterHost\(/u);
        assert.match(source, /const getState = \(\) => this\.gameInstance\.getState\(\);/u);
        assert.match(source, /getState,/u);
        for (const method of [
            'getSeats',
            'getStatus',
            'getHud',
            'getPrivate',
            'requestAction',
            'renderCard',
            'playSound',
            'formatChips',
            'getTableBackdrop',
            'openPopup'
        ]) {
            assert.match(source, new RegExp(`${method}:`, 'u'));
        }
        assert.match(source, /requestClose: \(\) => this\._requestParlorClose\?\.\(\) \?\? this\.close\(\)/u);
    });
});
