import { CardHandHUD } from '../../ui/CardHandHUD.js';

// 疯狂八经常持有多张牌，使用浅扇形和可滚动的牌区；其他游戏沿用原来的大手牌。
export class CrazyEightsHandHUD extends CardHandHUD {
    show(cards = []) {
        super.show(cards);
        this._root.classList.add('parlor-c8-hand-hud');
        const scroll = document.createElement('div');
        scroll.className = 'parlor-c8-hand-scroll';
        this._cardContainer.before(scroll);
        scroll.appendChild(this._cardContainer);
    }

    addCard(card, options = {}) {
        this._setHandWidth(this._cardElements.length + 1);
        super.addCard(card, options);
    }

    _getResponsiveMetrics() {
        const metrics = super._getResponsiveMetrics();
        const cardWidth = Math.round(Math.max(88, Math.min(128, window.innerHeight * 0.14)));
        const cardHeight = Math.round(cardWidth * 1.4);
        return {
            ...metrics, cardWidth, cardHeight,
            containerHeight: cardHeight + 38,
            cardSpacing: cardWidth * 0.7,
            hoverLift: -16, hoverScale: 1.04, tiltMax: 3,
            entranceOffset: cardHeight + 40
        };
    }

    _setHandWidth(cardCount) {
        if (this._cardContainer) {
            const { cardWidth } = this._getResponsiveMetrics();
            // 保留每张牌至少 32px 的牌角；窄窗或大手牌超出时横向滚动，不能把两端甩出屏幕。
            const width = Math.max(Math.min(1100, window.innerWidth - 32), (cardCount - 1) * 32 + cardWidth + 48);
            this._cardContainer.style.width = `${width}px`;
        }
    }

    _refreshResponsiveLayout() {
        this._setHandWidth(this._cardElements.length);
        super._refreshResponsiveLayout();
    }

    _getCardLayout(index) {
        const metrics = this._responsiveMetrics;
        const total = this._cardElements.length;
        const midpoint = (total - 1) / 2;
        const fraction = midpoint ? (index - midpoint) / midpoint : 0;
        const width = this._cardContainer?.clientWidth || 1100;
        const spacing = total > 1 ? Math.min(metrics.cardSpacing, (width - metrics.cardWidth - 48) / (total - 1)) : 0;
        return {
            x: (index - midpoint) * spacing - metrics.cardWidth / 2,
            y: 10 + fraction * fraction * 12,
            r: fraction * 5
        };
    }

    _applyCardEntry(card, entry) {
        super._applyCardEntry(card, entry);
        // 非本人回合保留牌面供查看，但不发出必然会被主机拒绝的出牌请求。
        if (entry.playable !== true) card._parlorOnClick = null;
        card.classList.toggle('is-clickable', entry.playable === true);
        card.setAttribute('role', 'button');
        card.setAttribute('aria-disabled', String(entry.playable !== true));
        card.tabIndex = entry.playable === true ? 0 : -1;
        if (card._c8KeyboardBound) return;
        card._c8KeyboardBound = true;
        card.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            if (card._parlorPlayable === true) card.click();
        });
        card.addEventListener('focus', () => {
            card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
    }
}
