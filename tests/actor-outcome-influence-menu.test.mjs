import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const actors = new Map();
const opened = [];

globalThis.game = {
    release: { generation: 14 },
    user: { isGM: true },
    actors: {
        get: id => actors.get(id) || null
    }
};

const {
    ACTOR_OUTCOME_CONTROL_ACTION,
    addActorOutcomeContextOption,
    addActorOutcomeHeaderControl
} = await import('../scripts/core/ActorOutcomeInfluenceMenu.js');

const actor = {
    id: 'hero',
    name: 'Hero',
    documentName: 'Actor',
    pack: null
};

describe('Actor outcome influence menu compatibility', () => {
    beforeEach(() => {
        actors.clear();
        actors.set(actor.id, actor);
        opened.length = 0;
        game.user.isGM = true;
        game.release.generation = 14;
    });

    it('在 V13/V14 的 ApplicationV2 Actor 标题菜单注入同一个 GM 入口', () => {
        for (const generation of [13, 14]) {
            game.release.generation = generation;
            const controls = [];

            addActorOutcomeHeaderControl({ document: actor }, controls, value => opened.push(value));

            assert.equal(controls.length, 1);
            assert.deepEqual(
                Object.keys(controls[0]).sort(),
                ['action', 'icon', 'label', 'onClick', 'visible']
            );
            assert.equal(controls[0].action, ACTOR_OUTCOME_CONTROL_ACTION);
            assert.equal(controls[0].label, 'PARLOR.OutcomeInfluence.Actor.Menu');
            assert.equal(controls[0].visible, true);
            controls[0].onClick();
        }

        assert.deepEqual(opened, [actor, actor]);
    });

    it('只给 GM 的世界 Actor 窗口加入口，也不会重复注入', () => {
        const controls = [{ action: ACTOR_OUTCOME_CONTROL_ACTION }];
        addActorOutcomeHeaderControl({ document: actor }, controls, () => {});
        assert.equal(controls.length, 1);

        addActorOutcomeHeaderControl({ document: { documentName: 'Item' } }, [], () => {
            assert.fail('非 Actor 不应打开设置窗');
        });

        const packedActor = { ...actor, pack: 'world.actors' };
        const packedControls = [];
        addActorOutcomeHeaderControl({ document: packedActor }, packedControls, () => {});
        assert.equal(packedControls.length, 0);

        game.user.isGM = false;
        const playerControls = [];
        addActorOutcomeHeaderControl({ document: actor }, playerControls, () => {});
        assert.equal(playerControls.length, 0);
    });

    it('V13 Actor 目录右键项使用旧字段，并解析 jQuery 目标', () => {
        game.release.generation = 13;
        const menuItems = [];
        addActorOutcomeContextOption({}, menuItems, value => opened.push(value));

        assert.deepEqual(
            Object.keys(menuItems[0]).sort(),
            ['callback', 'condition', 'icon', 'name']
        );
        const target = { 0: { closest: () => ({ dataset: { entryId: actor.id } }) } };
        assert.equal(menuItems[0].condition(target), true);
        menuItems[0].callback(target);
        assert.deepEqual(opened, [actor]);
    });

    it('V14 Actor 目录右键项使用新字段，并解析 HTMLElement 目标', () => {
        const menuItems = [];
        addActorOutcomeContextOption({}, menuItems, value => opened.push(value));

        assert.deepEqual(
            Object.keys(menuItems[0]).sort(),
            ['icon', 'label', 'onClick', 'visible']
        );
        const target = { closest: () => ({ dataset: { entryId: actor.id } }) };
        assert.equal(menuItems[0].visible(target), true);
        menuItems[0].onClick(target);
        assert.deepEqual(opened, [actor]);
    });

    it('Actor 目录只给世界 Actor 显示入口，并避免重复注入', () => {
        const target = { closest: () => ({ dataset: { entryId: 'missing' } }) };
        const menuItems = [];
        addActorOutcomeContextOption({}, menuItems, () => {});
        assert.equal(menuItems[0].visible(target), false);

        addActorOutcomeContextOption({}, menuItems, () => {});
        assert.equal(menuItems.length, 1);
    });
});
