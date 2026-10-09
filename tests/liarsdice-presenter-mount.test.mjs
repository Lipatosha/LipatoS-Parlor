import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('scripts/games/liarsdice/LiarsDiceTable.js', 'utf8').replace(/\r\n/gu, '\n');

function assertSourceContains(label, block) {
    assert.equal(source.includes(block), true, `${label} block changed or missing`);
}

describe('LiarsDiceTable presenter mount point', () => {
    it('keeps the native open/close/refresh bodies as mechanical extractions', () => {
        assertSourceContains('native open', `    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) {
            this.refresh();
            return;
        }

        document.querySelectorAll('#parlor-ld-overlay').forEach(node => node.remove());
        this._createOverlay();
        this._viewportFit = new OverlayViewportFit({
            overlay: this._overlay,
            targetSelector: '.parlor-ld-layout'
        });
        this._viewportFit.attach();
        // 把 DSN 画布抬到 overlay 之上，免得 3D 骰子被牌桌挡住
        Dsn3dBridge.attachOverlay(\`ld:\${this.sessionId}\`);
        document.addEventListener('keydown', this._onKeyDown);
        this.refresh();
    }`);

        assertSourceContains('native close', `    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        this._viewportFit?.destroy();
        this._viewportFit = null;
        document.removeEventListener('keydown', this._onKeyDown);
        document.querySelectorAll('#parlor-ld-overlay').forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        Dsn3dBridge.detachOverlay(\`ld:\${this.sessionId}\`);
    }`);

        assertSourceContains('native refresh', `    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        this._syncClaimDraft(state);
        // 开盅阶段不再播 DSN（产品决策：reveal 直接静态展示，飞骰子打断节奏）
        // 私密阶段的 DSN 仍由 handlePrivateUpdate 自己触发
        this._renderCenter(state);
        this._renderSeats(state);
        this._renderFooter(state);
        this._viewportFit?.update();
    }`);
    });

    it('routes Liars Dice through PresenterHost only when the active theme claims the surface', () => {
        assert.match(source, /import \{ PresenterHost \} from '\.\.\/\.\.\/ui\/PresenterHost\.js';/u);
        assert.match(source, /import \{ PresenterRegistry \} from '\.\.\/\.\.\/core\/PresenterRegistry\.js';/u);
        assert.match(source, /PresenterRegistry\.resolve\(themeId, 'table:liarsdice'\)/u);
        assert.match(source, /hostId: 'parlor-ld-presenter'/u);
        assert.match(source, /surface: 'table:liarsdice'/u);
        assert.match(source, /onFallback: \(\) => \{/u);
        assert.match(source, /this\._syncClaimDraft\(state\);/u);
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
