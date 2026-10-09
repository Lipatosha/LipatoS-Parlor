export const ACTOR_OUTCOME_CONTROL_ACTION = 'parlor-outcome-influence';

const MENU_LABEL = 'PARLOR.OutcomeInfluence.Actor.Menu';
const MENU_ICON = 'fa-solid fa-dice';

function getFoundryGeneration() {
    const releaseGeneration = Number(game?.release?.generation);
    if (Number.isFinite(releaseGeneration)) return releaseGeneration;

    const versionGeneration = Number.parseInt(String(game?.version || ''), 10);
    return Number.isFinite(versionGeneration) ? versionGeneration : 14;
}

function getWorldActor(application) {
    const actor = application?.document || application?.actor || application?.object || null;
    if (actor?.documentName !== 'Actor' || actor.pack) return null;
    return actor;
}

function getContextTarget(target) {
    return target?.currentTarget || target?.target || target?.[0] || target || null;
}

function getContextActor(target) {
    const element = getContextTarget(target)?.closest?.('[data-entry-id]');
    const actorId = element?.dataset?.entryId || element?.getAttribute?.('data-entry-id');
    return actorId ? game?.actors?.get(actorId) || null : null;
}

export function addActorOutcomeHeaderControl(application, controls, openActor) {
    if (!game?.user?.isGM || !Array.isArray(controls) || typeof openActor !== 'function') return;

    const actor = getWorldActor(application);
    if (!actor || controls.some(control => control?.action === ACTOR_OUTCOME_CONTROL_ACTION)) return;

    controls.push({
        action: ACTOR_OUTCOME_CONTROL_ACTION,
        label: MENU_LABEL,
        icon: MENU_ICON,
        visible: true,
        onClick: () => openActor(actor)
    });
}

export function addActorOutcomeContextOption(_application, menuItems, openActor) {
    if (!game?.user?.isGM || !Array.isArray(menuItems) || typeof openActor !== 'function') return;
    if (menuItems.some(item => item?.label === MENU_LABEL || item?.name === MENU_LABEL)) return;

    // V14 把目录菜单字段换了名字，V13 仍然需要旧的 jQuery 回调结构。
    if (getFoundryGeneration() >= 14) {
        menuItems.push({
            label: MENU_LABEL,
            icon: MENU_ICON,
            visible: target => !!getContextActor(target),
            onClick: target => {
                const actor = getContextActor(target);
                if (actor) openActor(actor);
            }
        });
        return;
    }

    menuItems.push({
        name: MENU_LABEL,
        icon: `<i class="${MENU_ICON}"></i>`,
        condition: target => !!getContextActor(target),
        callback: target => {
            const actor = getContextActor(target);
            if (actor) openActor(actor);
        }
    });
}
