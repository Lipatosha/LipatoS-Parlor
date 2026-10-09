/**
 * ThreeCardPokerPresenterData — 三张扑克 Presenter 数据映射(纯函数,零 import)
 *
 * 玩家 3 张私牌 vs 庄家 3 张。playerStates[uid]={anteAmount,pairPlusAmount,playAmount,
 * decision,hand,handRank,roundResult}。庄家牌呈现器从 getState() 读;玩家手牌走 HUD/getPrivate。
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

export function buildThreeCardPokerSeatEntries(state = {}, helpers = {}) {
    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const getDisplay = (id) => callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};

    return (state.playerIds || []).map(id => {
        const display = getDisplay(id);
        const seat = state.playerStates?.[id] || null;
        const badges = [];
        if (seat?.pairPlusAmount) {
            badges.push({ label: `${t(helpers, 'PARLOR.ThreeCardPoker.Hud.PairPlusLabel')} ${formatChips(helpers, seat.pairPlusAmount)}`, className: 'wax' });
        }
        let statusText = '';
        let className = '';
        if (state.phase === 'BETTING') {
            statusText = seat
                ? t(helpers, 'PARLOR.Common.BetPlaced')
                : t(helpers, 'PARLOR.Common.WaitingBet');
        } else if (seat?.decision === 'fold') {
            statusText = t(helpers, 'PARLOR.ThreeCardPoker.Action.Fold');
            className = 'is-folded';
        } else if (state.phase === 'DECISION') {
            statusText = seat?.decision === 'pending'
                ? t(helpers, 'PARLOR.Common.Waiting')
                : t(helpers, 'PARLOR.ThreeCardPoker.Action.Play');
        } else if (seat) {
            const payout = (state.payouts || {})[id];
            if (payout != null) {
                const staked = Number(seat.anteAmount || 0) + Number(seat.pairPlusAmount || 0) + Number(seat.playAmount || 0);
                const delta = Number(payout) - staked;
                statusText = delta >= 0 ? `+${formatChips(helpers, delta)}` : `${formatChips(helpers, delta)}`;
            }
        }
        return {
            id,
            name: getName(id),
            avatarHtml: display.avatarHtml || '',
            chips: seat?.anteAmount ? formatChips(helpers, seat.anteAmount) : '',
            badges,
            statusText,
            statusClass: '',
            highlight: (state.phase === 'BETTING' && !seat)
                || (state.phase === 'DECISION' && seat?.decision === 'pending'),
            isSelf: !!display.isSelf,
            className
        };
    });
}

export function buildThreeCardPokerStatus(state = {}, helpers = {}) {
    const phaseKeys = {
        IDLE: 'PARLOR.Common.Waiting',
        BETTING: 'PARLOR.ThreeCardPoker.Center.Phase.Betting',
        READY: 'PARLOR.ThreeCardPoker.Center.Phase.Ready',
        DEALING: 'PARLOR.ThreeCardPoker.Center.Phase.Dealing',
        DECISION: 'PARLOR.ThreeCardPoker.Center.Phase.Decision',
        REVEAL_READY: 'PARLOR.ThreeCardPoker.Center.Phase.RevealReady',
        SHOWDOWN: 'PARLOR.ThreeCardPoker.Center.Phase.Showdown',
        SETTLE: 'PARLOR.ThreeCardPoker.Center.Phase.Settle',
        RESOLVING: 'PARLOR.ThreeCardPoker.Center.Phase.Resolving'
    };
    const phase = t(helpers, phaseKeys[state.phase] || 'PARLOR.Common.Waiting');

    let title = phase;
    let sub = '';
    if (state.phase === 'BETTING') {
        const betted = (state.bets || []).length;
        const total = (state.playerIds || []).length;
        title = t(helpers, 'PARLOR.Common.WaitingBet');
        sub = `${betted} / ${total}`;
    } else if (state.phase === 'DECISION') {
        const pending = Object.values(state.playerStates || {}).filter(s => s?.decision === 'pending').length;
        sub = pending ? `${pending}` : '';
    } else if (['SHOWDOWN', 'SETTLE', 'RESOLVING'].includes(state.phase) && state.dealerRank) {
        const hand = getHandLabel(state.dealerRank, helpers);
        const titleKey = state.dealerQualified === false
            ? 'PARLOR.ThreeCardPoker.Center.ShowdownTitleNotQualified'
            : 'PARLOR.ThreeCardPoker.Center.ShowdownTitleQualified';
        title = t(helpers, titleKey, { hand });
        if (state.dealerQualified === false) sub = t(helpers, 'PARLOR.ThreeCardPoker.Badge.DealerNotQualified');
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
        case 'READY': return [make('deal', 'PARLOR.ThreeCardPoker.Action.DealByDM')];
        case 'REVEAL_READY': return [make('reveal', 'PARLOR.ThreeCardPoker.Action.RevealByDM')];
        case 'SETTLE': return [make('settle', 'PARLOR.Common.Settle')];
        case 'RESOLVING': return [
            make('newRound', 'PARLOR.Common.NextRound'),
            make('finishGame', 'PARLOR.Common.Finish', '')
        ];
        default: return [];
    }
}

export function buildThreeCardPokerHud(state = {}, helpers = {}) {
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
    const requestAction = (action, data) => callHelper(
        helpers, 'requestAction',
        () => Promise.resolve({ ok: false, reason: 'missing-action-handler' }),
        action, data
    );

    const isBettingPlayer = state.phase === 'BETTING' && !!selectedId && (state.playerIds || []).includes(selectedId);
    const isDeciding = state.phase === 'DECISION' && seat?.decision === 'pending';

    const actions = [];
    if (isBettingPlayer && !seat) {
        actions.push({
            icon: '',
            label: t(helpers, 'PARLOR.ThreeCardPoker.Hud.AnteLabel'),
            className: 'gold',
            disabled: false,
            // 底注取呈现器数字输入;对子加注(pairPlus)在 onClick 时从 aside 的第二个输入读
            onClick: (event, data = {}) => {
                const doc = event?.target?.ownerDocument;
                const pairPlus = Number(doc?.getElementById?.('tcp-hud-pairplus-input')?.value || 0);
                return requestAction('placeBet', {
                    participantId: selectedId,
                    anteAmount: Math.max(1, Math.floor(Number(data?.amount || 0))),
                    pairPlusAmount: Math.max(0, Math.floor(pairPlus))
                });
            }
        });
    }
    if (isDeciding) {
        actions.push({
            icon: '',
            label: t(helpers, 'PARLOR.ThreeCardPoker.Action.Play'),
            className: 'gold',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('makeDecision', {
                participantId: selectedId, decision: 'play', ...data, amount: undefined
            })
        });
        actions.push({
            icon: '',
            label: t(helpers, 'PARLOR.ThreeCardPoker.Action.Fold'),
            className: 'fold',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('makeDecision', {
                participantId: selectedId, decision: 'fold', ...data, amount: undefined
            })
        });
    }
    if (isGM) actions.push(...buildGmActions(state, helpers));

    // 自己的三张:默认扣着、悬停揭示(隐私同德州手牌)
    const cards = (seat?.hand || []).map(card => ({
        card,
        size: 'hud',
        startFaceDown: true,
        idleFaceDown: true,
        hoverReveal: true,
        handHover: true
    }));
    const strength = buildPlayerStrength(seat, helpers);

    const centerHtml = controlledIds.length > 1
        ? `
            <div class="parlor-th-hud-context">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
                <select class="parlor-th-hud-select" id="tcp-hud-participant">
                    ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getName(id))}</option>`).join('')}
                </select>
            </div>
        `
        : '';

    const asideHtml = isBettingPlayer && !seat
        ? `
            <div class="parlor-th-hud-raise">
                <label for="tcp-hud-ante-input">${t(helpers, 'PARLOR.ThreeCardPoker.Hud.AnteLabel')}</label>
                <input id="tcp-hud-ante-input" type="number" min="1" step="1" value="10">
                <label for="tcp-hud-pairplus-input">${t(helpers, 'PARLOR.ThreeCardPoker.Hud.PairPlusLabel')}</label>
                <input id="tcp-hud-pairplus-input" type="number" min="0" step="1" value="0">
            </div>
        `
        : '';

    return {
        ownerId: selectedId || 'gm',
        traySignature: [
            selectedId, state.phase, state.round, (state.bets || []).length,
            seat ? `${seat.anteAmount}:${seat.pairPlusAmount}:${seat.decision}` : '',
            controlledIds.join(','), isGM ? 'gm' : ''
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.ThreeCardPoker.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
            buildThreeCardPokerStatus(state, helpers).phase
        ],
        identity: {
            crest: getDisplay(selectedId).avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: selectedId ? getName(selectedId) : t(helpers, 'PARLOR.Common.Dealer'),
            credits: balance === '' ? '' : `${balance}`,
            sub: seat
                ? [
                    `${t(helpers, 'PARLOR.ThreeCardPoker.Hud.AnteLabel')} ${formatChips(helpers, seat.anteAmount)}`,
                    seat.pairPlusAmount ? `${t(helpers, 'PARLOR.ThreeCardPoker.Hud.PairPlusLabel')} ${formatChips(helpers, seat.pairPlusAmount)}` : '',
                    seat.handRank ? getHandLabel(seat.handRank, helpers) : ''
                ].filter(Boolean).join(' · ')
                : (isBettingPlayer ? t(helpers, 'PARLOR.Common.WaitingBet') : '')
        },
        cards,
        strength,
        centerHtml,
        asideHtml,
        actions
    };
}

// 三张牌型 → 牌力块。handRank 由 Game 发牌时用 evaluateThreeCardPokerHand 算好存进 playerStates
const TCP_HAND_LABEL_KEYS = {
    'high-card': 'PARLOR.ThreeCardPoker.Hand.HighCard',
    pair: 'PARLOR.ThreeCardPoker.Hand.Pair',
    flush: 'PARLOR.ThreeCardPoker.Hand.Flush',
    straight: 'PARLOR.ThreeCardPoker.Hand.Straight',
    'three-kind': 'PARLOR.ThreeCardPoker.Hand.ThreeKind',
    'straight-flush': 'PARLOR.ThreeCardPoker.Hand.StraightFlush'
};
const TCP_HAND_TIER = {
    'high-card': 1,
    pair: 2,
    flush: 3,
    straight: 4,
    'three-kind': 6,
    'straight-flush': 7
};

function getHandLabel(handRank, helpers) {
    if (!handRank?.category) return t(helpers, 'PARLOR.ThreeCardPoker.Hand.Unknown');
    const labelKey = handRank.isMiniRoyal
        ? 'PARLOR.ThreeCardPoker.Hand.MiniRoyal'
        : TCP_HAND_LABEL_KEYS[handRank.category];
    // 牌型是结构化对象，不带可展示 label；直接 String() 会把 [object Object] 送进 HUD。
    return t(helpers, labelKey || 'PARLOR.ThreeCardPoker.Hand.Unknown');
}

function buildPlayerStrength(seat, helpers) {
    const rank = seat?.handRank;
    if (!rank?.category || !(seat?.hand || []).length) return null;
    const isMiniRoyal = !!rank.isMiniRoyal;
    return {
        title: t(helpers, 'PARLOR.ThreeCardPoker.Hud.Strength') || null,
        label: getHandLabel(rank, helpers),
        tier: isMiniRoyal ? 7 : (TCP_HAND_TIER[rank.category] ?? 1),
        note: ''
    };
}
