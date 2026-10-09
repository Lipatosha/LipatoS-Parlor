/**
 * DragonTigerPresenterData — 龙虎 Presenter 数据映射(纯函数,零 import)
 *
 * 与百家乐同为"公共牌局 + 玩家下注"模型:龙虎各一张牌比大小,玩家押 龙/虎/和。
 * 牌局(dragonCard/tigerCard/winner)呈现器直接从 getState() 读,本模块管座位/匾/HUD。
 */

function fallbackT(key, data = null) {
    if (!data) return String(key || '');
    return `${String(key || '')}:${JSON.stringify(data)}`;
}

function t(helpers, key, data = null) {
    const localize = typeof helpers?.t === 'function' ? helpers.t : fallbackT;
    return localize(key, data);
}

function formatChips(helpers, value) {
    const formatter = typeof helpers?.formatChips === 'function'
        ? helpers.formatChips
        : (amount) => `${Number(amount || 0)}`;
    return formatter(value);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

function callHelper(helpers, name, fallback, ...args) {
    return typeof helpers?.[name] === 'function' ? helpers[name](...args) : fallback(...args);
}

function getBetForUser(state, userId) {
    return (state.bets || []).find(bet => bet.userId === userId) || null;
}

// 所压区徽章配色:虎=金、和=蜡红、龙=素(跟桌面左右阵营对应即可,别跟胜负语义混)
const SIDE_BADGE_CLASS = { tiger: 'gold', tie: 'wax', dragon: '' };

function sideLabel(state, side, helpers) {
    const keys = {
        dragon: 'PARLOR.DragonTiger.Side.Dragon',
        tiger: 'PARLOR.DragonTiger.Side.Tiger',
        tie: 'PARLOR.DragonTiger.Side.Tie'
    };
    return keys[side] ? t(helpers, keys[side]) : String(side || '');
}

export function buildDragonTigerSeatEntries(state = {}, helpers = {}) {
    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const getDisplay = (id) => callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};

    return (state.playerIds || []).map(id => {
        const display = getDisplay(id);
        const bet = getBetForUser(state, id);
        const badges = [];
        if (bet) {
            badges.push({ label: sideLabel(state, bet.side, helpers), className: SIDE_BADGE_CLASS[bet.side] || '' });
        }
        const payout = (state.payouts || {})[id];
        let statusText = '';
        if (state.phase === 'BETTING') {
            statusText = bet
                ? t(helpers, 'PARLOR.Common.BetPlaced')
                : t(helpers, 'PARLOR.Common.WaitingBet');
        } else if (payout != null && bet) {
            const delta = Number(payout) - Number(bet.amount || 0);
            statusText = delta >= 0 ? `+${formatChips(helpers, delta)}` : `${formatChips(helpers, delta)}`;
        }
        return {
            id,
            name: getName(id),
            avatarHtml: display.avatarHtml || '',
            chips: bet ? formatChips(helpers, bet.amount) : '',
            badges,
            statusText,
            statusClass: '',
            highlight: state.phase === 'BETTING' && !bet,
            isSelf: !!display.isSelf,
            className: ''
        };
    });
}

export function buildDragonTigerStatus(state = {}, helpers = {}) {
    const phaseKeys = {
        IDLE: 'PARLOR.Common.Waiting',
        BETTING: 'PARLOR.DragonTiger.Center.Phase.Betting',
        READY: 'PARLOR.DragonTiger.Center.Phase.Ready',
        DEALING: 'PARLOR.DragonTiger.Center.Phase.Dealing',
        SHOWDOWN: 'PARLOR.DragonTiger.Center.Phase.Showdown',
        SETTLE: 'PARLOR.DragonTiger.Center.Phase.Settle',
        RESOLVING: 'PARLOR.DragonTiger.Center.Phase.Resolving'
    };
    const phase = t(helpers, phaseKeys[state.phase] || 'PARLOR.Common.Waiting');

    let title = phase;
    let sub = '';
    if (state.phase === 'BETTING') {
        const betted = (state.bets || []).length;
        const total = (state.playerIds || []).length;
        title = t(helpers, 'PARLOR.Common.WaitingBet');
        sub = `${betted} / ${total}`;
    } else if (state.winner) {
        title = sideLabel(state, state.winner, helpers);
    }

    return {
        phase,
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
        title,
        sub
    };
}

function buildBetActions(state, selectedId, helpers) {
    const requestAction = (action, data) => callHelper(
        helpers, 'requestAction',
        () => Promise.resolve({ ok: false, reason: 'missing-action-handler' }),
        action, data
    );
    return ['dragon', 'tie', 'tiger'].map(side => ({
        icon: '',
        label: sideLabel(state, side, helpers),
        className: SIDE_BADGE_CLASS[side] === 'gold' ? 'gold' : (SIDE_BADGE_CLASS[side] === 'wax' ? 'fold' : ''),
        disabled: false,
        onClick: (_event, data = {}) => requestAction('placeBet', {
            participantId: selectedId,
            side,
            amount: Math.max(1, Math.floor(Number(data?.amount || 0)))
        })
    }));
}

function buildGmActions(state, helpers) {
    const requestAction = (action, data) => callHelper(
        helpers, 'requestAction',
        () => Promise.resolve({ ok: false, reason: 'missing-action-handler' }),
        action, data
    );
    const make = (action, labelKey, className = 'gold') => ({
        icon: '',
        label: t(helpers, labelKey),
        className,
        disabled: false,
        onClick: (_event, data = {}) => requestAction(action, { ...data, gm: true })
    });

    switch (state.phase) {
        case 'READY': return [make('deal', 'PARLOR.DragonTiger.Action.DealByDM')];
        case 'SETTLE': return [make('settle', 'PARLOR.Common.Settle')];
        case 'RESOLVING': return [
            make('newRound', 'PARLOR.Common.NextRound'),
            make('finishGame', 'PARLOR.Common.Finish', '')
        ];
        default: return [];
    }
}

export function buildDragonTigerHud(state = {}, helpers = {}) {
    const controlledIds = callHelper(helpers, 'getControlledParticipantIds', () => [], state);
    const isGM = callHelper(helpers, 'isGM', () => false);
    if (!controlledIds.length && !isGM) return null;

    const selectedId = callHelper(
        helpers, 'resolveSelectedParticipantId',
        (s, ids) => ids[0] || '',
        state, controlledIds
    );

    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const getDisplay = (id) => callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '' }), state, id) || {};
    const bet = selectedId ? getBetForUser(state, selectedId) : null;
    const balance = selectedId ? callHelper(helpers, 'getBalance', () => '', selectedId) : '';

    const isBettingPlayer = state.phase === 'BETTING' && !!selectedId && (state.playerIds || []).includes(selectedId);
    const actions = [
        ...(isBettingPlayer ? buildBetActions(state, selectedId, helpers) : []),
        ...(isGM ? buildGmActions(state, helpers) : [])
    ];

    const centerHtml = controlledIds.length > 1
        ? `
            <div class="parlor-th-hud-context">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
                <select class="parlor-th-hud-select" id="dt-hud-participant">
                    ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getName(id))}</option>`).join('')}
                </select>
            </div>
        `
        : '';

    const asideHtml = isBettingPlayer
        ? `
            <div class="parlor-th-hud-raise">
                <label for="dt-hud-bet-input">${t(helpers, 'PARLOR.Common.Bet')}</label>
                <input id="dt-hud-bet-input" type="number" min="1" step="1" value="${Math.max(1, Number(bet?.amount || 10))}">
            </div>
        `
        : '';

    return {
        ownerId: selectedId || 'gm',
        traySignature: [
            selectedId, state.phase, state.round, (state.bets || []).length,
            bet ? `${bet.side}:${bet.amount}` : '', controlledIds.join(','), isGM ? 'gm' : ''
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.DragonTiger.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
            buildDragonTigerStatus(state, helpers).phase
        ],
        identity: {
            crest: getDisplay(selectedId).avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: selectedId ? getName(selectedId) : t(helpers, 'PARLOR.Common.Dealer'),
            credits: balance === '' ? '' : `${balance}`,
            sub: bet
                ? `${sideLabel(state, bet.side, helpers)} · ${formatChips(helpers, bet.amount)}`
                : (isBettingPlayer ? t(helpers, 'PARLOR.Common.WaitingBet') : '')
        },
        cards: [],
        centerHtml,
        asideHtml,
        actions
    };
}
