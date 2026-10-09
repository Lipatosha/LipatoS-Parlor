/**
 * 大厅入口可见性
 *
 * 这里区分“功能存在”和“是否摆在大厅里”。隐藏的游戏仍然能走宏或内部 API 打开。
 */

export const LOBBY_HIDDEN_GAME_IDS = Object.freeze(new Set([
    'roulette',
    'dragontiger',
    'casinowar'
]));

export function isVisibleInLobby(gameId) {
    return !LOBBY_HIDDEN_GAME_IDS.has(String(gameId || ''));
}
