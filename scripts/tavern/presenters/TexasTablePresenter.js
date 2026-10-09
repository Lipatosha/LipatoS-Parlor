/**
 * TexasTablePresenter — 奇幻酒馆 · 德州扑克桌
 *
 * 壳(招牌/播报牌/桌台/HUD/背景)全在 TavernTableShell;本类只填德州特有的:
 * 阶段灯的四条街、垫面公共牌、铭文条的底池/当前注、木牌上的牌局播报。
 */

import { TavernTableShell } from './TavernTableShell.js';

// 德州四条街,phasebar 阶段灯按 state.street 点亮
const STREETS = [
    { key: 'preflop', labelKey: 'PARLOR.TexasHoldem.Street.Preflop' },
    { key: 'flop', labelKey: 'PARLOR.TexasHoldem.Street.Flop' },
    { key: 'turn', labelKey: 'PARLOR.TexasHoldem.Street.Turn' },
    { key: 'river', labelKey: 'PARLOR.TexasHoldem.Street.River' }
];

// 播报语气:决定木牌上那一行的符号和颜色
const ACTION_TONE = {
    fold: 'fold',
    check: 'check',
    call: 'call',
    raise: 'raise',
    'all-in': 'allin'
};

export class TexasTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.TexasHoldem.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.TexasHoldem'; }
    get gameGlyph() { return '♠'; }
    get phases() { return STREETS; }

    phaseProgress(state) {
        const active = STREETS.findIndex(s => s.key === state.street);
        // showdown 时四街全亮;否则当前街之前的都算 done
        return { active, done: state.street === 'showdown' ? STREETS.length : active };
    }

    // 垫面中央:五张公共牌位(已发的正面走 renderCard,未发的翻面占位)
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';
        const community = Array.isArray(state.communityCards) ? state.communityCards : [];
        const row = document.createElement('div');
        row.className = 'cards-row';
        const dealt = [];
        for (let i = 0; i < 5; i++) {
            const card = community[i] || null;
            const el = this._card(card, { faceDown: !card });
            row.appendChild(el);
            if (card) dealt.push(el);
        }
        host.appendChild(row);
        this._dealNew('board', dealt);
    }

    // ── 木牌播报 ────────────────────────────────────────────
    //
    // 快照里全是原始值:playerStates 是活引用,直接留到下一帧对比等于自己跟自己比。
    // seat.updatedAt 只在真出手时才动(换街清 streetCommitted 不动它),拿它当"这人刚行动过"的判据最稳
    _heraldSnapshot(state, status) {
        const seats = {};
        for (const [id, seat] of Object.entries(state.playerStates || {})) {
            seats[id] = {
                at: Number(seat.updatedAt || 0),
                act: seat.lastAction || '',
                street: Number(seat.streetCommitted || 0),
                status: seat.status || '',
                result: seat.result || ''
            };
        }
        return {
            ...super._heraldSnapshot(state, status),
            hand: Number(state.handNumber || 0),
            street: state.street || '',
            bet: Number(state.currentBet || 0),
            sbId: state.smallBlindId || '',
            bbId: state.bigBlindId || '',
            buttonId: state.dealerButtonId || '',
            smallBlind: Number(state.smallBlind || 0),
            bigBlind: Number(state.bigBlind || 0),
            resultKind: state.roundResult?.kind || '',
            uncontestedId: state.roundResult?.winnerId || '',
            uncontestedPot: Number(state.roundResult?.pot || 0),
            payouts: { ...(state.payouts || {}) },
            seats
        };
    }

    // 开新局:局号 → 庄位 → 两家盲注,比基类那句"第 N 局 · 盲注 5/10"说得清是谁在出钱
    _roundOpenLines(next) {
        const out = [{ text: next.round || '', tone: 'round' }];
        if (next.buttonId) {
            out.push({ text: this._t('PARLORTAVERN.Herald.Button', { name: this._seatName(next.buttonId) }), tone: 'deal' });
        }
        const blinds = [
            next.sbId ? this._t('PARLORTAVERN.Herald.SmallBlind', { name: this._seatName(next.sbId), amount: this._chips(next.smallBlind) }) : '',
            next.bbId ? this._t('PARLORTAVERN.Herald.BigBlind', { name: this._seatName(next.bbId), amount: this._chips(next.bigBlind) }) : ''
        ].filter(Boolean);
        if (blinds.length) out.push({ text: blinds.join(' · '), tone: 'blind' });
        return out;
    }

    _gameHeraldLines(prev, next, newRound) {
        const out = [];
        if (!newRound) {
            for (const [id, seat] of Object.entries(next.seats)) {
                const before = prev.seats?.[id];
                if (!before || before.at === seat.at) continue;
                const line = this._actionLine(id, before, seat, prev);
                if (line) out.push(line);
            }
            if (next.street !== prev.street && next.street !== 'preflop') {
                out.push({ text: this._streetLabel(next.street), tone: 'deal' });
            }
        }
        if (next.resultKind && !prev.resultKind) out.push(...this._resultLines(next));
        return out;
    }

    // 一位玩家刚出的手。lastAction 是本体明确写下的动作名,不用靠金额猜
    _actionLine(id, before, seat, prev) {
        const name = this._seatName(id);
        if (!name) return null;
        const tone = ACTION_TONE[seat.act] || '';
        // 同街内 street 只增不减;跨街本体会清零,这时 before.street 已是 0,delta 即本街投入
        const delta = Math.max(0, seat.street - before.street);

        switch (seat.act) {
            case 'fold':
                return { text: this._t('PARLORTAVERN.Herald.Fold', { name }), tone };
            case 'check':
                return { text: this._t('PARLORTAVERN.Herald.Check', { name }), tone };
            case 'call':
                return { text: this._t('PARLORTAVERN.Herald.Call', { name, amount: this._chips(delta) }), tone };
            case 'raise':
                // 本街还没人开火 = 下注;已有当前注 = 加注到某个数
                return {
                    text: prev.bet > 0
                        ? this._t('PARLORTAVERN.Herald.RaiseTo', { name, amount: this._chips(seat.street) })
                        : this._t('PARLORTAVERN.Herald.Bet', { name, amount: this._chips(delta) }),
                    tone
                };
            case 'all-in':
                return { text: this._t('PARLORTAVERN.Herald.AllIn', { name, amount: this._chips(delta) }), tone };
            default:
                return null;
        }
    }

    _resultLines(next) {
        if (next.resultKind === 'uncontested') {
            return [{
                text: this._t('PARLORTAVERN.Herald.Win', {
                    name: this._seatName(next.uncontestedId),
                    amount: this._chips(next.uncontestedPot)
                }),
                tone: 'win'
            }];
        }
        const winners = Object.entries(next.seats)
            .filter(([, seat]) => seat.result === 'win')
            .map(([id]) => ({
                text: this._t('PARLORTAVERN.Herald.Win', {
                    name: this._seatName(id),
                    amount: this._chips(next.payouts?.[id] || 0)
                }),
                tone: 'win'
            }));
        return winners.length ? winners : [{ text: this._t('PARLOR.TexasHoldem.Street.Showdown'), tone: 'win' }];
    }

    _streetLabel(street) {
        const key = String(street || '').charAt(0).toUpperCase() + String(street || '').slice(1);
        return this._t(`PARLOR.TexasHoldem.Street.${key}`) || '';
    }

    // 铭文条:底池 · 街 · 当前注。键值带 {amount} 占位,金额用 <b> 包住走 innerHTML 保留金色粗体
    tableStripStatus(state) {
        const pot = (state.pots || []).reduce((sum, p) => sum + Number(p?.amount || 0), 0);
        const streetKey = STREETS.find(s => s.key === state.street)?.labelKey || 'PARLOR.TexasHoldem.Street.Preflop';
        const potData = { amount: `<b>${this._chips(pot)}</b>` };
        const betData = { amount: `<b>${this._chips(state.currentBet)}</b>` };
        const potStr = this._t('PARLOR.TexasHoldem.Table.Pot', potData) || this._t('PARLORTAVERN.Table.Pot', potData);
        const betStr = this._t('PARLOR.TexasHoldem.Table.CurrentBet', betData) || this._t('PARLORTAVERN.Table.CurrentBet', betData);
        return [
            `<span>${potStr}</span>`,
            `<span>${this._esc(this._t(streetKey))}</span>`,
            Number(state.currentBet) ? `<span>${betStr}</span>` : ''
        ];
    }
}
