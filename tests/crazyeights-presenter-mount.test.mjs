import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync('scripts/games/crazyeights/CrazyEightsTable.js', 'utf8');

const GAME_API_METHODS = [
    'getState', 'getSeats', 'getStatus', 'getHud', 'getPrivate', 'requestAction', 'renderCard',
    'playSound', 'formatChips', 'getTableBackdrop', 'getTableDeck', 'openPopup', 'requestClose', 't'
];

describe('疯狂八桌的呈现器挂载点', () => {
    it('open/close/refresh 是分发器，原生实现拆在 _xxxNative 里', () => {
        assert.match(source, /PresenterRegistry\.resolve\(themeId, 'table:crazyeights'\)/u);
        assert.match(source, /PresenterHost\.hasCrashed\(themeId, 'table:crazyeights'\)/u);
        assert.match(source, /surface: 'table:crazyeights'/u);
        assert.match(source, /hostId: 'parlor-c8-presenter'/u);
        assert.match(source, /onFallback: \(\) => \{/u);
        assert.match(source, /_openNative\(\) \{/u);
        assert.match(source, /_closeNative\(\{ dismiss = true \} = \{\}\) \{/u);
        assert.match(source, /_refreshNative\(\) \{/u);
    });

    it('主题模式下结算弹窗仍由本体开关，并登记到 host', () => {
        assert.match(source, /this\._presenterHost\.refresh\(state\);\s*\/\/[^\n]*\n\s*this\._syncSettlement\(state\);/u);
        assert.match(source, /markDetachedSurface\(popup, 'settlement'\)/u);
        assert.match(source, /SETTLEMENT_ID = 'parlor-c8-settlement'/u);
    });

    it('gameApi 十四个方法齐全，关桌走共享关闭流', () => {
        for (const method of GAME_API_METHODS) {
            // getState 在对象里是简写属性，只有逗号
            assert.match(source, new RegExp(`^\\s+${method}(:|\\(|,)`, 'mu'), `missing gameApi.${method}`);
        }
        assert.match(source, /requestClose:\s*\(\)\s*=>\s*this\._requestParlorClose\?\.\(\)\s*\?\?\s*this\.close\(\)/u);
    });

    it('动作路由：GM 推进与玩家动作分流，玩家动作保留 suit/rank', () => {
        assert.match(source, /new Set\(\['newRound', 'finishGame'\]\)/u);
        assert.match(source, /delete payload\.participantId;/u);
        assert.match(source, /_requestPlayerAction\(\{ userId: participantId, action: safeAction, data: payload \}\)/u);
    });

    it('手牌 HUD：轮到自己时钉住，花色动作不进 HUD 动作行', () => {
        assert.match(source, /this\._handHUD\.setPinned\(isTurn\)/u);
        assert.match(source, /filter\(action => action\.kind !== 'suit'\)/u);
        assert.match(source, /this\._handHUD\.addCard\(entries\[index\], \{ fromRect: stockRect, index \}\)/u);
    });
});
