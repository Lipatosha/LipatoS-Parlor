import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('scripts/games/blackjack/BlackjackTable.js', 'utf8').replace(/\r\n/gu, '\n');

function assertSourceContains(label, block) {
    assert.equal(source.includes(block), true, `${label} block changed or missing`);
}

describe('BlackjackTable presenter mount point', () => {
    it('keeps the native open/close/refresh bodies as mechanical extractions', () => {
        assertSourceContains('native open', `    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) { this.refresh(); return; }
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-overlay').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-settlement').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-bj-layout'
        });
        this._viewportFit.attach();
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }`);

        assertSourceContains('native close', `    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._stopBlackjackFx();
        LocalResultFx.clear(this._overlay);
        this._clearSeatBustFx();
        this._handHUD.destroy();
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-hand-hud').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-settlement').forEach(node => node.remove());
        document.querySelectorAll('#parlor-bj-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._resetTracking();
    }`);

        assertSourceContains('native refresh', `    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncBlackjackFxRound(state);
        this._syncResultFxRound(state);
        const queuedFlights = this._collectFlights(state);
        this._queuedHudFlights = queuedFlights.hud;
        this._queuedSeatFlights = queuedFlights.seat;

        // V14 兼容：阶段切换时顺手把中央区追踪也清掉
        if (state.phase !== this._prevPhase) {
            this._renderedCenterKey = '';
            this._renderedCenterCards = 0;
            if (state.phase === 'BETTING') {
                this._renderedDealerCards = 0;
                this._prevCardCount = 0;
                this._settlementShown = false;
                this._betDraftAmounts.clear();
                this._stopBlackjackFx();
                LocalResultFx.clear(this._overlay);
                this._clearSeatBustFx();
            }
            this._prevPhase = state.phase;
        }

        this._renderDealerCards(state);
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderHandHUD(state);
        this._playSeatFlights();
        this._maybePlaySeatBustFx(state);
        this._maybePlayBlackjackFx(state);
        this._maybePlayLocalResultFx(state);

        if (state.phase !== 'RESOLVING') {
            document.querySelector('#parlor-bj-settlement')?.remove();
        }

        // V14 兼容：只在真正算完输赢后弹结算页
        if (state.phase === 'RESOLVING' && !this._settlementShown) {
            this._showSettlementPopup(state);
            this._settlementShown = true;
        }

        this._viewportFit?.update();
        this._prevStateSnapshot = this._cloneState(state);
    }`);
    });

    it('routes Blackjack through PresenterHost only when the active theme claims the surface', () => {
        assert.match(source, /import \{ PresenterHost \} from '\.\.\/\.\.\/ui\/PresenterHost\.js';/u);
        assert.match(source, /import \{ PresenterRegistry \} from '\.\.\/\.\.\/core\/PresenterRegistry\.js';/u);
        assert.match(source, /PresenterRegistry\.resolve\(themeId, 'table:blackjack'\)/u);
        assert.match(source, /hostId: 'parlor-bj-presenter'/u);
        assert.match(source, /surface: 'table:blackjack'/u);
        assert.match(source, /onFallback: \(\) => \{/u);
        assert.match(source, /this\._syncSettlement\(state\);/u);
        for (const method of [
            'getState',
            'getSeats',
            'getStatus',
            'getHud',
            'getPrivate',
            'requestAction',
            'renderCard',
            'playSound',
            'formatChips',
            'getTableBackdrop',
            'openPopup',
            'requestClose',
            't'
        ]) {
            assert.match(source, new RegExp(`${method}:`, 'u'));
        }
    });
});
