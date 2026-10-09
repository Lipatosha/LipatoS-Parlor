export class OverlayViewportFit {
    constructor({ overlay, targetSelector, measureSelectors = null }) {
        this.overlay = overlay;
        this.targetSelector = targetSelector;
        this.measureSelectors = Array.isArray(measureSelectors) && measureSelectors.length
            ? measureSelectors
            : [targetSelector];
        this._resizeObserver = null;
        this._rafId = 0;
        this._boundUpdate = () => this.update();
    }

    attach() {
        if (!this.overlay || !this.targetSelector) return;

        window.addEventListener('resize', this._boundUpdate, { passive: true });

        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(() => this.update());
            this._resizeObserver.observe(this.overlay);
            const target = this._getTarget();
            if (target) this._resizeObserver.observe(target);
        }

        this.update();
    }

    update() {
        if (this._rafId) return;
        this._rafId = window.requestAnimationFrame(() => {
            this._rafId = 0;
            this._applyScale();
        });
    }

    destroy() {
        if (this._rafId) {
            window.cancelAnimationFrame(this._rafId);
            this._rafId = 0;
        }

        window.removeEventListener('resize', this._boundUpdate);
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;

        const target = this._getTarget();
        if (!target) return;
        target.style.transform = '';
        target.style.transformOrigin = '';
        target.style.willChange = '';
    }

    _applyScale() {
        const target = this._getTarget();
        if (!this.overlay?.isConnected || !target) return;

        // 先量原始尺寸，不然会被上一次 scale 过的结果带偏。
        target.style.transform = '';
        target.style.transformOrigin = 'center center';
        target.style.willChange = 'transform';

        const bounds = this._measureBounds(this._getMeasureNodes(target));
        if (!bounds.width || !bounds.height) return;

        const available = this._getAvailableSize();
        const scale = Math.min(1, available.width / bounds.width, available.height / bounds.height);
        if (!Number.isFinite(scale) || scale <= 0) return;

        if (scale >= 0.999) {
            target.style.transform = '';
            return;
        }

        target.style.transform = `scale(${scale})`;
    }

    _getTarget() {
        return this.overlay?.querySelector(this.targetSelector) || null;
    }

    _getMeasureNodes(target) {
        const nodes = this.measureSelectors
            .map(selector => this.overlay?.querySelector(selector))
            .filter(Boolean);
        return nodes.length ? nodes : [target];
    }

    _measureBounds(nodes) {
        let left = 0;
        let top = 0;
        let right = 0;
        let bottom = 0;
        let hasRect = false;

        for (const node of nodes) {
            const rect = node.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;

            if (!hasRect) {
                left = rect.left;
                top = rect.top;
                right = rect.right;
                bottom = rect.bottom;
                hasRect = true;
                continue;
            }

            left = Math.min(left, rect.left);
            top = Math.min(top, rect.top);
            right = Math.max(right, rect.right);
            bottom = Math.max(bottom, rect.bottom);
        }

        if (!hasRect) return { width: 0, height: 0 };
        return {
            width: right - left,
            height: bottom - top
        };
    }

    _getAvailableSize() {
        const styles = window.getComputedStyle(this.overlay);
        const paddingX = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
        const paddingY = (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);

        return {
            width: Math.max(0, this.overlay.clientWidth - paddingX - 8),
            height: Math.max(0, this.overlay.clientHeight - paddingY - 8)
        };
    }
}
