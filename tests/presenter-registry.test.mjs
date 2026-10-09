import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadRegistry() {
    const stamp = `${Date.now()}-${Math.random()}`;
    return import(`../scripts/core/PresenterRegistry.js?case=${stamp}`);
}

describe('PresenterRegistry', () => {
    it('registers v1 presenter profiles and resolves claimed surfaces', async () => {
        const { PRESENTER_API_VERSION, PresenterRegistry } = await loadRegistry();
        class TexasPresenter {}

        const registered = PresenterRegistry.register({
            id: 'presenter-smoke',
            labelKey: 'PARLOR.Debug.PresenterSmoke',
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces: {
                'table:texasholdem': TexasPresenter
            }
        });

        assert.equal(registered, true);
        assert.equal(PresenterRegistry.hasTheme('presenter-smoke'), true);
        assert.equal(PresenterRegistry.resolve('presenter-smoke', 'table:texasholdem'), TexasPresenter);
        assert.equal(PresenterRegistry.resolve('presenter-smoke', 'table:blackjack'), null);
    });

    it('rejects classic and empty theme ids', async () => {
        const { PRESENTER_API_VERSION, PresenterRegistry } = await loadRegistry();
        class Presenter {}

        assert.equal(PresenterRegistry.register({
            id: 'classic',
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces: { lobby: Presenter }
        }), false);
        assert.equal(PresenterRegistry.register({
            id: '   ',
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces: { lobby: Presenter }
        }), false);
        assert.equal(PresenterRegistry.hasTheme('classic'), false);
    });

    it('rejects unknown presenter API versions', async () => {
        const { PresenterRegistry } = await loadRegistry();
        class Presenter {}

        assert.equal(PresenterRegistry.register({
            id: 'future-theme',
            presenterApiVersion: 99,
            surfaces: { lobby: Presenter }
        }), false);
        assert.equal(PresenterRegistry.hasTheme('future-theme'), false);
    });

    it('keeps only valid presenter surface constructors', async () => {
        const { PRESENTER_API_VERSION, PresenterRegistry } = await loadRegistry();
        class LobbyPresenter {}
        class TexasPresenter {}

        assert.equal(PresenterRegistry.register({
            id: 'mixed-theme',
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces: {
                lobby: LobbyPresenter,
                'table:texasholdem': TexasPresenter,
                'table:BadCase': class BadCase {},
                'table:liarsdice': {}
            }
        }), true);

        assert.equal(PresenterRegistry.resolve('mixed-theme', 'lobby'), LobbyPresenter);
        assert.equal(PresenterRegistry.resolve('mixed-theme', 'table:texasholdem'), TexasPresenter);
        assert.equal(PresenterRegistry.resolve('mixed-theme', 'table:BadCase'), null);
        assert.equal(PresenterRegistry.resolve('mixed-theme', 'table:liarsdice'), null);
    });
});
