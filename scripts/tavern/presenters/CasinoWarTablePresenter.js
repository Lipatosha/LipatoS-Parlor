/**
 * CasinoWarTablePresenter — 奇幻酒馆 · 赌场战争桌
 *
 * 玩家一张 vs 庄家一张,平局可"开战"加牌。垫面 = 庄家牌 +(开战时)战争加牌;
 * 玩家自己的牌走 HUD(per-player,在 playerStates 里,由 getHud 递)。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE', 'BETTING', 'READY'], labelKey: 'PARLOR.CasinoWar.Center.Phase.Betting' },
    { keys: ['DEALING'], labelKey: 'PARLOR.CasinoWar.Center.Phase.Dealing' },
    { keys: ['SHOWDOWN'], labelKey: 'PARLOR.CasinoWar.Center.Phase.Showdown' },
    { keys: ['WAR'], labelKey: 'PARLOR.CasinoWar.Center.Phase.War' },
    { keys: ['SETTLE', 'RESOLVING'], labelKey: 'PARLOR.CasinoWar.Center.Phase.Settle' }
];

export class CasinoWarTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.CasinoWar.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.CasinoWar'; }
    get gameGlyph() { return '⚔'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 垫面:庄家牌居中;WAR 阶段追加庄家的战争牌组。玩家各自的牌在 HUD,不铺桌面
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';

        const row = document.createElement('div');
        row.className = 'pth-duelrow';
        row.appendChild(this._duelGroup({
            label: this._t('PARLOR.Common.Dealer') || this._t('PARLORTAVERN.Labels.Dealer'),
            cards: [state.dealerCard || null],
            dealZone: 'dealer'
        }));
        const warCards = state.dealerWarCards || [];
        if (warCards.length) {
            const vs = document.createElement('div');
            vs.className = 'pth-vs';
            vs.textContent = '⚔';
            row.appendChild(vs);
            row.appendChild(this._duelGroup({
                label: this._t('PARLOR.CasinoWar.Center.Phase.War') || this._t('PARLORTAVERN.Labels.War'),
                cards: warCards,
                dealZone: 'war'
            }));
        }
        host.appendChild(row);
    }

    tableStripStatus(_state) {
        const s = this._api?.getStatus?.() || {};
        return s.phase ? [`<span>${this._esc(s.phase)}</span>`] : [];
    }

    // ── 木牌播报:下注归基类,这里报开战/投降/输赢 ──
    _heraldSnapshot(state, status) {
        const seats = {};
        for (const [id, seat] of Object.entries(state.playerStates || {})) {
            seats[id] = seat?.status || '';
        }
        return { ...super._heraldSnapshot(state, status), seats };
    }

    _gameHeraldLines(prev, next, newRound) {
        if (newRound) return [];
        const out = [];
        for (const [id, status] of Object.entries(next.seats)) {
            const before = prev.seats?.[id];
            if (before === undefined || before === status) continue;
            const name = this._seatName(id);
            if (!name) continue;
            switch (status) {
                case 'war': out.push({ text: this._t('PARLORTAVERN.Herald.War', { name }), tone: 'allin' }); break;
                case 'surrender': out.push({ text: this._t('PARLORTAVERN.Herald.Surrender', { name }), tone: 'fold' }); break;
                case 'win': case 'war-win': out.push({ text: this._t('PARLORTAVERN.Herald.Beats', { name }), tone: 'win' }); break;
                case 'lose': case 'war-lose': out.push({ text: this._t('PARLORTAVERN.Herald.Beaten', { name }), tone: 'lose' }); break;
                case 'war-push': out.push({ text: this._t('PARLORTAVERN.Herald.Push', { name }), tone: 'stand' }); break;
                default: break;
            }
        }
        return out;
    }
}
