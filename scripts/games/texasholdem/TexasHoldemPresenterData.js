const MAX_PRESENTER_SEATS = 6;

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

function defaultParticipantName(_state, participantId) {
    return String(participantId || '');
}

function defaultDisplayParticipant() {
    return { avatarHtml: '', isSelf: false };
}

function defaultSeatStatus() {
    return { text: '', className: '' };
}

function getSeatIds(state) {
    return (state?.seatIds || state?.playerIds || []).slice(0, MAX_PRESENTER_SEATS);
}

export function buildTexasHoldemSeatBadges(state = {}, participantId, helpers = {}) {
    const seat = state.playerStates?.[participantId] || null;
    const badges = [];
    if (state.dealerButtonId === participantId) {
        badges.push({ label: t(helpers, 'PARLOR.TexasHoldem.Tag.Dealer'), className: 'gold' });
    }
    if (state.smallBlindId === participantId) {
        badges.push({ label: t(helpers, 'PARLOR.TexasHoldem.Tag.SmallBlind'), className: 'wax' });
    }
    if (state.bigBlindId === participantId) {
        badges.push({ label: t(helpers, 'PARLOR.TexasHoldem.Tag.BigBlind'), className: 'wax' });
    }
    if (seat?.committed) {
        badges.push({
            label: t(helpers, 'PARLOR.TexasHoldem.Table.InPot', {
                amount: formatChips(helpers, seat.committed)
            })
        });
    }
    return badges;
}

export function buildTexasHoldemSeatEntries(state = {}, helpers = {}) {
    const getDisplayParticipant = typeof helpers.getDisplayParticipant === 'function'
        ? helpers.getDisplayParticipant
        : defaultDisplayParticipant;
    const getParticipantName = typeof helpers.getParticipantName === 'function'
        ? helpers.getParticipantName
        : defaultParticipantName;
    const getSeatStatus = typeof helpers.getSeatStatus === 'function'
        ? helpers.getSeatStatus
        : defaultSeatStatus;

    return getSeatIds(state).map(id => {
        const display = getDisplayParticipant(state, id) || {};
        const seat = state.playerStates?.[id] || null;
        const status = getSeatStatus(state, id) || defaultSeatStatus();
        return {
            id,
            name: getParticipantName(state, id),
            avatarHtml: display.avatarHtml || '',
            chips: t(helpers, 'PARLOR.TexasHoldem.Table.Stack', {
                amount: formatChips(helpers, state.tableStacks?.[id] || 0)
            }),
            badges: buildTexasHoldemSeatBadges(state, id, helpers),
            statusText: status.text || '',
            statusClass: status.className || '',
            highlight: state.currentPlayerId === id,
            isSelf: !!display.isSelf,
            className: [
                seat?.status === 'folded' ? 'is-folded' : '',
                seat?.status === 'all-in' ? 'is-all-in' : '',
                seat?.result === 'win' ? 'is-winner' : ''
            ].filter(Boolean).join(' ')
        };
    });
}

export function buildTexasHoldemStatus(state = {}, helpers = {}) {
    const getParticipantName = typeof helpers.getParticipantName === 'function'
        ? helpers.getParticipantName
        : defaultParticipantName;
    const getStreetLabel = typeof helpers.getStreetLabel === 'function'
        ? helpers.getStreetLabel
        : (street) => localizeStreet(street, helpers);
    const getPhaseTitle = typeof helpers.getPhaseTitle === 'function'
        ? helpers.getPhaseTitle
        : () => t(helpers, 'PARLOR.Common.Waiting');

    const currentName = state.currentPlayerId
        ? getParticipantName(state, state.currentPlayerId)
        : '';
    const title = currentName
        ? t(helpers, 'PARLOR.TexasHoldem.Table.CurrentTurn', { name: currentName })
        : getPhaseTitle(state);
    return {
        phase: getStreetLabel(state.street),
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.handNumber || state.round || 0 }),
        title,
        sub: t(helpers, 'PARLOR.TexasHoldem.Table.Blinds', {
            small: formatChips(helpers, state.smallBlind),
            big: formatChips(helpers, state.bigBlind)
        })
    };
}

function buildHudCards(cards) {
    if (!Array.isArray(cards) || !cards.length) {
        return [0, 1].map(() => ({
            card: null,
            size: 'hud',
            startFaceDown: true,
            idleFaceDown: true,
            hoverReveal: false,
            handHover: true
        }));
    }

    return cards.map(card => ({
        card,
        size: 'hud',
        startFaceDown: true,
        idleFaceDown: true,
        hoverReveal: true,
        handHover: true
    }));
}

function localizeStreet(street, helpers) {
    const safeStreet = ['preflop', 'flop', 'turn', 'river', 'showdown', 'waiting'].includes(street)
        ? street
        : 'waiting';
    const key = safeStreet.charAt(0).toUpperCase() + safeStreet.slice(1);
    return t(helpers, `PARLOR.TexasHoldem.Street.${key}`);
}

function getStreetLabelForHud(state, helpers) {
    if (typeof helpers.getStreetLabel === 'function') return helpers.getStreetLabel(state.street);
    return localizeStreet(state.street, helpers);
}

function buildHudCenterHtml(state, selectedId, controlledIds, helpers) {
    if (controlledIds.length <= 1) return '';
    const getParticipantName = typeof helpers.getParticipantName === 'function'
        ? helpers.getParticipantName
        : defaultParticipantName;
    return `
        <div class="parlor-th-hud-context">
            <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
            <select class="parlor-th-hud-select" id="th-hud-participant">
                ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getParticipantName(state, id))}</option>`).join('')}
            </select>
        </div>
    `;
}

function buildHudAsideHtml(state, selectedId, { minRaiseTo, maxRaiseTo, raiseDisabled }, helpers) {
    if (raiseDisabled) return '';
    const getRaiseShortcuts = typeof helpers.getRaiseShortcuts === 'function'
        ? helpers.getRaiseShortcuts
        : () => ({ min: minRaiseTo, half: minRaiseTo, pot: maxRaiseTo, max: maxRaiseTo });
    const shortcuts = getRaiseShortcuts(state, selectedId);
    const defaultRaise = Math.min(Math.max(minRaiseTo, Number(state.currentBet || 0) + Number(state.bigBlind || 0)), maxRaiseTo);
    return `
        <div class="parlor-th-hud-raise">
            <label for="th-hud-raise-input">${t(helpers, 'PARLOR.TexasHoldem.Action.RaiseTo')}</label>
            <input id="th-hud-raise-input" type="number" min="${minRaiseTo}" max="${maxRaiseTo}" step="1" value="${defaultRaise}">
            <div class="parlor-th-hud-raise-quick">
                <button type="button" data-raise-quick="${shortcuts.min}">${t(helpers, 'PARLOR.TexasHoldem.Action.RaiseMin')}</button>
                <button type="button" data-raise-quick="${shortcuts.half}">${t(helpers, 'PARLOR.TexasHoldem.Action.RaiseHalfPot')}</button>
                <button type="button" data-raise-quick="${shortcuts.pot}">${t(helpers, 'PARLOR.TexasHoldem.Action.RaisePot')}</button>
                <button type="button" data-raise-quick="${shortcuts.max}">${t(helpers, 'PARLOR.TexasHoldem.Action.RaiseMax')}</button>
            </div>
        </div>
    `;
}

// 牌力块:底牌+公共牌评当前最佳牌型。tier 0-7 宝石(straight-flush=8 封顶 7);
// 翻牌前只有两张底牌,只报对子/高牌,note 提示"仅以底牌计"
function buildHudStrength(state, holeCards, helpers) {
    if (!Array.isArray(holeCards) || !holeCards.length) return null;
    if (typeof helpers.evaluateHand !== 'function') return null;
    const community = Array.isArray(state.communityCards) ? state.communityCards : [];
    const result = helpers.evaluateHand([...holeCards, ...community]);
    if (!result) return null;
    return {
        title: t(helpers, 'PARLOR.TexasHoldem.Hud.Strength') || null,
        label: t(helpers, result.labelKey),
        tier: Math.max(0, Math.min(7, Number(result.value ?? 0))),
        note: community.length < 3 ? t(helpers, 'PARLOR.TexasHoldem.Street.Preflop') : ''
    };
}

function withParticipant(data, participantId) {
    return { participantId, ...(data || {}) };
}

function clampRaiseAmount(value, fallback, minRaiseTo, maxRaiseTo) {
    const amount = Math.round(Number(value ?? fallback));
    if (!Number.isFinite(amount)) return fallback;
    return Math.max(minRaiseTo, Math.min(maxRaiseTo, amount));
}

function buildHudActions(state, participantId, { toCall, minRaiseTo, maxRaiseTo, defaultRaise }, helpers) {
    const requestAction = typeof helpers.requestAction === 'function'
        ? helpers.requestAction
        : () => Promise.resolve({ ok: false, reason: 'missing-action-handler' });
    const canRaise = maxRaiseTo > Number(state.currentBet || 0);
    const actions = [];

    if (toCall <= 0) {
        actions.push({
            icon: 'fas fa-hand-paper',
            label: t(helpers, 'PARLOR.TexasHoldem.Action.Check'),
            disabled: false,
            onClick: (_event, data = {}) => requestAction('check', withParticipant(data, participantId))
        });
    } else {
        actions.push({
            icon: 'fas fa-equals',
            label: t(helpers, 'PARLOR.TexasHoldem.Action.CallAmount', {
                amount: formatChips(helpers, toCall)
            }),
            disabled: false,
            onClick: (_event, data = {}) => requestAction('call', withParticipant(data, participantId))
        });
        actions.push({
            icon: 'fas fa-times',
            label: t(helpers, 'PARLOR.TexasHoldem.Action.Fold'),
            className: 'fold',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('fold', withParticipant(data, participantId))
        });
    }

    if (canRaise) {
        actions.push({
            icon: 'fas fa-arrow-up',
            label: t(helpers, 'PARLOR.TexasHoldem.Action.Raise'),
            className: 'gold',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('raiseTo', withParticipant({
                ...data,
                amount: clampRaiseAmount(data?.amount, defaultRaise, minRaiseTo, maxRaiseTo)
            }, participantId))
        });
    }

    actions.push({
        icon: 'fas fa-fire',
        label: t(helpers, 'PARLOR.TexasHoldem.Action.AllIn'),
        disabled: false,
        onClick: (_event, data = {}) => requestAction('allIn', withParticipant(data, participantId))
    });

    return actions;
}

export function buildTexasHoldemHud(state = {}, helpers = {}) {
    const getControlledParticipantIds = typeof helpers.getControlledParticipantIds === 'function'
        ? helpers.getControlledParticipantIds
        : () => [];
    const controlledIds = getControlledParticipantIds(state);
    if (!controlledIds.length) return null;

    const resolveSelectedParticipantId = typeof helpers.resolveSelectedParticipantId === 'function'
        ? helpers.resolveSelectedParticipantId
        : () => controlledIds[0];
    const selectedId = resolveSelectedParticipantId(state, controlledIds);
    if (!selectedId) return null;

    const getDisplayParticipant = typeof helpers.getDisplayParticipant === 'function'
        ? helpers.getDisplayParticipant
        : defaultDisplayParticipant;
    const getParticipantName = typeof helpers.getParticipantName === 'function'
        ? helpers.getParticipantName
        : defaultParticipantName;
    const getSeatStatus = typeof helpers.getSeatStatus === 'function'
        ? helpers.getSeatStatus
        : defaultSeatStatus;
    const getVisibleHoleCards = typeof helpers.getVisibleHoleCards === 'function'
        ? helpers.getVisibleHoleCards
        : () => [];
    const getCallAmount = typeof helpers.getCallAmount === 'function'
        ? helpers.getCallAmount
        : () => 0;
    const getMinRaiseTo = typeof helpers.getMinRaiseTo === 'function'
        ? helpers.getMinRaiseTo
        : () => Number(state.currentBet || 0);
    const getMaxRaiseTo = typeof helpers.getMaxRaiseTo === 'function'
        ? helpers.getMaxRaiseTo
        : () => Number(state.currentBet || 0);

    const display = getDisplayParticipant(state, selectedId) || {};
    const seat = state.playerStates?.[selectedId] || null;
    const status = getSeatStatus(state, selectedId) || defaultSeatStatus();
    const stack = formatChips(helpers, state.tableStacks?.[selectedId] || 0);
    const toCall = getCallAmount(state, selectedId);
    const minRaiseTo = getMinRaiseTo(state, selectedId);
    const maxRaiseTo = getMaxRaiseTo(state, selectedId);
    const raiseDisabled = maxRaiseTo <= Number(state.currentBet || 0);
    const isTurn = state.phase === 'PLAYER_TURNS' && state.currentPlayerId === selectedId && seat?.status === 'active';
    const defaultRaise = Math.min(Math.max(minRaiseTo, Number(state.currentBet || 0) + Number(state.bigBlind || 0)), maxRaiseTo);

    return {
        ownerId: selectedId,
        traySignature: [
            selectedId, stack, toCall, state.currentBet, minRaiseTo, maxRaiseTo,
            raiseDisabled ? 'nr' : 'r', status.text || '', controlledIds.join(','), isTurn ? 't' : '', state.phase
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.TexasHoldem.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.handNumber || state.round || 0 }),
            getStreetLabelForHud(state, helpers)
        ],
        identity: {
            crest: display.avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: getParticipantName(state, selectedId),
            credits: t(helpers, 'PARLOR.TexasHoldem.Table.Stack', { amount: stack }),
            sub: `${t(helpers, 'PARLOR.TexasHoldem.Table.ToCall', { amount: formatChips(helpers, toCall) })} · ${status.text || ''}`
        },
        cards: buildHudCards(getVisibleHoleCards(selectedId)),
        strength: buildHudStrength(state, getVisibleHoleCards(selectedId), helpers),
        centerHtml: buildHudCenterHtml(state, selectedId, controlledIds, helpers),
        asideHtml: buildHudAsideHtml(state, selectedId, { minRaiseTo, maxRaiseTo, raiseDisabled }, helpers),
        actions: isTurn
            ? buildHudActions(state, selectedId, { toCall, minRaiseTo, maxRaiseTo, defaultRaise }, helpers)
            : []
    };
}
