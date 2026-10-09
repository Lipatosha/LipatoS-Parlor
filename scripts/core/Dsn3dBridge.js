/**
 * Dice So Nice 适配层
 *
 * 我们的骰子结果已经在 GM 端算好了，DSN 这里只做"播放面值"的事——
 * 构造一个 1dN 的 Roll，把面值塞回 Die 的 results，再交给 showForRoll，
 * 让本机骰子飞一段动画。同步广播交给 parlor 自己的 socket 层，DSN 这边
 * 一律 synchronize=false，避免 chatMessage / blind / 双重播放打架。
 */

const MODULE_ID = 'parlor';
const SETTING_KEY = 'dsnIntegration';
// 原生桌面在 2100，PresenterHost 在 3000。之前只抬到 2200，酒馆皮肤一开就会把
// DSN 整层压住，只剩声音。3100 让骰子越过牌桌，但仍低于 3200 的系统对话框。
const STAGE_Z_INDEX = '3100';
const DEBUG_PREFIX = '[DEBUG-DSN]';

function debugDsn(event, details = {}) {
    console.warn(`${DEBUG_PREFIX} ${event}`, details);
}

function getMode() {
    try {
        return game.settings.get(MODULE_ID, SETTING_KEY) || 'auto';
    } catch (_err) {
        return 'auto';
    }
}

const _stageHolders = new Set();
// stage-keyed：DSN 重建舞台节点时，各自恢复各自的原值，不会串号。
const _savedStylesByStage = new WeakMap();

function asElement(value) {
    if (value instanceof HTMLElement) return value;
    return value?.[0] instanceof HTMLElement ? value[0] : null;
}

function safeComputedStyle(element) {
    try {
        return globalThis.getComputedStyle?.(element) || null;
    } catch (_err) {
        return null;
    }
}

function snapshotElement(element) {
    if (!element) return null;
    const style = safeComputedStyle(element);
    const rect = element.getBoundingClientRect?.();
    const parent = element.parentElement;
    const className = typeof element.className === 'string'
        ? element.className
        : String(element.className?.baseVal || '');
    return {
        tag: String(element.tagName || element.nodeName || '').toLowerCase(),
        id: String(element.id || ''),
        className,
        isConnected: element.isConnected ?? null,
        inlinePosition: String(element.style?.position || ''),
        inlineZIndex: String(element.style?.zIndex || ''),
        computedPosition: String(style?.position || ''),
        computedZIndex: String(style?.zIndex || ''),
        display: String(style?.display || ''),
        visibility: String(style?.visibility || ''),
        opacity: String(style?.opacity || ''),
        pointerEvents: String(style?.pointerEvents || element.style?.pointerEvents || ''),
        transform: String(style?.transform || ''),
        width: String(style?.width || ''),
        height: String(style?.height || ''),
        rect: rect ? {
            left: Math.round(Number(rect.left || 0)),
            top: Math.round(Number(rect.top || 0)),
            width: Math.round(Number(rect.width || 0)),
            height: Math.round(Number(rect.height || 0))
        } : null,
        parent: parent ? {
            tag: String(parent.tagName || '').toLowerCase(),
            id: String(parent.id || ''),
            className: typeof parent.className === 'string' ? parent.className : ''
        } : null
    };
}

function snapshotAncestorChain(element) {
    const ancestors = [];
    let current = element?.parentElement || null;
    while (current && ancestors.length < 8) {
        const style = safeComputedStyle(current);
        ancestors.push({
            tag: String(current.tagName || '').toLowerCase(),
            id: String(current.id || ''),
            className: typeof current.className === 'string' ? current.className : '',
            position: String(style?.position || ''),
            zIndex: String(style?.zIndex || ''),
            transform: String(style?.transform || ''),
            opacity: String(style?.opacity || ''),
            isolation: String(style?.isolation || '')
        });
        current = current.parentElement;
    }
    return ancestors;
}

function snapshotPresenterRoots() {
    return Array.from(document.querySelectorAll?.('.parlor-presenter-root') || [])
        .map(snapshotElement);
}

function snapshotDsnRuntime() {
    const dice3d = game.dice3d;
    return {
        mode: getMode(),
        moduleActive: !!game.modules?.get?.('dice-so-nice')?.active,
        hasDice3d: !!dice3d,
        boxRunning: dice3d?.box?.running ?? null,
        boxVisible: dice3d?.box?.isVisible ?? null,
        publicCanvas: snapshotElement(asElement(dice3d?.canvas)),
        rendererCanvas: snapshotElement(asElement(dice3d?.box?.renderer?.domElement))
    };
}

function getDsnStageSelection() {
    // 真正建立堆叠上下文的是 #dice-box-canvas 容器。优先抬它，不能误抬内部 WebGL canvas，
    // 子节点的 z-index 无法越过父容器，正是之前“有声音没画面”仍然存在的另一层原因。
    const candidates = [
        { source: 'dom:#dice-box-canvas', element: asElement(document.getElementById('dice-box-canvas')) },
        { source: 'game.dice3d.canvas', element: asElement(game.dice3d?.canvas) },
        { source: 'game.dice3d.box.element', element: asElement(game.dice3d?.box?.element) },
        { source: 'game.dice3d.box.canvas', element: asElement(game.dice3d?.box?.canvas) }
    ];
    const selected = candidates.find(candidate => candidate.element) || null;
    return {
        stage: selected?.element || null,
        source: selected?.source || 'none',
        candidates: candidates.map(candidate => ({
            source: candidate.source,
            present: !!candidate.element
        }))
    };
}

function applyStageRaise(reason = 'unspecified') {
    const selection = getDsnStageSelection();
    const stage = selection.stage;
    if (!stage) {
        debugDsn('stage.raise.missing', {
            reason,
            holderCount: _stageHolders.size,
            holders: [..._stageHolders],
            candidates: selection.candidates,
            runtime: snapshotDsnRuntime()
        });
        return null;
    }
    if (!_savedStylesByStage.has(stage)) {
        _savedStylesByStage.set(stage, {
            zIndex: stage.style.zIndex || '',
            pointerEvents: stage.style.pointerEvents || ''
        });
    }
    stage.style.zIndex = STAGE_Z_INDEX;
    // DSN 默认就 pointer-events:none，这里兜一下底，免得偶发被改回去挡到操作
    stage.style.pointerEvents = 'none';
    debugDsn('stage.raise.applied', {
        reason,
        source: selection.source,
        holderCount: _stageHolders.size,
        holders: [..._stageHolders],
        candidates: selection.candidates,
        stage: snapshotElement(stage),
        ancestors: snapshotAncestorChain(stage),
        presenterRoots: snapshotPresenterRoots(),
        runtime: snapshotDsnRuntime()
    });
    return stage;
}

function releaseStageRaise(reason = 'unspecified') {
    const selection = getDsnStageSelection();
    const stage = selection.stage;
    if (!stage) {
        debugDsn('stage.restore.missing', { reason, candidates: selection.candidates });
        return;
    }
    const saved = _savedStylesByStage.get(stage);
    if (!saved) {
        debugDsn('stage.restore.skipped', {
            reason,
            source: selection.source,
            stage: snapshotElement(stage)
        });
        return;
    }
    const before = snapshotElement(stage);
    stage.style.zIndex = saved.zIndex;
    stage.style.pointerEvents = saved.pointerEvents;
    _savedStylesByStage.delete(stage);
    debugDsn('stage.restore.applied', {
        reason,
        source: selection.source,
        before,
        after: snapshotElement(stage)
    });
}

function getAvailabilitySnapshot() {
    const mode = getMode();
    const moduleActive = !!game.modules?.get?.('dice-so-nice')?.active;
    const dice3d = game.dice3d;
    let enabled = null;
    let enabledError = '';
    if (typeof dice3d?.isEnabled === 'function') {
        try {
            enabled = !!dice3d.isEnabled();
        } catch (err) {
            enabled = false;
            enabledError = String(err?.message || err || 'unknown');
        }
    }
    return {
        available: mode !== 'off' && moduleActive && !!dice3d && enabled !== false,
        mode,
        moduleActive,
        hasDice3d: !!dice3d,
        enabled,
        enabledError
    };
}

export const Dsn3dBridge = {
    SETTING_KEY,

    /**
     * parlor overlay 打开时调用，把 DSN 画布层级抬到我们的 overlay 之上。
     * 多桌同时开走引用计数，最后一桌关掉再恢复。
     */
    attachOverlay(token) {
        if (!token) return;
        const wasEmpty = _stageHolders.size === 0;
        _stageHolders.add(token);
        debugDsn('overlay.attach', {
            token,
            wasEmpty,
            holderCount: _stageHolders.size,
            holders: [..._stageHolders],
            availability: getAvailabilitySnapshot(),
            runtime: snapshotDsnRuntime()
        });
        if (wasEmpty) applyStageRaise('overlay.attach');
    },

    detachOverlay(token) {
        if (!token) return;
        const existed = _stageHolders.delete(token);
        debugDsn('overlay.detach', {
            token,
            existed,
            holderCount: _stageHolders.size,
            holders: [..._stageHolders]
        });
        if (_stageHolders.size === 0) releaseStageRaise('overlay.detach');
    },

    isAvailable() {
        const availability = getAvailabilitySnapshot();
        debugDsn('availability.check', {
            availability,
            holderCount: _stageHolders.size,
            runtime: snapshotDsnRuntime()
        });
        return availability.available;
    },

    /**
     * 用预定好的面值，让 DSN 在本机播一段 NdN 动画。
     * @param {number[]} values 1-6 的面值数组
     * @param {object} [options]
     * @param {boolean} [options.broadcast] 是否同步到其他玩家；parlor 已有自己的广播，默认不开
     * @param {string|null} [options.ownerUserId] 骰子主人的 userId，DSN 会用他的皮肤；缺省 = 本机用户
     * @returns {Promise<boolean>} 没播或播失败都解析为 false，不抛
     */
    async rollD6Visuals(values, { broadcast = false, ownerUserId = null } = {}) {
        const availability = getAvailabilitySnapshot();
        debugDsn('roll.request', {
            values: Array.isArray(values) ? [...values] : values,
            broadcast: !!broadcast,
            ownerUserId,
            holderCount: _stageHolders.size,
            holders: [..._stageHolders],
            availability,
            runtime: snapshotDsnRuntime()
        });
        if (!availability.available) {
            debugDsn('roll.skipped', { reason: 'unavailable', availability });
            return false;
        }
        const faces = (Array.isArray(values) ? values : [])
            .map(value => Math.max(1, Math.min(6, Math.floor(Number(value) || 0))))
            .filter(value => value >= 1 && value <= 6);
        if (!faces.length) {
            debugDsn('roll.skipped', { reason: 'no-valid-faces', values });
            return false;
        }

        try {
            // DSN canvas 是懒创建的——attachOverlay 时它可能还没存在；这里再补一遍
            if (_stageHolders.size > 0) applyStageRaise('roll.before-show');
            else debugDsn('stage.raise.skipped', { reason: 'no-overlay-holder' });

            const roll = new Roll(`${faces.length}d6`);
            await roll.evaluate();

            const dieTerm = roll.terms?.[0];
            if (dieTerm?.results?.length) {
                for (let i = 0; i < dieTerm.results.length; i += 1) {
                    const next = faces[i] ?? dieTerm.results[i].result;
                    dieTerm.results[i].result = next;
                    dieTerm.results[i].active = true;
                    dieTerm.results[i].discarded = false;
                }
            }
            // 重新算总和，免得 DSN 内部对照时被原始随机值带飞
            roll._total = faces.reduce((sum, value) => sum + value, 0);

            // user 决定 DSN 用谁的皮肤/颜色；查不到 owner 就退回本机用户
            const owner = ownerUserId ? game.users?.get(ownerUserId) : null;
            const speakingUser = owner || game.user;

            const beforeSelection = getDsnStageSelection();
            debugDsn('roll.showForRoll.before', {
                faces,
                formula: String(roll.formula || `${faces.length}d6`),
                total: roll.total ?? roll._total ?? null,
                broadcast: !!broadcast,
                ownerUserId,
                speakingUserId: speakingUser?.id || null,
                hasShowForRoll: typeof game.dice3d?.showForRoll === 'function',
                stageSource: beforeSelection.source,
                stage: snapshotElement(beforeSelection.stage),
                ancestors: snapshotAncestorChain(beforeSelection.stage),
                presenterRoots: snapshotPresenterRoots(),
                runtime: snapshotDsnRuntime()
            });

            // showForRoll(roll, user, synchronize, whisper, blind, chatMessageID, speaker)
            // 这里 synchronize 走配置——默认 false，跨端动画由 parlor 自己的 socket 触发
            const result = await game.dice3d.showForRoll(
                roll,
                speakingUser,
                !!broadcast,
                null,
                false,
                null,
                null
            );
            const afterSelection = getDsnStageSelection();
            debugDsn('roll.showForRoll.after', {
                result: result ?? null,
                resultType: typeof result,
                stageSource: afterSelection.source,
                stage: snapshotElement(afterSelection.stage),
                runtime: snapshotDsnRuntime()
            });
            return !!result;
        } catch (err) {
            debugDsn('roll.error', {
                message: String(err?.message || err || 'unknown'),
                stack: String(err?.stack || ''),
                runtime: snapshotDsnRuntime()
            });
            console.warn(`${MODULE_ID} | DSN 动画播放失败，已降级到 HTML 骰子`, err);
            return false;
        }
    }
};
