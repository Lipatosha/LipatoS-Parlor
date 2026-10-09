/**
 * BeetleRacePresenterData — 甲虫赛跑 Presenter 数据映射（纯函数，零 import）
 *
 * 赛跑跟牌桌不一样：主角是甲虫不是座位。主题要的东西分四块——
 * - lanes：每道甲虫的名牌信息（名字、介绍、战力文字、赔率、谁押了它），巡游/挑选台/赛道都用
 * - seats：押注的人（名录抽屉用），一人一行，带押了哪几道、本场输赢
 * - hud：自己的注单（押了什么、余额、注额上下限、结果），动作按 kind 分：bet / withdraw / gm
 * - cheats：DM 专用，作弊招和自然动作两组，主题自己画面板
 * 比赛画面（每帧位置）不在这里：那是本地模拟，走 gameApi.getRaceFrame。
 *
 * 注额和"押哪一道"是主题自己的界面状态，bet 动作的 onClick 从 data 里拿 { lane, amount }。
 */

function fallbackT(key, data = null) {
    if (!data) return String(key || '');
    return `${String(key || '')}:${JSON.stringify(data)}`;
}

function t(helpers, key, data = null) {
    const localize = typeof helpers?.t === 'function' ? helpers.t : fallbackT;
    return localize(key, data);
}

function callHelper(helpers, name, fallback, ...args) {
    return typeof helpers?.[name] === 'function' ? helpers[name](...args) : fallback(...args);
}

function participantName(state, id, helpers) {
    return String(callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id) || '');
}

function displayParticipant(state, id, helpers) {
    return callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};
}

function controlledIds(state, helpers) {
    const ids = callHelper(helpers, 'getControlledParticipantIds', () => [], state);
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

function requestAction(helpers, action, data) {
    return callHelper(helpers, 'requestAction', () => Promise.resolve({ ok: false, reason: 'missing-helper' }), action, data);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

function lanesOf(state) {
    return Array.isArray(state?.race?.lanes) ? state.race.lanes : [];
}

function betsOf(state) {
    return Array.isArray(state?.bets) ? state.bets : [];
}

export function powerTextFor(race, lane, helpers) {
    switch (race?.powerDisplay) {
        case 'number': return t(helpers, 'PARLOR.BeetleRace.Caption.PowerNumber', { power: lane.power });
        case 'stars': {
            const stars = Math.max(1, Math.min(5, Math.round(Number(lane.power || 0) / 2)));
            return `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;
        }
        default: return t(helpers, 'PARLOR.BeetleRace.Caption.PowerHidden');
    }
}

/** 每道甲虫的名牌。backers 按注额从大到小，自己的那注标 isSelf */
export function buildBeetleRaceLanes(state = {}, helpers = {}) {
    const race = state.race || {};
    const mine = new Set(controlledIds(state, helpers));
    const bets = betsOf(state);
    const winner = state.phase === 'RESOLVING' ? Number(state.result?.winnerLane ?? -1) : -1;
    const order = Array.isArray(state.order) ? state.order : [];
    return lanesOf(state).map((lane, index) => {
        const backers = bets
            .filter(bet => bet.lane === index)
            .sort((a, b) => b.amount - a.amount)
            .map(bet => ({ id: bet.userId, name: participantName(state, bet.userId, helpers), amount: Number(bet.amount || 0), isSelf: mine.has(bet.userId) }));
        const stats = lane.stats?.races
            ? t(helpers, 'PARLOR.BeetleRace.Caption.Stats', { races: lane.stats.races, wins: lane.stats.wins })
            : t(helpers, 'PARLOR.BeetleRace.Caption.Debut');
        const place = order.indexOf(index);
        return {
            index,
            number: index + 1,
            beetleId: lane.beetleId || '',
            name: lane.name || '',
            intro: lane.intro || '',
            catchphrase: lane.catchphrase || '',
            color: lane.color || '#8a5a2a',
            pattern: lane.pattern || 'plain',
            horn: lane.horn || 'none',
            powerText: powerTextFor(race, lane, helpers),
            statsText: stats,
            multiplier: Number(lane.multiplier || 0),
            multiplierText: `×${Number(lane.multiplier || 0).toFixed(1)}`,
            backers,
            pool: backers.reduce((sum, bet) => sum + bet.amount, 0),
            place: place >= 0 ? place + 1 : 0,
            isWinner: index === winner,
            // 巡游登场演哪个动作（按性格挑的，只给动作名不给性格，玩家看不出性格）
            paradeActionId: String(callHelper(helpers, 'paradeActionFor', () => 'bow', lane) || 'bow')
        };
    });
}

/** 名录：押注的人一人一行 */
export function buildBeetleRaceSeatEntries(state = {}, helpers = {}) {
    const mine = new Set(controlledIds(state, helpers));
    const lanes = lanesOf(state);
    const rows = state.phase === 'RESOLVING' && Array.isArray(state.result?.rows) ? state.result.rows : [];
    const ids = Array.isArray(state.playerIds) ? state.playerIds : [];
    return ids.map(id => {
        const display = displayParticipant(state, id, helpers);
        const bets = betsOf(state).filter(bet => bet.userId === id);
        const staked = bets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
        const row = rows.find(entry => entry.id === id);
        const badges = bets.map(bet => ({ label: `${bet.lane + 1} · ${bet.amount}`, className: 'lane', color: lanes[bet.lane]?.color || '' }));
        let statusText = bets.length ? t(helpers, 'PARLOR.BeetleRace.Hud.Staked', { amount: staked }) : t(helpers, 'PARLOR.BeetleRace.Stands.Watching');
        let statusClass = bets.length ? 'is-in' : 'is-idle';
        if (row) {
            statusText = `${row.net > 0 ? '+' : ''}${row.net}`;
            statusClass = row.net > 0 ? 'is-win' : (row.net < 0 ? 'is-lose' : 'is-push');
        }
        const balance = callHelper(helpers, 'getBalance', () => '', id);
        return {
            id,
            name: participantName(state, id, helpers),
            avatarHtml: display.avatarHtml || '',
            chips: balance === '' || balance == null ? '' : t(helpers, 'PARLOR.BeetleRace.Hud.Balance', { amount: balance }),
            badges,
            bets: bets.map(bet => ({ lane: bet.lane, amount: Number(bet.amount || 0), color: lanes[bet.lane]?.color || '', name: lanes[bet.lane]?.name || '' })),
            staked,
            net: row ? row.net : null,
            statusText,
            statusClass,
            highlight: false,
            isSelf: !!display.isSelf || mine.has(id),
            className: row ? (row.net > 0 ? 'is-winner' : '') : ''
        };
    });
}

export function buildBeetleRaceStatus(state = {}, helpers = {}) {
    const race = state.race || {};
    const lanes = lanesOf(state);
    const phase = t(helpers, `PARLOR.BeetleRace.Phase.${state.phase || 'IDLE'}`);
    let sub = '';
    if (state.phase === 'PARADE') {
        sub = t(helpers, 'PARLOR.BeetleRace.Head.ParadeOf', { index: Math.min(lanes.length, Number(state.paradeIndex || 0) + 1), total: lanes.length });
    } else if (state.phase === 'RESOLVING') {
        const winner = lanes[Number(state.result?.winnerLane ?? -1)];
        sub = winner ? t(helpers, 'PARLOR.BeetleRace.Settlement.Winner', { name: winner.name }) : '';
    }
    return {
        phase,
        round: t(helpers, 'PARLOR.BeetleRace.Head.Round', { round: state.round || 1 }),
        title: race.name || t(helpers, 'PARLOR.Games.BeetleRace.Name'),
        sub
    };
}

function buildParticipantSelect(state, helpers, ids, selectedId) {
    if (ids.length <= 1) return '';
    const options = ids.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(participantName(state, id, helpers))}</option>`).join('');
    return `
        <div class="parlor-br-hud-context">
            <span class="parlor-hud-footer-label">${escapeHtml(t(helpers, 'PARLOR.Common.CurrentParticipant'))}</span>
            <select data-br-participant>${options}</select>
        </div>
    `;
}

function hudMessage(state, helpers, selectedId, mine) {
    if (!selectedId) return t(helpers, callHelper(helpers, 'isGM', () => false) ? 'PARLOR.BeetleRace.Hud.GmWatching' : 'PARLOR.BeetleRace.Hud.Watching');
    switch (state.phase) {
        case 'PARADE':
        case 'IDLE':
            return t(helpers, 'PARLOR.BeetleRace.Hud.WaitParade');
        case 'BETTING':
            return mine.length ? '' : t(helpers, 'PARLOR.BeetleRace.Hud.NoBets');
        case 'RESOLVING': {
            const row = (state.result?.rows || []).find(entry => entry.id === selectedId);
            if (!row) return t(helpers, 'PARLOR.BeetleRace.Hud.NoBetThisRound');
            return row.payout > 0
                ? t(helpers, 'PARLOR.BeetleRace.Hud.Won', { amount: row.payout })
                : t(helpers, 'PARLOR.BeetleRace.Hud.Lost', { amount: row.staked });
        }
        default:
            return t(helpers, mine.length ? 'PARLOR.BeetleRace.Hud.Locked' : 'PARLOR.BeetleRace.Hud.NoBetThisRound');
    }
}

/**
 * 注单。null = 纯观众（不是 GM、名下也没有押注席位）。
 * actions：
 * - kind 'bet'：onClick(event, { lane, amount }) 押 / 改一道；amount 0 等于撤掉这一道
 * - kind 'withdraw'：全部撤回
 * - kind 'gm'：DM 推进（跳过入场 / 封盘开跑）
 */
export function buildBeetleRaceHud(state = {}, helpers = {}) {
    const ids = controlledIds(state, helpers).filter(id => (state.playerIds || []).includes(id));
    const isGM = !!callHelper(helpers, 'isGM', () => false);
    if (!ids.length && !isGM) return null;

    const selectedId = String(callHelper(helpers, 'resolveSelectedParticipantId', () => ids[0] || '', state) || '');
    const race = state.race || {};
    const lanes = lanesOf(state);
    const mine = selectedId ? betsOf(state).filter(bet => bet.userId === selectedId) : [];
    const staked = mine.reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
    const betting = state.phase === 'BETTING' && !!selectedId;
    const display = selectedId ? displayParticipant(state, selectedId, helpers) : {};
    const balance = selectedId ? callHelper(helpers, 'getBalance', () => '', selectedId) : '';
    const row = state.phase === 'RESOLVING' && selectedId ? (state.result?.rows || []).find(entry => entry.id === selectedId) || null : null;
    const pendingBet = callHelper(helpers, 'isActionPending', () => false, `player:${selectedId}:placeBet`);

    const actions = [];
    if (betting) {
        actions.push({
            kind: 'bet',
            icon: 'fas fa-coins',
            label: t(helpers, 'PARLOR.Common.Bet'),
            className: 'gold',
            disabled: !!pendingBet,
            onClick: (_event, data = {}) => requestAction(helpers, 'placeBet', {
                participantId: selectedId,
                lane: Number(data.lane),
                amount: Math.max(0, Math.floor(Number(data.amount) || 0))
            })
        });
        actions.push({
            kind: 'withdraw',
            icon: 'fas fa-undo',
            label: t(helpers, 'PARLOR.BeetleRace.Hud.Withdraw'),
            className: 'fold',
            disabled: !mine.length,
            onClick: () => requestAction(helpers, 'clearBets', { participantId: selectedId })
        });
    }
    if (isGM && state.phase === 'PARADE') {
        actions.push({ kind: 'gm', icon: 'fas fa-forward', label: t(helpers, 'PARLOR.BeetleRace.Gm.SkipParade'), className: 'gm', disabled: false, onClick: () => requestAction(helpers, 'skipParade', {}) });
    }
    if (isGM && state.phase === 'BETTING') {
        actions.push({ kind: 'gm', icon: 'fas fa-flag-checkered', label: t(helpers, 'PARLOR.BeetleRace.Gm.CloseBetting'), className: 'gm', disabled: false, onClick: () => requestAction(helpers, 'closeBetting', {}) });
    }

    return {
        ownerId: selectedId || 'gm',
        topline: [t(helpers, 'PARLOR.Games.BeetleRace.Name'), t(helpers, 'PARLOR.BeetleRace.Head.Round', { round: state.round || 1 }), t(helpers, `PARLOR.BeetleRace.Phase.${state.phase || 'IDLE'}`)],
        identity: {
            crest: display.avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: selectedId ? participantName(state, selectedId, helpers) : t(helpers, 'PARLOR.Common.Spectating'),
            credits: balance === '' || balance == null ? '' : `${balance}`,
            sub: selectedId ? t(helpers, 'PARLOR.BeetleRace.Hud.Staked', { amount: staked }) : ''
        },
        cards: [],
        participantId: selectedId,
        bets: mine.map(bet => ({
            lane: bet.lane,
            amount: Number(bet.amount || 0),
            name: lanes[bet.lane]?.name || '',
            color: lanes[bet.lane]?.color || '',
            returns: Math.floor(Number(bet.amount || 0) * Number(lanes[bet.lane]?.multiplier || 0))
        })),
        staked,
        canBet: betting,
        limits: {
            min: Math.max(1, Number(race.minBet || 1)),
            max: Number(race.maxBet || 0),
            balance: typeof balance === 'number' ? balance : Number(balance),
            quick: [10, 50, 100]
        },
        result: row ? { payout: row.payout, staked: row.staked, net: row.net } : null,
        message: hudMessage(state, helpers, selectedId, mine),
        isGM,
        centerHtml: buildParticipantSelect(state, helpers, ids, selectedId),
        asideHtml: '',
        actions
    };
}

/** DM 作弊面板：明招一组、自然动作一组，每只虫当前的暗调倍率 */
export function buildBeetleRaceCheats(state = {}, helpers = {}) {
    if (!callHelper(helpers, 'isGM', () => false)) return null;
    const moves = Array.isArray(state.race?.cheats) ? state.race.cheats : [];
    const toEntry = (move) => {
        const category = callHelper(helpers, 'actionCategory', () => 'show', move.actionId);
        const magic = !!callHelper(helpers, 'isMagicAction', () => false, move.actionId);
        return {
            id: move.id,
            name: move.name || '',
            actionId: move.actionId,
            actionName: t(helpers, `PARLOR.BeetleRace.Action.${move.actionId}.Name`),
            bubble: move.bubble || '',
            tone: magic ? 'magic' : (category === 'boost' ? 'boost' : 'stall')
        };
    };
    return {
        blatant: moves.filter(move => move.pool === 'cheat').map(toEntry),
        natural: moves.filter(move => move.pool === 'random').map(toEntry),
        biases: lanesOf(state).map((_lane, index) => Number(state.biases?.[index] ?? 1)),
        biasRange: { min: 0.4, max: 1.8, step: 0.05 },
        onCheat: (lane, moveId) => requestAction(helpers, 'cheat', { lane: Number(lane), moveId: String(moveId || '') }),
        onBias: (lane, mul) => requestAction(helpers, 'bias', { lane: Number(lane), mul: Number(mul) })
    };
}
