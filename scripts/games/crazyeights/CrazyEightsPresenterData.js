/**
 * CrazyEightsPresenterData — 疯狂八 Presenter 数据映射（纯函数，零 import）
 *
 * 甩牌桌：公开 state 只带每人剩牌张数、弃牌顶牌、当前花色、方向、牌堆张数；
 * 自己的手牌经 helpers.getVisibleHand 拿，能不能出经 helpers.getLegalActions 算（本机私牌本地算，不进 state）。
 * hud.cards 每张带 playable / onClick，主题点牌直接出；选花色是四个 kind:'suit' 的动作。
 */

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const RED_SUITS = new Set(['hearts', 'diamonds']);
const MAX_SIDE_SEATS = 4;
const MAX_PRESENTER_SEATS = MAX_SIDE_SEATS * 2;

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

function getParticipantName(state, id, helpers) {
    return callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
}

function getDisplayParticipant(state, id, helpers) {
    return callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};
}

function getSelfSeatParticipantId(state, helpers) {
    return String(callHelper(helpers, 'getSelfSeatParticipantId', () => '', state) || '');
}

function getControlledIds(state, helpers) {
    const ids = callHelper(helpers, 'getControlledParticipantIds', () => [], state);
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

function resolveSelectedId(state, helpers) {
    return String(callHelper(helpers, 'resolveSelectedParticipantId', () => '', state) || '');
}

function getVisibleHand(helpers, id) {
    const hand = callHelper(helpers, 'getVisibleHand', () => null, id);
    return Array.isArray(hand) ? hand : null;
}

function getLegalActions(helpers, id, hand) {
    const legal = callHelper(helpers, 'getLegalActions', () => null, id, hand);
    return legal || { mustChooseSuit: false, playable: [], canDraw: false, canPass: false, cardsAvailable: false };
}

function isActionPending(helpers, key) {
    return !!callHelper(helpers, 'isActionPending', () => false, key);
}

function requestAction(helpers, action, data = {}) {
    const requester = typeof helpers?.requestAction === 'function'
        ? helpers.requestAction
        : () => Promise.resolve({ ok: false, reason: 'missing-request-action' });
    return requester(action, data);
}

function suitLabel(helpers, suit) {
    return `${SUIT_SYMBOLS[suit] || ''} ${t(helpers, `PARLOR.CrazyEights.Suit.${suit}`)}`.trim();
}

function cardLabel(card) {
    if (!card) return '';
    return `${SUIT_SYMBOLS[card.suit] || ''}${card.rank || ''}`;
}

function sameCard(a, b) {
    return !!a && !!b && a.rank === b.rank && a.suit === b.suit;
}

function handPoints(cards, rules = {}) {
    const wild = rules.wildRank || '8';
    return (Array.isArray(cards) ? cards : []).reduce((sum, card) => {
        if (!card) return sum;
        if (card.rank === wild) return sum + 50;
        if (['J', 'Q', 'K'].includes(card.rank)) return sum + 10;
        if (card.rank === 'A') return sum + 1;
        const pip = parseInt(card.rank, 10);
        return sum + (Number.isFinite(pip) ? pip : 0);
    }, 0);
}

function roundIds(state) {
    const ids = Array.isArray(state.turnOrder) && state.turnOrder.length
        ? state.turnOrder
        : (Array.isArray(state.roundPlayerIds) ? state.roundPlayerIds : []);
    const sitting = Array.isArray(state.sittingOutPlayerIds) ? state.sittingOutPlayerIds : [];
    const all = [...ids, ...sitting.filter(id => !ids.includes(id))];
    if (all.length) return all;
    return Array.isArray(state.playerIds) ? state.playerIds : [];
}

function getSeatLayout(state, helpers) {
    const myId = getSelfSeatParticipantId(state, helpers);
    const allSeatIds = roundIds(state).filter(Boolean).slice(0, MAX_PRESENTER_SEATS);
    const hasMe = allSeatIds.includes(myId);
    const otherSeatIds = allSeatIds
        .filter(id => id !== myId)
        .slice(0, hasMe ? MAX_PRESENTER_SEATS - 1 : MAX_PRESENTER_SEATS);

    const leftCount = Math.min(MAX_SIDE_SEATS, Math.ceil(otherSeatIds.length / 2));
    const leftSeatIds = otherSeatIds.slice(0, leftCount);
    const rightSeatIds = hasMe
        ? [myId, ...otherSeatIds.slice(leftCount, leftCount + (MAX_SIDE_SEATS - 1))]
        : otherSeatIds.slice(leftCount, leftCount + MAX_SIDE_SEATS);

    return {
        myId,
        visibleSeatIds: [...leftSeatIds, ...rightSeatIds],
        entries: [
            ...leftSeatIds.map(id => ({ id, side: 'left' })),
            ...rightSeatIds.map(id => ({ id, side: 'right' }))
        ]
    };
}

function lastActionOf(state, type) {
    const list = Array.isArray(state.lastActions) ? state.lastActions : [];
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.type === type) return list[i];
    }
    return null;
}

function seatStatus(state, id, helpers) {
    const count = Number(state.handCounts?.[id] ?? -1);
    const winnerIds = Array.isArray(state.winnerIds) ? state.winnerIds : [];
    if ((state.sittingOutPlayerIds || []).includes(id)) {
        return { text: t(helpers, 'PARLOR.CrazyEights.Seat.StatusSittingOut'), className: 'is-sitting-out' };
    }
    if (state.phase === 'RESOLVING') {
        if (winnerIds.includes(id)) return { text: t(helpers, 'PARLOR.CrazyEights.Seat.StatusWinner'), className: 'is-winner' };
        return { text: '', className: '' };
    }
    if (state.phase === 'PLAYER_TURNS' && state.currentPlayerId === id) {
        return { text: t(helpers, 'PARLOR.CrazyEights.Seat.StatusCurrent'), className: 'is-current' };
    }
    const skip = lastActionOf(state, 'skip');
    if (skip?.targetId === id) {
        return { text: t(helpers, 'PARLOR.CrazyEights.Seat.StatusSkipped'), className: 'is-skipped' };
    }
    return { text: count >= 0 ? t(helpers, 'PARLOR.CrazyEights.Seat.StatusWaiting') : '', className: '' };
}

export function buildCrazyEightsSeatEntries(state = {}, helpers = {}) {
    const { myId, visibleSeatIds, entries } = getSeatLayout(state, helpers);
    const winnerIds = Array.isArray(state.winnerIds) ? state.winnerIds : [];
    const pendingDraw = Number(state.turn?.pendingDraw || 0);

    return entries.map(({ id, side }) => {
        const display = getDisplayParticipant(state, id, helpers);
        const count = Number(state.handCounts?.[id] ?? 0);
        const status = seatStatus(state, id, helpers);
        const isCurrent = state.phase === 'PLAYER_TURNS' && state.currentPlayerId === id;
        const isWinner = winnerIds.includes(id);
        const isLast = count === 1 && state.phase !== 'RESOLVING';
        const sittingOut = (state.sittingOutPlayerIds || []).includes(id);

        const badges = [];
        if (isLast) badges.push({ label: t(helpers, 'PARLOR.CrazyEights.Seat.LastCard'), className: 'wax' });
        else if (isWinner) badges.push({ label: t(helpers, 'PARLOR.CrazyEights.Seat.StatusWinner'), className: 'gold' });
        else if (isCurrent && pendingDraw > 0) badges.push({ label: `+${pendingDraw}`, className: 'wax' });
        else if (!sittingOut) badges.push({ label: `${count}`, className: 'gold' });

        const revealed = Array.isArray(state.revealedHands?.[id]) ? state.revealedHands[id] : null;
        const extraHtml = state.phase === 'RESOLVING' && revealed
            ? `<div class="parlor-c8-seat-points">${escapeHtml(t(helpers, 'PARLOR.CrazyEights.Seat.NotePoints', { points: handPoints(revealed, state.rules) }))}</div>`
            : '';

        return {
            id,
            name: id === myId ? t(helpers, 'PARLOR.Common.You') : getParticipantName(state, id, helpers),
            avatarHtml: display.avatarHtml || '',
            // 名录只画这个槽，给成带单位的字符串，光秃秃一个数字会被当成钱
            chips: sittingOut ? '' : t(helpers, 'PARLOR.CrazyEights.Seat.CardsLeft', { count }),
            badges,
            statusText: status.text || '',
            statusClass: status.className || '',
            highlight: isCurrent,
            isSelf: !!display.isSelf || id === myId,
            className: [
                isCurrent ? 'is-current' : '',
                isLast ? 'is-last-card' : '',
                isWinner ? 'is-winner' : '',
                sittingOut ? 'is-sitting-out is-out' : ''
            ].filter(Boolean).join(' '),
            side,
            seatNumber: Math.max(1, visibleSeatIds.indexOf(id) + 1),
            extraHtml
        };
    });
}

function directionLabel(state, helpers) {
    return Number(state.direction) < 0
        ? t(helpers, 'PARLOR.CrazyEights.Center.Direction.CounterClockwise')
        : t(helpers, 'PARLOR.CrazyEights.Center.Direction.Clockwise');
}

function buildStatusTitle(state, helpers) {
    const currentName = state.currentPlayerId ? getParticipantName(state, state.currentPlayerId, helpers) : '';
    const winnerIds = Array.isArray(state.winnerIds) ? state.winnerIds : [];
    const kind = state.roundResult?.kind || '';

    switch (state.phase) {
        case 'DEALING':
            return t(helpers, 'PARLOR.CrazyEights.Center.DealingTitle');
        case 'PLAYER_TURNS':
            if (state.turn?.mustChooseSuit) return t(helpers, 'PARLOR.CrazyEights.Center.ChooseSuitTitle', { name: currentName });
            if (Number(state.turn?.pendingDraw || 0) > 0) {
                return t(helpers, 'PARLOR.CrazyEights.Center.PendingDrawTitle', { name: currentName, count: Number(state.turn.pendingDraw) });
            }
            return t(helpers, 'PARLOR.CrazyEights.Center.TurnTitle', { name: currentName });
        case 'RESOLVING':
            if (kind === 'aborted') return t(helpers, 'PARLOR.CrazyEights.Center.AbortedTitle');
            if (kind === 'split') return t(helpers, 'PARLOR.CrazyEights.Center.SplitTitle');
            if (kind === 'dead') return t(helpers, 'PARLOR.CrazyEights.Center.DeadTitle', { name: getParticipantName(state, winnerIds[0], helpers) });
            return t(helpers, 'PARLOR.CrazyEights.Center.WinnerTitle', { name: getParticipantName(state, winnerIds[0], helpers) });
        default:
            return t(helpers, 'PARLOR.Common.Waiting');
    }
}

function buildStatusSub(state, helpers) {
    if (state.phase === 'RESOLVING') {
        const kind = state.roundResult?.kind || '';
        if (kind === 'aborted') return t(helpers, 'PARLOR.CrazyEights.Center.AbortedSub');
        const amount = formatChips(helpers, state.roundResult?.payoutPerWinner || 0);
        if (kind === 'split') return t(helpers, 'PARLOR.CrazyEights.Center.SplitSub', { amount });
        if (kind === 'dead') return t(helpers, 'PARLOR.CrazyEights.Center.DeadSub', { amount });
        return t(helpers, 'PARLOR.CrazyEights.Center.WinSub', { amount });
    }
    if (state.phase === 'DEALING') return t(helpers, 'PARLOR.CrazyEights.Center.DealingSub');

    const parts = [];
    if (state.currentSuit) {
        parts.push(t(helpers, 'PARLOR.CrazyEights.Center.CurrentSuit', { suit: suitLabel(helpers, state.currentSuit) }));
    }
    parts.push(directionLabel(state, helpers));
    parts.push(t(helpers, 'PARLOR.CrazyEights.Center.Stock', { count: Number(state.stockCount || 0) }));
    return parts.join(' · ');
}

export function buildCrazyEightsStatus(state = {}, helpers = {}) {
    const phaseKey = {
        DEALING: 'PARLOR.CrazyEights.Center.Phase.Dealing',
        PLAYER_TURNS: 'PARLOR.CrazyEights.Center.Phase.Turns',
        RESOLVING: 'PARLOR.CrazyEights.Center.Phase.Resolving'
    }[state.phase] || 'PARLOR.CrazyEights.Center.Phase.Idle';

    return {
        phase: t(helpers, phaseKey),
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: Number(state.round || 0) }),
        title: buildStatusTitle(state, helpers),
        sub: buildStatusSub(state, helpers)
    };
}

function buildIdentity(state, helpers, selectedId, hand) {
    const display = selectedId ? getDisplayParticipant(state, selectedId, helpers) : {};
    const name = selectedId ? getParticipantName(state, selectedId, helpers) : t(helpers, 'PARLOR.Common.Spectating');
    const balance = selectedId ? callHelper(helpers, 'getBalance', () => '', selectedId) : '';
    const sub = hand
        ? t(helpers, 'PARLOR.CrazyEights.Hud.HandSummary', { count: hand.length, points: handPoints(hand, state.rules) })
        : '';
    return {
        crest: display.avatarHtml || '',
        tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
        name,
        credits: balance === '' || balance == null ? '' : `${balance}`,
        sub
    };
}

function buildParticipantSelect(state, helpers, controlledIds, selectedId) {
    if (controlledIds.length <= 1) return '';
    const options = controlledIds.map(id => `
        <option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getParticipantName(state, id, helpers))}</option>
    `).join('');
    return `
        <div class="parlor-th-hud-context parlor-c8-hud-context">
            <span class="parlor-hud-footer-label">${escapeHtml(t(helpers, 'PARLOR.Common.CurrentParticipant'))}</span>
            <select id="c8-hud-participant">${options}</select>
        </div>
    `;
}

export function buildCrazyEightsHud(state = {}, helpers = {}) {
    const controlledIds = getControlledIds(state, helpers);
    const isGM = !!callHelper(helpers, 'isGM', () => false);
    if (!controlledIds.length && !isGM) return null;

    const selectedId = resolveSelectedId(state, helpers) || controlledIds[0] || '';
    const hand = selectedId ? getVisibleHand(helpers, selectedId) : null;
    const legal = selectedId ? getLegalActions(helpers, selectedId, hand || []) : getLegalActions(helpers, '', []);
    const isTurn = state.phase === 'PLAYER_TURNS' && !!selectedId && state.currentPlayerId === selectedId;
    const mustChooseSuit = isTurn && !!state.turn?.mustChooseSuit;
    const pendingDraw = Number(state.turn?.pendingDraw || 0);
    const pendingPlay = isActionPending(helpers, `player:${selectedId}:playCard`);
    const pendingSuit = isActionPending(helpers, `player:${selectedId}:chooseSuit`);
    const pendingDrawAction = isActionPending(helpers, `player:${selectedId}:draw`);
    const pendingPass = isActionPending(helpers, `player:${selectedId}:pass`);

    const cards = (hand || []).map(card => {
        const playable = isTurn && !mustChooseSuit && !pendingPlay && legal.playable.some(entry => sameCard(entry, card));
        return {
            card,
            size: 'hud',
            startFaceDown: false,
            idleFaceDown: false,
            hoverReveal: false,
            handHover: false,
            playable: isTurn ? playable : null,
            onClick: () => requestAction(helpers, 'playCard', { participantId: selectedId, suit: card.suit, rank: card.rank })
        };
    });

    const actions = [];
    if (mustChooseSuit) {
        for (const suit of SUITS) {
            actions.push({
                kind: 'suit',
                suit,
                icon: '',
                label: suitLabel(helpers, suit),
                className: `suit-${suit} ${RED_SUITS.has(suit) ? 'is-red' : 'is-black'}`,
                disabled: pendingSuit,
                onClick: () => requestAction(helpers, 'chooseSuit', { participantId: selectedId, suit })
            });
        }
    } else if (isTurn) {
        actions.push({
            kind: 'draw',
            icon: 'fas fa-hand-holding',
            label: pendingDraw > 0
                ? t(helpers, 'PARLOR.CrazyEights.Action.TakePenalty', { count: pendingDraw })
                : t(helpers, 'PARLOR.CrazyEights.Action.Draw'),
            className: 'gold',
            disabled: pendingDrawAction || !legal.canDraw,
            onClick: () => requestAction(helpers, 'draw', { participantId: selectedId })
        });
        if (legal.canPass) {
            actions.push({
                kind: 'pass',
                icon: 'fas fa-forward',
                label: t(helpers, 'PARLOR.CrazyEights.Action.Pass'),
                className: '',
                disabled: pendingPass,
                onClick: () => requestAction(helpers, 'pass', { participantId: selectedId })
            });
        }
    }

    // 结算操作由本体弹窗统一提供，主题 HUD 不再重复显示。

    const status = buildCrazyEightsStatus(state, helpers);
    const handKeys = (hand || []).map(card => `${card.rank}-${card.suit}`).join(',');

    return {
        ownerId: selectedId || 'gm',
        traySignature: [
            selectedId, state.phase, state.round, state.roundToken, state.currentPlayerId, state.turnStep,
            state.currentSuit, pendingDraw, mustChooseSuit, !!state.turn?.drawnThisTurn, handKeys,
            controlledIds.join('|'), isGM
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.CrazyEights.Name'),
            status.round,
            status.phase
        ],
        identity: buildIdentity(state, helpers, selectedId, hand),
        cards,
        // 主题画垫面用得上的公共桌况；getState 仍是真源，这里只是顺手
        table: {
            discardTop: state.discardTop || null,
            currentSuit: state.currentSuit || '',
            direction: Number(state.direction) < 0 ? -1 : 1,
            stockCount: Number(state.stockCount || 0),
            discardCount: Number(state.discardCount || 0),
            pendingDraw,
            pot: Number(state.pot || 0)
        },
        centerHtml: buildParticipantSelect(state, helpers, controlledIds, selectedId),
        asideHtml: '',
        actions
    };
}
