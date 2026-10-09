/**
 * BaccaratTablePresenter — 奇幻酒馆 · 百家乐桌
 *
 * 壳全在 TavernTableShell;百家乐是"闲庄两副公共手牌 + 玩家下注"模型,
 * 垫面 = 闲/庄对峙牌组 + 点数,开牌后胜方镶金。玩家的注在名录/HUD 走 gameApi。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE', 'BETTING', 'READY'], labelKey: 'PARLOR.Baccarat.Center.Phase.Betting' },
    { keys: ['DEALING'], labelKey: 'PARLOR.Baccarat.Center.Phase.Dealing' },
    { keys: ['SHOWDOWN', 'DRAW_RULES', 'DRAWING', 'FINAL_SHOWDOWN'], labelKey: 'PARLOR.Baccarat.Center.Phase.Showdown' },
    { keys: ['SETTLE', 'RESOLVING'], labelKey: 'PARLOR.Baccarat.Center.Phase.Settle' }
];

export class BaccaratTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.Baccarat.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.Baccarat'; }
    get gameGlyph() { return '✦'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 垫面:闲(PLAYER)vs 庄(BANKER)两组公共手牌 + 各自点数;winner 判定后胜方镶金
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';

        const row = document.createElement('div');
        row.className = 'pth-duelrow';
        const dealt = state.phase && !['IDLE', 'BETTING', 'READY'].includes(state.phase);
        const playerCards = (state.playerHand || []).length ? state.playerHand : (dealt ? [] : [null, null]);
        const bankerCards = (state.bankerHand || []).length ? state.bankerHand : (dealt ? [] : [null, null]);

        row.appendChild(this._duelGroup({
            label: this._t('PARLOR.Baccarat.Side.Player') || this._t('PARLORTAVERN.Labels.BaccaratPlayer'),
            labelVariant: 'plaque',
            cards: playerCards,
            total: (state.playerHand || []).length ? state.playerTotal ?? '' : '',
            win: state.winner === 'player',
            dealZone: 'player'
        }));
        const vs = document.createElement('div');
        vs.className = 'pth-vs';
        vs.textContent = 'VS';
        row.appendChild(vs);
        row.appendChild(this._duelGroup({
            label: this._t('PARLOR.Baccarat.Side.Banker') || this._t('PARLORTAVERN.Labels.BaccaratBanker'),
            labelVariant: 'plaque',
            cards: bankerCards,
            total: (state.bankerHand || []).length ? state.bankerTotal ?? '' : '',
            win: state.winner === 'banker',
            dealZone: 'banker'
        }));
        host.appendChild(row);
    }

    tableStripStatus(_state) {
        const s = this._api?.getStatus?.() || {};
        return s.phase ? [`<span>${this._esc(s.phase)}</span>`] : [];
    }

    // ── 木牌播报:下注归基类,这里只报开牌结果 ──
    _betSideLabel(side) {
        if (side === 'player') return this._t('PARLOR.Baccarat.Side.Player') || this._t('PARLORTAVERN.Labels.BaccaratPlayer');
        if (side === 'banker') return this._t('PARLOR.Baccarat.Side.Banker') || this._t('PARLORTAVERN.Labels.BaccaratBanker');
        if (side === 'tie') return this._t('PARLOR.Common.Tie');
        return '';
    }

    _heraldSnapshot(state, status) {
        return {
            ...super._heraldSnapshot(state, status),
            winner: state.winner || '',
            playerTotal: Number(state.playerTotal || 0),
            bankerTotal: Number(state.bankerTotal || 0)
        };
    }

    _gameHeraldLines(prev, next) {
        if (!next.winner || next.winner === prev.winner) return [];
        const score = this._t('PARLOR.Baccarat.Center.FinalScore', {
            playerTotal: next.playerTotal,
            bankerTotal: next.bankerTotal
        });
        const verdict = next.winner === 'tie'
            ? this._t('PARLOR.Common.Tie')
            : this._t('PARLORTAVERN.Herald.SideWin', { side: this._betSideLabel(next.winner) });
        return [
            score ? { text: score, tone: 'deal' } : null,
            { text: verdict, tone: next.winner === 'tie' ? 'stand' : 'win' }
        ].filter(Boolean);
    }
}
