/**
 * BlackjackTablePresenter — 奇幻酒馆 · 二十一点桌
 *
 * 壳全在 TavernTableShell;本类只填 21点特有的:
 * 阶段灯(8 内部态映射成 下注/发牌/行动/结算 4 显示态)、垫面庄家手牌、铭文条。
 * 玩家手牌/操作(要牌/停牌/加倍/下注)走 gameApi.getHud,由基类统一渲染。
 */

import { TavernTableShell } from './TavernTableShell.js';

// 8 个内部阶段折叠成 4 盏阶段灯;labelKey 缺失时用 label 中文兜底
const PHASES = [
    { keys: ['IDLE', 'BETTING', 'READY'], labelKey: 'PARLOR.Blackjack.Center.Phase.Betting' },
    { keys: ['DEALING'], labelKey: 'PARLOR.Blackjack.Center.Phase.Dealing' },
    { keys: ['PLAYER_TURNS', 'DEALER_TURN'], labelKey: 'PARLOR.Blackjack.Center.Phase.Action' },
    { keys: ['SETTLE', 'RESOLVING'], labelKey: 'PARLOR.Blackjack.Center.Phase.Settle' }
];

// 庄家暗牌(第 2 张)在这些阶段揭示,镜像原生 BlackjackTable._renderDealerCards 的逻辑
const REVEAL_PHASES = ['DEALER_TURN', 'RESOLVING', 'SETTLE'];

export class BlackjackTablePresenter extends TavernTableShell {
    constructor() {
        super();
        this._lastSurfaceState = null;
        this._tableHitZoneKey = '';
    }

    get gameNameKey() { return 'PARLOR.Games.Blackjack.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.Blackjack'; }
    get gameGlyph() { return '♠'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 顶部只放"庄 X 点"紧凑徽章——庄家手牌在下方 HUD 托盘已显示,不必两处重复;做小、不占地方。
    // 明面点数:揭示(DEALER_TURN 起)前不计暗牌(index 1),末尾 + 号提示还有暗牌未翻。
    renderSurface(state) {
        this._playCollectedTableCards(state);
        if (this._els.surface) {
            this._els.surface.innerHTML = '';
            if (!this._renderDealerTableCards(state)) {
                this._renderPlayerTableCards(state);
            }
        }

        const zone = this._els.topZone;
        if (zone) {
            const dh = state.dealerHand || {};
            const cards = [...(dh.handCards || []), ...(dh.tableCards || [])];
            const reveal = REVEAL_PHASES.includes(state.phase);
            const shown = reveal ? cards : cards.filter((_, i) => i !== 1);
            const total = this._bjTotal(shown);
            const hidden = !reveal && cards.length > 1;
            zone.innerHTML = cards.length ? `
                <div class="pth-dealer pth-dealer-mini">
                    <div class="pth-dealer-crest">${this._esc(this._t('PARLORTAVERN.Labels.DealerMark'))}</div>
                    <div class="pth-dealer-total"><b>${total}${hidden ? '<em>+</em>' : ''}</b><small>${this._esc(this._t('PARLORTAVERN.Blackjack.DealerSummary'))}</small></div>
                </div>` : '';
        }

        this._lastSurfaceState = this._surfaceSnapshot(state);
    }

    // ── 木牌播报 ────────────────────────────────────────────
    //
    // 21点没有"上一步动作"这种字段,靠手牌状态 + 牌数变化倒推。快照必须全是原始值:
    // playerHands 是 state 上的活引用,原样留到下一帧再比等于自己跟自己比
    _heraldSnapshot(state, status) {
        const hands = {};
        for (const [id, hand] of Object.entries(state.playerHands || {})) {
            hands[id] = {
                status: hand?.status || '',
                cards: (hand?.handCards?.length || 0) + (hand?.tableCards?.length || 0),
                bet: Number(hand?.bet || 0)
            };
        }
        const dealer = state.dealerHand || {};
        return {
            ...super._heraldSnapshot(state, status),
            round: status.round || '',
            phase: state.phase || '',
            dealerStatus: dealer.status || '',
            payouts: { ...(state.payouts || {}) },
            hands
        };
    }

    // 下注走基类的 bets 通道,这里只管发牌后的动作
    _gameHeraldLines(prev, next, newRound) {
        const out = [];
        if (newRound) return out;

        for (const [id, hand] of Object.entries(next.hands)) {
            const before = prev.hands?.[id];
            if (!before) continue;
            const name = this._seatName(id);
            if (!name) continue;

            if (hand.status === before.status) {
                // 状态没变但多了牌 = 补牌落袋,报一句免得玩家不知道自己拿到第几张
                if (hand.cards > before.cards && hand.status === 'playing') {
                    out.push({ text: this._t('PARLORTAVERN.Herald.Draw', { name }), tone: 'deal' });
                }
                continue;
            }
            switch (hand.status) {
                case 'awaiting_deal': out.push({ text: this._t('PARLORTAVERN.Herald.Hit', { name }), tone: 'call' }); break;
                case 'stand': out.push({ text: this._t('PARLORTAVERN.Herald.Stand', { name }), tone: 'stand' }); break;
                case 'bust': out.push({ text: this._t('PARLORTAVERN.Herald.Bust', { name }), tone: 'bust' }); break;
                case 'blackjack': out.push({ text: this._t('PARLORTAVERN.Herald.Natural', { name }), tone: 'natural' }); break;
                default: break;
            }
        }

        if (next.dealerStatus !== prev.dealerStatus) {
            const dealer = this._t('PARLORTAVERN.Labels.Dealer');
            if (next.dealerStatus === 'bust') out.push({ text: this._t('PARLORTAVERN.Herald.Bust', { name: dealer }), tone: 'bust' });
            if (next.dealerStatus === 'stand') out.push({ text: this._t('PARLORTAVERN.Herald.Stand', { name: dealer }), tone: 'stand' });
        }

        return out;
    }

    // 21点点数:JQK=10,A=11 超 21 再降为 1。纯显示用(引擎另有权威判定),庄家棚上标"庄 X 点"
    _bjTotal(cards) {
        let total = 0;
        let aces = 0;
        for (const c of cards) {
            const r = String(c?.rank ?? '');
            if (['J', 'Q', 'K'].includes(r)) total += 10;
            else if (r === 'A') { total += 11; aces += 1; }
            else total += Number(r) || 0;
        }
        while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
        return total;
    }

    _renderPlayerTableCards(state) {
        const participantId = state.currentPlayerId || '';
        const zoneKey = participantId ? `blackjack-hit:${participantId}` : '';
        const hand = participantId ? state.playerHands?.[participantId] : null;
        const tableCards = state.phase === 'PLAYER_TURNS' ? (hand?.tableCards || []) : [];
        if (!tableCards.length) {
            if (this._tableHitZoneKey) this._dealNew(this._tableHitZoneKey, []);
            this._tableHitZoneKey = '';
            return;
        }

        if (this._tableHitZoneKey && this._tableHitZoneKey !== zoneKey) {
            this._dealNew(this._tableHitZoneKey, []);
        }
        this._tableHitZoneKey = zoneKey;

        const holder = document.createElement('div');
        holder.className = 'pth-bj-table-hit cards-row';
        this._prepareTableCardHolder(holder);
        const dealt = [];
        tableCards.forEach(card => {
            const el = this._card(card, { faceDown: false });
            el.classList?.add('pth-bj-table-card');
            el.style.pointerEvents = 'auto';
            holder.appendChild(el);
            dealt.push(el);
        });
        this._els.surface.appendChild(holder);
        this._dealNew(zoneKey, dealt);
    }

    _renderDealerTableCards(state) {
        if (state.phase !== 'DEALER_TURN') {
            this._dealNew('blackjack-dealer', []);
            return false;
        }

        const dealerHand = state.dealerHand || {};
        const cards = [...(dealerHand.handCards || []), ...(dealerHand.tableCards || [])];
        if (!cards.length) {
            this._dealNew('blackjack-dealer', []);
            return false;
        }

        if (this._tableHitZoneKey) {
            this._dealNew(this._tableHitZoneKey, []);
            this._tableHitZoneKey = '';
        }

        const holder = document.createElement('div');
        holder.className = 'pth-bj-dealer-table cards-row';
        this._prepareTableCardHolder(holder);
        const dealt = [];
        cards.forEach(card => {
            const el = this._card(card, { faceDown: false });
            el.classList?.add('pth-bj-table-card');
            el.style.pointerEvents = 'auto';
            holder.appendChild(el);
            dealt.push(el);
        });
        this._els.surface.appendChild(holder);
        this._dealNew('blackjack-dealer', dealt);
        return true;
    }

    _prepareTableCardHolder(holder) {
        holder.style.padding = '0';
        holder.style.background = 'none';
        holder.style.border = '0';
        holder.style.boxShadow = 'none';
        holder.style.pointerEvents = 'none';
    }

    _playCollectedTableCards(state) {
        const prev = this._lastSurfaceState;
        if (!prev || prev.phase !== 'PLAYER_TURNS' || !prev.currentPlayerId) return;

        const participantId = prev.currentPlayerId;
        const prevHand = prev.playerHands?.[participantId];
        const nextHand = state.playerHands?.[participantId];
        const prevHandCards = prevHand?.handCards || [];
        const prevTableCards = prevHand?.tableCards || [];
        const nextHandCards = nextHand?.handCards || [];
        if (!prevHand || !nextHand || !prevTableCards.length) return;

        const delta = Math.min(prevTableCards.length, nextHandCards.length - prevHandCards.length);
        if (delta <= 0) return;

        const sourceEls = [...(this._els.surface?.querySelectorAll('.pth-bj-table-card') || [])].slice(-delta);
        const cards = nextHandCards.slice(-delta);
        const target = this._flightTargetFor(participantId);
        if (!target) return;

        if (target.kind === 'hud') {
            // 中央牌已经飞进 HUD 了,这里先推进计数,免得手牌区再从上方重播一次。
            this._dealCounts.hand = Math.max(this._dealCounts.hand ?? 0, nextHandCards.length);
        }

        sourceEls.forEach((source, index) => {
            this._animateCardFlight(cards[index], source, target.node, target.kind, index);
        });
    }

    _flightTargetFor(participantId) {
        const hud = this._api?.getHud?.() || null;
        if (hud?.ownerId === participantId && this._els.hudMid) {
            return { node: this._els.hudMid.querySelector?.('.hand') || this._els.hudMid, kind: 'hud' };
        }

        const anchor = this._seatAnchor(participantId);
        return anchor ? { node: anchor, kind: 'seat' } : null;
    }

    _animateCardFlight(card, source, target, kind, index) {
        if (!card) return;
        const from = source?.getBoundingClientRect?.();
        const to = target?.getBoundingClientRect?.();
        if (!from || !to) return;

        const ghost = this._card(card, { faceDown: false });
        ghost.classList?.add('pth-bj-card-flight');
        ghost.style.position = 'fixed';
        ghost.style.left = `${from.left}px`;
        ghost.style.top = `${from.top}px`;
        ghost.style.width = `${from.width}px`;
        ghost.style.height = `${from.height}px`;
        ghost.style.margin = '0';
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '100001';
        ghost.style.opacity = '0.98';
        ghost.style.transition = 'transform 560ms cubic-bezier(.18,1,.22,1), opacity 520ms ease';
        document.body?.appendChild(ghost);

        const fromCx = from.left + from.width / 2;
        const fromCy = from.top + from.height / 2;
        const toCx = to.left + to.width / 2;
        const toCy = to.top + to.height / 2;
        const moveX = toCx - fromCx;
        const moveY = toCy - fromCy;
        const scale = kind === 'hud' ? 0.72 : 0.42;
        const rotate = moveX < 0 ? -8 : 8;
        const delay = index * 90;

        setTimeout(() => {
            requestAnimationFrame(() => {
                ghost.style.transform = `translate(${moveX}px, ${moveY}px) scale(${scale}) rotate(${rotate}deg)`;
                ghost.style.opacity = '0.08';
            });
        }, delay);
        setTimeout(() => ghost.remove(), 660 + delay);
    }

    _surfaceSnapshot(state) {
        const playerHands = {};
        for (const [participantId, hand] of Object.entries(state.playerHands || {})) {
            playerHands[participantId] = {
                handCards: [...(hand?.handCards || [])],
                tableCards: [...(hand?.tableCards || [])]
            };
        }
        return {
            phase: state.phase,
            currentPlayerId: state.currentPlayerId || '',
            playerHands
        };
    }

    // 铭文条:游戏名后补当前阶段(庄家/轮次细节在链吊匾)
    tableStripStatus(state) {
        const s = this._api?.getStatus?.() || {};
        void state;
        return s.phase ? [`<span>${this._esc(s.phase)}</span>`] : [];
    }
}
