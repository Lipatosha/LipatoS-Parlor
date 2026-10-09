/**
 * 旧控牌入口只保留一版输入兼容。
 * 新代码统一使用 CardLuckPlan，这里不再提供任何固定牌面构建方法。
 */
import { CardLuckPlan } from './CardLuckPlan.js';

export class ForcedOutcomePlan {
    static BLACKJACK_MODES = Object.freeze(['normal', 'win', 'lose', 'blackjack']);
    static TEXAS_MODES = Object.freeze(['normal', 'win', 'lose', 'hand']);
    static TEXAS_HAND_TYPES = CardLuckPlan.CUSTOM_HAND_TYPES.texasholdem;

    static sanitize(gameType, plan = {}, participantIds = []) {
        return CardLuckPlan.sanitize(gameType, plan, participantIds);
    }

    static hasEntries(plan = {}) {
        return CardLuckPlan.hasInfluence(plan);
    }

    static toCardLuckPlan(gameType, plan = {}, participantIds = []) {
        return CardLuckPlan.sanitize(gameType, plan, participantIds);
    }
}
