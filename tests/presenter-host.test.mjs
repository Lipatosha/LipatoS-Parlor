import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

async function loadHost() {
    const stamp = `${Date.now()}-${Math.random()}`;
    return import(`../scripts/ui/PresenterHost.js?case=${stamp}`);
}

function createDocumentStub() {
    class ElementStub {
        constructor(tagName) {
            this.tagName = tagName;
            this.id = '';
            this.className = '';
            this.dataset = {};
            this.children = [];
            this.parentNode = null;
            this.isConnected = false;
        }

        appendChild(child) {
            child.parentNode = this;
            child.isConnected = this.isConnected;
            this.children.push(child);
            return child;
        }

        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
            this.isConnected = false;
            for (const child of this.children) child.isConnected = false;
        }
    }

    const body = new ElementStub('body');
    body.isConnected = true;

    function visit(node, callback) {
        if (callback(node)) return node;
        for (const child of node.children) {
            const found = visit(child, callback);
            if (found) return found;
        }
        return null;
    }

    return {
        body,
        createElement: (tagName) => new ElementStub(tagName),
        getElementById: (id) => visit(body, node => node.id === id)
    };
}

describe('PresenterHost', () => {
    it('marks detached surfaces with the presenter theme', async () => {
        globalThis.document = createDocumentStub();
        const { PresenterHost } = await loadHost();
        const host = new PresenterHost({
            surface: 'table:baccarat',
            themeId: 'parlor-themes-tavern',
            gameApi: {},
            PresenterClass: class Presenter {},
            onFallback: () => {}
        });
        const popup = document.createElement('div');

        assert.equal(host.markDetachedSurface(popup, 'settlement'), popup);
        assert.equal(popup.dataset.presenterTheme, 'parlor-themes-tavern');
        assert.equal(popup.dataset.presenterSurface, 'settlement');
    });

    it('removes marked detached surfaces when the host is destroyed', async () => {
        globalThis.document = createDocumentStub();
        const { PresenterHost } = await loadHost();
        const host = new PresenterHost({
            surface: 'table:blackjack',
            hostId: 'parlor-detached-host',
            themeId: 'parlor-themes-tavern',
            gameApi: {},
            PresenterClass: class Presenter { mount() {} },
            onFallback: () => {}
        });
        const popup = document.createElement('div');
        popup.id = 'parlor-bj-settlement';

        host.open();
        host.markDetachedSurface(popup, 'settlement');
        document.body.appendChild(popup);
        assert.equal(popup.isConnected, true);

        host.destroy();

        assert.equal(popup.isConnected, false);
        assert.equal(document.getElementById('parlor-bj-settlement'), null);
    });

    it('mounts, refreshes, dispatches, and destroys a presenter root', async () => {
        globalThis.document = createDocumentStub();
        const { PresenterHost } = await loadHost();
        const calls = [];

        class Presenter {
            mount(root, gameApi) {
                calls.push(['mount', root.id, gameApi.marker]);
            }

            refresh(state) {
                calls.push(['refresh', state.phase]);
            }

            onEvent(event) {
                calls.push(['event', event.type]);
            }

            destroy() {
                calls.push(['destroy']);
            }
        }

        const host = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-test-host',
            themeId: 'presenter-smoke',
            gameApi: { marker: 'api' },
            PresenterClass: Presenter,
            onFallback: () => calls.push(['fallback'])
        });

        host.open({ phase: 'OPENING' });
        host.refresh({ phase: 'PLAYER_TURNS' });
        host.dispatch({ type: 'cardDealt' });

        assert.equal(document.getElementById('parlor-test-host')?.className, 'parlor-presenter-root');
        assert.deepEqual(calls, [
            ['mount', 'parlor-test-host', 'api'],
            ['refresh', 'OPENING'],
            ['refresh', 'PLAYER_TURNS'],
            ['event', 'cardDealt']
        ]);

        host.destroy();
        assert.equal(document.getElementById('parlor-test-host'), null);
        assert.deepEqual(calls.at(-1), ['destroy']);
    });

    it('removes stale roots before mounting the next presenter', async () => {
        globalThis.document = createDocumentStub();
        const stale = document.createElement('div');
        stale.id = 'parlor-stale-host';
        document.body.appendChild(stale);
        const { PresenterHost } = await loadHost();

        class Presenter {
            mount() {}
        }

        const host = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-stale-host',
            themeId: 'presenter-smoke',
            gameApi: {},
            PresenterClass: Presenter,
            onFallback: () => {}
        });

        host.open();

        assert.notEqual(document.getElementById('parlor-stale-host'), stale);
        assert.equal(stale.isConnected, false);
    });

    it('falls back and disables the same theme surface after mount crashes', async () => {
        globalThis.document = createDocumentStub();
        const { PresenterHost } = await loadHost();
        const calls = [];

        class CrashingPresenter {
            mount() {
                throw new Error('boom');
            }

            destroy() {
                calls.push('destroy-crashed');
            }
        }

        const firstHost = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-crash-host',
            themeId: 'presenter-smoke',
            gameApi: {},
            PresenterClass: CrashingPresenter,
            onFallback: () => calls.push('fallback-first')
        });

        firstHost.open({ phase: 'OPENING' });
        assert.equal(document.getElementById('parlor-crash-host'), null);

        class WorkingPresenter {
            mount() {
                calls.push('mounted-again');
            }
        }

        const secondHost = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-crash-host',
            themeId: 'presenter-smoke',
            gameApi: {},
            PresenterClass: WorkingPresenter,
            onFallback: () => calls.push('fallback-second')
        });

        secondHost.open({ phase: 'OPENING' });

        assert.deepEqual(calls, ['destroy-crashed', 'fallback-first', 'fallback-second']);
        assert.equal(document.getElementById('parlor-crash-host'), null);
    });

    it('falls back after refresh crashes but only logs on event crashes', async () => {
        globalThis.document = createDocumentStub();
        const { PresenterHost } = await loadHost();
        const calls = [];

        class EventCrashPresenter {
            mount() {
                calls.push('mount-event');
            }

            onEvent() {
                throw new Error('animation-only');
            }
        }

        const eventHost = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-event-host',
            themeId: 'presenter-smoke',
            gameApi: {},
            PresenterClass: EventCrashPresenter,
            onFallback: () => calls.push('event-fallback')
        });

        eventHost.open();
        eventHost.dispatch({ type: 'cardDealt' });
        assert.equal(document.getElementById('parlor-event-host')?.isConnected, true);
        assert.equal(calls.includes('event-fallback'), false);

        class RefreshCrashPresenter {
            mount() {
                calls.push('mount-refresh');
            }

            refresh() {
                throw new Error('refresh-boom');
            }

            destroy() {
                calls.push('destroy-refresh');
            }
        }

        const refreshHost = new PresenterHost({
            surface: 'table:texasholdem',
            hostId: 'parlor-refresh-host',
            themeId: 'refresh-smoke',
            gameApi: {},
            PresenterClass: RefreshCrashPresenter,
            onFallback: () => calls.push('refresh-fallback')
        });

        refreshHost.open();
        refreshHost.refresh({ phase: 'PLAYER_TURNS' });

        assert.equal(document.getElementById('parlor-refresh-host'), null);
        assert.equal(calls.includes('destroy-refresh'), true);
        assert.equal(calls.includes('refresh-fallback'), true);
    });
});
