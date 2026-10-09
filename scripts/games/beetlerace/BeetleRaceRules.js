/**
 * 甲虫赛跑 · 规则（纯函数，引擎和界面共用）
 *
 * 钱怎么算都在这：下注校验、固定倍率派彩、结算行。引擎只负责什么时候调、调完写进 state。
 */

import { TRACK_LENGTH } from './BeetleRaceCatalog.js';

// 巡游：每只甲虫在灯下待多久；入场动作按性格挑，爱现的会秀一下起飞
export const PARADE_STEP_MS = 4200;
// 巡游开场留给"开幕"的一段：第一只甲虫要等这么久才上台。算在主机的阶段时钟里，
// 各端两套皮肤的拉幕和亮灯才是同一时刻；别挪到呈现器里各自延时
export const PARADE_INTRO_MS = 2400;
export const COUNTDOWN_MS = 3200;
// 最后一只撞线、全员停稳之后再等这么久才进结算，给各端把慢镜和撞线演完
export const RESOLVE_GRACE_MS = 1800;

const PARADE_POSES = {
    steady: 'bow',
    greedy: 'snack',
    hothead: 'dash',
    lazy: 'nap',
    clumsy: 'trip',
    showoff: 'fly',
    timid: 'moonwalk',
    sly: 'taunt'
};

export function paradeActionFor(lane) {
    return PARADE_POSES[lane?.temperament] || 'bow';
}

/** 赛事快照 + 本场随机种子/干预 → 模拟器吃的 spec */
export function buildSimSpec(race, run) {
    return {
        seed: Number(run?.seed) >>> 0,
        durationSec: race.durationSec,
        eventRate: race.eventRate,
        lanes: race.lanes.map(lane => ({ power: lane.power, temperament: lane.temperament })),
        pool: race.pool.map(move => ({ id: move.id, actionId: move.actionId, bubble: move.bubble, bubbles: move.bubbles, dur: move.dur, strength: move.strength })),
        interventions: Array.isArray(run?.interventions) ? run.interventions : []
    };
}

export function stakeOf(bets, participantId) {
    return (bets || []).filter(bet => bet.userId === participantId).reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
}

export function betOn(bets, participantId, laneIndex) {
    return (bets || []).find(bet => bet.userId === participantId && bet.lane === laneIndex) || null;
}

/**
 * 押一只（或改注额）。amount 是这一只的新注额，不是追加量；0 = 撤掉这一只。
 * balance 为 Infinity 表示不进账的席位（机器人 / NPC / 自测局的 DM）。
 * 返回 { ok, bets } 或 { ok:false, reason }
 */
export function applyBet({ race, bets, participantId, laneIndex, amount, balance = Infinity }) {
    const lane = Number(laneIndex);
    if (!Number.isInteger(lane) || lane < 0 || lane >= race.lanes.length) return { ok: false, reason: 'invalid-lane' };
    const value = Math.floor(Number(amount));
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: 'invalid-amount' };

    const rest = (bets || []).filter(bet => !(bet.userId === participantId && bet.lane === lane));
    if (value === 0) return { ok: true, bets: rest };
    if (value < race.minBet) return { ok: false, reason: 'below-min', min: race.minBet };
    if (race.maxBet > 0 && value > race.maxBet) return { ok: false, reason: 'above-max', max: race.maxBet };
    const total = stakeOf(rest, participantId) + value;
    if (total > balance) return { ok: false, reason: 'chips', balance };

    return { ok: true, bets: [...rest, { userId: participantId, lane, amount: value }] };
}

/** 押中冠军的拿 注额 × 倍率（含本金），向下取整；其余注全输 */
export function payoutFor(race, bet, winnerLane) {
    if (!bet || bet.lane !== winnerLane) return 0;
    const multiplier = Number(race.lanes[winnerLane]?.multiplier) || 0;
    return Math.floor(Number(bet.amount || 0) * multiplier);
}

/**
 * 结算行：每个下过注的席位一行。
 * rows: [{ id, staked, payout, net, stakes: [{ lane, amount, payout }] }]
 */
export function computeSettlement({ race, bets, order }) {
    const winnerLane = Array.isArray(order) && order.length ? order[0] : -1;
    const byId = new Map();
    for (const bet of bets || []) {
        const row = byId.get(bet.userId) || { id: bet.userId, staked: 0, payout: 0, net: 0, stakes: [] };
        const payout = payoutFor(race, bet, winnerLane);
        row.staked += bet.amount;
        row.payout += payout;
        row.stakes.push({ lane: bet.lane, amount: bet.amount, payout });
        byId.set(bet.userId, row);
    }
    const rows = [...byId.values()].map(row => ({ ...row, net: row.payout - row.staked }));
    rows.sort((a, b) => (b.net - a.net) || String(a.id).localeCompare(String(b.id)));
    return { winnerLane, rows };
}

/** 画面用：模拟坐标（0..TRACK_LENGTH+滑行）→ 0..1 进度 */
export function trackProgress(x) {
    return Math.max(0, Number(x) || 0) / TRACK_LENGTH;
}
