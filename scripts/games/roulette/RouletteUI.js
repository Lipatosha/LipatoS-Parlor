/**
 * RouletteUI — 轮盘赌 UI（完整赌桌 SVG 版）
 * 箭头指针，GP 下注弹窗。保留原始华丽的赌桌视觉。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { WHEEL_SEQUENCE, getNumberColor } from './RouletteGame.js';
import { getControlledParticipants, getParticipantLabel } from '../../core/ParticipantRoster.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

const SPIN_DURATION = 7000;

export class RouletteUI extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: 'parlor-roulette',
        tag: 'div',
        classes: ['parlor-game-window', 'parlor-roulette'],
        window: {
            title: 'PARLOR.Games.Roulette.Name',
            icon: 'fas fa-circle-notch',
            resizable: true
        },
        position: { width: 900, height: 520 }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/roulette.hbs` }
    };

    constructor({ gameInstance, ...options }) {
        super(options);
        this.gameInstance = gameInstance;
        this._currentRotation = 0;
        this._isSpinning = false;
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const state = this.gameInstance.getState();
        const { feltTexturePath, railTexturePath } = ParlorAppearance.getTableTexturePaths();
        const controlledIds = getControlledParticipants(state).map(entry => entry.id);
        const myBets = state.bets.filter(b => controlledIds.includes(b.userId));
        const myStake = myBets.reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
        const myPayout = controlledIds.reduce((sum, id) => sum + Number((state.payouts || {})[id] || 0), 0);

        // 轮盘数字槽（弧形扇区）
        const SLOT_COUNT = WHEEL_SEQUENCE.length;
        const SLOT_ANGLE = 360 / SLOT_COUNT;
        const R_OUTER = 175, R_INNER = 125, R_TEXT = 155;
        const DEG2RAD = Math.PI / 180;

        const wheelSlots = WHEEL_SEQUENCE.map((num, i) => {
            const startAngle = (i * SLOT_ANGLE) - 90;
            const endAngle = startAngle + SLOT_ANGLE;
            const midAngle = startAngle + SLOT_ANGLE / 2;

            const ox1 = R_OUTER * Math.cos(startAngle * DEG2RAD);
            const oy1 = R_OUTER * Math.sin(startAngle * DEG2RAD);
            const ox2 = R_OUTER * Math.cos(endAngle * DEG2RAD);
            const oy2 = R_OUTER * Math.sin(endAngle * DEG2RAD);
            const ix1 = R_INNER * Math.cos(endAngle * DEG2RAD);
            const iy1 = R_INNER * Math.sin(endAngle * DEG2RAD);
            const ix2 = R_INNER * Math.cos(startAngle * DEG2RAD);
            const iy2 = R_INNER * Math.sin(startAngle * DEG2RAD);
            const tx = R_TEXT * Math.cos(midAngle * DEG2RAD);
            const ty = R_TEXT * Math.sin(midAngle * DEG2RAD);

            const arcPath = `M${ox1.toFixed(2)},${oy1.toFixed(2)} A${R_OUTER},${R_OUTER} 0 0,1 ${ox2.toFixed(2)},${oy2.toFixed(2)} L${ix1.toFixed(2)},${iy1.toFixed(2)} A${R_INNER},${R_INNER} 0 0,0 ${ix2.toFixed(2)},${iy2.toFixed(2)} Z`;

            return {
                number: num, color: getNumberColor(num),
                angle: (i / SLOT_COUNT) * 360,
                midAngle: midAngle + 90,
                arcPath, textX: tx.toFixed(2), textY: ty.toFixed(2),
                isWinner: state.winningNumber === num
            };
        });

        // 数字格 (1-36, 3列×12行)
        const numberGrid = [];
        for (let row = 0; row < 12; row++) {
            const cells = [];
            for (let col = 0; col < 3; col++) {
                const num = row * 3 + col + 1;
                const myBets = state.bets.filter(b => b.type === 'straight' && b.number === num);
                const totalBet = myBets.reduce((s, b) => s + b.amount, 0);
                cells.push({ number: num, color: getNumberColor(num), totalBet, hasBets: totalBet > 0 });
            }
            numberGrid.push(cells);
        }

        Object.assign(context, {
            wheelSlots, numberGrid,
            phase: state.phase,
            isBetting: state.phase === 'BETTING',
            isSpinning: state.phase === 'SPINNING',
            isResolving: state.phase === 'RESOLVING',
            winningNumber: state.winningNumber,
            winningColor: state.winningNumber != null ? getNumberColor(state.winningNumber) : null,
            payouts: state.payouts || {},
            myPayout,
            myNet: myPayout - myStake,
            totalBets: state.bets.reduce((s, b) => s + b.amount, 0),
            feltTexturePath,
            railTexturePath,
            isGM: game.user.isGM,
            bets: state.bets
        });

        return context;
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        if (!html) return;

        // 恢复轮盘旋转
        this._setWheelRotation(this._currentRotation);

        // SVG 下注格点击 → GP 弹窗
        html.querySelectorAll('[data-bet-area]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.gameInstance.phase !== 'BETTING') return;
                const betType = el.dataset.betType || 'straight';
                const betNumber = el.dataset.betNumber ? parseInt(el.dataset.betNumber) : null;
                const betArea = el.dataset.betArea;
                this._showBetDialog(betArea, betType, betNumber);
            });
        });

        // SVG GM Spin 按钮
        html.querySelector('.parlor-spin-btn')?.addEventListener('click', () => {
            if (!game.user.isGM) return;
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                sessionId: this.gameInstance.sessionId,
                action: 'spin'
            });
        });

        // SVG GM New Round 按钮
        html.querySelector('.parlor-newround-btn')?.addEventListener('click', () => {
            if (!game.user.isGM) return;
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                sessionId: this.gameInstance.sessionId,
                action: 'newRound'
            });
        });

        html.querySelector('.parlor-finish-btn')?.addEventListener('click', () => {
            if (!game.user.isGM) return;
            SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, {
                sessionId: this.gameInstance.sessionId,
                action: 'finishGame'
            });
        });

        // 旋转动画
        if (this.gameInstance.phase === 'SPINNING' && !this._isSpinning) {
            this.playSpinAnimation(this.gameInstance.getState().winningNumber);
        }
    }

    async _showBetDialog(betArea, betType, betNumber) {
        const state = this.gameInstance.getState();
        const controlledParticipants = getControlledParticipants(state)
            .filter(entry => (state.playerIds || []).includes(entry.id));
        if (!controlledParticipants.length) {
            ui.notifications.warn(t('PARLOR.Games.Roulette.BetDialog.MissingParticipant'));
            return;
        }

        const participantOptions = controlledParticipants.map(entry =>
            `<option value="${entry.id}">${getParticipantLabel(entry)}</option>`
        ).join('');
        const content = `
            <div style="text-align:center;">
                <p><strong>${betArea}</strong></p>
                ${controlledParticipants.length > 1 ? `
                    <label style="display:block;margin-bottom:8px;">${t('PARLOR.Games.Roulette.BetDialog.Participant')}：
                        <select name="participantId" style="width:180px;text-align:center;">
                            ${participantOptions}
                        </select>
                    </label>
                ` : `
                    <p style="margin:0 0 8px;color:#888;">${t('PARLOR.Games.Roulette.BetDialog.Participant')}：${getParticipantLabel(controlledParticipants[0])}</p>
                    <input type="hidden" name="participantId" value="${controlledParticipants[0].id}">
                `}
                <label>${t('PARLOR.Games.Roulette.BetDialog.Amount', { gp: t('PARLOR.Common.GP') })}：
                    <input type="number" name="amount" value="10" min="1" style="width:80px;text-align:center;">
                </label>
            </div>
        `;
        const result = await foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.Games.Roulette.BetDialog.Title') },
            content,
            buttons: [{
                label: t('PARLOR.Games.Roulette.BetDialog.Confirm'),
                action: 'bet',
                icon: 'fas fa-coins',
                callback: (event, button, dialog) => {
                    const form = dialog.querySelector ? dialog : button.closest('.dialog');
                    const amount = parseInt(form.querySelector('input[name="amount"]')?.value) || 0;
                    const participantId = form.querySelector('[name="participantId"]')?.value || controlledParticipants[0].id;
                    return { amount, participantId };
                }
            }, {
                label: t('PARLOR.Common.Cancel'), action: 'cancel'
            }],
            rejectClose: false
        });

        if (!result || result === 'cancel' || !result.amount || result.amount <= 0) return;

        await SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, {
            sessionId: this.gameInstance.sessionId,
            userId: result.participantId,
            action: 'placeBet',
            data: {
                betType,
                number: betNumber,
                amount: result.amount
            }
        });
    }

    _setWheelRotation(deg) {
        const wheel = this.element?.querySelector('.parlor-roulette-wheel');
        if (wheel) wheel.setAttribute('transform', `rotate(${deg})`);
    }

    playSpinAnimation(winningNumber) {
        if (this._isSpinning) return;
        this._isSpinning = true;

        const slotIndex = WHEEL_SEQUENCE.indexOf(winningNumber);
        const slotAngle = (slotIndex / WHEEL_SEQUENCE.length) * 360;
        const targetAngle = 360 - slotAngle;

        const extraSpins = 5 + Math.floor(Math.random() * 3);
        const fromAngle = this._currentRotation;
        const toAngle = fromAngle + extraSpins * 360 + targetAngle;

        const wheel = this.element?.querySelector('.parlor-roulette-wheel');
        if (!wheel) { this._isSpinning = false; return; }

        const startTime = performance.now();
        const ease = (t) => 1 - Math.pow(1 - t, 5); // power-5 减速

        const animate = (now) => {
            const elapsed = now - startTime;
            const t = Math.min(elapsed / SPIN_DURATION, 1);
            const angle = fromAngle + (toAngle - fromAngle) * ease(t);
            wheel.setAttribute('transform', `rotate(${angle})`);

            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                this._currentRotation = toAngle % 360;
                this._isSpinning = false;
                wheel.setAttribute('transform', `rotate(${this._currentRotation})`);
            }
        };
        requestAnimationFrame(animate);
    }
}
