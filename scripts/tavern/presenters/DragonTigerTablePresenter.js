/**
 * DragonTigerTablePresenter — 奇幻酒馆 · 龙虎桌
 *
 * 最纯粹的对峙:龙一张 vs 虎一张,比大小。垫面 = 两张牌对峙,开牌后胜方镶金。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE', 'BETTING', 'READY'], labelKey: 'PARLOR.DragonTiger.Center.Phase.Betting' },
    { keys: ['DEALING'], labelKey: 'PARLOR.DragonTiger.Center.Phase.Dealing' },
    { keys: ['SHOWDOWN'], labelKey: 'PARLOR.DragonTiger.Center.Phase.Showdown' },
    { keys: ['SETTLE', 'RESOLVING'], labelKey: 'PARLOR.DragonTiger.Center.Phase.Settle' }
];

export class DragonTigerTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.DragonTiger.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.DragonTiger'; }
    get gameGlyph() { return '🐲'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 垫面:龙 vs 虎各一张;未发牌给背面占位
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';

        const row = document.createElement('div');
        row.className = 'pth-duelrow';
        row.appendChild(this._duelGroup({
            label: this._t('PARLOR.DragonTiger.Side.Dragon') || this._t('PARLORTAVERN.Labels.Dragon'),
            cards: [state.dragonCard || null],
            win: state.winner === 'dragon',
            dealZone: 'dragon'
        }));
        const vs = document.createElement('div');
        vs.className = 'pth-vs';
        vs.textContent = 'VS';
        row.appendChild(vs);
        row.appendChild(this._duelGroup({
            label: this._t('PARLOR.DragonTiger.Side.Tiger') || this._t('PARLORTAVERN.Labels.Tiger'),
            cards: [state.tigerCard || null],
            win: state.winner === 'tiger',
            dealZone: 'tiger'
        }));
        host.appendChild(row);
    }

    tableStripStatus(_state) {
        const s = this._api?.getStatus?.() || {};
        return s.phase ? [`<span>${this._esc(s.phase)}</span>`] : [];
    }

    // ── 木牌播报:下注归基类,这里只报谁赢 ──
    _betSideLabel(side) {
        if (side === 'dragon') return this._t('PARLOR.DragonTiger.Side.Dragon') || this._t('PARLORTAVERN.Labels.Dragon');
        if (side === 'tiger') return this._t('PARLOR.DragonTiger.Side.Tiger') || this._t('PARLORTAVERN.Labels.Tiger');
        if (side === 'tie') return this._t('PARLOR.Common.Tie');
        return '';
    }

    _heraldSnapshot(state, status) {
        return { ...super._heraldSnapshot(state, status), winner: state.winner || '' };
    }

    _gameHeraldLines(prev, next) {
        if (!next.winner || next.winner === prev.winner) return [];
        return next.winner === 'tie'
            ? [{ text: this._t('PARLOR.Common.Tie'), tone: 'stand' }]
            : [{ text: this._t('PARLORTAVERN.Herald.SideWin', { side: this._betSideLabel(next.winner) }), tone: 'win' }];
    }
}
