import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function setupFoundryStubs() {
    globalThis.window = {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener() {},
        removeEventListener() {}
    };
    globalThis.document = createDocumentStub();
    globalThis.game = {
        user: { id: 'gm', isGM: true },
        users: { get() { return null; }, find() { return null; }, filter() { return []; } },
        actors: { get() { return null; } },
        system: { id: 'dnd5e' },
        i18n: {
            localize: key => key,
            format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
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
            getProperty: () => undefined,
            escapeHTML: value => String(value ?? '')
        },
        audio: {}
    };
    globalThis.Hooks = { callAll() {} };
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

        querySelector() { return null; }
        querySelectorAll() { return []; }
        addEventListener() {}
        setAttribute(name, value) { this[name] = value; }
        set innerHTML(value) { this._innerHTML = String(value || ''); }
        get innerHTML() { return this._innerHTML || ''; }
    }

    const body = new ElementStub('body');
    body.isConnected = true;

    function visit(node, callback, results = []) {
        if (callback(node)) results.push(node);
        for (const child of node.children) visit(child, callback, results);
        return results;
    }

    return {
        body,
        documentElement: { clientWidth: 1280, clientHeight: 800 },
        createElement: tagName => new ElementStub(tagName),
        getElementById: id => visit(body, node => node.id === id)[0] || null,
        querySelector(selector) {
            if (!selector.startsWith('#')) return null;
            return this.getElementById(selector.slice(1));
        },
        querySelectorAll(selector) {
            if (!selector.startsWith('#')) return [];
            return visit(body, node => node.id === selector.slice(1));
        },
        addEventListener() {},
        removeEventListener() {}
    };
}

const tableSpecs = [
    ['BlackjackTable', '../scripts/games/blackjack/BlackjackTable.js', 'parlor-bj-settlement'],
    ['BaccaratTable', '../scripts/games/baccarat/BaccaratTable.js', 'parlor-bac-settlement'],
    ['DragonTigerTable', '../scripts/games/dragontiger/DragonTigerTable.js', 'parlor-dt-settlement'],
    ['CasinoWarTable', '../scripts/games/casinowar/CasinoWarTable.js', 'parlor-cw-settlement'],
    ['ThreeCardPokerTable', '../scripts/games/threecardpoker/ThreeCardPokerTable.js', 'parlor-tcp-settlement'],
    ['TexasHoldemTable', '../scripts/games/texasholdem/TexasHoldemTable.js', 'parlor-th-settlement'],
    ['CrazyEightsTable', '../scripts/games/crazyeights/CrazyEightsTable.js', 'parlor-c8-settlement']
];

async function loadTable(className, modulePath) {
    setupFoundryStubs();
    const stamp = `${Date.now()}-${Math.random()}`;
    const module = await import(`${modulePath}?case=${stamp}`);
    return module[className];
}

function makeGameInstance(state) {
    return {
        sessionId: 'session-a',
        getState: () => state
    };
}

class SmokePresenter {
    mount() {}
    refresh() {}
    destroy() {}
}

describe('card presenter settlement lifecycle', () => {
    for (const [className, modulePath] of tableSpecs) {
        it(`${className} syncs settlement when an existing presenter is rendered`, async () => {
            const TableClass = await loadTable(className, modulePath);
            const state = { phase: 'RESOLVING', round: 1 };
            const table = new TableClass({ gameInstance: makeGameInstance(state) });
            const calls = [];
            table._presenterHost = {
                refresh: nextState => calls.push(['refresh', nextState])
            };
            table._syncSettlement = nextState => calls.push(['settlement', nextState]);

            table._openPresenter(SmokePresenter, 'parlor-themes-tavern');

            assert.deepEqual(calls, [
                ['refresh', state],
                ['settlement', state]
            ]);
        });

        it(`${className} syncs settlement on the first presenter mount`, async () => {
            const TableClass = await loadTable(className, modulePath);
            const state = { phase: 'RESOLVING', round: 1 };
            const table = new TableClass({ gameInstance: makeGameInstance(state) });
            const calls = [];
            table._syncSettlement = nextState => calls.push(nextState);

            table._openPresenter(SmokePresenter, 'parlor-themes-tavern');

            assert.deepEqual(calls, [state]);
            table.close({ dismiss: false });
        });
    }

    for (const [className, modulePath, settlementId] of tableSpecs.filter(([name]) => ['BlackjackTable', 'TexasHoldemTable', 'CrazyEightsTable'].includes(name))) {
        it(`${className} removes its detached settlement when the presenter closes`, async () => {
            const TableClass = await loadTable(className, modulePath);
            const state = { phase: 'RESOLVING', round: 1 };
            const table = new TableClass({ gameInstance: makeGameInstance(state) });
            table._syncSettlement = () => {};
            table._openPresenter(SmokePresenter, 'parlor-themes-tavern');

            const popup = document.createElement('div');
            popup.id = settlementId;
            table._presenterHost.markDetachedSurface(popup, 'settlement');
            document.body.appendChild(popup);

            table.close({ dismiss: false });

            assert.equal(document.getElementById(settlementId), null);
        });
    }

    it('ThreeCardPokerTable refreshes an active presenter after a socket action completes', async () => {
        const TableClass = await loadTable('ThreeCardPokerTable', '../scripts/games/threecardpoker/ThreeCardPokerTable.js');
        const state = { phase: 'RESOLVING', round: 1 };
        const table = new TableClass({ gameInstance: makeGameInstance(state) });
        const calls = [];

        table._overlay = null;
        table._presenterHost = {
            refresh: nextState => calls.push(['refresh', nextState])
        };
        table._syncSettlement = nextState => calls.push(['settlement', nextState]);

        const originalNow = Date.now;
        let now = 1000;
        Date.now = () => now;

        try {
            const result = await table._runSocketAction('gm:settle', null, async () => {
                now = 2000;
                return { ok: true };
            });

            assert.deepEqual(result, { ok: true });
            assert.deepEqual(calls, [
                ['refresh', state],
                ['settlement', state]
            ]);
            assert.equal(table._actionRequests.has('gm:settle'), false);
        } finally {
            Date.now = originalNow;
        }
    });
});