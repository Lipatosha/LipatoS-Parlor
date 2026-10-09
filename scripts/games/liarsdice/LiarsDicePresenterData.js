const MAX_SIDE_SEATS = 5;
const MAX_PRESENTER_SEATS = MAX_SIDE_SEATS * 2;
const DIE_PIPS = Object.freeze({
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
});

function fallbackT(key, data = null) {
    if (!data) return String(key || '');
    return `${String(key || '')}:${JSON.stringify(data)}`;
}

function t(helpers, key, data = null) {
    const localize = typeof helpers?.t === 'function' ? helpers.t : fallbackT;
    return localize(key, data);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&#39;');
}

function defaultParticipantName(_state, participantId) {
    return String(participantId || '');
}

function defaultDisplayParticipant() {
    return { avatarHtml: '', isSelf: false, kind: 'user' };
}

function defaultSeatStatus() {
    return { text: '', className: '' };
}

function callHelper(helpers, name, fallback, ...args) {
    return typeof helpers?.[name] === 'function' ? helpers[name](...args) : fallback(...args);
}

function getParticipantName(state, participantId, helpers) {
    return callHelper(helpers, 'getParticipantName', defaultParticipantName, state, participantId);
}

function getDisplayParticipant(state, participantId, helpers) {
    return callHelper(helpers, 'getDisplayParticipant', defaultDisplayParticipant, state, participantId) || defaultDisplayParticipant();
}

function getSelfSeatParticipantId(state, helpers) {
    return callHelper(helpers, 'getSelfSeatParticipantId', () => '', state);
}

function getActivePlayerIds(state, helpers) {
    return callHelper(
        helpers,
        'getActivePlayerIds',
        (safeState) => (safeState?.playerIds || []).filter(id => Number(safeState?.diceCounts?.[id] || 0) > 0),
        state
    );
}

function getSelectableParticipantIds(state, helpers) {
    return callHelper(helpers, 'getSelectableParticipantIds', () => [], state);
}

function resolveSelectedParticipantId(state, selectableIds, helpers) {
    return callHelper(helpers, 'resolveSelectedParticipantId', (_safeState, ids) => ids[0] || '', state, selectableIds);
}

function getSeatStatus(state, participantId, helpers) {
    return callHelper(helpers, 'getSeatStatus', defaultSeatStatus, state, participantId) || defaultSeatStatus();
}

function getSeatNote(state, participantId, helpers) {
    return callHelper(helpers, 'getSeatNote', () => '', state, participantId);
}

function getVisibleDice(participantId, helpers) {
    return callHelper(helpers, 'getVisibleDice', () => [], participantId) || [];
}

function getSuggestedClaimQuantity(state, helpers) {
    return callHelper(
        helpers,
        'getSuggestedClaimQuantity',
        (safeState) => {
            if (!safeState?.lastClaim) return 1;
            if (Number(safeState.lastClaim.face || 0) < 6) return Math.max(1, Number(safeState.lastClaim.quantity || 1));
            return Math.max(1, Number(safeState.lastClaim.quantity || 1) + 1);
        },
        state
    );
}

function isClaimAvailable(state, claim, helpers) {
    return callHelper(
        helpers,
        'isClaimAvailable',
        (safeState, safeClaim) => {
            const quantity = Math.max(1, Math.floor(Number(safeClaim?.quantity || 0)));
            const face = Math.max(1, Math.min(6, Math.floor(Number(safeClaim?.face || 0))));
            if (!quantity || !face) return false;
            if (!safeState?.lastClaim) return true;
            if (quantity > Number(safeState.lastClaim.quantity || 0)) return true;
            if (quantity < Number(safeState.lastClaim.quantity || 0)) return false;
            return face > Number(safeState.lastClaim.face || 0);
        },
        state,
        claim
    );
}

function isActionPending(actionKey, helpers) {
    return callHelper(helpers, 'isActionPending', () => false, actionKey);
}

function formatClaim(quantity, face, helpers) {
    return callHelper(
        helpers,
        'formatClaim',
        (safeQuantity, safeFace) => t(helpers, 'PARLOR.LiarsDice.Text.ClaimFormat', {
            quantity: safeQuantity,
            face: safeFace
        }),
        quantity,
        face
    );
}

function requestAction(helpers, action, data) {
    const requester = typeof helpers?.requestAction === 'function'
        ? helpers.requestAction
        : () => Promise.resolve({ ok: false, reason: 'missing-action-handler' });
    return requester(action, data);
}

function getSeatLayout(state, helpers) {
    const myId = getSelfSeatParticipantId(state, helpers);
    const allSeatIds = (state?.playerIds || []).filter(Boolean).slice(0, MAX_PRESENTER_SEATS);
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

function buildDie(value, { small = false, compact = false } = {}) {
    const safeValue = Math.max(1, Math.min(6, Math.floor(Number(value || 0))));
    const pips = DIE_PIPS[safeValue] || [];
    const classes = [
        'parlor-ld-die',
        small ? 'is-small' : '',
        compact ? 'is-compact' : ''
    ].filter(Boolean).join(' ');

    return `
        <div class="${classes}" data-value="${safeValue}">
            ${Array.from({ length: 9 }, (_, index) => {
                const pipIndex = index + 1;
                const className = pips.includes(pipIndex) ? 'is-on' : '';
                return `<span class="parlor-ld-pip pip-${pipIndex} ${className}"></span>`;
            }).join('')}
        </div>
    `;
}

function buildDiceRow(dice, { small = false, compact = false } = {}) {
    return (Array.isArray(dice) ? dice : []).map(value => buildDie(value, { small, compact })).join('');
}

function buildSeatExtraHtml(state, participantId, note) {
    const revealedDice = Array.isArray(state?.revealedDice?.[participantId]) ? state.revealedDice[participantId] : [];
    return `
        ${note ? `<div class="parlor-ld-seat-note">${escapeHtml(note)}</div>` : ''}
        ${revealedDice.length ? `<div class="parlor-ld-seat-dice">${buildDiceRow(revealedDice, { small: true })}</div>` : ''}
    `;
}

export function buildLiarsDiceSeatEntries(state = {}, helpers = {}) {
    const { myId, visibleSeatIds, entries } = getSeatLayout(state, helpers);

    return entries.map(({ id, side }) => {
        const display = getDisplayParticipant(state, id, helpers);
        const diceCount = Number(state.diceCounts?.[id] || 0);
        const status = getSeatStatus(state, id, helpers);
        const note = getSeatNote(state, id, helpers);
        const isCurrent = state.currentPlayerId === id;
        const isOut = diceCount < 1;
        return {
            id,
            name: id === myId ? t(helpers, 'PARLOR.Common.You') : getParticipantName(state, id, helpers),
            avatarHtml: display.avatarHtml || '',
            chips: `${diceCount}`,
            badges: [],
            statusText: status.text || '',
            statusClass: status.className || '',
            highlight: isCurrent && state.phase === 'PLAYER_TURNS',
            isSelf: !!display.isSelf || id === myId,
            className: [
                isOut ? 'is-out' : '',
                isCurrent ? 'is-current' : ''
            ].filter(Boolean).join(' '),
            side,
            seatNumber: Math.max(1, visibleSeatIds.indexOf(id) + 1),
            extraHtml: buildSeatExtraHtml(state, id, note)
        };
    });
}

function buildResolutionHeadline(state, helpers) {
    const claimOwner = state.lastClaim?.userId
        ? getParticipantName(state, state.lastClaim.userId, helpers)
        : t(helpers, 'PARLOR.Common.Waiting');

    if (state.claimWasTrue === true) {
        return t(helpers, 'PARLOR.LiarsDice.Center.ClaimantWasTruthful', { name: claimOwner });
    }

    if (state.claimWasTrue === false) {
        return t(helpers, 'PARLOR.LiarsDice.Center.ClaimantWasLying', { name: claimOwner });
    }

    return t(helpers, 'PARLOR.LiarsDice.Center.ResolvingTitle');
}

export function buildLiarsDiceStatus(state = {}, helpers = {}) {
    const currentName = state.currentPlayerId
        ? getParticipantName(state, state.currentPlayerId, helpers)
        : t(helpers, 'PARLOR.Common.Waiting');

    let phase = t(helpers, 'PARLOR.Common.Waiting');
    let title = t(helpers, 'PARLOR.Common.Waiting');
    let sub = '';

    if (state.phase === 'ROLLING') {
        phase = t(helpers, 'PARLOR.LiarsDice.Center.Phase.Rolling');
        title = t(helpers, 'PARLOR.LiarsDice.Center.RollingTitle');
        sub = t(helpers, 'PARLOR.LiarsDice.Center.RollingSub');
    } else if (state.phase === 'PLAYER_TURNS') {
        phase = t(helpers, 'PARLOR.LiarsDice.Center.Phase.Turns');
        title = state.lastClaim
            ? t(helpers, 'PARLOR.LiarsDice.Center.TurnsTitleRespond', { name: currentName })
            : t(helpers, 'PARLOR.LiarsDice.Center.TurnsTitleFirst', { name: currentName });
        sub = state.lastClaim
            ? t(helpers, 'PARLOR.LiarsDice.Center.TurnsSubRespond')
            : t(helpers, 'PARLOR.LiarsDice.Center.TurnsSubFirst');
    } else if (state.phase === 'RESOLVING') {
        phase = t(helpers, 'PARLOR.LiarsDice.Center.Phase.Resolving');
        title = buildResolutionHeadline(state, helpers);
        sub = state.matchWinnerId
            ? t(helpers, 'PARLOR.LiarsDice.Center.MatchWinnerSub')
            : t(helpers, 'PARLOR.LiarsDice.Center.ResolvingSub');
    }

    return {
        phase,
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
        title,
        sub
    };
}

function buildSelectedDiceHtml(state, selectedId, visibleDice, selectableIds, helpers) {
    const selectedName = selectedId
        ? getParticipantName(state, selectedId, helpers)
        : t(helpers, 'PARLOR.Common.Spectating');
    const selectHtml = selectableIds.length > 1
        ? `
            <label class="parlor-ld-footer-select">
                <span>${t(helpers, 'PARLOR.LiarsDice.Footer.SelectRole')}</span>
                <select id="ld-footer-select">
                    ${selectableIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getParticipantName(state, id, helpers))}</option>`).join('')}
                </select>
            </label>
        `
        : '';

    return `
        <div class="parlor-ld-footer-shell ${!visibleDice.length ? 'is-empty' : ''}">
            <div class="parlor-ld-footer-head">
                <div class="parlor-ld-footer-title">${escapeHtml(selectedName)}</div>
                ${selectHtml}
            </div>
            <div class="parlor-ld-footer-dice ${state.phase === 'ROLLING' ? 'is-rolling' : ''}">
                ${visibleDice.length
                    ? buildDiceRow(visibleDice)
                    : `<div class="parlor-ld-dice-placeholder">${t(helpers, 'PARLOR.LiarsDice.Footer.NoDice')}</div>`}
            </div>
        </div>
    `;
}

function buildClaimSummaryHtml(state, helpers) {
    if (!state.lastClaim) {
        return `
            <div class="parlor-ld-claim-card is-empty">
                <span>${t(helpers, 'PARLOR.LiarsDice.Label.CurrentClaim')}</span>
                <strong>${t(helpers, 'PARLOR.LiarsDice.Center.NoClaimYet')}</strong>
            </div>
        `;
    }

    return `
        <div class="parlor-ld-claim-card">
            <span>${t(helpers, 'PARLOR.LiarsDice.Label.CurrentClaim')}</span>
            <strong>${escapeHtml(formatClaim(state.lastClaim.quantity, state.lastClaim.face, helpers))}</strong>
            <em>${t(helpers, 'PARLOR.LiarsDice.Center.ClaimedBy', {
                name: getParticipantName(state, state.lastClaim.userId, helpers)
            })}</em>
        </div>
    `;
}

// 叫某个面的合法数量下限:面更大→跟上家数量,面相同或更小→数量必须 +1
function minQuantityForFace(state, face) {
    const last = state.lastClaim;
    if (!last) return 1;
    const lastQty = Math.max(1, Number(last.quantity || 1));
    return face > Number(last.face || 0) ? lastQty : lastQty + 1;
}

function buildLiarsDiceActions(state, participantId, helpers) {
    if (!participantId || state.phase !== 'PLAYER_TURNS' || state.currentPlayerId !== participantId) return [];

    const openPending = isActionPending(`player:${participantId}:open`, helpers);
    const claimPending = isActionPending(`player:${participantId}:makeClaim`, helpers);
    const actions = [];

    if (state.lastClaim) {
        actions.push({
            kind: 'open',
            icon: 'fas fa-eye',
            label: t(helpers, 'PARLOR.LiarsDice.Action.Open'),
            className: 'fold',
            disabled: openPending,
            onClick: (_event, data = {}) => requestAction(helpers, 'open', { participantId, ...(data || {}), amount: undefined })
        });
    }

    // 点面按钮只声明合法下限，真正的数量始终取玩家输入。这里不能偷偷抬价，
    // 不然界面上喊的是 2 个，服务端收到的却会变成 3 个；非法组合由呈现器直接禁用。
    [1, 2, 3, 4, 5, 6].forEach(face => {
        const minQty = minQuantityForFace(state, face);
        actions.push({
            kind: 'claim',
            face,
            minQuantity: minQty,
            icon: 'fas fa-dice',
            label: formatClaim(minQty, face, helpers),
            disabled: claimPending,
            onClick: (_event, data = {}) => requestAction(helpers, 'claim', {
                participantId,
                quantity: Math.max(1, Math.floor(Number(data?.amount || 0)) || 1),
                face
            })
        });
    });

    return actions;
}

// GM 推进:开盅判定完(RESOLVING)后要能开下一轮/新比赛/散场,不然全桌卡死
function buildLiarsDiceGmActions(state, helpers) {
    if (state.phase !== 'RESOLVING') return [];
    const make = (action, labelKey, className = 'gold') => ({
        icon: '',
        label: t(helpers, labelKey),
        className,
        disabled: false,
        onClick: (_event, data = {}) => requestAction(helpers, action, { ...data, gm: true, amount: undefined })
    });
    return state.matchWinnerId
        ? [make('newMatch', 'PARLOR.LiarsDice.Action.NewMatch'), make('finishGame', 'PARLOR.Common.Finish', '')]
        : [make('newRound', 'PARLOR.Common.NextRound'), make('finishGame', 'PARLOR.Common.Finish', '')];
}

export function buildLiarsDiceHud(state = {}, helpers = {}) {
    const selectableIds = getSelectableParticipantIds(state, helpers);
    const selectedId = resolveSelectedParticipantId(state, selectableIds, helpers);
    if (!selectedId) return null;

    const display = getDisplayParticipant(state, selectedId, helpers);
    const visibleDice = getVisibleDice(selectedId, helpers);
    const status = getSeatStatus(state, selectedId, helpers);
    const diceCount = Number(state.diceCounts?.[selectedId] || 0);
    const claimDraft = state.phase === 'PLAYER_TURNS' && state.currentPlayerId === selectedId
        ? {
            quantity: Math.max(1, Number(getSuggestedClaimQuantity(state, helpers) || 1)),
            label: t(helpers, 'PARLOR.LiarsDice.Footer.ClaimCount'),
            hint: t(helpers, 'PARLOR.LiarsDice.Footer.ClaimCountHint')
        }
        : null;

    return {
        ownerId: selectedId,
        traySignature: [
            selectedId,
            state.phase,
            state.currentPlayerId || '',
            state.roundToken || '',
            state.lastClaim?.quantity || 0,
            state.lastClaim?.face || 0,
            visibleDice.join(','),
            diceCount,
            status.text || ''
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.LiarsDice.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 })
        ],
        identity: {
            crest: display.avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: getParticipantName(state, selectedId, helpers),
            credits: t(helpers, 'PARLOR.LiarsDice.Seat.NoteDiceLeft', { count: diceCount }),
            sub: status.text || ''
        },
        cards: [],
        claimDraft,
        centerHtml: buildSelectedDiceHtml(state, selectedId, visibleDice, selectableIds, helpers),
        asideHtml: buildQuantityAsideHtml(state, selectedId, helpers) + buildClaimSummaryHtml(state, helpers),
        actions: [
            ...buildLiarsDiceActions(state, selectedId, helpers),
            ...(callHelperIsGM(helpers) ? buildLiarsDiceGmActions(state, helpers) : [])
        ]
    };
}

function callHelperIsGM(helpers) {
    return typeof helpers?.isGM === 'function' ? !!helpers.isGM() : false;
}

// 轮到自己叫点时给数量输入(原版有,呈现器把它采集进 data.amount);建议值=最小合法量
function buildQuantityAsideHtml(state, selectedId, helpers) {
    if (state.phase !== 'PLAYER_TURNS' || state.currentPlayerId !== selectedId) return '';
    const suggested = Math.max(1, Number(getSuggestedClaimQuantity(state, helpers) || 1));
    return `
        <div class="parlor-th-hud-raise">
            <label for="ld-hud-qty-input">${t(helpers, 'PARLOR.LiarsDice.Footer.ClaimCount')}</label>
            <input id="ld-hud-qty-input" type="number" min="1" step="1" value="${suggested}">
        </div>
    `;
}
