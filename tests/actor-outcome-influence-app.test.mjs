import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

class ApplicationV2Stub {
    constructor(options = {}) {
        this.options = options;
        this.closed = false;
    }

    async _prepareContext() { return {}; }
    _onRender() {}
    close() { this.closed = true; }
}

globalThis.foundry = {
    applications: {
        api: {
            ApplicationV2: ApplicationV2Stub,
            HandlebarsApplicationMixin: Base => class extends Base {}
        }
    },
    utils: {
        deepClone: value => structuredClone(value),
        getProperty: (source, path) => String(path || '')
            .split('.')
            .filter(Boolean)
            .reduce((value, key) => value?.[key], source)
    }
};

const notices = [];
const config = {
    enabled: true,
    minWinRate: 5,
    maxWinRate: 95,
    games: {
        blackjack: { attributePath: 'skills.luck.total', baseWinRate: 50, pointsPerWinRate: 10 },
        texasholdem: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        threecardpoker: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        liarsdice: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        bone21: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 },
        crazyeights: { attributePath: '', baseWinRate: 50, pointsPerWinRate: 10 }
    },
    baccarat: {
        attributePath: 'skills.luck.total',
        lossReductionPercent: 10,
        winBoostPercent: 20,
        pointsPerPercent: 10
    }
};

globalThis.game = {
    user: { isGM: true },
    actors: { get: () => null },
    users: { get: () => null },
    settings: {
        settings: { has: () => true },
        get: () => structuredClone(config)
    },
    i18n: {
        localize: key => key,
        format: (key, data = {}) => `${key}:${JSON.stringify(data)}`
    }
};

globalThis.ui = {
    notifications: {
        info: message => notices.push({ type: 'info', message }),
        error: message => notices.push({ type: 'error', message })
    }
};

const { ActorOutcomeInfluenceConfigApp } = await import('../scripts/apps/ActorOutcomeInfluenceConfigApp.js');
const templateSource = readFileSync('templates/actor-outcome-influence-config.hbs', 'utf8');
const styleSource = readFileSync('styles/parlor.css', 'utf8');
const mainSource = readFileSync('scripts/main.js', 'utf8');
const en = JSON.parse(readFileSync('languages/en.json', 'utf8'));
const cn = JSON.parse(readFileSync('languages/cn.json', 'utf8'));

function createActor(overrides = { blackjack: 0, baccarat: -10 }) {
    return {
        id: 'hero',
        name: 'Hero',
        overrides: structuredClone(overrides),
        getFlag: () => structuredClone(overrides),
        getRollData: () => ({ skills: { luck: { total: 20 } } }),
        async setFlag(_scope, _key, value) {
            this.saved = structuredClone(value);
        }
    };
}

describe('Actor outcome influence ApplicationV2', () => {
    beforeEach(() => {
        notices.length = 0;
        game.user.isGM = true;
    });

    it('只列出七种已接入牌局，并预览人工值覆盖后的换算结果', async () => {
        const app = new ActorOutcomeInfluenceConfigApp(createActor());
        const context = await app._prepareContext({});

        assert.deepEqual(context.rows.map(row => row.id), [
            'blackjack',
            'texasholdem',
            'threecardpoker',
            'liarsdice',
            'bone21',
            'crazyeights',
            'baccarat'
        ]);
        assert.equal(context.rows[0].isManual, true);
        assert.equal(context.rows[0].manualValue, 0);
        assert.equal(context.rows[0].automaticValue, 20);
        assert.match(context.rows[0].preview, /"value":"50"/u);
        assert.match(context.rows[6].preview, /"loss":"5"/u);
        assert.match(context.rows[6].preview, /"win":"15"/u);
    });

    it('保存零、负数和小数后才关闭窗口', async () => {
        const actor = createActor({});
        const app = new ActorOutcomeInfluenceConfigApp(actor);
        app._draft = { blackjack: 0, texasholdem: -2.5 };

        assert.equal(await app._saveOverrides(), true);
        assert.deepEqual(actor.saved, { blackjack: 0, texasholdem: -2.5 });
        assert.equal(app.closed, true);
        assert.equal(notices.at(-1)?.type, 'info');
    });

    it('保存失败时保留窗口和草稿，并明确报错', async () => {
        const actor = createActor({ blackjack: 12 });
        actor.setFlag = async () => {
            throw new Error('permission denied');
        };
        const app = new ActorOutcomeInfluenceConfigApp(actor);
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            assert.equal(await app._saveOverrides(), false);
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(app.closed, false);
        assert.deepEqual(app._draft, { blackjack: 12 });
        assert.equal(notices.at(-1)?.type, 'error');
        assert.match(notices.at(-1)?.message, /permission denied/u);
    });

    it('人工值为空时不写 Actor flag，也不关闭窗口', async () => {
        const actor = createActor({});
        const app = new ActorOutcomeInfluenceConfigApp(actor);
        app._draft = { blackjack: '' };
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            assert.equal(await app._saveOverrides(), false);
        } finally {
            console.error = originalConsoleError;
        }

        assert.equal(actor.saved, undefined);
        assert.equal(app.closed, false);
        assert.equal(notices.at(-1)?.type, 'error');
    });

    it('模板提供自动与人工切换，样式限制窗口并保留独立滚动区', () => {
        assert.match(templateSource, /data-actor-outcome-mode/u);
        assert.match(templateSource, /data-actor-outcome-value/u);
        assert.match(templateSource, /data-action="save-actor-outcomes"/u);
        assert.match(styleSource, /\.parlor-actor-outcome-config \.window-content/u);
        assert.match(styleSource, /\.parlor-actor-outcome-list\s*\{[^}]*overflow-y:\s*auto/su);
    });

    it('主入口只用 V2 标题 Hook，并保留 Actor 目录右键入口', () => {
        assert.match(mainSource, /Hooks\.on\('getHeaderControlsApplicationV2'/u);
        assert.match(mainSource, /Hooks\.on\('getActorContextOptions'/u);
        assert.doesNotMatch(mainSource, /getApplicationV1HeaderButtons|getActorSheetHeaderButtons/u);
    });

    it('中英文都说明人工值覆盖自动路径', () => {
        assert.match(cn.PARLOR.OutcomeInfluence.Actor.Sub, /覆盖/u);
        assert.match(cn.PARLOR.OutcomeInfluence.Panel.Sub, /人工值优先/u);
        assert.match(en.PARLOR.OutcomeInfluence.Actor.Sub, /overrides/u);
        assert.match(en.PARLOR.OutcomeInfluence.Panel.Sub, /take priority/u);
    });
});
