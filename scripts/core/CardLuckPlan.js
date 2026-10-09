const LUCK_MODES = Object.freeze(['normal', 'good', 'bad']);

const CUSTOM_HAND_TYPES = Object.freeze({
    blackjack: Object.freeze(['natural-blackjack']),
    texasholdem: Object.freeze([
        'royal-flush',
        'straight-flush',
        'full-house',
        'three-kind',
        'flush'
    ])
});

const LEGACY_LUCK_MODES = Object.freeze({
    win: 'good',
    lose: 'bad'
});

function normalizeGameType(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeParticipantId(value) {
    return String(value || '').trim();
}

function normalizeMode(value) {
    return String(value || 'normal').trim().toLowerCase();
}

function normalizeLuck(value) {
    const mode = normalizeMode(value);
    if (LUCK_MODES.includes(mode)) return mode;
    return LEGACY_LUCK_MODES[mode] || 'normal';
}

function normalizeCustomHandType(gameType, value, { legacyHand = false } = {}) {
    const handTypes = CUSTOM_HAND_TYPES[gameType] || [];
    const handType = normalizeMode(value);
    if (handTypes.includes(handType)) return handType;
    if (gameType === 'blackjack' && handType === 'blackjack') return 'natural-blackjack';
    if (gameType === 'texasholdem' && legacyHand && !value) return 'flush';
    return '';
}

function getLegacyEntries(rawPlan) {
    if (!rawPlan || typeof rawPlan !== 'object') return {};
    if (rawPlan.entries && typeof rawPlan.entries === 'object') return rawPlan.entries;

    const hasNewShape = Object.hasOwn(rawPlan, 'luckByParticipantId')
        || Object.hasOwn(rawPlan, 'customHand')
        || Object.hasOwn(rawPlan, 'gameType');
    return hasNewShape ? {} : rawPlan;
}

function buildParticipantFilter(participantIds) {
    const ids = Array.isArray(participantIds)
        ? participantIds.map(normalizeParticipantId).filter(Boolean)
        : [];
    return ids.length ? new Set(ids) : null;
}

function isEligibleParticipant(participantId, participantFilter) {
    return !!participantId && (!participantFilter || participantFilter.has(participantId));
}

function readLegacyEntry(gameType, rawEntry) {
    const mode = normalizeMode(typeof rawEntry === 'string' ? rawEntry : rawEntry?.mode);
    const luck = normalizeLuck(mode);

    if (gameType === 'blackjack' && ['blackjack', 'natural-blackjack'].includes(mode)) {
        return { luck: 'normal', customHandType: 'natural-blackjack' };
    }

    if (gameType === 'texasholdem') {
        const directHandType = normalizeCustomHandType(gameType, mode);
        if (directHandType) return { luck: 'normal', customHandType: directHandType };
        if (mode === 'hand') {
            return {
                luck: 'normal',
                customHandType: normalizeCustomHandType(gameType, rawEntry?.handType, { legacyHand: true })
            };
        }
    }

    return { luck, customHandType: '' };
}

function buildCustomHand(gameType, rawCustomHand, participantFilter) {
    if (!rawCustomHand || typeof rawCustomHand !== 'object' || rawCustomHand.pending === false) return null;

    const participantId = normalizeParticipantId(rawCustomHand.participantId);
    if (!isEligibleParticipant(participantId, participantFilter)) return null;

    const requestedGameType = normalizeGameType(rawCustomHand.gameType || gameType);
    if (requestedGameType !== gameType) return null;

    const handType = normalizeCustomHandType(gameType, rawCustomHand.handType ?? rawCustomHand.mode);
    if (!handType) return null;

    return {
        participantId,
        gameType,
        handType,
        pending: true
    };
}

function clonePlan(plan) {
    return {
        gameType: normalizeGameType(plan?.gameType),
        luckByParticipantId: { ...(plan?.luckByParticipantId || {}) },
        customHand: plan?.customHand ? { ...plan.customHand } : null,
        errors: Array.isArray(plan?.errors) ? [...plan.errors] : []
    };
}

export class CardLuckPlan {
    static LUCK_MODES = LUCK_MODES;
    static CUSTOM_HAND_TYPES = CUSTOM_HAND_TYPES;

    static sanitize(gameType, rawPlan = {}, participantIds = []) {
        const safeGameType = normalizeGameType(gameType);
        const participantFilter = buildParticipantFilter(participantIds);
        const luckByParticipantId = {};
        let customHand = null;

        for (const [rawParticipantId, rawEntry] of Object.entries(getLegacyEntries(rawPlan))) {
            const participantId = normalizeParticipantId(rawParticipantId);
            if (!isEligibleParticipant(participantId, participantFilter)) continue;

            const entry = readLegacyEntry(safeGameType, rawEntry);
            if (entry.luck !== 'normal') luckByParticipantId[participantId] = entry.luck;
            if (entry.customHandType) {
                // 旧格式可能同时带多个目标，按对象顺序取最后一个，和 UI 的“转移”语义一致。
                customHand = {
                    participantId,
                    gameType: safeGameType,
                    handType: entry.customHandType,
                    pending: true
                };
            }
        }

        for (const [rawParticipantId, rawLuck] of Object.entries(rawPlan?.luckByParticipantId || {})) {
            const participantId = normalizeParticipantId(rawParticipantId);
            if (!isEligibleParticipant(participantId, participantFilter)) continue;

            const luck = normalizeLuck(rawLuck);
            if (luck === 'normal') delete luckByParticipantId[participantId];
            else luckByParticipantId[participantId] = luck;
        }

        if (Object.hasOwn(rawPlan || {}, 'customHand')) {
            customHand = buildCustomHand(safeGameType, rawPlan.customHand, participantFilter);
        }

        return {
            gameType: safeGameType,
            luckByParticipantId,
            customHand,
            errors: []
        };
    }

    static getLuck(plan, participantId) {
        const luck = normalizeLuck(plan?.luckByParticipantId?.[normalizeParticipantId(participantId)]);
        return LUCK_MODES.includes(luck) ? luck : 'normal';
    }

    static hasInfluence(plan) {
        return Object.keys(plan?.luckByParticipantId || {}).length > 0 || !!plan?.customHand?.pending;
    }

    static consumeCustomHand(plan, { committed = false, participantId = '' } = {}) {
        if (!committed || !plan?.customHand?.pending) return plan;

        const expectedParticipantId = normalizeParticipantId(participantId);
        if (expectedParticipantId && expectedParticipantId !== plan.customHand.participantId) return plan;

        const next = clonePlan(plan);
        next.customHand = null;
        return next;
    }

    static withCustomHand(plan, customHand, participantIds = []) {
        const source = clonePlan(plan);
        source.customHand = customHand;
        return this.sanitize(source.gameType, source, participantIds);
    }

    static toLegacyCompatiblePlan(plan) {
        const entries = {};
        for (const [participantId, luck] of Object.entries(plan?.luckByParticipantId || {})) {
            if (luck === 'good') entries[participantId] = { mode: 'win' };
            if (luck === 'bad') entries[participantId] = { mode: 'lose' };
        }

        const customHand = plan?.customHand;
        if (customHand?.pending) {
            entries[customHand.participantId] = customHand.gameType === 'blackjack'
                ? { mode: 'blackjack' }
                : { mode: 'hand', handType: customHand.handType };
        }

        return {
            gameType: normalizeGameType(plan?.gameType),
            entries,
            errors: []
        };
    }
}
