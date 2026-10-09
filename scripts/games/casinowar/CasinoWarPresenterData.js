/**
 * CasinoWarPresenterData — 赌场战争 Presenter 数据映射(纯函数,零 import)
 *
 * 玩家一张 vs 庄家一张,平局可"开战"。playerStates[uid]={bet,warBet,card,warCard,status,result}。
 * 庄家牌/战争牌呈现器从 getState() 读;玩家自己的牌走 getHud().cards / getPrivate。
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

export function buildCasinoWarSeatEntries(state = {}, helpers = {}) {
    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const getDisplay = (id) => callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};

    return (state.playerIds || []).map(id => {
        const display = getDisplay(id);
        const seat = state.playerStates?.[id] || null;
        const badges = [];
        if (seat?.warBet) {
            badges.push({ label: t(helpers, 'PARLOR.CasinoWar.Center.Phase.War'), className: 'wax' });
        }
        let statusText = '';
        if (state.phase === 'BETTING') {
            statusText = seat
                ? t(helpers, 'PARLOR.Common.BetPlaced')
                : t(helpers, 'PARLOR.Common.WaitingBet');
        } else if (seat) {
            const payout = (state.payouts || {})[id];
            if (payout != null) {
                const delta = Number(payout) - Number(seat.bet || 0) - Number(seat.warBet || 0);
                statusText = delta >= 0 ? `+${formatChips(helpers, delta)}` : `${formatChips(helpers, delta)}`;
            } else if (seat.result) {
                statusText = String(seat.result);
            }
        }
        const isWar = (state.warParticipants || []).includes(id);
        return {
            id,
            name: getName(id),
            avatarHtml: display.avatarHtml || '',
            chips: seat?.bet ? formatChips(helpers, seat.bet) : '',
            badges,
            statusText,
            statusClass: '',
            // 下注期点亮未下注者;开战期点亮参战者
            highlight: (state.phase === 'BETTING' && !seat) || (state.phase !== 'BETTING' && isWar),
            isSelf: !!display.isSelf,
            className: ''
        };
    });
}

export function buildCasinoWarStatus(state = {}, helpers = {}) {
    const phaseKeys = {
        IDLE: 'PARLOR.Common.Waiting',
        BETTING: 'PARLOR.CasinoWar.Center.Phase.Betting',
        READY: 'PARLOR.CasinoWar.Center.Phase.Ready',
        DEALING: 'PARLOR.CasinoWar.Center.Phase.Dealing',
        SHOWDOWN: 'PARLOR.CasinoWar.Center.Phase.Showdown',
        WAR: 'PARLOR.CasinoWar.Center.Phase.War',
        SETTLE: 'PARLOR.CasinoWar.Center.Phase.Settle',
        RESOLVING: 'PARLOR.CasinoWar.Center.Phase.Resolving'
    };
    const phase = t(helpers, phaseKeys[state.phase] || 'PARLOR.Common.Waiting');

    let title = phase;
    let sub = '';
    if (state.phase === 'BETTING') {
        const betted = (state.bets || []).length;
        const total = (state.playerIds || []).length;
        title = t(helpers, 'PARLOR.Common.WaitingBet');
        sub = `${betted} / ${total}`;
    } else if ((state.warParticipants || []).length && ['SHOWDOWN', 'WAR'].includes(state.phase)) {
        sub = t(helpers, 'PARLOR.CasinoWar.Center.Phase.War');
    }

    return {
        phase,
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
        title,
        sub
    };
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
        case 'READY': return [make('deal', 'PARLOR.CasinoWar.Action.DealByDM')];
        case 'SHOWDOWN': return (state.warParticipants || []).length
            ? [make('resolveWar', 'PARLOR.CasinoWar.Action.ResolveWar')]
            : [make('openSettle', 'PARLOR.CasinoWar.Action.OpenSettle')];
        case 'WAR': return [make('openSettle', 'PARLOR.CasinoWar.Action.OpenSettle')];
        case 'SETTLE': return [make('settle', 'PARLOR.Common.Settle')];
        case 'RESOLVING': return [
            make('newRound', 'PARLOR.Common.NextRound'),
            make('finishGame', 'PARLOR.Common.Finish', '')
        ];
        default: return [];
    }
}

export function buildCasinoWarHud(state = {}, helpers = {}) {
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
    const seat = selectedId ? (state.playerStates?.[selectedId] || null) : null;
    const balance = selectedId ? callHelper(helpers, 'getBalance', () => '', selectedId) : '';

    const isBettingPlayer = state.phase === 'BETTING' && !!selectedId && (state.playerIds || []).includes(selectedId);
    const requestAction = (action, data) => callHelper(
        helpers, 'requestAction',
        () => Promise.resolve({ ok: false, reason: 'missing-action-handler' }),
        action, data
    );

    const actions = [];
    if (isBettingPlayer) {
        actions.push({
            icon: '',
            label: t(helpers, 'PARLOR.Common.Bet'),
            className: 'gold',
            disabled: !!seat,
            onClick: (_event, data = {}) => requestAction('placeBet', {
                participantId: selectedId,
                amount: Math.max(1, Math.floor(Number(data?.amount || 0)))
            })
        });
    }
    if (isGM) actions.push(...buildGmActions(state, helpers));

    // 自己的牌:主牌 + 战争牌,发出后正面朝上(战争是明牌游戏,无隐私诉求)
    const cards = [];
    if (seat?.card) cards.push({ card: seat.card, size: 'hud' });
    if (seat?.warCard) cards.push({ card: seat.warCard, size: 'hud' });

    const centerHtml = controlledIds.length > 1
        ? `
            <div class="parlor-th-hud-context">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
                <select class="parlor-th-hud-select" id="cw-hud-participant">
                    ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getName(id))}</option>`).join('')}
                </select>
            </div>
        `
        : '';

    const asideHtml = isBettingPlayer && !seat
        ? `
            <div class="parlor-th-hud-raise">
                <label for="cw-hud-bet-input">${t(helpers, 'PARLOR.Common.Bet')}</label>
                <input id="cw-hud-bet-input" type="number" min="1" step="1" value="10">
            </div>
        `
        : '';

    return {
        ownerId: selectedId || 'gm',
        traySignature: [
            selectedId, state.phase, state.round, (state.bets || []).length,
            seat ? `${seat.bet}:${seat.warBet}:${seat.status}` : '',
            (state.warParticipants || []).length, controlledIds.join(','), isGM ? 'gm' : ''
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.CasinoWar.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
            buildCasinoWarStatus(state, helpers).phase
        ],
        identity: {
            crest: getDisplay(selectedId).avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: selectedId ? getName(selectedId) : t(helpers, 'PARLOR.Common.Dealer'),
            credits: balance === '' ? '' : `${balance}`,
            sub: seat
                ? `${t(helpers, 'PARLOR.Common.Bet')} ${formatChips(helpers, seat.bet)}${seat.warBet ? ` + ${formatChips(helpers, seat.warBet)}` : ''}`
                : (isBettingPlayer ? t(helpers, 'PARLOR.Common.WaitingBet') : '')
        },
        cards,
        centerHtml,
        asideHtml,
        actions
    };
}
