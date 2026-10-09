/**
 * PresenterHost — Presenter API v1 的 DOM 宿主
 *
 * Host 只管 root、生命周期和崩溃回退。classic 不在这里实现；回退时直接调用游戏侧原生路径。
 */

const CRASHED_SURFACES = new Set();

function crashKey(themeId, surface) {
    return `${String(themeId || '')}::${String(surface || '')}`;
}

export class PresenterHost {
    constructor({ surface, hostId, gameApi, PresenterClass, themeId = 'unknown', onFallback }) {
        this.surface = String(surface || '');
        this.hostId = String(hostId || `parlor-presenter-${this.surface.replace(/[^a-z0-9_-]/giu, '-')}`);
        this.gameApi = gameApi;
        this.PresenterClass = PresenterClass;
        this.themeId = String(themeId || 'unknown');
        this.onFallback = typeof onFallback === 'function' ? onFallback : () => {};
        this._root = null;
        this._presenter = null;
        this._detachedSurfaces = new Set();
    }

    static hasCrashed(themeId, surface) {
        return CRASHED_SURFACES.has(crashKey(themeId, surface));
    }

    get root() { return this._root; }
    get presenter() { return this._presenter; }

    markDetachedSurface(element, surface) {
        if (!element?.dataset) return element;
        // 有些本体弹窗直接挂在 body，不在 presenter root 里；这里既补主题身份，也登记后续销毁。
        // presenterTheme 用注册表里的 themeId，和主题模组文件夹名不是一回事。
        for (const detached of this._detachedSurfaces) {
            if (!detached?.isConnected) this._detachedSurfaces.delete(detached);
        }
        element.dataset.presenterTheme = this.themeId;
        if (surface) element.dataset.presenterSurface = String(surface);
        this._detachedSurfaces.add(element);
        return element;
    }

    open(state) {
        if (PresenterHost.hasCrashed(this.themeId, this.surface) || typeof this.PresenterClass !== 'function') {
            this._fallbackToNative();
            return this;
        }

        if (this._root?.isConnected) {
            this.refresh(state);
            return this;
        }

        this._removeStaleRoots();
        this._root = document.createElement('div');
        this._root.id = this.hostId;
        this._root.className = 'parlor-presenter-root';
        this._root.dataset.surface = this.surface;
        this._root.dataset.presenterTheme = this.themeId;
        document.body.appendChild(this._root);

        try {
            this._presenter = new this.PresenterClass();
            this._presenter.mount(this._root, this.gameApi);
            if (state !== undefined) this._presenter.refresh?.(state);
        } catch (error) {
            this._handlePresenterCrash('mount', error);
        }

        return this;
    }

    refresh(state) {
        if (!this._presenter) return;
        try {
            this._presenter.refresh?.(state);
        } catch (error) {
            this._handlePresenterCrash('refresh', error);
        }
    }

    dispatch(event) {
        try {
            this._presenter?.onEvent?.(event);
        } catch (error) {
            console.error(`parlor | Presenter onEvent failed (theme=${this.themeId}, surface=${this.surface})`, error);
        }
    }

    destroy() {
        this._teardownPresenter();
        for (const detached of this._detachedSurfaces) detached?.remove?.();
        this._detachedSurfaces.clear();
        this._root?.remove();
        this._root = null;
    }

    _handlePresenterCrash(stage, error) {
        CRASHED_SURFACES.add(crashKey(this.themeId, this.surface));
        console.error(`parlor | Presenter ${stage} failed (theme=${this.themeId}, surface=${this.surface}); falling back to native UI`, error);
        this._fallbackToNative();
    }

    _fallbackToNative() {
        this.destroy();
        this.onFallback();
    }

    _teardownPresenter() {
        if (!this._presenter) return;
        try {
            this._presenter.destroy?.();
        } catch (error) {
            console.error(`parlor | Presenter destroy failed (theme=${this.themeId}, surface=${this.surface})`, error);
        }
        this._presenter = null;
    }

    _removeStaleRoots() {
        let stale = document.getElementById(this.hostId);
        while (stale) {
            stale.remove();
            stale = document.getElementById(this.hostId);
        }
    }
}
