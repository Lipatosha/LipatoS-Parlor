/**
 * 作弊面板的位置由用户掌握：打开时避让一次，之后不随甲虫的动作换边。
 * 酒馆桌面会缩放，鼠标是屏幕坐标，left/top 却是桌面坐标；换算必须用实际定位容器。
 */
export class BeetleRaceCheatPanel {
    constructor(panel, { bounds, handle, anchor = bounds }) {
        this.panel = panel;
        this.bounds = bounds;
        this.anchor = anchor;
        this.handle = handle;
        this._position = null;
        this._drag = null;
        this._manual = false;
        this._abort = new AbortController();
        const signal = this._abort.signal;
        panel.addEventListener('pointerdown', event => this._startDrag(event), { signal });
        panel.addEventListener('pointermove', event => this._moveDrag(event), { signal });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            panel.addEventListener(name, event => this._endDrag(event), { signal });
        }
        window.addEventListener('resize', () => this.reflow(), { signal });
        this._observer = new ResizeObserver(() => this.reflow());
        this._observer.observe(bounds);
        this._observer.observe(panel);
    }

    _space() {
        const parent = this.panel.offsetParent;
        if (!parent) return { left: 0, top: 0, scaleX: 1, scaleY: 1 };
        const box = parent.getBoundingClientRect();
        return {
            left: box.left,
            top: box.top,
            scaleX: box.width / (parent.offsetWidth || box.width) || 1,
            scaleY: box.height / (parent.offsetHeight || box.height) || 1
        };
    }

    _place(left, top) {
        const space = this._space();
        const box = this.bounds.getBoundingClientRect();
        const width = this.panel.offsetWidth * space.scaleX;
        const height = this.panel.offsetHeight * space.scaleY;
        const minX = Math.max(12, box.left + 12);
        const minY = Math.max(12, box.top + 12);
        const maxX = Math.max(minX, Math.min(window.innerWidth, box.right) - width - 12);
        const maxY = Math.max(minY, Math.min(window.innerHeight, box.bottom) - height - 12);
        const x = Math.max(minX, Math.min(maxX, left));
        const y = Math.max(minY, Math.min(maxY, top));
        this._position = { x: (x - space.left) / space.scaleX, y: (y - space.top) / space.scaleY };
        // 清掉另一侧约束，避免绝对定位面板同时受 left/right 控制而在拖动时变形。
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
        this.panel.style.left = `${this._position.x}px`;
        this.panel.style.top = `${this._position.y}px`;
    }

    open(point) {
        if (this._manual && this._position) {
            this.reflow();
            return;
        }
        const box = this.anchor.getBoundingClientRect();
        const side = point && point.x < box.left + box.width / 2 ? 'right' : 'left';
        this.panel.dataset.side = side;
        const width = this.panel.offsetWidth * this._space().scaleX;
        this._place(side === 'right' ? box.right - width - 18 : box.left + 18, box.top + 18);
    }

    reflow() {
        if (this.panel.hidden || !this._position || this._drag) return;
        const space = this._space();
        this._place(space.left + this._position.x * space.scaleX, space.top + this._position.y * space.scaleY);
    }

    _startDrag(event) {
        if (event.button !== 0 || !event.isPrimary || !event.target.closest(this.handle)) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        const space = this._space();
        if (!this._position) this.open(null);
        this._drag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - (space.left + this._position.x * space.scaleX),
            offsetY: event.clientY - (space.top + this._position.y * space.scaleY)
        };
        this._manual = true;
        this.panel.classList.add('is-dragging');
        this.panel.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    }

    _moveDrag(event) {
        if (event.pointerId !== this._drag?.pointerId) return;
        this._place(event.clientX - this._drag.offsetX, event.clientY - this._drag.offsetY);
    }

    _endDrag(event) {
        if (!this._drag || (event && event.pointerId !== this._drag.pointerId)) return;
        const pointerId = this._drag.pointerId;
        this._drag = null;
        if (this.panel.hasPointerCapture(pointerId)) this.panel.releasePointerCapture(pointerId);
        this.panel.classList.remove('is-dragging');
        this.reflow();
    }

    close() {
        this._endDrag();
    }

    destroy() {
        this.close();
        this._abort.abort();
        this._observer.disconnect();
    }
}
