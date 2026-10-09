import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CrazyEightsTable } from '../scripts/games/crazyeights/CrazyEightsTable.js';
import { CrazyEightsHandHUD } from '../scripts/games/crazyeights/CrazyEightsHandHUD.js';

function tableStub() {
    const table = Object.create(CrazyEightsTable.prototype);
    table._t = key => key;
    table._escape = value => String(value);
    table._playerName = (_state, id) => id;
    return table;
}

describe('疯狂八经典桌交互', () => {
    for (const [direction, expected] of [[1, ['b', 'c', 'd', 'a']], [-1, ['b', 'a', 'd', 'c']]]) {
        it(`出牌顺序从当前席位起按方向 ${direction} 展开`, () => {
            const html = tableStub()._buildTurnOrder({
                phase: 'PLAYER_TURNS', turnOrder: ['a', 'b', 'c', 'd'], currentPlayerId: 'b', direction,
                handCounts: { a: 3, b: 1, c: 7, d: 5 }
            });
            const names = [...html.matchAll(/class="parlor-c8-order-name">([^<]+)/gu)].map(match => match[1]);
            assert.deepEqual(names, expected);
            assert.equal((html.match(/aria-current="step"/gu) || []).length, 1);
            assert.equal((html.match(/PARLOR.CrazyEights.Order.Next/gu) || []).length, 1);
        });
    }

    it('进入结算就撤下固定手牌栏', () => {
        const table = tableStub();
        let destroyed = 0;
        table._handHUD = { destroy: () => { destroyed++; } };
        table._renderHandHUD({ phase: 'RESOLVING' });
        assert.equal(destroyed, 1);
        assert.deepEqual(table._hudCardKeys, []);
        assert.equal(table._hudActionsKey, '');
    });

    it('抽到可出为止模式不会误提示可以过', () => {
        const table = tableStub();
        const state = { phase: 'PLAYER_TURNS', currentPlayerId: 'a', turn: { drawnThisTurn: true } };
        table._legalForSelected = () => ({ canPass: false, playable: [{}] });
        assert.match(table._buildHudFooter(state, { identity: {} }, 'a'), /MustPlayAfterDraw/u);
        table._legalForSelected = () => ({ canPass: true, playable: [{}] });
        assert.match(table._buildHudFooter(state, { identity: {} }, 'a'), /YourTurnAfterDraw/u);
    });

    it('结算期间隔离两种桌面的键盘操作，关闭后恢复焦点', () => {
        const table = tableStub();
        let focused = 0;
        globalThis.document = { activeElement: { isConnected: true, focus() { focused++; } } };
        table._overlay = {};
        table._presenterHost = { root: {} };
        table._setSettlementActive(true);
        assert.equal(table._overlay.inert, true);
        assert.equal(table._presenterHost.root.inert, true);
        table._setSettlementActive(false);
        assert.equal(table._overlay.inert, false);
        assert.equal(table._presenterHost.root.inert, false);
        assert.equal(focused, 1);
    });

    it('结算请求期间禁止重复操作，失败后两按钮都能重试', async () => {
        const table = tableStub();
        const buttons = [{ disabled: false, isConnected: true }, { disabled: false, isConnected: true }];
        const popup = { querySelectorAll: () => buttons };
        let complete;
        let calls = 0;
        table._requestGMAction = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
        const first = table._runSettlementAction(popup, 'newRound', buttons[0]);
        assert.ok(buttons.every(button => button.disabled));
        await table._runSettlementAction(popup, 'finishGame', buttons[1]);
        assert.equal(calls, 1);
        complete({ ok: false, reason: 'request-failed' });
        await first;
        assert.ok(buttons.every(button => !button.disabled));
    });
});

describe('疯狂八手牌边界', () => {
    for (const [count, width] of [[1, 360], [7, 1100], [20, 1100], [32, 1166]]) {
        it(`${count} 张牌的牌面和扇形两端留在 ${width}px 牌区内`, () => {
            const hud = Object.create(CrazyEightsHandHUD.prototype);
            hud._responsiveMetrics = { cardWidth: 110, cardHeight: 154, cardSpacing: 77, containerHeight: 192 };
            hud._cardElements = Array(count).fill(null);
            hud._cardContainer = { clientWidth: width };
            for (let index = 0; index < count; index++) {
                const { x, y, r } = hud._getCardLayout(index);
                const angle = Math.abs(r) * Math.PI / 180;
                const halfWidth = (110 * Math.cos(angle) + 154 * Math.sin(angle)) / 2;
                const halfHeight = (154 * Math.cos(angle) + 110 * Math.sin(angle)) / 2;
                const centerX = width / 2 + x + 55;
                assert.ok(centerX - halfWidth >= 0);
                assert.ok(centerX + halfWidth <= width);
                assert.ok(y + 77 + halfHeight <= 192);
            }
        });
    }
});
