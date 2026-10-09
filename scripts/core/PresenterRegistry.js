/**
 * PresenterRegistry — Presenter API v1 的主题呈现器注册表
 *
 * classic 不是 presenter，它永远走本体原生 UI。这里只登记外部主题声明接管的 surface，
 * 查不到时调用方自然回到原生路径。
 */

export const PRESENTER_API_VERSION = 1;

const SURFACE_PATTERN = /^(?:lobby|table:[a-z0-9_-]+)$/u;
const REGISTRY = new Map();

function normalizeThemeId(value) {
    return String(value || '').trim();
}

function isPlainSurfaceMap(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class PresenterRegistry {
    static get apiVersion() { return PRESENTER_API_VERSION; }

    static register(profile) {
        const id = normalizeThemeId(profile?.id);
        if (!id || id === 'classic') {
            console.warn('parlor | registerThemePresenter: 非法主题 id，已忽略', profile);
            return false;
        }

        if (Number(profile?.presenterApiVersion) !== PRESENTER_API_VERSION) {
            console.warn(`parlor | registerThemePresenter: 主题 "${id}" 的 presenterApiVersion=${profile?.presenterApiVersion} 与本体 v${PRESENTER_API_VERSION} 不匹配，已回退原生 UI`);
            return false;
        }

        const surfaces = new Map();
        if (!isPlainSurfaceMap(profile?.surfaces)) {
            console.warn(`parlor | registerThemePresenter: 主题 "${id}" 没有提供有效 surfaces，所有面都会走原生 UI`);
        }

        for (const [surface, PresenterClass] of Object.entries(isPlainSurfaceMap(profile?.surfaces) ? profile.surfaces : {})) {
            if (!SURFACE_PATTERN.test(surface)) {
                console.warn(`parlor | registerThemePresenter: 主题 "${id}" 的 surface "${surface}" 不合法，已跳过`);
                continue;
            }
            if (typeof PresenterClass !== 'function') {
                console.warn(`parlor | registerThemePresenter: 主题 "${id}" 的 surface "${surface}" 不是构造函数，已跳过`);
                continue;
            }
            surfaces.set(surface, PresenterClass);
        }

        if (REGISTRY.has(id)) console.warn(`parlor | registerThemePresenter: 主题 "${id}" 重复注册，后一次会覆盖前一次`);
        REGISTRY.set(id, Object.freeze({
            id,
            labelKey: String(profile?.labelKey || ''),
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces
        }));
        return true;
    }

    static resolve(themeId, surface) {
        const theme = REGISTRY.get(normalizeThemeId(themeId));
        return theme?.surfaces.get(String(surface || '')) || null;
    }

    static hasTheme(themeId) {
        return REGISTRY.has(normalizeThemeId(themeId));
    }

    static listThemes() {
        return [...REGISTRY.values()].map(theme => Object.freeze({
            id: theme.id,
            labelKey: theme.labelKey,
            presenterApiVersion: theme.presenterApiVersion
        }));
    }
}
