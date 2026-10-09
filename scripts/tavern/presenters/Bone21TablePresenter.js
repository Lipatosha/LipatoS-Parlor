/**
 * Bone21TablePresenter — 奇幻酒馆 · 骨骰21桌
 *
 * 骰子版 21 点:两颗私骰打底,轮流加骰,未爆且最接近 21 者胜。
 * 自己的骰子(私+公)与牌力在 HUD(shell 的 diceValues/strength);
 * 垫面聚焦当前行动者的公开加骰;3D 骰子(DSN)由本体照飞,呈现器画落定后的静态骰。
 */

import { TavernTableShell } from './TavernTableShell.js';

const PHASES = [
    { keys: ['IDLE', 'BETTING'], labelKey: 'PARLOR.Bone21.Phase.Betting' },
    { keys: ['ROLLING'], labelKey: 'PARLOR.Bone21.Phase.Rolling' },
    { keys: ['PLAYER_TURNS'], labelKey: 'PARLOR.Bone21.Phase.PlayerTurns' },
    { keys: ['RESOLVING'], labelKey: 'PARLOR.Bone21.Phase.Resolving' }
];

export class Bone21TablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.Bone21.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.Bone21'; }
    get gameGlyph() { return '⚅'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 骰子操作不能继承纸牌桌的落牌声，DSN 自己会负责掷骰反馈。
    actionSoundKind() { return ''; }

    // 垫面只放当前行动者已经公开的加骰。姓名和总点 HUD 里本来就有，
    // 再压在骰子上下既像说明牌，也会让桌面中心更难读。
    renderSurface(state) {
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';
        this._syncRevealPanel(state);
        if (state.phase === 'RESOLVING') return;

        const focusId = state.phase === 'PLAYER_TURNS' ? state.currentPlayerId : '';
        const seat = focusId ? state.playerStates?.[focusId] : null;
        if (!seat) return;
        host.appendChild(this._dieRow(seat.dice || []));
    }

    // 摊牌弹窗:一人一行(名字|全部骰子|真实总点|盈亏),胜者镶金、爆牌标 ✕ 压灰;
    // 人多滚动。RESOLVING 进入时挂到 root,离开时移除(newRound 后自动消失)
    _syncRevealPanel(state) {
        const existing = this._root?.querySelector('.pth-reveal');
        if (state.phase !== 'RESOLVING') {
            existing?.remove();
            return;
        }

        const order = Array.isArray(state.turnOrder) && state.turnOrder.length ? state.turnOrder : (state.playerIds || []);
        const rows = order.map(id => {
            const seat = state.playerStates?.[id];
            if (!seat) return '';
            const revealed = state.revealedInitialDice?.[id] || [];
            const dice = [...revealed, ...(seat.dice || [])];
            const total = dice.reduce((sum, v) => sum + Number(v || 0), 0);
            const bust = total > 21;
            const win = (state.winnerIds || []).includes(id);
            const payout = (state.payouts || {})[id];
            const delta = payout != null ? Number(payout) - Number(seat.bet || 0) : null;
            const diceHtml = dice.map(v => {
                const val = Math.max(1, Math.min(6, Number(v) || 1));
                return `<div class="die die-sm" data-v="${val}">${'<i></i>'.repeat(val)}</div>`;
            }).join('');
            return `<div class="pth-reveal-row${win ? ' win' : ''}${bust ? ' bust' : ''}">
                <span class="rv-name">${this._esc(this._seatName(id))}</span>
                <span class="rv-dice">${diceHtml}</span>
                <span class="rv-total">${total}${bust ? ' ✕' : ''}</span>
                <span class="rv-delta">${delta == null ? '' : (delta >= 0 ? `+${this._chips(delta)}` : this._chips(delta))}</span>
            </div>`;
        }).join('');

        const panel = existing || document.createElement('div');
        panel.className = 'pth-reveal';
        panel.innerHTML = '';

        const box = document.createElement('div');
        box.className = 'pth-reveal-box';
        box.innerHTML = `
            <div class="pth-reveal-title">${this._esc(this._t('PARLOR.Bone21.Phase.Resolving') || this._t('PARLORTAVERN.Labels.Settlement'))}</div>
            <div class="pth-reveal-list">${rows}</div>`;

        // 这个遮罩覆盖整张 presenter root，底下 HUD 的按钮即使存在也点不到。
        // 所以 GM 推进动作必须跟结果一起放进遮罩，不能只靠通用 HUD 再画一份。
        const actions = this._api?.getHud?.()?.actions || [];
        this._appendActionButtons(box, actions, { rowClass: 'pth-reveal-actions' });
        panel.appendChild(box);

        if (!existing) this._root.appendChild(panel);
    }

    destroy() {
        this._root?.querySelector('.pth-reveal')?.remove();
        super.destroy();
    }

    _dieRow(values, small = false) {
        const row = document.createElement('div');
        row.className = 'dice-row';
        row.innerHTML = (values || []).map(v => {
            const val = Math.max(1, Math.min(6, Number(v) || 1));
            return `<div class="die${small ? ' die-sm' : ''}" data-v="${val}">${'<i></i>'.repeat(val)}</div>`;
        }).join('');
        return row;
    }

    // ── 木牌播报:底注归基类,这里报掷骰/停手/爆牌 ──
    _heraldSnapshot(state, status) {
        const seats = {};
        for (const [id, seat] of Object.entries(state.playerStates || {})) {
            seats[id] = {
                status: seat?.status || '',
                dice: (seat?.dice || []).length,
                lastRoll: Number(seat?.lastRoll || 0),
                total: Number(seat?.total || 0)
            };
        }
        return {
            ...super._heraldSnapshot(state, status),
            seats,
            winners: (state.winnerIds || []).join(',')
        };
    }

    _gameHeraldLines(prev, next, newRound) {
        const out = [];
        if (newRound) return out;

        for (const [id, seat] of Object.entries(next.seats)) {
            const before = prev.seats?.[id];
            if (!before) continue;
            const name = this._seatName(id);
            if (!name) continue;
            if (seat.dice > before.dice && seat.lastRoll) {
                out.push({ text: this._t('PARLORTAVERN.Herald.Roll', { name, value: seat.lastRoll }), tone: 'deal' });
            }
            if (seat.status === before.status) continue;
            if (seat.status === 'stand') out.push({ text: this._t('PARLORTAVERN.Herald.Stand', { name }), tone: 'stand' });
            if (seat.status === 'bust') out.push({ text: this._t('PARLORTAVERN.Herald.Bust', { name }), tone: 'bust' });
        }

        if (next.winners && next.winners !== prev.winners) {
            const names = next.winners.split(',').map(id => this._seatName(id)).filter(Boolean).join(' · ');
            if (names) out.push({ text: this._t('PARLORTAVERN.Herald.RoundWin', { name: names }), tone: 'win' });
        }
        return out;
    }

    tableStripStatus(state) {
        const s = this._api?.getStatus?.() || {};
        const bits = [];
        if (s.phase) bits.push(`<span>${this._esc(s.phase)}</span>`);
        if (state.roundAnte) bits.push(`<span>${this._esc(this._t('PARLOR.Common.Bet') || this._t('PARLORTAVERN.Labels.Bet'))} <b>${this._chips(state.roundAnte)}</b></span>`);
        return bits;
    }
}
