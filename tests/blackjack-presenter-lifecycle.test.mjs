import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function setupFoundryStubs() {
    globalThis.window = {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener() {},
        removeEventListener() {}
    };
    globalThis.document = {
        documentElement: {
            clientWidth: 1280,
            clientHeight: 800
        },
        body: {
            appendChild() {}
        },
        createElement(tagName) {
            return {
                tagName,
                className: '',
                classList: {
                    add() {},
                    remove() {},
                    toggle() {},
                    contains() { return false; }
                },
                dataset: {},
                style: {
                    setProperty() {},
                    removeProperty() {}
                },
                appendChild() {},
                remove() {},
                querySelector() { return null; },
                querySelectorAll() { return []; },
                addEventListener() {},
                set innerHTML(_value) {},
                get innerHTML() { return ''; }
            };
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {}
    };
    globalThis.game = {
        user: { id: 'gm', isGM: true },
        users: { get() { return null; }, find() { return null; }, filter() { return []; } },
        actors: { get() { return null; } },
        system: { id: 'dnd5e' },
        i18n: {
            localize: key => key,
            format: (key, data = {}) => `${key}:${Object.entries(data).map(([name, value]) => `${name}=${value}`).join(',')}`
        },
        settings: {
            settings: new Map(),
            get() { return {}; },
            set() {}
        }
    };
    globalThis.foundry = {
        utils: {
            deepClone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
            mergeObject: (target, source) => ({ ...(target || {}), ...(source || {}) }),
            getProperty: () => undefined
        },
        audio: {}
    };
    globalThis.Hooks = { callAll() {} };
}

async function loadBlackjackTable() {
    setupFoundryStubs();
    const stamp = `${Date.now()}-${Math.random()}`;
    return import(`../scripts/games/blackjack/BlackjackTable.js?case=${stamp}`);
}

function makeGameInstance(state) {
    return {
        sessionId: 'session-a',
        getState: () => state
    };
}

function makeElement(tagName = 'div') {
    return {
        tagName,
        id: '',
        className: '',
        dataset: {},
        children: [],
        style: {},
        parentNode: null,
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        set innerHTML(value) { this._innerHTML = String(value || ''); },
        get innerHTML() { return this._innerHTML || ''; }
    };
}

function installSettlementDom() {
    const body = makeElement('body');
    globalThis.document.createElement = tagName => makeElement(tagName);
    globalThis.document.body = body;
    globalThis.document.querySelector = selector => {
        if (selector === '#parlor-bj-settlement') {
            return body.children.find(child => child.id === 'parlor-bj-settlement') || null;
        }
        return null;
    };
    globalThis.document.querySelectorAll = selector => {
        const found = globalThis.document.querySelector(selector);
        return found ? [found] : [];
    };
    return body;
}

describe('BlackjackTable presenter lifecycle', () => {
    it('marks settlement popups with the active presenter theme', async () => {
        const { BlackjackTable } = await loadBlackjackTable();
        const state = {
            phase: 'RESOLVING',
            round: 1,
            turnOrder: ['actor:a'],
            dealerHand: { handCards: [{ rank: '10' }, { rank: '7' }], tableCards: [], status: 'stand' },
            playerHands: {
                'actor:a': { handCards: [{ rank: '9' }, { rank: '8' }], tableCards: [], bet: 10, status: 'stand' }
            },
            payouts: { 'actor:a': 20 },
            rules: { bustThreshold: 21 }
        };
        const table = new BlackjackTable({ gameInstance: makeGameInstance(state) });
        table._presenterHost = {
            markDetachedSurface: (popup, surface) => {
                popup.dataset.presenterTheme = 'parlor-themes-tavern';
                popup.dataset.presenterSurface = surface;
                return popup;
            }
        };
        installSettlementDom();

        table._showSettlementPopup(state);

        const popup = document.querySelector('#parlor-bj-settlement');
        assert.equal(popup.dataset.presenterTheme, 'parlor-themes-tavern');
        assert.equal(popup.dataset.presenterSurface, 'settlement');
    });

    it('syncs settlement when an existing presenter host is refreshed from the open path', async () => {
        const { BlackjackTable } = await loadBlackjackTable();
        const state = { phase: 'RESOLVING', round: 1 };
        const table = new BlackjackTable({ gameInstance: makeGameInstance(state) });
        const calls = [];

        table._presenterHost = {
            refresh: nextState => calls.push(['refresh', nextState])
        };
        table._syncSettlement = nextState => calls.push(['settlement', nextState]);

        table._openPresenter(class Presenter {}, 'tavern');

        assert.deepEqual(calls, [
            ['refresh', state],
            ['settlement', state]
        ]);
    });

    it('refreshes an active presenter after a socket action releases its pending lock', async () => {
        const { BlackjackTable } = await loadBlackjackTable();
        const state = { phase: 'DEALER_TURN', round: 1 };
        const table = new BlackjackTable({ gameInstance: makeGameInstance(state) });
        const refreshedStates = [];

        table._overlay = null;
        table._presenterHost = {
            refresh: nextState => refreshedStates.push(nextState)
        };

        const originalNow = Date.now;
        let now = 1000;
        Date.now = () => now;

        try {
            const result = await table._runSocketAction('gm:dealerHit', null, async () => {
                now = 2000;
                return { ok: true };
            });

            assert.deepEqual(result, { ok: true });
            assert.deepEqual(refreshedStates, [state]);
            assert.equal(table._actionRequests.has('gm:dealerHit'), false);
        } finally {
            Date.now = originalNow;
        }
    });
});
