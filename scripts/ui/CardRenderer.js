/**
 * CardRenderer — 扑克牌 DOM 渲染器
 * V14 兼容优先：直接吃 Foundry 自带的扑克牌资源，发牌 / 翻牌动画还是留在这里。
 */

import { ParlorAppearance } from '../core/AppearanceConfig.js';

export class CardRenderer {

    /**
     * V14 兼容：创建一张扑克牌 DOM 元素
     * @param {Object} card - { rank, suit } 或 null（牌背）
     * @param {Object} options - { faceDown, size, animate }
     * @returns {HTMLElement}
     */
    static createCard(card = null, options = {}) {
        const { faceDown = false, size = 'normal', animate = false, appearance = null } = options;
        const safeAppearance = ParlorAppearance.sanitizeAppearanceConfig(
            appearance || ParlorAppearance.getAppearanceConfig()
        );

        const el = document.createElement('div');
        el.className = `parlor-playing-card size-${size}`;
        if (faceDown) el.classList.add('face-down');
        if (animate) el.classList.add('deal-animate');
        el._parlorAppearance = safeAppearance;

        // 正面
        const front = document.createElement('div');
        front.className = 'card-front';
        if (card) {
            const art = document.createElement('img');
            art.className = 'card-face-art';
            art.alt = `${card.rank} of ${card.suit}`;
            art.src = ParlorAppearance.getCardFacePath(card, safeAppearance);
            front.appendChild(art);
        }

        // 背面
        const back = document.createElement('div');
        back.className = 'card-back';
        const backArt = document.createElement('img');
        backArt.className = 'card-back-art';
        backArt.alt = 'Card back';
        backArt.src = ParlorAppearance.getCardBackPath(safeAppearance);
        back.appendChild(backArt);

        // 高光扫过层
        const shine = document.createElement('div');
        shine.className = 'card-shine';

        el.appendChild(front);
        el.appendChild(back);
        el.appendChild(shine);

        if (card) {
            el.dataset.rank = card.rank;
            el.dataset.suit = card.suit;
        }

        return el;
    }

    /**
     * V14 兼容：翻牌动画，默认还是靠 front/back 的 3D 过渡
     * @param {HTMLElement} cardEl
     * @param {boolean} faceDown - true=翻到背面, false=翻到正面
     * @param {number} duration - 动画时长 ms
     * @param {Object} options - { silent }
     */
    static flip(cardEl, faceDown = false, duration = 400, options = {}) {
        if (cardEl?.isConnected && !options.silent) {
            ParlorAppearance.playCardSound('flip', cardEl?._parlorAppearance || null);
        }
        cardEl.style.setProperty('--card-flip-duration', `${duration}ms`);
        cardEl.classList.add('is-flipping');
        if (faceDown) {
            cardEl.classList.add('face-down');
        } else {
            cardEl.classList.remove('face-down');
        }
        setTimeout(() => {
            cardEl.classList.remove('is-flipping');
            cardEl.style.removeProperty('--card-flip-duration');
        }, duration + 80);
    }

    /**
     * V14 兼容：发牌动画从指定位置飞入，可选落桌后再翻牌
     * @param {HTMLElement} cardEl
     * @param {Object} from - { x, y } 起始偏移
     * @param {number} delay - 延迟 ms
     */
    static dealFrom(cardEl, from = { x: -300, y: -200 }, delay = 0, options = {}) {
        const opts = typeof delay === 'object' ? delay : options;
        const wait = typeof delay === 'number' ? delay : (opts.delay ?? 0);
        const duration = opts.duration ?? 540;
        const settleRotate = opts.settleRotate ?? 0;
        const settleScale = opts.settleScale ?? 1;
        const startRotate = opts.startRotate ?? -16;
        const startScale = opts.startScale ?? 0.72;
        const opacityDuration = opts.opacityDuration ?? Math.round(duration * 0.58);
        const flipAfter = opts.flipAfter || null;
        if (opts.appearance) {
            cardEl._parlorAppearance = ParlorAppearance.sanitizeAppearanceConfig(opts.appearance);
        }

        cardEl.style.opacity = '0';
        cardEl.style.transform = `translate(${from.x}px, ${from.y}px) rotate(${startRotate}deg) scale(${startScale})`;

        setTimeout(() => {
            if (!cardEl?.isConnected) return;
            ParlorAppearance.playCardSound('deal', cardEl?._parlorAppearance || null);
            cardEl.style.transition = `transform ${duration}ms cubic-bezier(.18,1,.22,1), opacity ${opacityDuration}ms ease`;
            cardEl.style.opacity = '1';
            cardEl.style.transform = `translate(0,0) rotate(${settleRotate}deg) scale(${settleScale})`;

            if (flipAfter) {
                const flipDelay = duration + (flipAfter.delay ?? 80);
                setTimeout(() => {
                    this.flip(cardEl, flipAfter.faceDown ?? false, flipAfter.duration ?? 420);
                }, flipDelay);
            }

            const cleanupDelay = duration + (flipAfter ? (flipAfter.delay ?? 80) + (flipAfter.duration ?? 420) : 0) + 60;
            setTimeout(() => { cardEl.style.transition = ''; }, cleanupDelay);
        }, wait);

        setTimeout(() => {
            if (!cardEl?.isConnected) return;
            ParlorAppearance.playCardSound('placed', cardEl?._parlorAppearance || null);
        }, wait + duration);
    }

    /**
     * V14 兼容：更新已有牌面内容，尽量不重建 DOM
     */
    static updateCard(cardEl, card, options = {}) {
        const front = cardEl.querySelector('.card-front');
        if (!front || !card) return;
        const safeAppearance = ParlorAppearance.sanitizeAppearanceConfig(
            options.appearance || cardEl._parlorAppearance || ParlorAppearance.getAppearanceConfig()
        );

        let art = front.querySelector('.card-face-art');
        if (!art) {
            front.innerHTML = '';
            art = document.createElement('img');
            art.className = 'card-face-art';
            front.appendChild(art);
        }

        art.alt = `${card.rank} of ${card.suit}`;
        art.src = ParlorAppearance.getCardFacePath(card, safeAppearance);
        const backArt = cardEl.querySelector('.card-back-art');
        if (backArt) backArt.src = ParlorAppearance.getCardBackPath(safeAppearance);
        cardEl._parlorAppearance = safeAppearance;
        cardEl.dataset.rank = card.rank;
        cardEl.dataset.suit = card.suit;
    }
}
