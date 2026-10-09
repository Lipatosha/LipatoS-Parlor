export const CARD_BET_LIMIT_GAME_IDS = new Set([
    'blackjack',
    'baccarat',
    'dragontiger',
    'threecardpoker',
    'casinowar'
]);

function readNumber(source, keys, fallback) {
    for (const key of keys) {
        if (source?.[key] !== undefined && source?.[key] !== null) {
            return Number(source[key]);
        }
    }
    return fallback;
}

export function supportsCardBetLimits(gameId) {
    return CARD_BET_LIMIT_GAME_IDS.has(String(gameId || '').toLowerCase());
}

export function normalizeBetLimits(source = {}) {
    const rawMin = Math.floor(readNumber(source, ['min', 'minBet', 'betMin', 'betLimitMin'], 1));
    const min = Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 1;
    const rawMax = Math.floor(readNumber(source, ['max', 'maxBet', 'betMax', 'betLimitMax'], 0));
    const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.max(min, rawMax) : 0;
    return { min, max };
}

export function validateBetAmount(amount, limits = {}, options = {}) {
    const { min, max } = normalizeBetLimits(limits);
    const value = Math.floor(Number(amount));

    if (!Number.isFinite(value)) {
        return { ok: false, reason: 'invalid-amount', amount: 0, min, max };
    }

    if (options.optional && value === 0) {
        return { ok: true, amount: 0, min, max };
    }

    if (value <= 0) {
        return { ok: false, reason: 'invalid-amount', amount: value, min, max };
    }

    if (value < min) {
        return { ok: false, reason: 'bet-too-low', amount: value, min, max };
    }

    if (max > 0 && value > max) {
        return { ok: false, reason: 'bet-too-high', amount: value, min, max };
    }

    return { ok: true, amount: value, min, max };
}

export function clampBetAmount(amount, limits = {}) {
    const { min, max } = normalizeBetLimits(limits);
    const value = Math.floor(Number(amount));
    const safeValue = Number.isFinite(value) && value > 0 ? value : min;
    return Math.max(min, max > 0 ? Math.min(max, safeValue) : safeValue);
}
