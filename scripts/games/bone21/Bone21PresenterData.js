/**
 * Bone21PresenterData — 骨骰21 Presenter 数据映射(纯函数,零 import)
 *
 * 骰子版 21 点:每人两颗私骰(RESOLVING 才公开),之后轮流加骰(公开),
 * 未爆且最接近 21 者胜。playerStates[uid]={dice(公开加骰),total(公开和),status,result,lastRoll,bet}。
 * 私骰经 helpers.getVisibleDice 拿(自己/代管可见);公开数据全部走 state。
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

function seatIds(state) {
    const order = Array.isArray(state.turnOrder) && state.turnOrder.length ? state.turnOrder : (state.playerIds || []);
    return order;
}

export function buildBone21SeatEntries(state = {}, helpers = {}) {
    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const getDisplay = (id) => callHelper(helpers, 'getDisplayParticipant', () => ({ avatarHtml: '', isSelf: false }), state, id) || {};

    return seatIds(state).map(id => {
        const display = getDisplay(id);
        const seat = state.playerStates?.[id] || null;
        const badges = [];
        // 公开总点(只算加骰,私骰在 RESOLVING 前对外保密)
        if (seat) {
            badges.push({ label: `${seat.total ?? 0}`, className: seat.status === 'bust' ? 'wax' : 'gold' });
        }
        let statusText = '';
        let className = '';
        if (seat?.status === 'bust') {
            statusText = t(helpers, 'PARLOR.Common.Bust');
            className = 'is-bust';
        } else if (seat?.status === 'stand') {
            statusText = t(helpers, 'PARLOR.Common.Stand');
        } else if (state.phase === 'ROLLING') {
            statusText = seat
                ? t(helpers, 'PARLOR.Common.Ready')
                : t(helpers, 'PARLOR.Common.Waiting');
        }
        if ((state.winnerIds || []).includes(id)) {
            className = 'is-winner';
            statusText = t(helpers, 'PARLOR.Common.Win');
        }
        return {
            id,
            name: getName(id),
            avatarHtml: display.avatarHtml || '',
            chips: seat?.bet ? formatChips(helpers, seat.bet) : '',
            badges,
            statusText,
            statusClass: '',
            highlight: state.phase === 'PLAYER_TURNS' && state.currentPlayerId === id,
            isSelf: !!display.isSelf,
            className
        };
    });
}

export function buildBone21Status(state = {}, helpers = {}) {
    const getName = (id) => callHelper(helpers, 'getParticipantName', () => String(id || ''), state, id);
    const phaseKeys = {
        IDLE: 'PARLOR.Common.Waiting',
        BETTING: 'PARLOR.Bone21.Phase.Betting',
        ROLLING: 'PARLOR.Bone21.Phase.Rolling',
        PLAYER_TURNS: 'PARLOR.Bone21.Phase.PlayerTurns',
        RESOLVING: 'PARLOR.Bone21.Phase.Resolving'
    };
    const phase = t(helpers, phaseKeys[state.phase] || 'PARLOR.Common.Waiting');

    let title = phase;
    let sub = '';
    if (state.phase === 'BETTING') {
        sub = state.roundAnte ? `${formatChips(helpers, state.roundAnte)}` : '';
    } else if (state.phase === 'ROLLING') {
        const rolled = Object.keys(state.playerStates || {}).length;
        const total = seatIds(state).length;
        sub = `${rolled} / ${total}`;
    } else if (state.phase === 'PLAYER_TURNS' && state.currentPlayerId) {
        title = t(helpers, 'PARLOR.Common.CurrentTurn', { name: getName(state.currentPlayerId) })
            || getName(state.currentPlayerId);
    } else if (state.phase === 'RESOLVING') {
        const winners = (state.winnerIds || []).map(id => getName(id)).join('、');
        if (winners) title = winners;
    }

    return {
        phase,
        round: t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
        title,
        sub
    };
}

// 真实总和(含私骰)→ 七格宝石,映射同 21点:21=7 → 17=3 递减、12-16 危险区、≤11 还能掷、爆=0
function buildStrength(visibleDice, seat, helpers) {
    if (!visibleDice.length) return null;
    const total = visibleDice.reduce((sum, v) => sum + Number(v || 0), 0);
    const bust = total > 21;
    let tier;
    if (bust) tier = 0;
    else if (total >= 21) tier = 7;
    else if (total >= 17) tier = total - 14;
    else if (total >= 12) tier = 2;
    else tier = 1;
    return {
        title: t(helpers, 'PARLOR.Bone21.Hud.Strength') || null,
        label: bust ? t(helpers, 'PARLOR.Common.Bust') : `${total}`,
        tier,
        // 桌面只公开加骰之和,提醒自己别把私骰念出声
        note: seat ? `${t(helpers, 'PARLOR.Bone21.Hud.PublicTotal') || '公开'} ${seat.total ?? 0}` : ''
    };
}

export function buildBone21Hud(state = {}, helpers = {}) {
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
    const visibleDice = selectedId ? callHelper(helpers, 'getVisibleDice', () => [], selectedId) : [];
    const requestAction = (action, data) => callHelper(
        helpers, 'requestAction',
        () => Promise.resolve({ ok: false, reason: 'missing-action-handler' }),
        action, data
    );

    const inGame = !!selectedId && seatIds(state).includes(selectedId);
    const needsInitialRoll = state.phase === 'ROLLING' && inGame && !seat;
    const isTurn = state.phase === 'PLAYER_TURNS' && state.currentPlayerId === selectedId && seat?.status === 'playing';

    const actions = [];
    if (needsInitialRoll || isTurn) {
        actions.push({
            icon: 'fas fa-dice',
            label: t(helpers, 'PARLOR.Bone21.Action.Roll'),
            className: 'gold',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('roll', { participantId: selectedId, ...data, amount: undefined })
        });
    }
    if (isTurn) {
        actions.push({
            icon: 'fas fa-hand-paper',
            label: t(helpers, 'PARLOR.Bone21.Action.Stand'),
            className: '',
            disabled: false,
            onClick: (_event, data = {}) => requestAction('stand', { participantId: selectedId, ...data, amount: undefined })
        });
    }
    if (isGM) {
        if (state.phase === 'BETTING') {
            actions.push({
                icon: '',
                label: t(helpers, 'PARLOR.Bone21.Action.SetAnte'),
                className: 'gold',
                disabled: false,
                onClick: (_event, data = {}) => requestAction('setAnte', {
                    amount: Math.max(1, Math.floor(Number(data?.amount || 0)) || 10),
                    gm: true
                })
            });
        } else if (state.phase === 'RESOLVING') {
            actions.push({
                icon: 'fas fa-redo',
                label: t(helpers, 'PARLOR.Common.NextRound'),
                className: 'gold',
                disabled: false,
                onClick: (_event, data = {}) => requestAction('newRound', { ...data, gm: true, amount: undefined })
            });
            actions.push({
                icon: 'fas fa-door-closed',
                label: t(helpers, 'PARLOR.Common.Finish'),
                className: '',
                disabled: false,
                onClick: (_event, data = {}) => requestAction('finishGame', { ...data, gm: true, amount: undefined })
            });
        }
    }

    const centerHtml = controlledIds.length > 1
        ? `
            <div class="parlor-th-hud-context">
                <span class="parlor-hud-footer-label">${t(helpers, 'PARLOR.Common.CurrentParticipant')}</span>
                <select class="parlor-th-hud-select" id="b21-hud-participant">
                    ${controlledIds.map(id => `<option value="${escapeHtml(id)}" ${id === selectedId ? 'selected' : ''}>${escapeHtml(getName(id))}</option>`).join('')}
                </select>
            </div>
        `
        : '';

    const asideHtml = isGM && state.phase === 'BETTING'
        ? `
            <div class="parlor-th-hud-raise">
                <label for="b21-hud-ante-input">${t(helpers, 'PARLOR.Bone21.Hud.AnteLabel') || 'Ante'}</label>
                <input id="b21-hud-ante-input" type="number" min="1" step="1" value="${Math.max(1, Number(state.roundAnte || state.startingAnte || 10))}">
            </div>
        `
        : '';

    return {
        ownerId: selectedId || 'gm',
        traySignature: [
            selectedId, state.phase, state.round, state.currentPlayerId || '',
            seat ? `${seat.status}:${seat.total}:${(seat.dice || []).length}` : '',
            visibleDice.length, controlledIds.join(','), isGM ? 'gm' : ''
        ].join('|'),
        topline: [
            t(helpers, 'PARLOR.Games.Bone21.Name'),
            t(helpers, 'PARLOR.Common.RoundCounter', { round: state.round || 0 }),
            buildBone21Status(state, helpers).phase
        ],
        identity: {
            crest: getDisplay(selectedId).avatarHtml || '',
            tag: t(helpers, 'PARLOR.Common.CurrentParticipant'),
            name: selectedId ? getName(selectedId) : t(helpers, 'PARLOR.Common.Dealer'),
            credits: balance === '' ? '' : `${balance}`,
            sub: seat
                ? `${t(helpers, 'PARLOR.Common.Bet')} ${formatChips(helpers, seat.bet)}`
                : ''
        },
        cards: [],
        // 自己的骰子(私骰+加骰),呈现器画成酒馆骰;strength 用真实总和(含私骰)
        diceValues: visibleDice,
        strength: buildStrength(visibleDice, seat, helpers),
        centerHtml,
        asideHtml,
        actions
    };
}
