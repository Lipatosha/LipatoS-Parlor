/**
 * CrazyEightsTablePresenter — 奇幻酒馆 · 疯狂八桌
 *
 * 垫面 = 牌堆(可点即抽)| 座次环 + 方向环 + 花色徽章 | 弃牌堆(顶牌 + 两张残影 + 花色选择器)。
 * 手牌走壳的扇形布局(handLayout 'fan'),点牌直接出;只剩一张的人名录/圆标流光。
 * 本体没有语义事件,动画全靠 state.lastActions 的 seq 回放:别人出牌从他的圆标飞到弃牌堆,
 * 自己出牌从被点的那张牌飞过去,别人抽牌从牌堆飞回圆标。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE'], labelKey: 'PARLOR.CrazyEights.Center.Phase.Idle' },
    { keys: ['DEALING'], labelKey: 'PARLOR.CrazyEights.Center.Phase.Dealing' },
    { keys: ['PLAYER_TURNS'], labelKey: 'PARLOR.CrazyEights.Center.Phase.Turns' },
    { keys: ['RESOLVING'], labelKey: 'PARLOR.CrazyEights.Center.Phase.Resolving' }
];
const SUIT_GLYPHS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const RED_SUITS = new Set(['hearts', 'diamonds']);
const TRAIL_MAX = 2;
const PILE_CARDS = 3;
const FLIP_MS = 620;
const POP_MS = 520;
const FLASH_MS = 1100;
const MAX_DRAW_GHOSTS = 4;

export class CrazyEightsTablePresenter extends TavernTableShell {
    constructor() {
        super();
        this._ceState = null;
        this._ceEls = null; // 垫面骨架建一次,之后只打补丁(牌堆上挂着点击,重建会抖)
        this._ceSnap = null; // 上一帧的桌况快照,变化了才动画
        this._lastSeq = 0; // 已回放到的动作序号
        this._trail = []; // 弃牌堆顶牌下面的残影(前两张)
        this._cePendingPlay = null; // 自己刚点出去的牌:牌 + 出发矩形
        this._ceDrawAction = null; // 当前可用的抽牌动作(牌堆点击用)
        this._pickerKey = '';
        this._ringSig = '';
        this._timers = new Set();
    }

    get gameNameKey() { return 'PARLOR.Games.CrazyEights.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.CrazyEights'; }
    get gameGlyph() { return '♣'; }
    get handLayout() { return 'fan'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    mount(root, gameApi) {
        root.classList.add('pth-ce');
        super.mount(root, gameApi);
    }

    destroy() {
        for (const timer of this._timers) clearTimeout(timer);
        this._timers.clear();
        this._root?.classList.remove('pth-ce');
        this._ceEls = null;
        super.destroy();
    }

    // 名录渲染在垫面之前,先把 state 存下来给名录覆盖用
    refresh(state) {
        this._ceState = state || this._api?.getState?.() || {};
        super.refresh(this._ceState);
    }

    actionSoundKind(action) {
        switch (action?.kind) {
            case 'play': return 'placed';
            case 'draw': return 'deal';
            case 'suit': return 'flip';
            case 'pass':
            case 'gm': return '';
            default: return 'placed';
        }
    }

    handCardPlayed(entry, slot) {
        this._cePendingPlay = {
            card: entry?.card || null,
            rect: slot?.getBoundingClientRect?.() || null
        };
    }

    // 花色选择器贴在弃牌堆上,HUD 动作行里不再重复放
    _renderHudActions(hud) {
        super._renderHudActions({ ...hud, actions: (hud.actions || []).filter(action => action.kind !== 'suit') });
    }

    // ── 垫面 ───────────────────────────────────────────────

    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        if (!this._ceEls || this._ceEls.root.parentNode !== host) this._buildSurface(host);

        const hud = this._api?.getHud?.() || null;
        this._patchStock(state, hud);
        this._patchCenter(state);
        this._patchDiscard(state);
        this._patchRing(state);
        this._patchPicker(state, hud);
        this._replayActions(state, hud);
        this._ceSnap = this._surfaceSnapshot(state);
    }

    _buildSurface(host) {
        host.innerHTML = '';
        const make = (className, tag = 'div') => {
            const node = document.createElement(tag);
            node.className = className;
            return node;
        };

        const root = make('pth-ce-table');

        const stock = make('pth-ce-stock');
        const pile = make('pth-ce-pile');
        for (let i = 0; i < PILE_CARDS; i++) {
            const back = this._card(null, { faceDown: true });
            back.style?.setProperty('--k', String(i));
            pile.appendChild(back);
        }
        const stockPlaque = make('pth-ce-plaque');
        const stockLabel = make('pth-ce-plaque-lbl', 'span');
        stockLabel.textContent = this._t('PARLORTAVERN.CrazyEights.Stock');
        const stockCount = make('pth-ce-plaque-num', 'b');
        stockPlaque.appendChild(stockLabel);
        stockPlaque.appendChild(stockCount);
        const pending = make('pth-ce-pending badge wax', 'span');
        pending.hidden = true;
        stock.appendChild(pile);
        stock.appendChild(stockPlaque);
        stock.appendChild(pending);
        stock.addEventListener('click', event => {
            const action = this._ceDrawAction;
            if (!action || action.disabled) return;
            this._runHudAction(action, event, stock, {});
        });

        const center = make('pth-ce-center');
        const ring = make('pth-ce-ring');
        const core = make('pth-ce-core');
        const dir = make('pth-ce-dir');
        dir.dataset.dir = '1';
        dir.innerHTML = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 15a22 22 0 1 1-8 17" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M10 22 2 36h16Z" fill="currentColor"/></svg>';
        const dirLabel = make('pth-ce-dir-label', 'span');
        dir.appendChild(dirLabel);
        const suit = make('pth-ce-suit');
        const suitGlyph = make('pth-ce-suit-glyph', 'span');
        suit.appendChild(suitGlyph);
        core.appendChild(dir);
        core.appendChild(suit);
        center.appendChild(ring);
        center.appendChild(core);

        const discard = make('pth-ce-discard');
        const trail = make('pth-ce-trail');
        const top = make('pth-ce-top');
        const discardPlaque = make('pth-ce-plaque');
        const discardLabel = make('pth-ce-plaque-lbl', 'span');
        discardLabel.textContent = this._t('PARLORTAVERN.CrazyEights.Discard');
        const discardCount = make('pth-ce-plaque-num', 'b');
        discardPlaque.appendChild(discardLabel);
        discardPlaque.appendChild(discardCount);
        const picker = make('pth-ce-picker');
        picker.hidden = true;
        discard.appendChild(trail);
        discard.appendChild(top);
        discard.appendChild(discardPlaque);
        discard.appendChild(picker);

        root.appendChild(stock);
        root.appendChild(center);
        root.appendChild(discard);
        host.appendChild(root);

        this._ceEls = { root, stock, pile, stockCount, pending, ring, dir, dirLabel, suit, suitGlyph, discard, trail, top, discardCount, picker };
        this._ceSnap = null;
        this._trail = [];
        this._ringSig = '';
        this._pickerKey = '';
    }

    _patchStock(state, hud) {
        const els = this._ceEls;
        const count = Number(state.stockCount || 0);
        els.stockCount.textContent = String(count);
        els.stock.classList.toggle('is-empty', count <= 0);

        const pendingDraw = Number(state.turn?.pendingDraw || 0);
        els.pending.hidden = pendingDraw <= 0;
        els.pending.textContent = pendingDraw > 0 ? `+${pendingDraw}` : '';

        const drawAction = (hud?.actions || []).find(action => action.kind === 'draw' && !action.disabled) || null;
        this._ceDrawAction = drawAction;
        els.stock.classList.toggle('is-clickable', !!drawAction);
    }

    _patchCenter(state) {
        const els = this._ceEls;
        const direction = Number(state.direction) < 0 ? '-1' : '1';
        els.dir.dataset.dir = direction;
        const directionLabel = this._t(direction === '-1'
            ? 'PARLOR.CrazyEights.Center.Direction.CounterClockwise'
            : 'PARLOR.CrazyEights.Center.Direction.Clockwise');
        els.dirLabel.textContent = directionLabel;
        els.dir.title = directionLabel;

        const choosing = !!state.turn?.mustChooseSuit;
        const suit = state.currentSuit || state.discardTop?.suit || '';
        const wildOnTop = !!state.discardTop && state.discardTop.rank === (state.rules?.wildRank || '8');
        els.suit.dataset.suit = suit;
        els.suit.classList.toggle('is-red', RED_SUITS.has(suit));
        els.suit.classList.toggle('is-wild', wildOnTop && !choosing);
        els.suit.classList.toggle('is-pending', choosing);
        els.suitGlyph.textContent = choosing ? '?' : (SUIT_GLYPHS[suit] || '');
    }

    _patchDiscard(state) {
        const els = this._ceEls;
        const topCard = state.discardTop || null;
        const key = topCard ? `${state.roundToken}:${Number(state.discardCount || 0)}:${topCard.rank}-${topCard.suit}` : '';
        els.discardCount.textContent = String(Number(state.discardCount || 0));
        els.discard.classList.toggle('is-empty', !topCard);
        if (key === this._ceSnap?.topKey && els.top.children.length) return;

        const sameRound = this._ceSnap?.roundToken === state.roundToken;
        const previous = sameRound ? this._ceSnap?.topCard : null;
        if (!sameRound) this._trail = [];
        else if (previous && Number(state.discardCount || 0) > 1) {
            this._trail.push(previous);
            while (this._trail.length > TRAIL_MAX) this._trail.shift();
        }
        // 洗牌后弃牌堆只剩顶牌,残影也该清掉
        if (Number(state.discardCount || 0) <= 1) this._trail = [];

        els.trail.innerHTML = '';
        this._trail.forEach((card, index) => {
            const node = this._card(card, { faceDown: false });
            node.classList?.add(`pth-ce-trail-${index}`);
            els.trail.appendChild(node);
        });

        els.top.innerHTML = '';
        if (topCard) els.top.appendChild(this._card(topCard, { faceDown: false }));
    }

    // 座次环:按出牌顺序围一圈小圆标(头像 + 剩牌数 + 名字),当前行动者点亮,只剩一张流光
    _patchRing(state) {
        const els = this._ceEls;
        const order = Array.isArray(state.turnOrder) ? state.turnOrder : [];
        const sig = `${state.roundToken}|${order.join(',')}`;
        if (sig !== this._ringSig) {
            this._ringSig = sig;
            els.ring.innerHTML = '';
            const seats = this._api?.getSeats?.() || [];
            const byId = new Map(seats.map(seat => [seat.id, seat]));
            order.forEach((id, index) => {
                const seat = byId.get(id) || { name: id, avatarHtml: '' };
                const orb = document.createElement('div');
                orb.className = 'pth-ce-orb';
                orb.dataset.pid = id;
                orb.style.setProperty('--a', `${-90 + (360 / Math.max(1, order.length)) * index}deg`);
                const ava = document.createElement('div');
                ava.className = 'ava';
                ava.innerHTML = seat.avatarHtml || this._initial(seat.name);
                const cnt = document.createElement('b');
                cnt.className = 'cnt';
                const nm = document.createElement('span');
                nm.className = 'nm';
                nm.textContent = seat.name || '';
                if (seat.isSelf) orb.classList.add('is-self');
                orb.appendChild(ava);
                orb.appendChild(cnt);
                orb.appendChild(nm);
                const role = document.createElement('span');
                role.className = 'pth-ce-order-role';
                orb.appendChild(role);
                els.ring.appendChild(orb);
            });
        }

        const counts = state.handCounts || {};
        const winners = new Set(state.winnerIds || []);
        const prevCounts = this._ceSnap?.counts || {};
        const inTurns = state.phase === 'PLAYER_TURNS';
        const currentIndex = order.indexOf(state.currentPlayerId);
        const direction = Number(state.direction) < 0 ? -1 : 1;
        const nextId = currentIndex >= 0 ? order[(currentIndex + direction + order.length) % order.length] : '';
        for (const orb of els.ring.querySelectorAll('.pth-ce-orb')) {
            const id = orb.dataset?.pid;
            const count = Number(counts[id] ?? 0);
            const last = count === 1 && state.phase !== 'RESOLVING';
            orb.querySelector('.cnt').textContent = String(count);
            orb.classList.toggle('is-turn', inTurns && state.currentPlayerId === id);
            orb.classList.toggle('is-next', inTurns && nextId === id);
            const role = !inTurns ? '' : state.currentPlayerId === id
                ? this._t('PARLOR.CrazyEights.Order.Current')
                : nextId === id ? this._t('PARLOR.CrazyEights.Order.Next') : '';
            orb.querySelector('.pth-ce-order-role').textContent = role;
            orb.title = [orb.querySelector('.nm').textContent, role].filter(Boolean).join(' · ');
            orb.classList.toggle('is-last', last);
            orb.classList.toggle('is-winner', winners.has(id));
            // 刚落到只剩一张:扫一次亮光,之后留常亮的呼吸流光
            if (last && this._ceSnap && Number(prevCounts[id] ?? 0) > 1) this._flashOnce(orb);
        }
    }

    // 出 8 之后的花色选择器:四枚花色从弃牌堆旁弹出,悬停时徽章跟着预览;
    // 只在"这一步"第一次出现时建一次,后续 refresh 不重建(按钮上有监听)
    _patchPicker(state, hud) {
        const els = this._ceEls;
        const suitActions = (hud?.actions || []).filter(action => action.kind === 'suit');
        if (!suitActions.length || !state.turn?.mustChooseSuit) {
            els.picker.hidden = true;
            els.picker.innerHTML = '';
            this._pickerKey = '';
            return;
        }

        const key = `${state.roundToken}:${state.turnStep}:${state.currentPlayerId}`;
        if (key === this._pickerKey && els.picker.children.length) {
            els.picker.hidden = false;
            return;
        }
        this._pickerKey = key;
        els.picker.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'pth-ce-picker-title';
        title.textContent = this._t('PARLORTAVERN.CrazyEights.ChooseSuit');
        els.picker.appendChild(title);

        const row = document.createElement('div');
        row.className = 'pth-ce-picker-row';
        const restore = () => this._patchCenter(this._ceState || state);
        for (const action of suitActions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `pth-ce-suit-btn${RED_SUITS.has(action.suit) ? ' is-red' : ''}`;
            btn.dataset.suit = action.suit;
            btn.disabled = !!action.disabled;
            btn.innerHTML = `<span class="g">${SUIT_GLYPHS[action.suit] || ''}</span><span class="n">${this._esc(this._suitName(action.suit))}</span>`;
            btn.addEventListener('mouseenter', () => {
                els.suit.dataset.suit = action.suit;
                els.suit.classList.toggle('is-red', RED_SUITS.has(action.suit));
                els.suitGlyph.textContent = SUIT_GLYPHS[action.suit] || '';
            });
            btn.addEventListener('mouseleave', restore);
            btn.addEventListener('click', event => this._runHudAction(action, event, btn, { suit: action.suit }));
            row.appendChild(btn);
        }
        els.picker.appendChild(row);
        els.picker.hidden = false;
    }

    // ── 动作回放(飞牌/翻环/徽章弹跳)──────────────────────

    _replayActions(state, hud) {
        const list = Array.isArray(state.lastActions) ? state.lastActions : [];
        const maxSeq = list.reduce((max, entry) => Math.max(max, Number(entry?.seq || 0)), 0);
        // 首帧不倒放历史(刷新页面/换主题回来不该把上一手再飞一遍)
        if (!this._ceSnap) {
            this._lastSeq = maxSeq;
            return;
        }
        const fresh = list.filter(entry => Number(entry?.seq || 0) > this._lastSeq);
        this._lastSeq = Math.max(this._lastSeq, maxSeq);
        if (!fresh.length) return;

        // 新动作到了,上一批还没落地的幽灵牌直接收掉,别在桌上叠成一串
        this._cancelFlights();
        const ownerId = hud?.ownerId || '';
        let delay = 0;
        for (const entry of fresh) {
            switch (entry.type) {
                case 'deal':
                    this._api?.playSound?.('deal');
                    break;
                case 'play':
                case 'wild':
                    this._flyPlayed(entry, ownerId, delay);
                    delay += 60;
                    break;
                case 'draw':
                case 'penalty':
                    if (entry.participantId && entry.participantId !== ownerId) {
                        delay += this._flyDrawn(entry, delay);
                    }
                    break;
                case 'reverse':
                    this._pulse(this._ceEls.dir, 'is-flip', FLIP_MS);
                    break;
                case 'chooseSuit':
                    this._pulse(this._ceEls.suit, 'is-pop', POP_MS);
                    break;
                default:
                    break;
            }
        }
        this._cePendingPlay = null;
    }

    _flyPlayed(entry, ownerId, delay) {
        const to = this._ceEls.top?.getBoundingClientRect?.();
        if (!to || !entry?.card) return;
        let from = null;
        if (entry.participantId === ownerId && this._cePendingPlay?.rect) from = this._cePendingPlay.rect;
        else from = this._orbRect(entry.participantId);
        if (!from) return;
        this._flyCardGhost({
            card: entry.card,
            from,
            to,
            scale: to.width / Math.max(1, from.width),
            delay,
            rotate: from.left < to.left ? 6 : -6
        });
    }

    _flyDrawn(entry, delay) {
        const from = this._ceEls.pile?.getBoundingClientRect?.();
        const to = this._orbRect(entry.participantId);
        if (!from || !to) return 0;
        const count = Math.max(1, Math.min(MAX_DRAW_GHOSTS, Number(entry.count || 1)));
        for (let i = 0; i < count; i++) {
            this._flyCardGhost({
                card: null,
                faceDown: true,
                from,
                to,
                scale: to.width / Math.max(1, from.width),
                delay: delay + i * 80,
                rotate: -10
            });
        }
        return count * 80;
    }

    _orbRect(participantId) {
        if (!participantId) return null;
        for (const orb of this._ceEls?.ring?.querySelectorAll?.('.pth-ce-orb') || []) {
            if (orb.dataset?.pid === participantId) return orb.getBoundingClientRect?.() || null;
        }
        return this._seatAnchor(participantId)?.getBoundingClientRect?.() || null;
    }

    _pulse(node, className, ms) {
        if (!node) return;
        node.classList.add(className);
        const timer = setTimeout(() => {
            node.classList.remove(className);
            this._timers.delete(timer);
        }, ms);
        this._timers.add(timer);
    }

    _flashOnce(node) {
        this._pulse(node, 'is-flash', FLASH_MS);
    }

    _surfaceSnapshot(state) {
        const counts = {};
        for (const [id, count] of Object.entries(state.handCounts || {})) counts[id] = Number(count || 0);
        const topCard = state.discardTop ? { rank: state.discardTop.rank, suit: state.discardTop.suit } : null;
        return {
            roundToken: state.roundToken || '',
            direction: Number(state.direction) < 0 ? -1 : 1,
            suit: state.currentSuit || '',
            topCard,
            topKey: topCard ? `${state.roundToken}:${Number(state.discardCount || 0)}:${topCard.rank}-${topCard.suit}` : '',
            counts
        };
    }

    // ── 名录:只剩一张的人名字流光,抽屉把手同步发光 ─────────

    _renderRoster(seats) {
        super._renderRoster(seats);
        const state = this._ceState || {};
        const counts = state.handCounts || {};
        const winners = new Set(state.winnerIds || []);
        const resolving = state.phase === 'RESOLVING';
        let anyLast = false;
        for (const row of this._els.roster?.querySelectorAll?.('.prow') || []) {
            const id = row.dataset?.pid;
            const last = !resolving && Number(counts[id] ?? 0) === 1;
            row.classList.toggle('pth-ce-last', last);
            row.classList.toggle('pth-ce-winner', winners.has(id));
            anyLast = anyLast || last;
        }
        this._els.rosterTab?.classList?.toggle('pth-ce-has-last', anyLast);
    }

    // ── 铭文条:牌堆 · 花色 · 方向 · 底池 ───────────────────

    tableStripStatus(state) {
        const bits = [];
        bits.push(`<span>${this._esc(this._t('PARLORTAVERN.CrazyEights.Stock'))} <b>${Number(state.stockCount || 0)}</b></span>`);
        const suit = state.currentSuit || '';
        if (suit) {
            bits.push(`<span>${this._esc(this._t('PARLORTAVERN.CrazyEights.CurrentSuit'))} <b class="pth-ce-ink${RED_SUITS.has(suit) ? ' is-red' : ''}">${SUIT_GLYPHS[suit] || ''}</b></span>`);
        }
        bits.push(`<span>${this._esc(this._t('PARLORTAVERN.CrazyEights.Direction'))} <b>${Number(state.direction) < 0 ? '↺' : '↻'}</b></span>`);
        if (Number(state.pot || 0) > 0) {
            // Table.Pot 是带 {amount} 的句模板,金额直接塞进去(德州同款,不能再包一层转义)
            bits.push(`<span>${this._t('PARLORTAVERN.Table.Pot', { amount: `<b>${this._chips(state.pot)}</b>` })}</span>`);
        }
        return bits;
    }

    // ── 木牌播报:按 lastActions 序号逐条报 ──────────────────

    _heraldSnapshot(state, status) {
        const counts = {};
        for (const [id, count] of Object.entries(state.handCounts || {})) counts[id] = Number(count || 0);
        const actions = (Array.isArray(state.lastActions) ? state.lastActions : []).map(entry => ({
            type: entry?.type || '',
            seq: Number(entry?.seq || 0),
            pid: entry?.participantId || '',
            target: entry?.targetId || '',
            rank: entry?.card?.rank || '',
            suit: entry?.card?.suit || '',
            chosen: entry?.suit || '',
            count: Number(entry?.count || 0),
            auto: !!entry?.autoPass
        }));
        return {
            ...super._heraldSnapshot(state, status),
            lastSeq: actions.reduce((max, entry) => Math.max(max, entry.seq), 0),
            actions,
            counts,
            payout: Number(state.roundResult?.payoutPerWinner || 0)
        };
    }

    _gameHeraldLines(prev, next, newRound) {
        const out = [];
        const fresh = (next.actions || []).filter(entry => entry.seq > Number(prev.lastSeq || 0));
        for (const entry of fresh) {
            const name = this._seatName(entry.pid);
            switch (entry.type) {
                case 'deal':
                    if (!newRound) out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Deal', { count: entry.count }), tone: 'deal' });
                    break;
                case 'play':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Play', { name, card: `${SUIT_GLYPHS[entry.suit] || ''}${entry.rank}` }), tone: 'call' });
                    break;
                case 'wild':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Wild', { name }), tone: 'raise' });
                    break;
                case 'chooseSuit':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Suit', { name, suit: this._suitName(entry.chosen) }), tone: 'raise' });
                    break;
                case 'draw':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Draw', { name }), tone: 'deal' });
                    break;
                case 'pass':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Pass', { name }), tone: 'check' });
                    break;
                case 'penalty':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.DrawTwo', { name, count: entry.count }), tone: 'bust' });
                    break;
                case 'skip':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Skip', { name: this._seatName(entry.target) || name }), tone: 'fold' });
                    break;
                case 'reverse':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Reverse'), tone: 'deal' });
                    break;
                case 'reshuffle':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Reshuffle'), tone: 'deal' });
                    break;
                case 'win':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Win', { name, amount: this._chips(next.payout) }), tone: 'win' });
                    break;
                case 'dead':
                    out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.Dead'), tone: 'lose' });
                    break;
                default:
                    break;
            }
        }
        for (const [id, count] of Object.entries(next.counts || {})) {
            if (count === 1 && Number(prev.counts?.[id] ?? 0) > 1) {
                out.push({ text: this._t('PARLORTAVERN.Herald.CrazyEights.LastCard', { name: this._seatName(id) }), tone: 'allin' });
            }
        }
        return out;
    }

    _suitName(suit) {
        return this._t(`PARLORTAVERN.Suits.${suit}`) || SUIT_GLYPHS[suit] || '';
    }
}
