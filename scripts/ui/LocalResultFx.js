const FX_STATE = new WeakMap();

function getState(overlay) {
    let state = FX_STATE.get(overlay);
    if (state) return state;

    state = {
        timer: null,
        active: false,
        queue: [],
        root: null
    };
    FX_STATE.set(overlay, state);
    return state;
}

function ensureRoot(overlay) {
    const state = getState(overlay);
    if (state.root?.isConnected) return state.root;

    const root = document.createElement('div');
    root.className = 'parlor-local-result-fx-root';
    root.dataset.parlorFxOwner = overlay?.id || 'parlor';
    document.body.appendChild(root);
    state.root = root;
    return root;
}

function buildBurstHtml() {
    const shards = [
        { x: '-168px', y: '-92px', rotate: '-34deg', delay: '0.02s' },
        { x: '-216px', y: '28px', rotate: '-72deg', delay: '0.11s' },
        { x: '-92px', y: '152px', rotate: '-142deg', delay: '0.16s' },
        { x: '0px', y: '-168px', rotate: '0deg', delay: '0.08s' },
        { x: '118px', y: '-116px', rotate: '42deg', delay: '0.13s' },
        { x: '206px', y: '20px', rotate: '88deg', delay: '0.19s' },
        { x: '112px', y: '148px', rotate: '132deg', delay: '0.1s' },
        { x: '-18px', y: '188px', rotate: '180deg', delay: '0.15s' }
    ];

    return shards.map(shard => `
        <span
            class="parlor-local-result-fx-shard"
            style="--parlor-fx-x:${shard.x}; --parlor-fx-y:${shard.y}; --parlor-fx-rotate:${shard.rotate}; --parlor-fx-delay:${shard.delay};"
        ></span>
    `).join('');
}

function buildHtml(entry) {
    return `
        <div class="parlor-local-result-fx tone-${entry.tone || 'win'}">
            <div class="parlor-local-result-fx-veil"></div>
            <div class="parlor-local-result-fx-ring"></div>
            <div class="parlor-local-result-fx-burst">
                ${buildBurstHtml()}
            </div>
            <div class="parlor-local-result-fx-banner">
                <div class="parlor-local-result-fx-badge">${entry.icon || '✦'}</div>
                <div class="parlor-local-result-fx-title">${entry.title || ''}</div>
                ${entry.sub ? `<div class="parlor-local-result-fx-sub">${entry.sub}</div>` : ''}
            </div>
        </div>
    `;
}

function finishCurrent(overlay) {
    const root = getState(overlay).root;
    if (root) {
        root.classList.remove('is-active');
        root.innerHTML = '';
    }
    overlay?.classList.remove('show-local-result-fx');
}

function playNext(overlay) {
    const state = getState(overlay);
    if (state.active) return;

    const next = state.queue.shift();
    if (!next) return;

    const root = ensureRoot(overlay);
    state.active = true;
    root.innerHTML = buildHtml(next);
    root.dataset.tone = next.tone || 'win';

    requestAnimationFrame(() => {
        root.classList.add('is-active');
        overlay?.classList.add('show-local-result-fx');
    });

    state.timer = window.setTimeout(() => {
        finishCurrent(overlay);
        state.timer = null;
        state.active = false;
        window.setTimeout(() => playNext(overlay), 110);
    }, Math.max(900, Number(next.duration) || 1480));
}

export class LocalResultFx {
    static enqueue(overlay, entries = []) {
        if (!overlay || !entries.length) return;
        const state = getState(overlay);
        state.queue.push(...entries);
        playNext(overlay);
    }

    static clear(overlay) {
        if (!overlay) return;
        const state = getState(overlay);
        state.queue = [];
        state.active = false;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        finishCurrent(overlay);
        state.root?.remove();
        state.root = null;
    }
}
