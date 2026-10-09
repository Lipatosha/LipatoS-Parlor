/**
 * LiarsDiceTablePresenter — 奇幻酒馆 · 说谎骰桌
 *
 * 壳全在 TavernTableShell;说谎骰特有的:
 * - 垫面中央 = 叫点擂台盘(当前叫点 count × face),说谎骰是"叫点公示"共享焦点,居中合理
 * - HUD 中段 = 玩家自己的骰子(getPrivate 原始点数,用酒馆 .die 渲染,不吃核心 .parlor-ld-die)
 * - 叫点操作把 gameApi 的动作描述排成“数量 + 开盅 + 六点面”，保留经典桌的快速叫法
 */

import { TavernTableShell } from './TavernTableShell.js';

// 4 内部阶段折叠成 摇骰/叫点/开盅 3 盏;labelKey 缺失用 label 中文兜底
const PHASES = [
    { keys: ['IDLE', 'ROLLING'], labelKey: 'PARLOR.LiarsDice.Center.Phase.Rolling' },
    { keys: ['PLAYER_TURNS'], labelKey: 'PARLOR.LiarsDice.Center.Phase.Turns' },
    { keys: ['RESOLVING'], labelKey: 'PARLOR.LiarsDice.Center.Phase.Resolving' }
];

export class LiarsDiceTablePresenter extends TavernTableShell {
    get gameNameKey() { return 'PARLOR.Games.LiarsDice.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.LiarsDice'; }
    get gameGlyph() { return '⚄'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    // 垫面中央 = 叫点擂台盘:当前叫点(count × face 骰)+ 谁叫的
    renderSurface(state) {
        if (this._els.topZone) this._els.topZone.innerHTML = '';
        const host = this._els.surface;
        if (!host) return;
        host.innerHTML = '';

        const claim = state.lastClaim;
        const label = this._esc(this._t('PARLOR.LiarsDice.Label.CurrentClaim') || this._t('PARLORTAVERN.Labels.CurrentClaim'));
        const arena = document.createElement('div');
        arena.className = 'ld-arena is-static';
        const face = document.createElement('div');
        face.className = 'ld-arena-face';

        if (!claim) {
            face.innerHTML = `<div class="ld-arena-lbl">${label}</div>
                <div class="ld-arena-by">${this._esc(this._t('PARLOR.LiarsDice.Center.NoClaimYet') || this._t('PARLORTAVERN.Labels.NoClaimYet'))}</div>`;
        } else {
            face.innerHTML = `<div class="ld-arena-lbl">${label}</div>`;
            const bid = document.createElement('div');
            bid.className = 'ld-arena-bid';
            bid.innerHTML = `<span class="ld-arena-count">${Number(claim.quantity) || 0}</span><span class="ld-arena-x">×</span>`;
            bid.appendChild(this._die(claim.face));
            face.appendChild(bid);
            const status = this._api?.getStatus?.() || {};
            if (status.title) face.insertAdjacentHTML('beforeend', `<div class="ld-arena-by">${this._esc(status.title)}</div>`);
        }
        arena.appendChild(face);
        host.appendChild(arena);
    }

    // ── 木牌播报:叫点 / 开盅 / 谁掉骰 ──
    _heraldSnapshot(state, status) {
        const claim = state.lastClaim || null;
        return {
            ...super._heraldSnapshot(state, status),
            // turnStep 每叫一次就往前走一格,拿它当"这是新叫点"的判据比比数量点数可靠
            claimStep: claim ? Number(claim.turnStep ?? -1) : -1,
            claimBy: claim?.userId || '',
            claimQuantity: Number(claim?.quantity || 0),
            claimFace: Number(claim?.face || 0),
            revealed: !!state.revealed,
            revealedBy: state.revealedBy || '',
            claimWasTrue: state.claimWasTrue === null || state.claimWasTrue === undefined ? '' : String(!!state.claimWasTrue),
            actualCount: Number(state.actualClaimCount || 0),
            loserId: state.roundLoserId || '',
            matchWinnerId: state.matchWinnerId || ''
        };
    }

    _gameHeraldLines(prev, next) {
        const out = [];
        if (next.claimBy && next.claimStep !== prev.claimStep) {
            out.push({
                text: this._t('PARLORTAVERN.Herald.Claim', {
                    name: this._seatName(next.claimBy),
                    quantity: next.claimQuantity,
                    face: next.claimFace
                }),
                tone: 'raise'
            });
        }
        if (next.revealed && !prev.revealed) {
            if (next.revealedBy) {
                out.push({ text: this._t('PARLORTAVERN.Herald.Open', { name: this._seatName(next.revealedBy) }), tone: 'allin' });
            }
            if (next.claimWasTrue) {
                out.push({
                    text: this._t(next.claimWasTrue === 'true' ? 'PARLORTAVERN.Herald.ClaimTrue' : 'PARLORTAVERN.Herald.ClaimFalse',
                        { count: next.actualCount }),
                    tone: next.claimWasTrue === 'true' ? 'win' : 'bust'
                });
            }
            if (next.loserId) {
                out.push({ text: this._t('PARLORTAVERN.Herald.LoseDie', { name: this._seatName(next.loserId) }), tone: 'lose' });
            }
        }
        if (next.matchWinnerId && next.matchWinnerId !== prev.matchWinnerId) {
            out.push({ text: this._t('PARLORTAVERN.Herald.MatchWin', { name: this._seatName(next.matchWinnerId) }), tone: 'win' });
        }
        return out;
    }

    // HUD 中段 = 玩家自己的骰子(getPrivate 拿原始点数)+ 参与者切换(多控时从 centerHtml 抽 select)
    _renderHudHand(hud) {
        const mid = this._els.hudMid;
        if (!mid) return;
        mid.innerHTML = '';

        const priv = this._api?.getPrivate?.() || {};
        const dice = Array.isArray(priv.dice) ? priv.dice : [];
        const row = document.createElement('div');
        row.className = 'dice-row';
        dice.forEach(v => row.appendChild(this._die(v)));
        mid.appendChild(row);

        if (hud.centerHtml) {
            const tmp = document.createElement('div');
            tmp.innerHTML = hud.centerHtml;
            const sel = tmp.querySelector('select');
            if (sel) {
                const wrap = document.createElement('div');
                wrap.className = 'parlor-th-hud-context';
                wrap.appendChild(sel);
                mid.appendChild(wrap);
                sel.addEventListener('change', () => this._renderHud(this._api.getState?.() || {}));
            }
        }
    }

    // 说谎骰的动作反馈来自骰子和状态变化，不能拿纸牌落桌声冒充。
    actionSoundKind() { return ''; }

    // 叫点沿用经典桌的操作模型：一个数量输入、一个开盅、六个固定点面。
    // 点面合法性只体现在 disabled 上，玩家输入几就真的喊几，绝不在点击时暗改数量。
    _renderHudActions(hud) {
        const actions = hud.actions || [];
        const claimActions = actions.filter(action => action.kind === 'claim');
        if (!claimActions.length) {
            super._renderHudActions(hud);
            return;
        }

        const right = this._els.hudRight;
        right.innerHTML = '';
        const box = document.createElement('div');
        box.className = 'pth-ld-claim-box';

        const top = document.createElement('div');
        top.className = 'pth-ld-claim-top';
        const field = document.createElement('label');
        field.className = 'pth-ld-claim-field';
        const label = document.createElement('span');
        label.textContent = hud.claimDraft?.label || '';
        if (hud.claimDraft?.hint) {
            const hint = document.createElement('small');
            hint.textContent = hud.claimDraft.hint;
            label.appendChild(hint);
        }
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'pth-ld-claim-quantity';
        input.min = '1';
        input.step = '1';
        input.value = String(Math.max(1, Math.floor(Number(hud.claimDraft?.quantity || 1)) || 1));
        field.appendChild(label);
        field.appendChild(input);
        top.appendChild(field);

        const readQuantity = () => Math.max(1, Math.floor(Number(input.value || 0)) || 1);
        const openAction = actions.find(action => action.kind === 'open');
        if (openAction) {
            top.appendChild(this._createActionButton(openAction, {
                dataProvider: () => ({ amount: readQuantity() }),
                extraClassName: 'pth-ld-open'
            }));
        }
        box.appendChild(top);

        const faceRow = document.createElement('div');
        faceRow.className = 'pth-ld-face-row';
        const faceEntries = claimActions.map(action => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pth-ld-face-btn';
            button.dataset.ldClaimFace = String(action.face);
            button.title = action.label || '';
            button.setAttribute('aria-label', action.label || '');
            button.appendChild(this._die(action.face));
            const number = document.createElement('span');
            number.textContent = String(action.face);
            button.appendChild(number);
            button.addEventListener('click', event => {
                this._runHudAction(action, event, button, { amount: readQuantity() });
            });
            faceRow.appendChild(button);
            return { action, button };
        });
        box.appendChild(faceRow);
        right.appendChild(box);

        const syncAvailability = () => {
            const quantity = readQuantity();
            faceEntries.forEach(({ action, button }) => {
                button.disabled = !!action.disabled || quantity < Math.max(1, Number(action.minQuantity || 1));
            });
        };
        input.addEventListener('input', syncAvailability);
        input.addEventListener('change', () => {
            input.value = String(readQuantity());
            syncAvailability();
        });
        syncAvailability();
    }

    // 铭文条:桌上总骰数
    tableStripStatus(state) {
        const total = Object.values(state.diceCounts || {}).reduce((sum, n) => sum + Number(n || 0), 0);
        return total
            ? [`<span>${this._esc(this._t('PARLOR.LiarsDice.Label.TableDice') || this._t('PARLORTAVERN.Labels.TableDice'))} <b>${total}</b></span>`]
            : [];
    }
}
