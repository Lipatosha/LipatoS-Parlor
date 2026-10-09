/**
 * ThreeCardPokerTablePresenter — 奇幻酒馆 · 三张扑克桌
 *
 * 玩家 3 张私牌(HUD)vs 庄家 3 张(垫面,摊牌前扣着)。
 * 摊牌后垫面标注庄家牌型与是否够格(Queen high 起叫)。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE', 'BETTING', 'READY'], labelKey: 'PARLOR.ThreeCardPoker.Center.Phase.Betting' },
    { keys: ['DEALING'], labelKey: 'PARLOR.ThreeCardPoker.Center.Phase.Dealing' },
    { keys: ['DECISION', 'REVEAL_READY'], labelKey: 'PARLOR.ThreeCardPoker.Center.Phase.Decision' },
    { keys: ['SHOWDOWN', 'SETTLE', 'RESOLVING'], labelKey: 'PARLOR.ThreeCardPoker.Center.Phase.Showdown' }
];

// 庄家三张在这些阶段才翻开
const REVEAL_PHASES = ['SHOWDOWN', 'SETTLE', 'RESOLVING'];

const HAND_LABEL_KEYS = Object.freeze({
    'high-card': 'PARLOR.ThreeCardPoker.Hand.HighCard',
    pair: 'PARLOR.ThreeCardPoker.Hand.Pair',
    flush: 'PARLOR.ThreeCardPoker.Hand.Flush',
    straight: 'PARLOR.ThreeCardPoker.Hand.Straight',
    'three-kind': 'PARLOR.ThreeCardPoker.Hand.ThreeKind',
    'straight-flush': 'PARLOR.ThreeCardPoker.Hand.StraightFlush'
});

export class ThreeCardPokerTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.ThreeCardPoker.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.ThreeCardPoker'; }
    get gameGlyph() { return '♣'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    _formatDealerRank(rank) {
        if (typeof rank === 'string') return rank;
        if (!rank?.category) return '';
        const key = rank.isMiniRoyal
            ? 'PARLOR.ThreeCardPoker.Hand.MiniRoyal'
            : HAND_LABEL_KEYS[rank.category];
        return this._t(key || 'PARLOR.ThreeCardPoker.Hand.Unknown');
    }

    // 垫面只留庄家三张和牌型。牌归属在吊牌/HUD 已经明确，别再往绒面上刻一层“庄”。
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';

        const reveal = REVEAL_PHASES.includes(state.phase);
        const hand = state.dealerHand || [];
        const cards = hand.length
            ? hand.map(card => ({ card, faceDown: !reveal }))
            : [null, null, null];

        let total = '';
        if (reveal && hand.length) {
            // dealerRank 是牌型对象，必须先匹配语言键，直接 String() 就会漏成 [object Object]。
            total = this._formatDealerRank(state.dealerRank);
            if (state.dealerQualified === false) {
                total = `${total}${total ? ' · ' : ''}${this._t('PARLOR.ThreeCardPoker.Badge.DealerNotQualified') || this._t('PARLORTAVERN.Labels.DealerNotQualified')}`;
            }
        }

        const row = document.createElement('div');
        row.className = 'pth-duelrow';
        row.appendChild(this._duelGroup({
            label: '',
            cards,
            total,
            dealZone: 'dealer'
        }));
        host.appendChild(row);
    }

    tableStripStatus(_state) {
        const s = this._api?.getStatus?.() || {};
        return s.phase ? [`<span>${this._esc(s.phase)}</span>`] : [];
    }

    // ── 木牌播报:底注归基类,这里报跟/弃和庄家够不够格 ──
    _heraldSnapshot(state, status) {
        return {
            ...super._heraldSnapshot(state, status),
            dealerRank: this._formatDealerRank(state.dealerRank),
            // 未开牌时是 null/undefined,归一成空串,才不会一进桌就误报"够格"
            qualified: state.dealerQualified === undefined || state.dealerQualified === null
                ? '' : String(!!state.dealerQualified)
        };
    }

    _gameHeraldLines(prev, next, newRound) {
        const out = [];
        if (!newRound) {
            for (const [id, bet] of Object.entries(next.bets || {})) {
                const before = prev.bets?.[id];
                if (!before || before.decision === bet.decision) continue;
                const name = this._seatName(id);
                if (!name) continue;
                if (bet.decision === 'play') out.push({ text: this._t('PARLORTAVERN.Herald.Play', { name }), tone: 'raise' });
                if (bet.decision === 'fold') out.push({ text: this._t('PARLORTAVERN.Herald.Fold', { name }), tone: 'fold' });
            }
        }
        if (next.qualified && next.qualified !== prev.qualified) {
            const dealer = this._t('PARLORTAVERN.Labels.Dealer');
            out.push(next.qualified === 'true'
                ? { text: this._t('PARLORTAVERN.Herald.DealerHand', { name: dealer, hand: next.dealerRank }), tone: 'deal' }
                : { text: this._t('PARLORTAVERN.Herald.DealerNotQualified', { name: dealer }), tone: 'stand' });
        }
        return out;
    }
}
