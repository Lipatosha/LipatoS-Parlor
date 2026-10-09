/**
 * D&D 金币和 Parlor 筹码的兑换规划。
 *
 * 这层不碰 Foundry 文档，只负责把“想怎么换”算成稳定的写入计划，方便 GM 面板和玩家自助共用。
 */

export const DND_GOLD_CHIP_RATE = 1;

function toWholeAmount(value) {
    const amount = Math.floor(Number(value || 0));
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function addAmount(map, entry) {
    const participantId = String(entry?.participantId || entry?.id || '').trim();
    const amount = toWholeAmount(entry?.amount);
    if (!participantId || !amount) return;
    map.set(participantId, (map.get(participantId) || 0) + amount);
}

function buildAmountMap(entries) {
    const map = new Map();
    if (!Array.isArray(entries)) return map;
    for (const entry of entries) addAmount(map, entry);
    return map;
}

function safeBalance(value) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
}

export function planGoldChipExchange({ rows = [], grants = [], goldToChip = [], chipToGold = [] } = {}) {
    const rowMap = new Map(rows.map(row => [String(row?.id || ''), row]).filter(([id]) => id));
    const grantMap = buildAmountMap(grants);
    const goldToChipMap = buildAmountMap(goldToChip);
    const chipToGoldMap = buildAmountMap(chipToGold);
    const participantIds = new Set([
        ...grantMap.keys(),
        ...goldToChipMap.keys(),
        ...chipToGoldMap.keys()
    ]);

    const actorUpdates = [];
    const chipDeltas = [];
    const missingRows = [];
    const shortGoldRows = [];
    const shortChipRows = [];
    let totalGranted = 0;
    let totalGoldToChip = 0;
    let totalChipToGold = 0;

    for (const participantId of participantIds) {
        const row = rowMap.get(participantId);
        if (!row?.actorId) {
            missingRows.push({ participantId });
            continue;
        }

        const currentGold = safeBalance(row.gold);
        const currentChips = safeBalance(row.chips);
        const grantAmount = grantMap.get(participantId) || 0;
        const wantedGoldToChip = goldToChipMap.get(participantId) || 0;
        const wantedChipToGold = chipToGoldMap.get(participantId) || 0;
        const goldAfterGrant = currentGold + grantAmount;
        const acceptedGoldToChip = wantedGoldToChip <= goldAfterGrant ? wantedGoldToChip : 0;
        const acceptedChipToGold = wantedChipToGold <= currentChips ? wantedChipToGold : 0;

        if (wantedGoldToChip && !acceptedGoldToChip) {
            shortGoldRows.push({
                participantId,
                requested: wantedGoldToChip,
                available: goldAfterGrant
            });
        }

        if (wantedChipToGold && !acceptedChipToGold) {
            shortChipRows.push({
                participantId,
                requested: wantedChipToGold,
                available: currentChips
            });
        }

        const chipDelta = (acceptedGoldToChip * DND_GOLD_CHIP_RATE) - acceptedChipToGold;
        const nextGold = Math.max(0, Math.round((goldAfterGrant - acceptedGoldToChip + acceptedChipToGold) * 100) / 100);

        if (!grantAmount && !acceptedGoldToChip && !acceptedChipToGold) continue;

        actorUpdates.push({
            participantId,
            actorId: row.actorId,
            nextGold,
            grantAmount,
            goldToChip: acceptedGoldToChip,
            chipToGold: acceptedChipToGold,
            chipDelta
        });

        if (chipDelta) {
            chipDeltas.push({ userId: participantId, delta: chipDelta });
        }

        totalGranted += grantAmount;
        totalGoldToChip += acceptedGoldToChip;
        totalChipToGold += acceptedChipToGold;
    }

    return {
        actorUpdates,
        chipDeltas,
        missingRows,
        shortGoldRows,
        shortChipRows,
        totalGranted,
        totalGoldToChip,
        totalChipToGold
    };
}
