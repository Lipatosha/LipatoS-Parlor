/**
 * BlackjackRules — 21 点桌规小工具
 *
 * 这边只放 V14 兼容优先也确实会共用到的规则计算，别再散在三个文件里了。
 */
import { CardDeck } from '../shared/CardDeck.js';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export const DEFAULT_BLACKJACK_RULES = Object.freeze({
    bustThreshold: 21,
    deckCount: 4,
    naturalPayout: 2.5
});

function clampNumber(value, min, max, fallback, { decimals = 0 } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const factor = 10 ** decimals;
    const rounded = Math.round(parsed * factor) / factor;
    return Math.min(max, Math.max(min, rounded));
}

export function sanitizeBlackjackRules(rules = {}) {
    return {
        bustThreshold: clampNumber(rules.bustThreshold, 17, 31, DEFAULT_BLACKJACK_RULES.bustThreshold),
        deckCount: clampNumber(rules.deckCount, 1, 8, DEFAULT_BLACKJACK_RULES.deckCount),
        naturalPayout: clampNumber(rules.naturalPayout, 2, 3, DEFAULT_BLACKJACK_RULES.naturalPayout, { decimals: 1 })
    };
}

export function getBlackjackTotal(cards = [], rules = DEFAULT_BLACKJACK_RULES) {
    const safeRules = sanitizeBlackjackRules(rules);
    let total = 0;
    let aces = 0;

    for (const card of cards) {
        total += CardDeck.getValue(card);
        if (card.rank === 'A') aces++;
    }

    while (total > safeRules.bustThreshold && aces > 0) {
        total -= 10;
        aces--;
    }

    return total;
}

export function isNaturalHand(cards = [], rules = DEFAULT_BLACKJACK_RULES) {
    const safeRules = sanitizeBlackjackRules(rules);
    return cards.length === 2 && getBlackjackTotal(cards, safeRules) === safeRules.bustThreshold;
}

export function getNaturalHandLabel(rules = DEFAULT_BLACKJACK_RULES, { short = false } = {}) {
    const safeRules = sanitizeBlackjackRules(rules);
    if (safeRules.bustThreshold === 21) return 'Blackjack';
    return short
        ? t('PARLOR.Games.Blackjack.Rules.NaturalShort')
        : t('PARLOR.Games.Blackjack.Rules.NaturalLong', { threshold: safeRules.bustThreshold });
}

export function formatNaturalPayout(rules = DEFAULT_BLACKJACK_RULES) {
    const safeRules = sanitizeBlackjackRules(rules);
    return Number.isInteger(safeRules.naturalPayout)
        ? `${safeRules.naturalPayout.toFixed(0)}x`
        : `${safeRules.naturalPayout.toFixed(1)}x`;
}
