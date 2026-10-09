import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

class ElementStub {
    constructor() {
        this.style = { zIndex: '', pointerEvents: '' };
    }
}

globalThis.HTMLElement = ElementStub;
globalThis.document = {
    getElementById: () => null
};

const { Dsn3dBridge } = await import('../scripts/core/Dsn3dBridge.js');

const tokens = [];
const warnings = [];
const originalWarn = console.warn;

beforeEach(() => {
    warnings.length = 0;
    console.warn = (...args) => warnings.push(args);
});

afterEach(() => {
    while (tokens.length) Dsn3dBridge.detachOverlay(tokens.pop());
    delete globalThis.game;
    globalThis.document.getElementById = () => null;
    console.warn = originalWarn;
});

describe('Dsn3dBridge presenter layering', () => {
    it('raises the DSN canvas above the presenter root and restores its old style', () => {
        const canvas = new ElementStub();
        canvas.style.zIndex = '777';
        canvas.style.pointerEvents = 'auto';
        globalThis.game = {
            dice3d: { box: { canvas } }
        };

        const token = 'test:presenter-layer';
        tokens.push(token);
        Dsn3dBridge.attachOverlay(token);

        assert.equal(canvas.style.zIndex, '3100');
        assert.equal(canvas.style.pointerEvents, 'none');

        Dsn3dBridge.detachOverlay(tokens.pop());
        assert.equal(canvas.style.zIndex, '777');
        assert.equal(canvas.style.pointerEvents, 'auto');
    });

    it('raises the DSN stage container instead of an internal renderer canvas', () => {
        const stage = new ElementStub();
        const rendererCanvas = new ElementStub();
        globalThis.document.getElementById = id => id === 'dice-box-canvas' ? stage : null;
        globalThis.game = {
            dice3d: { box: { canvas: rendererCanvas } }
        };

        const token = 'test:dsn-stage-root';
        tokens.push(token);
        Dsn3dBridge.attachOverlay(token);

        assert.equal(stage.style.zIndex, '3100');
        assert.equal(rendererCanvas.style.zIndex, '');
        assert.equal(warnings.some(([message, details]) => (
            message === '[DEBUG-DSN] stage.raise.applied'
            && details?.source === 'dom:#dice-box-canvas'
            && details?.stage?.inlineZIndex === '3100'
        )), true);
    });
});
