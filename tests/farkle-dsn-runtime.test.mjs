import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Dsn3dBridge } from '../scripts/core/Dsn3dBridge.js';

describe('Farkle DSN runtime hold behavior', () => {
    it('temporarily disables real 3D auto-hide and restores settings afterward', () => {
        const oldGame = globalThis.game;
        const oldHTMLElement = globalThis.HTMLElement;
        const oldDocument = globalThis.document;
        const originalWarn = console.warn;
        let cleared = 0;
        const CONFIG = { hideAfterRoll: true };
        globalThis.HTMLElement = class HTMLElement {};
        globalThis.document = { querySelectorAll: () => [] };
        globalThis.game = {
            settings: { get: (_id, key) => key === 'dsnIntegration' ? 'auto' : null },
            modules: { get: id => id === 'dice-so-nice' ? { active: true } : null },
            dice3d: {
                constructor: { CONFIG },
                isEnabled: () => true,
                box: { clearAll() { cleared++; } }
            }
        };
        console.warn = () => {};
        try {
            assert.equal(Dsn3dBridge.holdFarkleDice('table-1-roll-1'), true);
            assert.equal(CONFIG.hideAfterRoll, false);
            Dsn3dBridge.clearFarkleDice();
            assert.equal(cleared, 1);
            Dsn3dBridge.releaseFarkleDice('table-1-roll-1');
            assert.equal(CONFIG.hideAfterRoll, true);
        } finally {
            globalThis.game = oldGame;
            globalThis.HTMLElement = oldHTMLElement;
            globalThis.document = oldDocument;
            console.warn = originalWarn;
        }
    });
});
