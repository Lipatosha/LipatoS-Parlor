/**
 * CardHandHUD — 手牌 HUD
 *
 * 这层后续交互和 DOM 调整统一按 Foundry V14 兼容优先来做。
 */
import { CardRenderer } from './CardRenderer.js';

const HUD_CONFIG = {
    cardSpacing: 126,
    minSpacing: 74,
    arcHeight: 5,
    baseOffsetY: 18,
    rotationFactor: 4.4,
    hoverLift: -114,
    hoverScale: 1.16,
    tiltMax: 7,
    entranceDelay: 90,
    entranceOffset: 304,
    containerHeight: 360
};

export class CardHandHUD {

    constructor() {
        this._root = null;
        this._cardContainer = null;
        this._actionBar = null;
        this._footerBar = null;
        this._cardElements = [];
        this._collapseTimer = null;
        this._handHoverActive = false;
        this._handHoverTilt = { dx: 0, dy: 0 };
        // 钉住 = 鼠标离开也不收拢。甩牌类游戏轮到自己时整手牌都是可点目标，收起来会点空
        this._pinned = false;
        this._responsiveMetrics = this._getResponsiveMetrics();
        this._handleResize = this._refreshResponsiveLayout.bind(this);
    }

    get root() {
        return this._root;
    }

    setPinned(pinned) {
        this._pinned = !!pinned;
        if (!this._root) return;
        if (this._pinned) {
            this._clearCollapseTimer();
            this._setCollapsed(false);
        } else if (!this._handHoverActive && !this._cardElements.some(card => card._parlorHovered)) {
            this._scheduleCollapse();
        }
    }

    show(cards = []) {
        this.destroy();
        const cardEntries = cards.map(card => this._normalizeCardEntry(card));

        const root = document.createElement('div');
        root.id = 'parlor-hand-hud';
        root.className = 'parlor-hand-hud-root';

        const actionBar = document.createElement('div');
        actionBar.className = 'parlor-hand-hud-actions';
        root.appendChild(actionBar);
        this._actionBar = actionBar;

        const cardContainer = document.createElement('div');
        cardContainer.className = 'parlor-hand-hud-cards';
        root.appendChild(cardContainer);
        this._cardContainer = cardContainer;
        this._attachContainerHoverEvents();

        const footerBar = document.createElement('div');
        footerBar.className = 'parlor-hand-hud-footer';
        root.appendChild(footerBar);
        this._footerBar = footerBar;

        this._cardElements = cardEntries.map((entry) => {
            const el = CardRenderer.createCard(entry.card, {
                faceDown: entry.startFaceDown,
                size: entry.size
            });
            el.style.position = 'absolute';
            el.style.left = '50%';
            el.style.top = '0';
            el.style.willChange = 'transform, filter';
            this._applyCardEntry(el, entry);
            this._applyCardSize(el);
            cardContainer.appendChild(el);
            return el;
        });

        document.body.appendChild(root);
        this._root = root;
        this._syncCardMode();
        window.addEventListener('resize', this._handleResize, { passive: true });
        this._refreshResponsiveLayout();

        this._animateEntrance();
        this._attachHoverEvents();
        this._setCollapsed(!this._pinned);
    }

    /**
     * 补一张牌进手。options.index 指定插到第几位（手牌按花色排序时新牌要落在它该在的位置），
     * 不给就追加到末尾；options.fromRect 是飞入起点。
     */
    addCard(card, options = {}) {
        if (!this._cardContainer) return;
        const entry = this._normalizeCardEntry(card);

        const el = CardRenderer.createCard(entry.card, {
            faceDown: entry.startFaceDown,
            size: entry.size
        });
        el.style.position = 'absolute';
        el.style.left = '50%';
        el.style.top = '0';
        el.style.willChange = 'transform, filter';
        this._applyCardEntry(el, entry);
        this._applyCardSize(el);

        const total = this._cardElements.length;
        const index = Number.isInteger(options.index)
            ? Math.max(0, Math.min(total, options.index))
            : total;
        const before = this._cardElements[index] || null;
        this._cardContainer.insertBefore(el, before);
        this._cardElements.splice(index, 0, el);
        this._syncCardMode();

        // 老牌让位要滑过去，不能瞬移
        this._arrangeCards({ animate: true, skip: el });

        const data = this._getCardLayout(index);
        const fromRect = options.fromRect || null;
        if (fromRect) {
            const containerRect = this._cardContainer.getBoundingClientRect();
            const startX = fromRect.left - (containerRect.left + containerRect.width / 2);
            const startY = fromRect.top - containerRect.top;
            const startScale = Math.max(0.58, Math.min(1, fromRect.width / Math.max(el.offsetWidth, 1)));
            el.style.opacity = '0.96';
            el.style.transform = `translateX(${startX}px) translateY(${startY}px) rotateZ(-10deg) scale(${startScale})`;
        } else {
            const metrics = this._responsiveMetrics || HUD_CONFIG;
            el.style.opacity = '0';
            el.style.transform = `translateX(${data.x}px) translateY(${metrics.entranceOffset}px) rotateZ(${data.r}deg) scale(0.8)`;
        }
        requestAnimationFrame(() => {
            el.style.transition = 'transform 500ms cubic-bezier(.2,1.2,.2,1), opacity 320ms ease';
            el.style.opacity = '1';
            el.style.transform = `translateX(${data.x}px) translateY(${data.y}px) rotateZ(${data.r}deg)`;
            setTimeout(() => {
                el.style.transition = '';
                this._syncCardFace(el, { duration: 350 });
            }, 500);
        });

        this._attachHoverToCard(el);
        this._refreshHoverState();
    }

    updateCards(cards = []) {
        const entries = cards.map(card => this._normalizeCardEntry(card));
        if (entries.length !== this._cardElements.length) {
            this.show(cards);
            return;
        }

        entries.forEach((entry, index) => {
            const cardEl = this._cardElements[index];
            CardRenderer.updateCard(cardEl, entry.card);
            this._applyCardEntry(cardEl, entry);
            this._syncCardFace(cardEl, { immediate: true });
        });

        this._arrangeCards();
        this._refreshHoverState();
    }

    showActions(actions) {
        if (!this._actionBar) return;
        this._actionBar.innerHTML = '';

        for (const action of actions) {
            const btn = document.createElement('button');
            btn.className = 'parlor-hud-action-btn';
            if (action.accent) btn.classList.add('accent');
            if (action.disabled) btn.disabled = true;
            btn.innerHTML = `${action.icon ? `<i class="${action.icon}"></i> ` : ''}${action.label}`;
            btn.addEventListener('click', (event) => action.callback?.(event));
            this._actionBar.appendChild(btn);
        }
    }

    hideActions() {
        if (this._actionBar) this._actionBar.innerHTML = '';
    }

    showFooter(html) {
        if (!this._footerBar) return;
        this._footerBar.innerHTML = html || '';
        this._footerBar.classList.toggle('is-empty', !html);
    }

    hideFooter() {
        this.showFooter('');
    }

    revealAll(staggerDelay = 120) {
        this._cardElements.forEach((el, i) => {
            setTimeout(() => CardRenderer.flip(el, false, 350), i * staggerDelay);
        });
    }

    destroy() {
        this._clearCollapseTimer();
        window.removeEventListener('resize', this._handleResize);
        this._root?.remove();
        this._root = null;
        this._cardContainer = null;
        this._actionBar = null;
        this._footerBar = null;
        this._cardElements = [];
        this._handHoverActive = false;
        this._handHoverTilt = { dx: 0, dy: 0 };
    }

    _getResponsiveMetrics() {
        const viewportWidth = Math.max(window.innerWidth || document.documentElement?.clientWidth || 0, 960);
        const viewportHeight = Math.max(window.innerHeight || document.documentElement?.clientHeight || 0, 720);
        const widthScale = Math.min(1, Math.max(0.68, viewportWidth / 1680));
        const heightScale = Math.min(1, Math.max(0.66, viewportHeight / 1180));
        const scale = Math.min(widthScale, heightScale);

        return {
            scale,
            cardWidth: Math.round(260 * scale),
            cardHeight: Math.round(364 * scale),
            cardSpacing: Math.round(HUD_CONFIG.cardSpacing * scale),
            minSpacing: Math.max(56, Math.round(HUD_CONFIG.minSpacing * Math.max(0.76, scale))),
            arcHeight: Math.max(3.2, HUD_CONFIG.arcHeight * scale),
            baseOffsetY: Math.round(HUD_CONFIG.baseOffsetY * Math.max(0.82, scale)),
            rotationFactor: HUD_CONFIG.rotationFactor * (0.9 + (scale * 0.1)),
            hoverLift: Math.round(HUD_CONFIG.hoverLift * scale),
            hoverScale: 1 + ((HUD_CONFIG.hoverScale - 1) * Math.max(0.74, scale)),
            tiltMax: Math.max(5.2, HUD_CONFIG.tiltMax * (0.86 + (scale * 0.14))),
            entranceOffset: Math.round(HUD_CONFIG.entranceOffset * scale),
            containerHeight: Math.max(238, Math.round(HUD_CONFIG.containerHeight * scale))
        };
    }

    _refreshResponsiveLayout() {
        this._responsiveMetrics = this._getResponsiveMetrics();
        const metrics = this._responsiveMetrics;

        if (!this._root) return;

        this._root.classList.toggle('is-compact', metrics.scale < 0.94);
        this._cardContainer.style.height = `${metrics.containerHeight}px`;
        this._cardElements.forEach(card => this._applyCardSize(card));
        this._arrangeCards();

        if (this._handHoverActive) {
            this._applyHandHoverTransforms();
            return;
        }

        this._cardElements.forEach(card => {
            if (!card._parlorHovered) return;
            this._applyHoverStyle(card);
        });
    }

    _applyCardSize(card) {
        const metrics = this._responsiveMetrics || HUD_CONFIG;
        card.style.width = `${metrics.cardWidth}px`;
        card.style.height = `${metrics.cardHeight}px`;
    }

    _syncCardMode() {
        this._root?.classList.toggle('has-no-cards', this._cardElements.length === 0);
    }

    _getCardLayout(index) {
        const metrics = this._responsiveMetrics || HUD_CONFIG;
        const total = this._cardElements.length;
        const ni = index - (total - 1) / 2;
        const containerWidth = this._cardContainer?.clientWidth || 1040;
        const maxSpread = total > 1
            ? Math.min(metrics.cardSpacing, (containerWidth * 0.72) / (total - 1))
            : metrics.cardSpacing;
        const spacing = Math.max(metrics.minSpacing, maxSpread);

        return {
            x: ni * spacing,
            y: metrics.baseOffsetY + (Math.abs(ni) * Math.abs(ni) * metrics.arcHeight),
            r: ni * metrics.rotationFactor
        };
    }

    _arrangeCards({ animate = false, skip = null } = {}) {
        this._cardElements.forEach((card, index) => {
            const { x, y, r } = this._getCardLayout(index);
            card.dataset.xOffset = String(x);
            card.dataset.yOffset = String(y);
            card.dataset.rotation = String(r);
            card.dataset.zIdx = String(index);
            if (card === skip) return;
            card.style.zIndex = String(index);
            // 悬停中的牌由 hover 样式接管位置，别把它拽回原位
            if (card._parlorHovered) return;
            if (animate) {
                card.style.transition = 'transform 0.3s cubic-bezier(.2,.8,.2,1)';
                setTimeout(() => {
                    if (card.isConnected && !card._parlorHovered) card.style.transition = '';
                }, 320);
            }
            card.style.transform = `translateX(${x}px) translateY(${y}px) rotateZ(${r}deg)`;
        });
    }

    _animateEntrance() {
        this._cardElements.forEach((card, index) => {
            const metrics = this._responsiveMetrics || HUD_CONFIG;
            const { x, y, r } = this._getCardLayout(index);
            card.style.opacity = '0';
            card.style.transform = `translateX(${x}px) translateY(${y + metrics.entranceOffset}px) rotateZ(${r}deg) scale(0.7)`;

            setTimeout(() => {
                card.style.transition = 'transform 450ms cubic-bezier(.2,1.2,.2,1), opacity 250ms ease';
                card.style.opacity = '1';
                card.style.transform = `translateX(${x}px) translateY(${y}px) rotateZ(${r}deg)`;
                setTimeout(() => {
                    card.style.transition = '';
                    this._syncCardFace(card, { duration: 350 });
                }, 450);
            }, (index + 1) * HUD_CONFIG.entranceDelay);
        });
    }

    _attachHoverEvents() {
        this._cardElements.forEach(card => this._attachHoverToCard(card));
    }

    _attachContainerHoverEvents() {
        if (!this._cardContainer) return;

        this._cardContainer.addEventListener('mousemove', (event) => {
            if (!this._handHoverActive) return;
            this._updateHandHover(event);
        });

        this._cardContainer.addEventListener('mouseleave', () => {
            if (!this._handHoverActive) return;
            this._deactivateHandHover();
        });
    }

    _scheduleCollapse(delay = 80) {
        this._clearCollapseTimer();
        if (this._pinned) return;
        this._collapseTimer = setTimeout(() => this._setCollapsed(true), delay);
    }

    _clearCollapseTimer() {
        if (!this._collapseTimer) return;
        clearTimeout(this._collapseTimer);
        this._collapseTimer = null;
    }

    _setCollapsed(collapsed) {
        if (!this._root) return;
        this._root.classList.toggle('is-collapsed', collapsed);
    }

    _applyHoverStyle(card, { dx = 0, dy = 0, zBoost = 9999 } = {}) {
        const metrics = this._responsiveMetrics || HUD_CONFIG;
        const x = parseFloat(card.dataset.xOffset) || 0;
        const y = parseFloat(card.dataset.yOffset) || 0;
        const r = parseFloat(card.dataset.rotation) || 0;
        const z = parseFloat(card.dataset.zIdx) || 0;

        card.style.zIndex = String(zBoost + z);
        card.style.filter = 'drop-shadow(0 16px 30px rgba(0,0,0,0.62)) brightness(1.06)';
        card.style.transition = 'transform 0.2s cubic-bezier(.2,.8,.2,1), filter 0.2s ease';
        card.style.transform = `perspective(1400px) translateX(${x}px) translateY(${y + metrics.hoverLift}px) rotateZ(${r}deg) rotateX(${-(dy * metrics.tiltMax)}deg) rotateY(${dx * metrics.tiltMax}deg) scale(${metrics.hoverScale})`;
    }

    _resetHoverStyle(card) {
        const x = parseFloat(card.dataset.xOffset) || 0;
        const y = parseFloat(card.dataset.yOffset) || 0;
        const r = parseFloat(card.dataset.rotation) || 0;

        card.style.zIndex = card.dataset.zIdx || '0';
        card.style.filter = '';
        card.style.transition = 'transform 0.25s ease, filter 0.2s ease';
        card.style.transform = `translateX(${x}px) translateY(${y}px) rotateZ(${r}deg)`;
        setTimeout(() => {
            if (!card.isConnected) return;
            if (card._parlorHandHover && this._handHoverActive) return;
            card.style.transition = '';
        }, 280);
    }

    _attachHoverToCard(card) {
        let raf = null;

        // 点击通道只绑一次，回调每次从元素上读最新的（updateCards 会原地换条目）
        if (!card._parlorClickBound) {
            card._parlorClickBound = true;
            card.addEventListener('click', (event) => {
                if (card._parlorPlayable === false) return;
                card._parlorOnClick?.(event, { card: card._parlorCard });
            });
        }

        if (card._parlorHandHover) {
            card.addEventListener('mouseenter', (event) => {
                this._activateHandHover(event);
            });
            return;
        }

        card.addEventListener('mouseenter', () => {
            card._parlorHovered = true;
            this._clearCollapseTimer();
            this._setCollapsed(false);
            this._syncCardFace(card, { duration: 260, silent: true });
            // 出不了的牌只展开手牌不抬升，免得看着像能点
            if (card._parlorPlayable === false) return;
            this._applyHoverStyle(card);
        });

        card.addEventListener('mousemove', (ev) => {
            if (card._parlorPlayable === false) return;
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                const rect = card.getBoundingClientRect();
                const dx = ((ev.clientX - rect.left) / rect.width - 0.5) * 2;
                const dy = ((ev.clientY - rect.top) / rect.height - 0.5) * 2;
                this._applyHoverStyle(card, { dx, dy });
            });
        });

        card.addEventListener('mouseleave', () => {
            card._parlorHovered = false;
            if (raf) {
                cancelAnimationFrame(raf);
                raf = null;
            }

            this._resetHoverStyle(card);
            this._syncCardFace(card, { duration: 260, silent: true });
            this._scheduleCollapse();
        });
    }

    _activateHandHover(event) {
        this._handHoverActive = true;
        this._clearCollapseTimer();
        this._setCollapsed(false);

        this._cardElements.forEach(card => {
            if (!card._parlorHandHover) return;
            card._parlorHovered = true;
            this._syncCardFace(card, { duration: 260, silent: true });
        });

        this._updateHandHover(event);
    }

    _updateHandHover(event) {
        if (!this._cardContainer) return;

        const rect = this._cardContainer.getBoundingClientRect();
        const dx = ((event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * 2;
        const dy = ((event.clientY - rect.top) / Math.max(rect.height, 1) - 0.5) * 2;
        this._handHoverTilt = { dx, dy };
        this._applyHandHoverTransforms();
    }

    _applyHandHoverTransforms() {
        const { dx, dy } = this._handHoverTilt;
        this._cardElements.forEach(card => {
            if (!card._parlorHandHover) return;
            this._applyHoverStyle(card, { dx, dy, zBoost: 9000 });
        });
    }

    _deactivateHandHover() {
        this._handHoverActive = false;

        this._cardElements.forEach(card => {
            if (!card._parlorHandHover) return;
            card._parlorHovered = false;
            this._resetHoverStyle(card);
            this._syncCardFace(card, { duration: 260, silent: true });
        });

        this._handHoverTilt = { dx: 0, dy: 0 };
        this._scheduleCollapse();
    }

    _refreshHoverState() {
        if (!this._handHoverActive) return;

        this._cardElements.forEach(card => {
            if (!card._parlorHandHover) return;
            card._parlorHovered = true;
            this._syncCardFace(card, { immediate: true });
        });

        this._applyHandHoverTransforms();
    }

    _normalizeCardEntry(entry) {
        if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'card')) {
            return {
                card: entry.card || null,
                size: entry.size || 'hud',
                startFaceDown: entry.startFaceDown !== false,
                idleFaceDown: !!entry.idleFaceDown,
                hoverReveal: entry.hoverReveal !== false,
                handHover: !!entry.handHover,
                // playable 三态：null = 这游戏不分可出不可出（老桌都是这样），true/false = 亮/灰
                playable: entry.playable === undefined || entry.playable === null ? null : !!entry.playable,
                onClick: typeof entry.onClick === 'function' ? entry.onClick : null
            };
        }

        return {
            card: entry || null,
            size: 'hud',
            startFaceDown: true,
            idleFaceDown: false,
            hoverReveal: false,
            handHover: false,
            playable: null,
            onClick: null
        };
    }

    _applyCardEntry(cardEl, entry) {
        cardEl._parlorStartFaceDown = !!entry.startFaceDown;
        cardEl._parlorIdleFaceDown = !!entry.idleFaceDown;
        cardEl._parlorHoverReveal = !!entry.hoverReveal;
        cardEl._parlorHandHover = !!entry.handHover;
        cardEl._parlorCard = entry.card || null;
        cardEl._parlorPlayable = entry.playable;
        cardEl._parlorOnClick = entry.onClick;
        cardEl.classList.toggle('is-playable', entry.playable === true);
        cardEl.classList.toggle('is-inert', entry.playable === false);
        cardEl.classList.toggle('is-clickable', !!entry.onClick && entry.playable !== false);
        cardEl._parlorHovered = cardEl._parlorHandHover
            ? this._handHoverActive
            : (!!cardEl._parlorHovered && cardEl.matches(':hover'));
    }

    _shouldCardBeFaceDown(cardEl) {
        if (cardEl?._parlorHoverReveal && cardEl?._parlorHovered) return false;
        return !!cardEl?._parlorIdleFaceDown;
    }

    _syncCardFace(cardEl, { duration = 320, immediate = false, silent = false } = {}) {
        if (!cardEl) return;

        const shouldFaceDown = this._shouldCardBeFaceDown(cardEl);
        const isFaceDown = cardEl.classList.contains('face-down');
        if (shouldFaceDown === isFaceDown) return;

        if (immediate) {
            cardEl.classList.toggle('face-down', shouldFaceDown);
            return;
        }

        CardRenderer.flip(cardEl, shouldFaceDown, duration, { silent });
    }
}
