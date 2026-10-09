import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it } from 'node:test';

const actors = new Map();

globalThis.foundry = {
    utils: {
        deepClone: value => structuredClone(value),
        getProperty: (source, path) => String(path || '')
            .split('.')
            .filter(Boolean)
            .reduce((value, key) => value?.[key], source)
    }
};

globalThis.game = {
    user: { isGM: true },
    actors: {
        get: actorId => actors.get(actorId) || null
    },
    users: {
        get: () => null
    },
    i18n: {
        localize: key => key
    }
};

const {
    DEFAULT_OUTCOME_INFLUENCE_CONFIG,
    OutcomeInfluence
} = await import('../scripts/core/OutcomeInfluence.js');

const appSource = readFileSync('scripts/apps/OutcomeInfluenceConfigApp.js', 'utf8');
const templateSource = readFileSync('templates/outcome-influence-config.hbs', 'utf8');
const styleSource = readFileSync('styles/parlor.css', 'utf8');
const en = JSON.parse(readFileSync('languages/en.json', 'utf8'));
const cn = JSON.parse(readFileSync('languages/cn.json', 'utf8'));

describe('OutcomeInfluence per-game attribute paths', () => {
    beforeEach(() => {
        actors.clear();
        game.user.isGM = true;
    });

    it('把旧全局路径迁移到每个游戏的新字段', () => {
        const legacy = {
            enabled: true,
            attributePath: ' skills.shared.total ',
            minWinRate: 5,
            maxWinRate: 95,
            games: {
                blackjack: { baseWinRate: 55, pointsPerWinRate: 12 }
            },
            baccarat: {
                lossReductionPercent: 10,
                winBoostPercent: 15,
                pointsPerPercent: 8
            }
        };

        const safe = OutcomeInfluence.sanitizeConfig(legacy);

        assert.equal(Object.hasOwn(safe, 'attributePath'), false);
        assert.equal(safe.games.blackjack.attributePath, 'skills.shared.total');
        assert.equal(safe.games.texasholdem.attributePath, 'skills.shared.total');
        assert.equal(safe.games.threecardpoker.attributePath, 'skills.shared.total');
        assert.equal(safe.games.liarsdice.attributePath, 'skills.shared.total');
        assert.equal(safe.games.bone21.attributePath, 'skills.shared.total');
        assert.equal(safe.baccarat.attributePath, 'skills.shared.total');
        assert.equal(safe.games.blackjack.baseWinRate, 55);
    });

    it('允许单个游戏清空路径，不会又被旧全局值填回', () => {
        const safe = OutcomeInfluence.sanitizeConfig({
            attributePath: 'skills.shared.total',
            games: {
                blackjack: { attributePath: '' },
                threecardpoker: { attributePath: 'skills.cunning.total' }
            },
            baccarat: {
                attributePath: ''
            }
        });

        assert.equal(safe.games.blackjack.attributePath, '');
        assert.equal(safe.games.texasholdem.attributePath, 'skills.shared.total');
        assert.equal(safe.games.threecardpoker.attributePath, 'skills.cunning.total');
        assert.equal(safe.games.liarsdice.attributePath, 'skills.shared.total');
        assert.equal(safe.games.bone21.attributePath, 'skills.shared.total');
        assert.equal(safe.baccarat.attributePath, '');
    });

    it('按当前游戏读取对应属性，不会串用其他游戏的路径', () => {
        actors.set('hero', {
            getRollData: () => ({
                skills: {
                    luck: { total: 20 },
                    cunning: { total: -10 },
                    fortune: { total: 30 },
                    instinct: { total: 10 }
                }
            })
        });

        const source = {
            participants: [{
                id: 'actor:hero',
                type: 'user',
                actorId: 'hero',
                name: 'Hero'
            }]
        };
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.games.blackjack.attributePath = 'skills.luck.total';
        config.games.texasholdem.attributePath = 'skills.instinct.total';
        config.games.threecardpoker.attributePath = 'skills.cunning.total';
        config.games.liarsdice.attributePath = '';
        config.games.bone21.attributePath = 'skills.luck.total';
        config.baccarat.attributePath = 'skills.fortune.total';
        config.baccarat.lossReductionPercent = 10;
        config.baccarat.winBoostPercent = 20;

        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'blackjack', 'actor:hero', config), 60);
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'texasholdem', 'actor:hero', config), 55);
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'threecardpoker', 'actor:hero', config), 45);
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'liarsdice', 'actor:hero', config), 50);
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'bone21', 'actor:hero', config), 60);
        assert.deepEqual(OutcomeInfluence.getBaccaratSwing(source, 'actor:hero', config), {
            lossReductionPercent: 25,
            winBoostPercent: 35
        });
    });

    it('角色卡人工熟练度只覆盖对应游戏的自动属性', () => {
        actors.set('hero', {
            getFlag: (_scope, key) => key === 'outcomeInfluenceOverrides'
                ? { blackjack: -10 }
                : undefined,
            getRollData: () => ({
                skills: {
                    luck: { total: 20 }
                }
            })
        });

        const source = {
            participants: [{
                id: 'actor:hero',
                type: 'user',
                actorId: 'hero',
                name: 'Hero'
            }]
        };
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.games.blackjack.attributePath = 'skills.luck.total';
        config.games.texasholdem.attributePath = 'skills.luck.total';

        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'blackjack', 'actor:hero', config), 45);
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'texasholdem', 'actor:hero', config), 60);
    });

    it('百家乐也用角色卡人工熟练度替换自动属性', () => {
        actors.set('hero', {
            getFlag: (_scope, key) => key === 'outcomeInfluenceOverrides'
                ? { baccarat: -10 }
                : undefined,
            getRollData: () => ({
                skills: {
                    luck: { total: 30 }
                }
            })
        });

        const source = {
            participants: [{
                id: 'actor:hero',
                type: 'user',
                actorId: 'hero',
                name: 'Hero'
            }]
        };
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.baccarat.attributePath = 'skills.luck.total';
        config.baccarat.lossReductionPercent = 10;
        config.baccarat.winBoostPercent = 20;

        assert.deepEqual(OutcomeInfluence.getBaccaratSwing(source, 'actor:hero', config), {
            lossReductionPercent: 5,
            winBoostPercent: 15
        });
    });

    it('保存时保留零与小数，过滤脏值，并能恢复自动', async () => {
        const actor = {
            flag: {},
            getFlag(_scope, key) {
                return key === 'outcomeInfluenceOverrides' ? this.flag : undefined;
            },
            async setFlag(scope, key, value) {
                assert.equal(scope, 'parlor');
                assert.equal(key, 'outcomeInfluenceOverrides');
                this.flag = structuredClone(value);
            },
            getRollData: () => ({
                skills: {
                    luck: { total: 20 }
                }
            })
        };
        actors.set('hero', actor);

        const saved = await OutcomeInfluence.setActorManualOverrides(actor, {
            blackjack: 0,
            texasholdem: -2.5,
            baccarat: 'bad-data',
            roulette: 99
        });
        assert.deepEqual(saved, {
            blackjack: 0,
            texasholdem: -2.5
        });

        const source = {
            participants: [{ id: 'actor:hero', actorId: 'hero' }]
        };
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.games.blackjack.attributePath = 'skills.luck.total';
        assert.deepEqual(
            OutcomeInfluence.getGameInfluenceInput(source, 'blackjack', 'actor:hero', config),
            { value: 0, source: 'manual' }
        );

        await OutcomeInfluence.setActorManualOverrides(actor, {});
        assert.deepEqual(
            OutcomeInfluence.getGameInfluenceInput(source, 'blackjack', 'actor:hero', config),
            { value: 20, source: 'automatic' }
        );
    });

    it('全局关闭、没有角色或脏 flag 时都安全退回原有基线', () => {
        const actor = {
            getFlag: () => ({ blackjack: '20', texasholdem: Number.NaN }),
            getRollData: () => ({ skills: { luck: { total: 10 } } })
        };
        actors.set('hero', actor);
        const source = {
            participants: [{ id: 'actor:hero', actorId: 'hero' }]
        };
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.games.blackjack.attributePath = 'skills.luck.total';

        assert.deepEqual(
            OutcomeInfluence.getGameInfluenceInput(source, 'blackjack', 'actor:hero', config),
            { value: 10, source: 'automatic' }
        );

        config.enabled = false;
        assert.deepEqual(
            OutcomeInfluence.getGameInfluenceInput(source, 'blackjack', 'actor:hero', config),
            { value: 0, source: 'baseline' }
        );
        assert.equal(OutcomeInfluence.getEffectiveWinRate(source, 'blackjack', 'actor:hero', config), 50);
        assert.deepEqual(OutcomeInfluence.getBaccaratSwing(source, 'actor:hero', config), {
            lossReductionPercent: 0,
            winBoostPercent: 0
        });

        assert.deepEqual(
            OutcomeInfluence.getGameInfluenceInput({ participants: [] }, 'blackjack', 'missing', config),
            { value: 0, source: 'baseline' }
        );
    });

    it('只有 GM 能保存角色卡人工熟练度', async () => {
        game.user.isGM = false;
        await assert.rejects(
            OutcomeInfluence.setActorManualOverrides({ setFlag: async () => {} }, { blackjack: 10 }),
            /Only a GM/u
        );
    });

    it('让属性只提高德州初始好牌分支的触发机会', () => {
        const source = {
            participants: [{
                id: 'actor:hero',
                type: 'user',
                actorId: 'hero',
                name: 'Hero'
            }]
        };
        actors.set('hero', {
            getRollData: () => ({
                skills: {
                    luck: { total: 20 }
                }
            })
        });
        const config = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        config.games.texasholdem.attributePath = 'skills.luck.total';

        assert.equal(OutcomeInfluence.rollRateLuckMode(
            source,
            'texasholdem',
            'actor:hero',
            { config, rng: () => 0 }
        ), 'good');
        assert.equal(OutcomeInfluence.rollRateLuckMode(
            source,
            'texasholdem',
            'actor:hero',
            { config, rng: () => 0.9 }
        ), 'normal');
    });

    it('骨骰 21 的好坏分支只改变初始三颗私骰质量', () => {
        const source = { participants: [] };
        const goodConfig = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        const neutralConfig = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        const badConfig = structuredClone(DEFAULT_OUTCOME_INFLUENCE_CONFIG);
        goodConfig.games.bone21.baseWinRate = 95;
        badConfig.games.bone21.baseWinRate = 5;

        const sequence = values => {
            let index = 0;
            return () => values[index++ % values.length];
        };
        const rolls = [0, 0.1, 0.9, 0.2, 0.8, 0.3, 0.7];
        const good = OutcomeInfluence.rollBone21InitialDice(
            source,
            'actor:hero',
            3,
            { config: goodConfig, rng: sequence(rolls) }
        );
        const neutral = OutcomeInfluence.rollBone21InitialDice(
            source,
            'actor:hero',
            3,
            { config: neutralConfig, rng: sequence(rolls) }
        );
        const bad = OutcomeInfluence.rollBone21InitialDice(
            source,
            'actor:hero',
            3,
            { config: badConfig, rng: sequence(rolls) }
        );
        const total = dice => dice.reduce((sum, face) => sum + face, 0);

        assert.ok(total(good) > total(neutral));
        assert.ok(total(neutral) > total(bad));
    });
});

describe('OutcomeInfluence per-game path UI', () => {
    it('给普通牌局和百家乐分别提供路径输入与探针目标', () => {
        assert.deepEqual(
            OutcomeInfluence.getConfigRows(DEFAULT_OUTCOME_INFLUENCE_CONFIG).map(row => row.id),
            ['blackjack', 'texasholdem', 'threecardpoker', 'liarsdice', 'bone21', 'crazyeights']
        );
        assert.match(templateSource, /data-outcome-field="games\.\{\{id\}\}\.attributePath"/u);
        assert.match(templateSource, /data-outcome-path-target="games\.\{\{id\}\}\.attributePath"/u);
        assert.match(templateSource, /data-outcome-field="baccarat\.attributePath"/u);
        assert.match(templateSource, /data-outcome-path-target="baccarat\.attributePath"/u);
        assert.doesNotMatch(templateSource, /data-outcome-field="attributePath"/u);
        assert.match(appSource, /querySelectorAll\('\[data-action="detect-attribute"\]'\)/u);
        assert.match(appSource, /foundry\.utils\.setProperty\(this\._draft, target, path\)/u);
    });

    it('使用受限窗口和独立滚动区，不再把百家乐撑到视口外', () => {
        assert.match(appSource, /height:\s*760/u);
        assert.doesNotMatch(appSource, /height:\s*'auto'/u);
        assert.match(templateSource, /class="parlor-outcome-scroll"/u);
        assert.match(templateSource, /class="parlor-outcome-game-grid"/u);
        assert.match(templateSource, /data-outcome-game="baccarat"/u);
        assert.doesNotMatch(templateSource, /<table\b/u);
        assert.equal(
            templateSource.match(/PARLOR\.OutcomeInfluence\.Fields\.AttributePathHint/gu)?.length,
            1
        );
        assert.match(
            styleSource,
            /\.parlor-outcome-config \.window-content\s*\{[^}]*overflow:\s*hidden/su
        );
        assert.match(
            styleSource,
            /\.parlor-outcome-scroll\s*\{[^}]*overflow-y:\s*auto/su
        );
    });

    it('局部改值与探针回填不会重绘窗口并把滚动位置送回顶部', () => {
        assert.match(appSource, /this\._syncWinRateBounds\(root\)/u);
        assert.match(appSource, /if \(field\) field\.value = path/u);
        assert.doesNotMatch(
            appSource,
            /Detection\.Applied[\s\S]{0,180}this\.render\(true\)/u
        );
    });

    it('中英文都说明属性路径按游戏独立配置', () => {
        assert.match(cn.PARLOR.OutcomeInfluence.Panel.Sub, /每个游戏/u);
        assert.match(cn.PARLOR.OutcomeInfluence.Games.Sub, /德州和骨骰 21/u);
        assert.equal(cn.PARLOR.OutcomeInfluence.FormulaTitle, '查看换算规则');
        assert.equal(cn.PARLOR.OutcomeInfluence.GameMode.StartingHandBias, '起手牌偏向');
        assert.equal(cn.PARLOR.OutcomeInfluence.GameMode.InitialDiceBias, '初始私骰偏向');
        assert.match(en.PARLOR.OutcomeInfluence.Panel.Sub, /Configure each game/u);
        assert.match(en.PARLOR.OutcomeInfluence.Games.Sub, /Texas Hold'em and Bones Twenty-One/u);
        assert.equal(en.PARLOR.OutcomeInfluence.FormulaTitle, 'View conversion rule');
        assert.equal(en.PARLOR.OutcomeInfluence.GameMode.StartingHandBias, 'Starting hand bias');
        assert.equal(en.PARLOR.OutcomeInfluence.GameMode.InitialDiceBias, 'Initial private dice bias');
    });
});
