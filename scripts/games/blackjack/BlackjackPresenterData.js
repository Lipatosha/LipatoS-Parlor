const MAX_SIDE_SEATS = 5;
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

function defaultParticipantName(_state, participantId) {
    return String(participantId || '');
}

function defaultDisplayParticipant() {
    return { avatarHtml: '', isSelf: false, kind: 'user' };
}

function callHelper(helpers, name, fallback, ...args) {
    return typeof helpers?.[name] === 'function' ? helpers[name](...args) : fallback(...args);
}

function getActivePlayerIds(state, helpers) {
    return callHelper(
        helpers,
        'getActivePlayerIds',
        (safeState) => (safeState?.turnOrder?.length ? safeState.turnOrder : (safeState?.playerIds || [])).filter(Boolean),
        state
    );
}

function getBettingPlayerIds(state, helpers) {
    return callHelper(
        helpers,
        'getBettingPlayerIds',
        (safeState) => Array.isArray(safeState?.bettingPlayerIds)
            ? safeState.bettingPlayerIds.filter(Boolean)
            : getActivePlayerIds(safeState, helpers),
        state
    );
}

function getSelfSeatParticipantId(state, helpers) {
    return callHelper(helpers, 'getSelfSeatParticipantId', () => '', state);
}

function getParticipantName(state, participantId, helpers) {
    return callHelper(helpers, 'getParticipantName', defaultParticipantName, state, participantId);
}

function getDisplayParticipant(state, participantId, helpers) {
    return callHelper(helpers, 'getDisplayParticipant', defaultDisplayParticipant, state, participantId) || defaultDisplayParticipant();
}

function getSeatLayout(state, helpers) {
    const myId = getSelfSeatParticipantId(state, helpers);
    const allSeatIds = getActivePlayerIds(state, helpers).slice(0, MAX_PRESENTER_SEATS);
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

function getBetAmount(state, participantId) {
    const handBet = Number(state?.playerHands?.[participantId]?.bet || 0);
    if (handBet) return handBet;
    const bet = (state?.bets || []).find(entry => entry.userId === participantId);
    return Number(bet?.amount || 0);
}

function getRoleLabel(state, participantId, helpers) {
    const display = getDisplayParticipant(state, participantId, helpers);
    if (display.kind === 'bot') return t(helpers, 'PARLOR.Common.BOT');
    if (display.kind === 'npc') return t(helpers, 'PARLOR.Common.NPC');
    return t(helpers, 'PARLOR.Common.Player');
}

function getBlackjackSeatStatus(state = {}, participantId, helpers = {}) {
    const hand = state.playerHands?.[participantId] || null;
    const betAmt = getBetAmount(state, participantId);
    const isActive = state.currentPlayerId === participantId && state.phase === 'PLAYER_TURNS';

    if (hand?.status === 'playing') {
        return {
            text: isActive ? t(helpers, 'PARLOR.Blackjack.Seat.Acting') : t(helpers, 'PARLOR.Blackjack.Seat.Playing'),
            className: isActive ? 'status-playing' : 'status-live'
        };
    }
    if (hand?.status === 'awaiting_deal') {
        return { text: t(helpers, 'PARLOR.Blackjack.Seat.AwaitingDeal'), className: 'status-playing' };
    }
    if (hand?.status === 'awaiting_collect') {
        return { text: t(helpers, 'PARLOR.Blackjack.Seat.AwaitingCollect'), className: 'status-playing' };
    }
    if (hand?.status === 'dealing') {
        return { text: t(helpers, 'PARLOR.Common.Dealing'), className: 'status-playing' };
    }
    if (hand?.status === 'bust') {
        return { text: t(helpers, 'PARLOR.Common.Bust'), className: 'status-bust' };
    }
    if (hand?.status === 'blackjack') {
        return { text: 'Blackjack', className: 'status-blackjack' };
    }
    if (hand?.status === 'stand') {
        return { text: t(helpers, 'PARLOR.Common.Stand'), className: 'status-stand' };
    }
    if (betAmt) {
        return { text: t(helpers, 'PARLOR.Blackjack.Seat.BetPlaced'), className: 'status-live' };
    }
    return { text: t(helpers, 'PARLOR.Blackjack.Seat.Seated'), className: 'status-idle' };
}

export function buildBlackjackSeatBadges(state = {}, participantId, helpers = {}) {
    const badges = [{ label: getRoleLabel(state, participantId, helpers), className: 'role' }];
    const betAmt = getBetAmount(state, participantId);
    if (betAmt) {
        badges.push({
            label: t(helpers, 'PARLOR.Common.Bet', {
                amount: `${formatChips(helpers, betAmt)} GP`
            }),
            className: 'bet'
        });
    }
    return badges;
}

export function buildBlackjackSeatEntries(state = {}, helpers = {}) {
    const { myId, visibleSeatIds, entries } = getSeatLayout(state, helpers);

    return entries.map(({ id, side }) => {
        const display = getDisplayParticipant(state, id, helpers);
        const hand = state.playerHands?.[id] || null;
        const betAmt = getBetAmount(state, id);
        const status = getBlackjackSeatStatus(state, id, helpers);
        return {
            id,
            name: id === myId ? t(helpers, 'PARLOR.Common.You') : getParticipantName(state, id, helpers),
            avatarHtml: display.avatarHtml || '',
            chips: betAmt ? `${formatChips(helpers, betAmt)} GP` : t(helpers, 'PARLOR.Common.WaitingBet'),
            badges: buildBlackjackSeatBadges(state, id, helpers),
            statusText: status.text || '',
            statusClass: status.className || '',
            highlight: state.currentPlayerId === id && state.phase === 'PLAYER_TURNS',
            isSelf: !!display.isSelf || id === myId,
            className: hand?.status === 'bust' ? 'is-bust' : '',
            side,
            seatNumber: Math.max(1, visibleSeatIds.indexOf(id) + 1)
        };
    });
}

function handCards(hand) {
    return [...(hand?.handCards || []), ...(hand?.tableCards || [])];
}

function defaultHandTotal(cards, rules = {}) {
    const bustThreshold = Number(rules?.bustThreshold || 21);
    let total = 0;
    let aces = 0;
    for (const card of cards || []) {
        let value = parseInt(card?.rank, 10);
        if (['J', 'Q', 'K'].includes(card?.rank)) value = 10;
        if (card?.rank === 'A') {
            value = 11;
            aces++;
        }
        total += Number.isFinite(value) ? value : 0;
    }
    while (total > bustThreshold && aces > 0) {
        total -= 10;
        aces--;
    }
    return total;
}

function getVisibleHandTotal(state, hand, helpers) {
    return callHelper(helpers, 'getVisibleHandTotal', (_safeState, safeHand) => defaultHandTotal(handCards(safeHand), state?.rules), state, hand);
}

export function buildBlackjackStatus(state = {}, helpers = {}) {
    const activePlayers = getBettingPlayerIds(state, helpers);
    const bettedCount = (state.bets || []).filter(bet => activePlayers.includes(bet.userId)).length;
    const dealerHand = state.dealerHand;
    const dealerCards = handCards(dealerHand);
    const dealerTotal = dealerCards.length ? defaultHandTotal(dealerCards, state.rules) : '?';
    const currentName = state.currentPlayerId
        ? getParticipantName(state, state.currentPlayerId, helpers)
        : t(helpers, 'PARLOR.Common.Waiting');

    let phase = t(helpers, 'PARLOR.Common.Waiting');
    let title = t(helpers, 'PARLOR.Blackjack.Hud.DealerPanel');
    let sub = t(helpers, 'PARLOR.Blackjack.Hud.DealerWaiting');

    if (state.phase === 'BETTING') {
        phase = t(helpers, 'PARLOR.Blackjack.Hud.PhaseBetting');
        title = t(helpers, 'PARLOR.Blackjack.Hud.WaitingBets');
        sub = t(helpers, 'PARLOR.Blackjack.Hud.BetsProgress', { betted: bettedCount, total: activePlayers.length });
    } else if (state.phase === 'DEALING') {
        phase = t(helpers, 'PARLOR.Common.Dealing');
        title = t(helpers, 'PARLOR.Common.Dealing');
        sub = t(helpers, 'PARLOR.Blackjack.Hud.DealingSub');
    } else if (state.phase === 'READY') {
        phase = t(helpers, 'PARLOR.Common.WaitingDeal');
        title = t(helpers, 'PARLOR.Blackjack.Hud.DealerReady');
        sub = t(helpers, 'PARLOR.Blackjack.Hud.DealerReadySub');
    } else if (state.phase === 'PLAYER_TURNS') {
        phase = t(helpers, 'PARLOR.Blackjack.Hud.PhasePlayerTurn');
        title = t(helpers, 'PARLOR.Blackjack.Hud.PlayerTurnTitle', { name: currentName });
        sub = state.pendingAction?.action === 'hit'
            ? t(helpers, 'PARLOR.Blackjack.Hud.PlayerHitRequested')
            : t(helpers, 'PARLOR.Blackjack.Hud.PlayerTurnSub');
    } else if (state.phase === 'DEALER_TURN') {
        phase = t(helpers, 'PARLOR.Blackjack.Hud.PhaseDealerTurn');
        title = t(helpers, 'PARLOR.Blackjack.Hud.DealerAction');
        sub = dealerHand?.status === 'dealing'
            ? t(helpers, 'PARLOR.Blackjack.Hud.DealerCollecting')
            : t(helpers, 'PARLOR.Blackjack.Hud.DealerDecision');
    } else if (state.phase === 'SETTLE') {
        phase = t(helpers, 'PARLOR.Common.WaitingSettlement');
        title = t(helpers, 'PARLOR.Blackjack.Hud.SettleReady');
        sub = t(helpers, 'PARLOR.Blackjack.Hud.DealerFinalPoints', { total: dealerTotal });
    } else if (state.phase === 'RESOLVING') {
        phase = t(helpers, 'PARLOR.Blackjack.Hud.RoundDone');
        title = t(helpers, 'PARLOR.Blackjack.Hud.ResultReady');
        sub = t(helpers, 'PARLOR.Common.SettlementOpen');
    }

    return {
        phase,
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
        title,
        sub
    };
}

function getControlledParticipantIds(state, helpers) {
    return callHelper(helpers, 'getControlledParticipantIds', () => [], state);
}

function resolveSelectedParticipantId(state, controlledIds, helpers) {
    return callHelper(helpers, 'resolveSelectedParticipantId', () => controlledIds[0] || '', state, controlledIds);
}

function isGM(helpers) {
    return callHelper(helpers, 'isGM', () => false);
}

function isDealerController(state, helpers) {
    return callHelper(helpers, 'isDealerController', () => false, state);
}

function getPlayerHudCards(state, hand, helpers) {
    return callHelper(
        helpers,
        'getPlayerHudCards',
        (_safeState, safeHand) => (safeHand?.handCards || []).map(card => ({ card, size: 'hud' })),
        state,
        hand
    );
}

function getDealerHudCards(state, hand, helpers) {
    return callHelper(
        helpers,
        'getDealerHudCards',
        (_safeState, safeHand) => (safeHand?.handCards || []).map(card => ({ card, size: 'hud' })),
        state,
        hand
    );
}

function getBetDraftAmount(participantId, helpers) {
    return callHelper(helpers, 'getBetDraftAmount', () => 10, participantId);
}

function isActionPending(actionKey, helpers) {
    return callHelper(helpers, 'isActionPending', () => false, actionKey);
}

function requestAction(helpers, action, data) {
    const handler = typeof helpers?.requestAction === 'function'
        ? helpers.requestAction
        : () => Promise.resolve({ ok: false, reason: 'missing-action-handler' });
    return handler(action, data);
}

function withParticipant(data, participantId) {
    return { participantId, ...(data || {}) };
}

function playerActionKey(participantId, action) {
    return `player:${participantId || 'none'}:${action}`;
}

function gmActionKey(action) {
    return `gm:${action}`;
}

function buildHudMode(state, helpers) {
    const controlledIds = getControlledParticipantIds(state, helpers);
    const myId = resolveSelectedParticipantId(state, controlledIds, helpers);
    const dealerController = isDealerController(state, helpers);
    const playerParticipant = controlledIds.length > 0;
    const preferDealerFooter = ['DEALER_TURN', 'SETTLE'].includes(state.phase);
    const useDealerFooter = preferDealerFooter
        ? (dealerController || (isGM(helpers) && !playerParticipant))
        : (!playerParticipant && (dealerController || isGM(helpers)));
    return { myId, controlledIds, dealerController, playerParticipant, useDealerFooter };
}

function buildRoleSelect(state, selectedId, controlledIds, helpers) {
    if (controlledIds.length <= 1) return '';
    return `
        <select id="bj-hud-participant-select" class="parlor-hud-footer-input">
            ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getParticipantName(state, id, helpers))}</option>`).join('')}
        </select>
    `;
}

function buildDealerCenterHtml(state, helpers) {
    const activePlayers = getBettingPlayerIds(state, helpers);
    const bettedCount = (state.bets || []).filter(bet => activePlayers.includes(bet.userId)).length;
    const dealerCards = handCards(state.dealerHand);
    const dealerTotal = dealerCards.length ? defaultHandTotal(dealerCards, state.rules) : '?';
    const status = buildBlackjackStatus(state, helpers);

    let rightHtml = `<span class="parlor-hud-footer-pill">${t(helpers, 'PARLOR.Blackjack.Hud.DealerPoints', { total: dealerTotal })}</span>`;
    if (state.phase === 'BETTING') {
        rightHtml = `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.Hud.BetsProgress', { betted: bettedCount, total: activePlayers.length })}</span>`;
    } else if (state.phase === 'DEALING') {
        rightHtml = `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Common.Dealing')}</span>`;
    } else if (state.phase === 'RESOLVING') {
        rightHtml = `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.Hud.RoundDone')}</span>`;
    }

    return `
        <div class="parlor-hud-footer-main">
            <div class="parlor-hud-footer-side">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.Dealer')}</span>
                <span class="parlor-hud-footer-pill">${t(helpers, 'PARLOR.Blackjack.Hud.PointsPill', { total: dealerTotal })}</span>
            </div>
            <div class="parlor-hud-footer-center">
                <div class="parlor-hud-footer-title">${status.title}</div>
                <div class="parlor-hud-footer-sub">${status.sub}</div>
            </div>
            <div class="parlor-hud-footer-side align-right">${rightHtml}</div>
        </div>
    `;
}

function buildPlayerCenterHtml(state, selectedId, controlledIds, helpers) {
    const hand = state.playerHands?.[selectedId] || null;
    const bet = Number(hand?.bet || getBetAmount(state, selectedId) || 0);
    const hasBet = bet > 0;
    const canBet = getBettingPlayerIds(state, helpers).includes(selectedId);
    const total = hand ? getVisibleHandTotal(state, hand, helpers) : null;
    const participant = getDisplayParticipant(state, selectedId, helpers);
    const participantLabel = participant?.isSelf
        ? t(helpers, 'PARLOR.Common.YourRole')
        : (getParticipantName(state, selectedId, helpers) || t(helpers, 'PARLOR.Common.CurrentRole'));

    let title = t(helpers, 'PARLOR.Blackjack.PlayerHud.WaitingStart');
    let sub = hasBet ? t(helpers, 'PARLOR.Blackjack.PlayerHud.BetPlacedWaiting') : t(helpers, 'PARLOR.Blackjack.PlayerHud.NoBetYet');
    // 点数药丸不再放这里——HUD 牌力块(strength)已经用大字+宝石展示点数,重复显示很乱
    let rightHtml = '';
    void total;

    if (state.phase === 'BETTING') {
        title = hasBet
            ? t(helpers, 'PARLOR.Blackjack.PlayerHud.BetLocked')
            : (canBet ? t(helpers, 'PARLOR.Blackjack.PlayerHud.PlaceBetFirst') : t(helpers, 'PARLOR.Blackjack.PlayerHud.SittingOutTitle'));
        sub = hasBet
            ? t(helpers, 'PARLOR.Blackjack.PlayerHud.BetThisRound', { participant: participantLabel, bet })
            : (canBet ? t(helpers, 'PARLOR.Blackjack.PlayerHud.BetRequired', { participant: participantLabel }) : t(helpers, 'PARLOR.Blackjack.PlayerHud.SittingOutSub'));
        rightHtml = hasBet
            ? `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.PlayerHud.WaitingOthers')}</span>`
            : `<input type="number" id="bj-hud-bet-input" value="${getBetDraftAmount(selectedId, helpers)}" min="1" class="parlor-hud-footer-input" placeholder="GP">`;
    } else if (state.phase === 'DEALING') {
        title = t(helpers, 'PARLOR.Common.Dealing');
        sub = t(helpers, 'PARLOR.Blackjack.PlayerHud.DealingSub');
    } else if (state.phase === 'READY') {
        title = t(helpers, 'PARLOR.Blackjack.PlayerHud.WaitingDealer');
        sub = hasBet
            ? t(helpers, 'PARLOR.Blackjack.PlayerHud.BetThisRound', { participant: participantLabel, bet })
            : t(helpers, 'PARLOR.Blackjack.PlayerHud.DealerTidying');
        rightHtml = `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.PlayerHud.ReadyPhase')}</span>`;
    } else if (state.phase === 'PLAYER_TURNS') {
        const currentName = state.currentPlayerId
            ? getParticipantName(state, state.currentPlayerId, helpers)
            : t(helpers, 'PARLOR.Common.Waiting');
        if (state.currentPlayerId === selectedId) {
            title = state.pendingAction?.action === 'hit'
                ? t(helpers, 'PARLOR.Blackjack.PlayerHud.HitRequested')
                : t(helpers, 'PARLOR.Blackjack.PlayerHud.YourTurn');
            sub = state.pendingAction?.action === 'hit'
                ? t(helpers, 'PARLOR.Blackjack.PlayerHud.HitRequestedSub')
                : t(helpers, 'PARLOR.Blackjack.PlayerHud.ActionHint');
        } else {
            title = t(helpers, 'PARLOR.Blackjack.PlayerHud.WaitingPlayer', { name: currentName });
            sub = t(helpers, 'PARLOR.Blackjack.PlayerHud.NotYourTurn');
        }
    } else if (state.phase === 'DEALER_TURN') {
        title = t(helpers, 'PARLOR.Blackjack.PlayerHud.DealerTurn');
        sub = t(helpers, 'PARLOR.Blackjack.PlayerHud.WaitDealerFinish');
    } else if (state.phase === 'SETTLE') {
        title = t(helpers, 'PARLOR.Common.WaitingSettlement');
        sub = total !== null
            ? t(helpers, 'PARLOR.Blackjack.PlayerHud.FinalPoints', { total })
            : t(helpers, 'PARLOR.Blackjack.PlayerHud.ResultSoon');
        rightHtml = `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.PlayerHud.BeforeSettlement')}</span>`;
    } else if (state.phase === 'RESOLVING') {
        const payout = Number((state.payouts || {})[selectedId] || 0);
        const roundDelta = hand ? payout - bet : 0;
        title = roundDelta > 0
            ? t(helpers, 'PARLOR.Blackjack.PlayerHud.RoundWin')
            : (roundDelta < 0 ? t(helpers, 'PARLOR.Blackjack.PlayerHud.RoundLose') : t(helpers, 'PARLOR.Blackjack.PlayerHud.RoundTie'));
        sub = `${roundDelta > 0 ? '+' : ''}${formatChips(helpers, roundDelta)} GP`;
        rightHtml = total !== null
            ? `<span class="parlor-hud-footer-pill">${t(helpers, 'PARLOR.Blackjack.PlayerHud.FinalPointsPill', { total })}</span>`
            : `<span class="parlor-hud-footer-pill muted">${t(helpers, 'PARLOR.Blackjack.PlayerHud.ResultOpen')}</span>`;
    }

    return `
        <div class="parlor-hud-footer-main">
            <div class="parlor-hud-footer-side">
                <span class="parlor-hud-footer-label">${participantLabel}</span>
                ${buildRoleSelect(state, selectedId, controlledIds, helpers)}
                <span class="parlor-hud-footer-pill ${hasBet ? '' : 'muted'}">${hasBet ? `${formatChips(helpers, bet)} GP` : t(helpers, 'PARLOR.Common.NoBet')}</span>
            </div>
            <div class="parlor-hud-footer-center">
                <div class="parlor-hud-footer-title">${title}</div>
                <div class="parlor-hud-footer-sub">${sub}</div>
            </div>
            <div class="parlor-hud-footer-side align-right">${rightHtml}</div>
        </div>
    `;
}

function buildDealerActions(state, helpers) {
    if (!isGM(helpers)) return [];
    if (state.phase === 'READY') {
        return [{
            icon: 'fas fa-hand-holding',
            label: t(helpers, 'PARLOR.Common.Deal'),
            className: 'gold',
            disabled: isActionPending(gmActionKey('startDeal'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'startDeal', { ...data, gm: true })
        }];
    }
    if (state.phase === 'PLAYER_TURNS' && state.pendingAction?.action === 'hit' && state.pendingAction?.stage === 'requested') {
        return [{
            icon: 'fas fa-clone',
            label: t(helpers, 'PARLOR.Common.Deal'),
            className: 'gold',
            disabled: isActionPending(gmActionKey('confirmDeal'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'confirmDeal', { ...data, gm: true })
        }];
    }
    if (state.phase === 'DEALER_TURN' && state.dealerHand?.status !== 'dealing') {
        return [
            {
                icon: 'fas fa-plus',
                label: t(helpers, 'PARLOR.Blackjack.Action.DealerHit'),
                disabled: isActionPending(gmActionKey('dealerHit'), helpers),
                onClick: (_event, data = {}) => requestAction(helpers, 'dealerHit', { ...data, gm: true })
            },
            {
                icon: 'fas fa-hand-paper',
                label: t(helpers, 'PARLOR.Common.Stand'),
                className: 'gold',
                disabled: isActionPending(gmActionKey('dealerStand'), helpers),
                onClick: (_event, data = {}) => requestAction(helpers, 'dealerStand', { ...data, gm: true })
            }
        ];
    }
    if (state.phase === 'SETTLE') {
        return [{
            icon: 'fas fa-file-invoice-dollar',
            label: t(helpers, 'PARLOR.Common.Settle'),
            className: 'gold',
            disabled: isActionPending(gmActionKey('settle'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'settle', { ...data, gm: true })
        }];
    }
    return [];
}

function buildPlayerActions(state, participantId, hand, helpers) {
    const actions = [];
    const bet = Number(hand?.bet || getBetAmount(state, participantId) || 0);
    const canBet = state.phase === 'BETTING' && !bet && getBettingPlayerIds(state, helpers).includes(participantId);
    if (canBet) {
        actions.push({
            icon: 'fas fa-coins',
            label: t(helpers, 'PARLOR.Common.Bet'),
            className: 'gold',
            disabled: isActionPending(playerActionKey(participantId, 'placeBet'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'placeBet', withParticipant({
                ...data,
                amount: Math.max(1, Math.floor(Number(data?.amount || getBetDraftAmount(participantId, helpers))))
            }, participantId))
        });
    }

    const isMyTurn = state.currentPlayerId === participantId && state.phase === 'PLAYER_TURNS';
    if (!hand || !isMyTurn) return actions;

    const canHit = callHelper(helpers, 'canPlayerHit', () => true, state, hand, participantId);
    const canStand = callHelper(helpers, 'canPlayerStand', () => hand.status === 'playing', state, hand, participantId);
    if (canHit) {
        actions.push({
            icon: 'fas fa-plus',
            label: t(helpers, 'PARLOR.Common.Hit'),
            disabled: isActionPending(playerActionKey(participantId, 'requestHit'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'requestHit', withParticipant(data, participantId))
        });
    }
    if (canStand) {
        actions.push({
            icon: 'fas fa-hand-paper',
            label: t(helpers, 'PARLOR.Common.Stand'),
            disabled: isActionPending(playerActionKey(participantId, 'requestStand'), helpers),
            onClick: (_event, data = {}) => requestAction(helpers, 'requestStand', withParticipant(data, participantId))
        });
    }
    return actions;
}

export function buildBlackjackHud(state = {}, helpers = {}) {
    const mode = buildHudMode(state, helpers);
    if (mode.useDealerFooter) {
        const dealerHand = state.dealerHand || null;
        const cards = dealerHand && mode.dealerController ? getDealerHudCards(state, dealerHand, helpers) : [];
        const dealerTotal = handCards(dealerHand).length ? defaultHandTotal(handCards(dealerHand), state.rules) : '?';
        return {
            ownerId: 'dealer',
            traySignature: ['dealer', state.phase, state.round, dealerTotal, mode.dealerController ? 'ctl' : 'view'].join('|'),
            topline: [
                t(helpers, 'PARLOR.Games.Blackjack.Name'),
                t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 })
            ],
            identity: {
                crest: '',
                tag: t(helpers, 'PARLOR.Common.Dealer'),
                name: t(helpers, 'PARLOR.Common.Dealer'),
                credits: t(helpers, 'PARLOR.Blackjack.Hud.PointsPill', { total: dealerTotal }),
                sub: buildBlackjackStatus(state, helpers).sub
            },
            cards,
            centerHtml: buildDealerCenterHtml(state, helpers),
            asideHtml: '',
            actions: buildDealerActions(state, helpers)
        };
    }

    if (!mode.playerParticipant) return null;
    const selectedId = mode.myId;
    const hand = state.playerHands?.[selectedId] || null;
    const display = getDisplayParticipant(state, selectedId, helpers);
    const status = hand ? getBlackjackSeatStatus(state, selectedId, helpers) : { text: t(helpers, 'PARLOR.Common.Waiting'), className: '' };
    const cards = hand ? getPlayerHudCards(state, hand, helpers) : [];
    const bet = Number(hand?.bet || getBetAmount(state, selectedId) || 0);
    const strength = buildPlayerStrength(state, hand, helpers);

    return {
        ownerId: selectedId,
        traySignature: [
            selectedId, state.phase, state.round, state.currentPlayerId || '',
            hand?.status || 'none', bet, status.text || '', mode.controlledIds.join(',')
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.Blackjack.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 })
        ],
        identity: {
            crest: display.avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: getParticipantName(state, selectedId, helpers),
            credits: bet ? `${formatChips(helpers, bet)} GP` : t(helpers, 'PARLOR.Common.NoBet'),
            sub: status.text || ''
        },
        cards,
        strength,
        centerHtml: buildPlayerCenterHtml(state, selectedId, mode.controlledIds, helpers),
        asideHtml: '',
        actions: buildPlayerActions(state, selectedId, hand, helpers)
    };
}

// 牌力块:自己手牌点数 → 七格宝石。21/BJ=7 → 17=3 递减,12-16 危险区 2,≤11 还能要牌 1,爆=0。
// note 报庄家明牌,给"要不要牌"一个判断锚
function buildPlayerStrength(state, hand, helpers) {
    const cards = handCards(hand);
    if (!cards.length) return null;
    const total = Number(defaultHandTotal(cards, state.rules)) || 0;
    const bust = total > 21;
    let tier;
    if (bust) tier = 0;
    else if (total >= 21) tier = 7;
    else if (total >= 17) tier = total - 14; // 20=6, 19=5, 18=4, 17=3
    else if (total >= 12) tier = 2;
    else tier = 1;

    const dealerUp = handCards(state.dealerHand)[0] || null;
    const note = dealerUp?.rank
        ? `${t(helpers, 'PARLOR.Common.Dealer')} · ${dealerUp.rank}`
        : '';
    return {
        title: t(helpers, 'PARLOR.Blackjack.Hud.Strength') || null,
        label: bust
            ? t(helpers, 'PARLOR.Common.Bust')
            : `${total}`,
        tier,
        note
    };
}
