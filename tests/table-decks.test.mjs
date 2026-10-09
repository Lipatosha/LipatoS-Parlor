import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const clone = value => structuredClone(value);

function mergeKnown(base, incoming) {
    const output = clone(base);
    for (const key of Object.keys(output)) {
        if (!(key in (incoming || {}))) continue;
        const current = output[key];
        const next = incoming[key];
        output[key] = current && next && typeof current === 'object' && typeof next === 'object'
            && !Array.isArray(current) && !Array.isArray(next)
            ? mergeKnown(current, next)
            : clone(next);
    }
    return output;
}

globalThis.foundry = {
    utils: {
        deepClone: clone,
        mergeObject: (base, incoming) => mergeKnown(base, incoming)
    }
};

const { TableDecks } = await import('../scripts/core/TableDecks.js');

describe('TableDecks felt visibility', () => {
    it('keeps an explicit hidden felt state', () => {
        const deck = TableDecks.sanitizeDeck({ felt: { color: '#5c1c21', visible: false } });

        assert.equal(deck.felt.visible, false);
        assert.equal(deck.felt.color, '#5c1c21');
    });

    it('shows felt for old presets without the new field', () => {
        const deck = TableDecks.sanitizeDeck({ felt: { color: '#1c4a30' } });

        assert.equal(deck.felt.visible, true);
    });
});
