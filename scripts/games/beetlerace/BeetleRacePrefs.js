/**
 * 甲虫赛跑 · 开桌偏好（GM 替全桌定，world 设置，记住上次的选择）
 *
 * 开桌对话里勾，点开始才写回去；比赛中也只有 GM 改得动。注册在 main.js。
 * 设置没注册的环境（离线预览、测试）一律回默认值，别抛。
 */

export const BEETLE_PREFS = Object.freeze({
    sound: { key: 'beetleRaceSound', fallback: true },
    cleanTable: { key: 'beetleRaceCleanTable', fallback: false }
});

const registered = (key) => !!game?.settings?.settings?.has?.(`parlor.${key}`);

export function getBeetlePref(name) {
    const pref = BEETLE_PREFS[name];
    if (!pref) return undefined;
    try {
        if (!registered(pref.key)) return pref.fallback;
        const value = game.settings.get('parlor', pref.key);
        return typeof value === 'boolean' ? value : pref.fallback;
    } catch {
        return pref.fallback;
    }
}

export async function setBeetlePref(name, value) {
    const pref = BEETLE_PREFS[name];
    if (!pref || !game?.user?.isGM || !registered(pref.key)) return;
    if (getBeetlePref(name) === !!value) return;
    try {
        await game.settings.set('parlor', pref.key, !!value);
    } catch (err) {
        console.warn(`parlor | beetle race pref ${name} failed`, err);
    }
}
