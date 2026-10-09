/**
 * BaccaratPresenterData — 百家乐 Presenter 数据映射(纯函数,零 import)
 *
 * 百家乐是"闲庄两副公共手牌 + 玩家下注"模型:玩家不持私牌,座位=下注者,
 * 牌局(playerHand/bankerHand/totals/winner)呈现器直接从 getState() 读。
 * 本模块只负责"该显示什么":座位条目、状态匾、HUD(下注/推进)。
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

// 所压区徽章配色:庄=金、和=蜡红、闲=素
const SIDE_BADGE_CLASS = { banker: 'gold', tie: 'wax', player: '' };

function sideLabel(state, side, helpers) {
    const keys = {
        player: 'PARLOR.Baccarat.Side.Player',
        banker: 'PARLOR.Baccarat.Side.Banker',
        tie: 'PARLOR.Baccarat.Side.Tie'
    };
    return keys[side] ? t(helpers, keys[side]) : String(side || '');
}

function localizeReason(reason, helpers) {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    return reason.key ? t(helpers, reason.key, reason.data || {}) : '';
}

function getDrawTitleKey(summary = {}) {
    if (summary.natural) return 'PARLOR.Baccarat.DrawTitle.Natural';
    if (!summary.playerShouldDraw && summary.bankerPlan === 'stand') return 'PARLOR.Baccarat.DrawTitle.NoThirdCard';
    return 'PARLOR.Baccarat.DrawTitle.RuleBased';
}

function getDrawActionKey(summary = {}) {
    if (summary.natural) return 'PARLOR.Baccarat.DrawAction.GoToResult';
    if (!summary.playerShouldDraw && summary.bankerPlan === 'stand') return 'PARLOR.Baccarat.DrawAction.ConfirmNoDraw';
    return 'PARLOR.Baccarat.DrawAction.ExecuteDraw';
}

function buildDrawRulesHtml(state, helpers) {
    const summary = state.roundSummary || {};
    const items = [
        { label: sideLabel(state, 'player', helpers), text: localizeReason(summary.playerReason, helpers) },
        { label: sideLabel(state, 'banker', helpers), text: localizeReason(summary.bankerReason, helpers) }
    ].filter(item => item.text);
    if (!items.length) return '';

    return `
        <div class="parlor-bac-draw-rules">
            <div class="parlor-bac-draw-rules-title">${escapeHtml(t(helpers, getDrawTitleKey(summary)))}</div>
            ${items.map(item => `
                <div class="parlor-bac-draw-rule">
                    <span class="parlor-bac-draw-rule-side">${escapeHtml(item.label)}</span>
                    <span class="parlor-bac-draw-rule-text">${escapeHtml(item.text)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

export function buildBaccaratSeatEntries(state = {}, helpers = {}) {
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
            // 百家乐没有"轮到谁":下注期把还没下注的点亮当提示
            highlight: state.phase === 'BETTING' && !bet,
            isSelf: !!display.isSelf,
            className: ''
        };
    });
}

export function buildBaccaratStatus(state = {}, helpers = {}) {
    const phaseKeys = {
        IDLE: 'PARLOR.Common.Waiting',
        BETTING: 'PARLOR.Baccarat.Center.Phase.Betting',
        READY: 'PARLOR.Baccarat.Center.Phase.Ready',
        DEALING: 'PARLOR.Baccarat.Center.Phase.Dealing',
        SHOWDOWN: 'PARLOR.Baccarat.Center.Phase.Showdown',
        DRAW_RULES: 'PARLOR.Baccarat.Center.Phase.DrawRules',
        DRAWING: 'PARLOR.Baccarat.Center.Phase.Drawing',
        FINAL_SHOWDOWN: 'PARLOR.Baccarat.Center.Phase.FinalShowdown',
        SETTLE: 'PARLOR.Baccarat.Center.Phase.Settle',
        RESOLVING: 'PARLOR.Baccarat.Center.Phase.Resolving'
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
        sub = `${state.playerTotal ?? ''} : ${state.bankerTotal ?? ''}`;
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
    // 下注三键:金额由呈现器从数字输入采集进 data.amount
    return ['player', 'tie', 'banker'].map(side => ({
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
        case 'READY': return [make('deal', 'PARLOR.Baccarat.Action.DealByDM')];
        case 'DRAW_RULES': return [make('draw', getDrawActionKey(state.roundSummary || {}))];
        case 'SETTLE': return [make('settle', 'PARLOR.Common.Settle')];
        case 'RESOLVING': return [
            make('newRound', 'PARLOR.Common.NextRound'),
            make('finishGame', 'PARLOR.Common.Finish', '')
        ];
        default: return [];
    }
}

export function buildBaccaratHud(state = {}, helpers = {}) {
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

    const participantSelectorHtml = controlledIds.length > 1
        ? `
            <div class="parlor-th-hud-context">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
                <select class="parlor-th-hud-select" id="bac-hud-participant">
                    ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getName(id))}</option>`).join('')}
                </select>
            </div>
        `
        : '';
    const centerHtml = state.phase === 'DRAW_RULES'
        ? buildDrawRulesHtml(state, helpers)
        : participantSelectorHtml;

    const asideHtml = isBettingPlayer
        ? `
            <div class="parlor-th-hud-raise">
                <label for="bac-hud-bet-input">${t(helpers, 'PARLOR.Common.Bet')}</label>
                <input id="bac-hud-bet-input" type="number" min="1" step="1" value="${Math.max(1, Number(bet?.amount || 10))}">
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
            t(helpers, 'PARLOR.Games.Baccarat.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
            buildBaccaratStatus(state, helpers).phase
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
