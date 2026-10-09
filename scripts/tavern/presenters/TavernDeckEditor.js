/**
 * TavernDeckEditor — 赌桌编辑模式(桌台工坊 W3)
 *
 * GM 在酒馆桌上直接编辑当前赌桌预设:桌名 / 桌角样式与金属色 / 毛毡色 / 桌面画风 /
 * 摆件(抽屉取件、拖动摆放、Ctrl+滚轮旋转、滚轮缩放、层级排序、选中调色换造型、Delete 删除)。
 * 编辑期间只改本地草稿并实时预览(shell._applyDeck),点保存才写回 world setting。
 */

import { PROP_TYPES, PROP_PALETTES, PROP_SIZE_KEY, PROP_SIZE_VERSION, getPropType, renderPropSvg } from '../props/PropLibrary.js';
import { clampPropToTable } from '../props/TableGeometry.js';
import {
    TABLE_STYLE_PRESETS,
    WOOD_MATERIAL_PRESETS,
    resolveTableSurface,
    tableSurfaceId,
    woodAssetPath
} from '../props/WoodPresets.js';

const DEFAULT_DECK = () => ({
    id: '',
    name: '',
    corner: { style: 'metal', color: '#a87f22' },
    felt: { color: '#5c1c21', visible: true },
    surface: { wood: tableSurfaceId('semi-real', 'tavern') },
    backdrop: { src: '', blur: 4, bright: 0.5, opacity: 1 },
    props: []
});

// V13/V14 的 FilePicker 取法(照本体 AppearanceConfigApp 的姿势)
function getFilePickerClass() {
    const globalPicker = globalThis.FilePicker;
    const foundryPicker = globalThis.foundry?.applications?.apps?.FilePicker;
    return globalPicker?.implementation || globalPicker || foundryPicker?.implementation || foundryPicker || null;
}

export class TavernDeckEditor {
    constructor(shell, { setActiveOnSave = true, onClose = null } = {}) {
        this._shell = shell;
        this._root = shell._root;
        // 桌上编辑的就是"今夜赌桌",保存顺手激活;大厅工坊里编辑任意预设,不能抢激活位
        this._setActiveOnSave = setActiveOnSave;
        this._onClose = typeof onClose === 'function' ? onClose : null;
        this._draft = null;
        this._selected = -1;
        this._el = null;
        this._selectionEl = null;
        this._interactionAbort = null;
        this._sceneResizeObserver = null;
        this._onResize = () => this._positionSelectionOverlay();
        this._onKeyDown = (ev) => {
            if (ev.key === 'Delete' && this._selected >= 0) {
                this._draft.props.splice(this._selected, 1);
                this._selected = -1;
                this._refreshAll();
            }
        };
    }

    get api() {
        // 契约允许的公开面:主题经 module.api 使用本体服务
        return game.modules.get('parlor')?.api?.tableDecks || null;
    }

    _t(key, data = null) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }

    open() {
        if (this._el || !this._root) return;
        const active = this._shell._api?.getTableDeck?.();
        this._draft = active ? foundry.utils.deepClone(active) : DEFAULT_DECK();
        this._root.classList.add('ptt-editing');
        this._buildUi();
        this._bindPropInteractions();
        document.addEventListener('keydown', this._onKeyDown);
        this._refreshAll();
    }

    close(revert = true) {
        if (!this._el) return;
        document.removeEventListener('keydown', this._onKeyDown);
        this._interactionAbort?.abort();
        this._interactionAbort = null;
        this._sceneResizeObserver?.disconnect();
        this._sceneResizeObserver = null;
        this._root?.classList.remove('ptt-editing');
        this._selectionEl?.remove();
        this._selectionEl = null;
        this._el?.remove();
        this._el = null;
        this._selected = -1;
        if (revert) this._shell._syncDeck(true); // 丢弃草稿,回到已存预设
        this._onClose?.();
    }

    async save() {
        if (!this.api) return;
        const saved = await this.api.save(this._draft);
        if (saved) {
            if (this._setActiveOnSave) await this.api.setActive(saved.id);
            this._draft = saved;
            ui.notifications?.info(saved.name);
            // 先让桌面对齐存档(sanitize 可能夹取过数值),再 close——close 可能连带销毁宿主
            this._shell._syncDeck(true);
            this.close(false);
        }
    }

    // ── UI ──────────────────────────────────────────────────

    _buildUi() {
        const el = document.createElement('div');
        el.className = 'deck-editor';
        el.innerHTML = `
            <div class="de-topbar">
                <label class="de-field"><span>${this._t('PARLORTAVERN.Workshop.TableName')}</span><input type="text" data-de="name" maxlength="60"></label>
                <div class="de-field"><span>${this._t('PARLORTAVERN.Workshop.Corners')}</span>
                    <div class="de-seg" data-de="cornerStyle">
                        <button data-v="metal">${this._t('PARLORTAVERN.Workshop.CornerMetal')}</button><button data-v="filigree">${this._t('PARLORTAVERN.Workshop.CornerFiligree')}</button><button data-v="none">${this._t('PARLORTAVERN.Workshop.CornerNone')}</button>
                    </div>
                    <input type="color" data-de="cornerColor" title="${this._t('PARLORTAVERN.Workshop.CornerColor')}">
                </div>
                <div class="de-field"><span>${this._t('PARLORTAVERN.Workshop.Felt')}</span>
                    <input type="color" data-de="feltColor" title="${this._t('PARLORTAVERN.Workshop.FeltColor')}">
                    <button class="de-btn de-felt-toggle" type="button" data-de="feltToggle" aria-pressed="true">${this._t('PARLORTAVERN.Workshop.FeltShown')}</button>
                </div>
                <div class="de-field"><span>${this._t('PARLORTAVERN.Workshop.SurfaceStyle')}</span>
                    <div class="de-styles" data-de="styles"></div>
                </div>
                <div class="de-field" data-de="materialField"><span>${this._t('PARLORTAVERN.Workshop.SurfaceMaterial')}</span>
                    <div class="de-materials" data-de="materials"></div>
                </div>
                <button class="de-btn" data-de="bgToggle">${this._t('PARLORTAVERN.Workshop.Background')}</button>
                <span class="de-spacer"></span>
                <button class="de-btn gold" data-de="save">${this._t('PARLORTAVERN.Workshop.Save')}</button>
                <button class="de-btn" data-de="cancel">${this._t('PARLORTAVERN.Workshop.Cancel')}</button>
            </div>
            <div class="de-bg" data-de="bg" hidden>
                <div class="de-bg-row">
                    <input type="text" data-de="bgSrc" placeholder="${this._t('PARLORTAVERN.Workshop.BackgroundSourcePlaceholder')}" spellcheck="false">
                    <button class="de-btn" data-de="bgBrowse">${this._t('PARLORTAVERN.Workshop.Browse')}</button>
                    <button class="de-btn" data-de="bgClear">${this._t('PARLORTAVERN.Workshop.Clear')}</button>
                </div>
                <div class="de-bg-row de-bg-sliders">
                    <label><span>${this._t('PARLORTAVERN.Workshop.Blur')}</span><input type="range" data-de="bgBlur" min="0" max="30" step="1"></label>
                    <label><span>${this._t('PARLORTAVERN.Workshop.Brightness')}</span><input type="range" data-de="bgBright" min="0.1" max="1" step="0.05"></label>
                    <label><span>${this._t('PARLORTAVERN.Workshop.Opacity')}</span><input type="range" data-de="bgOpacity" min="0.1" max="1" step="0.05"></label>
                </div>
            </div>
            <div class="de-drawer" data-de="drawer"></div>
            <div class="de-panel" data-de="panel" hidden></div>
        `;
        this._root.appendChild(el);
        this._el = el;
        this._buildSelectionOverlay();

        // 摆件抽屉:18 件缩略,点一下放到桌心并选中
        el.querySelector('[data-de="drawer"]').innerHTML = PROP_TYPES.map(p => `
            <button class="de-thumb" data-type="${p.id}" title="${this._t(p.nameKey)}">${renderPropSvg(p.id)}</button>
        `).join('');

        el.querySelector('[data-de="styles"]').innerHTML = TABLE_STYLE_PRESETS.map(style => `
            <button class="de-style" type="button" data-style="${style.id}" title="${this._t(style.hintKey)}" aria-pressed="false">
                <i aria-hidden="true"></i><span>${style.code} · ${this._t(style.nameKey)}</span>
            </button>
        `).join('');

        el.querySelector('[data-de="materials"]').innerHTML = WOOD_MATERIAL_PRESETS.map(material => {
            const name = this._t(material.nameKey);
            const filter = material.filter ? `filter:${material.filter};` : '';
            return `
                <button class="de-material" type="button" data-material="${material.id}" title="${name}" aria-label="${name}" aria-pressed="false">
                    <i aria-hidden="true" style="background-image:url('${woodAssetPath(material)}');${filter}"></i>
                </button>
            `;
        }).join('');

        // 顶部控件事件
        const q = sel => el.querySelector(sel);
        q('[data-de="name"]').addEventListener('input', ev => { this._draft.name = ev.target.value; this._preview(); });
        q('[data-de="cornerStyle"]').addEventListener('click', ev => {
            const btn = ev.target.closest('button'); if (!btn) return;
            this._draft.corner.style = btn.dataset.v;
            this._refreshTopbar(); this._preview();
        });
        q('[data-de="cornerColor"]').addEventListener('input', ev => { this._draft.corner.color = ev.target.value; this._preview(); });
        q('[data-de="feltColor"]').addEventListener('input', ev => { this._draft.felt.color = ev.target.value; this._preview(); });
        q('[data-de="feltToggle"]').addEventListener('click', () => {
            this._draft.felt.visible = this._draft.felt.visible === false;
            this._refreshTopbar();
            this._preview();
        });
        q('[data-de="styles"]').addEventListener('click', ev => {
            const btn = ev.target.closest('.de-style'); if (!btn) return;
            const current = resolveTableSurface(this._draft.surface?.wood);
            this._draft.surface = {
                ...(this._draft.surface || {}),
                wood: tableSurfaceId(btn.dataset.style, current.material.id)
            };
            this._refreshTopbar(); this._preview();
        });
        q('[data-de="materials"]').addEventListener('click', ev => {
            const btn = ev.target.closest('.de-material'); if (!btn) return;
            const current = resolveTableSurface(this._draft.surface?.wood);
            this._draft.surface = {
                ...(this._draft.surface || {}),
                wood: tableSurfaceId(current.style.id, btn.dataset.material)
            };
            this._refreshTopbar(); this._preview();
        });

        // 背景面板:路径/浏览/清除/三滑杆,全部实时预览("看着调")
        const bg = () => (this._draft.backdrop ??= { src: '', blur: 4, bright: 0.5, opacity: 1 });
        q('[data-de="bgToggle"]').addEventListener('click', () => {
            const panel = q('[data-de="bg"]');
            panel.hidden = !panel.hidden;
            q('[data-de="bgToggle"]').classList.toggle('on', !panel.hidden);
        });
        q('[data-de="bgSrc"]').addEventListener('change', ev => { bg().src = ev.target.value.trim(); this._preview(); });
        q('[data-de="bgClear"]').addEventListener('click', () => { bg().src = ''; this._refreshTopbar(); this._preview(); });
        q('[data-de="bgBrowse"]').addEventListener('click', () => this._browseBackdrop());
        q('[data-de="bgBlur"]').addEventListener('input', ev => { bg().blur = Number(ev.target.value); this._preview(); });
        q('[data-de="bgBright"]').addEventListener('input', ev => { bg().bright = Number(ev.target.value); this._preview(); });
        q('[data-de="bgOpacity"]').addEventListener('input', ev => { bg().opacity = Number(ev.target.value); this._preview(); });
        q('[data-de="save"]').addEventListener('click', () => this.save());
        q('[data-de="cancel"]').addEventListener('click', () => this.close(true));
        q('[data-de="drawer"]').addEventListener('click', ev => {
            const btn = ev.target.closest('.de-thumb'); if (!btn) return;
            // 新摆件一律打真实尺寸标记;老存档没标记,继续按原来的大小渲染
            this._draft.props.push({
                type: btn.dataset.type, x: 0.5, y: 0.5, rot: 0, scale: 1,
                colors: {}, styles: { [PROP_SIZE_KEY]: PROP_SIZE_VERSION }
            });
            this._selected = this._draft.props.length - 1;
            this._refreshAll();
        });
    }

    _buildSelectionOverlay() {
        const scene = this._root.querySelector('.scene');
        if (!scene) return;
        const back = this._t('PARLORTAVERN.Workshop.MoveBackward');
        const forward = this._t('PARLORTAVERN.Workshop.MoveForward');
        const overlay = document.createElement('div');
        overlay.className = 'de-selection-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
            <div class="de-selection-hint" data-de="selectionHint" aria-live="polite"></div>
            <div class="de-order-actions">
                <button type="button" data-order="back" title="${this._t('PARLORTAVERN.Workshop.MoveBackwardHint')}">${back}</button>
                <button type="button" data-order="forward" title="${this._t('PARLORTAVERN.Workshop.MoveForwardHint')}">${forward}</button>
            </div>
        `;
        overlay.addEventListener('pointerdown', ev => ev.stopPropagation());
        overlay.addEventListener('click', ev => {
            const button = ev.target.closest('[data-order]');
            if (!button || button.disabled) return;
            this._shiftSelectedLayer(button.dataset.order === 'forward' ? 1 : -1);
        });
        scene.appendChild(overlay);
        this._selectionEl = overlay;
    }

    _refreshTopbar() {
        const q = sel => this._el.querySelector(sel);
        q('[data-de="name"]').value = this._draft.name || '';
        q('[data-de="cornerColor"]').value = this._draft.corner?.color || '#a87f22';
        const feltVisible = this._draft.felt?.visible !== false;
        const feltColor = q('[data-de="feltColor"]');
        const feltToggle = q('[data-de="feltToggle"]');
        feltColor.value = this._draft.felt?.color || '#5c1c21';
        feltColor.disabled = !feltVisible;
        feltToggle.classList.toggle('on', feltVisible);
        feltToggle.setAttribute('aria-pressed', String(feltVisible));
        feltToggle.textContent = this._t(feltVisible
            ? 'PARLORTAVERN.Workshop.FeltShown'
            : 'PARLORTAVERN.Workshop.FeltHidden');
        const surface = resolveTableSurface(this._draft.surface?.wood);
        q('[data-de="styles"]').querySelectorAll('.de-style').forEach(b => {
            const selected = b.dataset.style === surface.style.id;
            b.classList.toggle('on', selected);
            b.setAttribute('aria-pressed', String(selected));
        });
        q('[data-de="materialField"]').hidden = surface.style.id !== 'semi-real';
        q('[data-de="materials"]').querySelectorAll('.de-material').forEach(b => {
            const selected = b.dataset.material === surface.material.id;
            b.classList.toggle('on', selected);
            b.setAttribute('aria-pressed', String(selected));
        });
        q('[data-de="cornerStyle"]').querySelectorAll('button').forEach(b =>
            b.classList.toggle('on', b.dataset.v === (this._draft.corner?.style || 'metal')));
        const bd = this._draft.backdrop || {};
        q('[data-de="bgSrc"]').value = bd.src || '';
        q('[data-de="bgBlur"]').value = bd.blur ?? 4;
        q('[data-de="bgBright"]').value = bd.bright ?? 0.5;
        q('[data-de="bgOpacity"]').value = bd.opacity ?? 1;
    }

    // FilePicker 是普通 FVTT 窗口(z~100),会被 z3000 的呈现器层整个盖住——render 完手动抬 z
    async _browseBackdrop() {
        const Picker = getFilePickerClass();
        if (!Picker) return;
        const picker = new Picker({
            type: 'imagevideo',
            current: this._draft.backdrop?.src || '',
            callback: (path) => {
                (this._draft.backdrop ??= { src: '', blur: 4, bright: 0.5, opacity: 1 }).src = String(path || '');
                this._refreshTopbar();
                this._preview();
            }
        });
        await picker.render(true);
        const el = picker.element instanceof HTMLElement ? picker.element : picker.element?.[0];
        if (el) el.style.zIndex = 3200;
    }

    // 选中摆件的参数板:部件色板 + 造型按钮 + 变体预设 + 删除
    _refreshPanel() {
        const panel = this._el.querySelector('[data-de="panel"]');
        const prop = this._draft.props[this._selected];
        const type = prop ? getPropType(prop.type) : null;
        if (!prop || !type) { panel.hidden = true; return; }
        panel.hidden = false;
        panel.innerHTML = `
            <div class="de-panel-head">${this._t(type.nameKey)}<button class="de-btn danger" data-p="remove">${this._t('PARLORTAVERN.Workshop.RemoveProp')}</button></div>
            ${type.spin ? `
            <div class="de-cap">${this._t('PARLORTAVERN.Workshop.Rotation')} <em class="de-rot-val">${Math.round(Number(prop.rot) || 0)}°</em></div>
            <input type="range" class="de-rot" data-p="rot" min="-180" max="180" step="5" value="${Math.round(Number(prop.rot) || 0)}">`
            // 圆对称件不给转:光影烤在路径里,一转顶光就跑偏,而且转了也看不出朝向
            : `<div class="de-cap de-dim">${this._t('PARLORTAVERN.Workshop.SymmetricNoRotation')}</div>`}
            ${type.variants?.length ? `<div class="de-cap">${this._t('PARLORTAVERN.Workshop.Variants')}</div><div class="de-vrow">${type.variants.map((v, i) => `<button class="de-vbtn" data-variant="${i}">${this._t(v.nameKey)}</button>`).join('')}</div>` : ''}
            ${type.styles.map(st => `
                <div class="de-cap">${this._t(st.labelKey)}</div>
                <div class="de-seg" data-style="${st.key}">
                    ${st.options.map(o => `<button data-v="${o.id}" class="${(prop.styles?.[st.key] || st.options[0].id) === o.id ? 'on' : ''}">${this._t(o.labelKey)}</button>`).join('')}
                </div>`).join('')}
            ${type.parts.map(part => {
                const val = prop.colors?.[part.key] || part.def;
                const pal = PROP_PALETTES[part.pal] || PROP_PALETTES.metal;
                return `
                <div class="de-cap">${this._t(part.labelKey)}</div>
                <div class="de-swatches" data-part="${part.key}">
                    ${pal.map(c => `<span class="de-sw${c.toLowerCase() === val.toLowerCase() ? ' on' : ''}" data-c="${c}" style="background:${c}"></span>`).join('')}
                    <input type="color" value="${val}">
                </div>`;
            }).join('')}
        `;
        panel.onclick = ev => {
            const prop2 = this._draft.props[this._selected];
            if (!prop2) return;
            if (ev.target.closest('[data-p="remove"]')) {
                this._draft.props.splice(this._selected, 1);
                this._selected = -1;
                this._refreshAll();
                return;
            }
            const vbtn = ev.target.closest('.de-vbtn');
            if (vbtn) {
                const v = type.variants[+vbtn.dataset.variant];
                prop2.colors = { ...(v.p || {}) };
                // 变体只换造型,别把尺寸制式标记一起冲掉
                const sz = prop2.styles?.[PROP_SIZE_KEY];
                prop2.styles = { ...(v.s || {}), ...(sz ? { [PROP_SIZE_KEY]: sz } : {}) };
                this._refreshAll();
                return;
            }
            const sbtn = ev.target.closest('.de-seg button');
            if (sbtn) {
                prop2.styles = { ...(prop2.styles || {}), [ev.target.closest('.de-seg').dataset.style]: sbtn.dataset.v };
                this._refreshAll();
                return;
            }
            const sw = ev.target.closest('.de-sw');
            if (sw) {
                prop2.colors = { ...(prop2.colors || {}), [ev.target.closest('.de-swatches').dataset.part]: sw.dataset.c };
                this._refreshAll();
            }
        };
        panel.oninput = ev => {
            const prop2 = this._draft.props[this._selected];
            if (!prop2) return;
            if (ev.target.dataset.p === 'rot') {
                prop2.rot = Number(ev.target.value) || 0;
                const label = panel.querySelector('.de-rot-val');
                if (label) label.textContent = `${Math.round(prop2.rot)}°`;
                this._preview();
                return;
            }
            if (ev.target.type !== 'color') return;
            prop2.colors = { ...(prop2.colors || {}), [ev.target.closest('.de-swatches').dataset.part]: ev.target.value };
            this._preview();
        };
    }

    // ── 摆件桌面交互(拖/转/缩/排序/选)────────────────────────

    _bindPropInteractions() {
        const propsHost = this._root.querySelector('.props');
        const scene = this._root.querySelector('.scene');
        if (!propsHost || !scene) return;
        this._interactionAbort?.abort();
        const controller = new AbortController();
        const { signal } = controller;
        this._interactionAbort = controller;
        window.addEventListener('resize', this._onResize, { signal });
        if (globalThis.ResizeObserver) {
            this._sceneResizeObserver?.disconnect();
            this._sceneResizeObserver = new globalThis.ResizeObserver(this._onResize);
            this._sceneResizeObserver.observe(scene);
        }

        propsHost.addEventListener('pointerdown', ev => {
            const node = ev.target.closest('.prop');
            if (!node || !this._el) return;
            ev.preventDefault();
            const index = Number(node.dataset.propIndex);
            if (!Number.isInteger(index)) return;
            this._selected = index;
            this._refreshPanel();
            this._markSelected();

            const rect = scene.getBoundingClientRect();
            const prop = this._draft.props[index];
            node.setPointerCapture(ev.pointerId);
            node.classList.add('dragging');
            const move = mv => {
                [prop.x, prop.y] = clampPropToTable(
                    (mv.clientX - rect.left) / rect.width,
                    (mv.clientY - rect.top) / rect.height,
                    prop
                );
                node.style.left = `${(prop.x * 100).toFixed(2)}%`;
                node.style.top = `${(prop.y * 100).toFixed(2)}%`;
                this._positionSelectionOverlay();
            };
            const up = () => {
                node.classList.remove('dragging');
                node.removeEventListener('pointermove', move);
                node.removeEventListener('pointerup', up);
                node.removeEventListener('pointercancel', up);
                // 拖过毛毡边界后重画一次，落点材质和影子才能马上对上。
                this._preview();
            };
            node.addEventListener('pointermove', move, { signal });
            node.addEventListener('pointerup', up, { signal });
            node.addEventListener('pointercancel', up, { signal });
        }, { signal });

        propsHost.addEventListener('wheel', ev => {
            const node = ev.target.closest('.prop');
            if (!node || !this._el) return;
            ev.preventDefault();
            const index = Number(node.dataset.propIndex);
            if (!Number.isInteger(index)) return;
            const prop = this._draft.props[index];
            if (!prop) return;
            this._selected = index;

            if (ev.ctrlKey) {
                // 圆对称件的顶光画在 SVG 里，硬转只会让光向穿帮。
                if (!getPropType(prop.type)?.spin) {
                    this._refreshPanel();
                    this._markSelected();
                    return;
                }
                const next = (Number(prop.rot) || 0) + (ev.deltaY < 0 ? 5 : -5);
                prop.rot = ((next + 180) % 360 + 360) % 360 - 180;
                this._refreshPanel();
            } else {
                prop.scale = Math.max(0.4, Math.min(2.5, (Number(prop.scale) || 1) + (ev.deltaY < 0 ? 0.08 : -0.08)));
                // 放大后可能探出桌板太多，顺手把位置收回完整桌面范围
                [prop.x, prop.y] = clampPropToTable(prop.x, prop.y, prop);
            }
            this._preview();
        }, { passive: false, signal });
    }

    _shiftSelectedLayer(delta) {
        const props = this._draft?.props;
        if (!Array.isArray(props) || this._selected < 0) return;
        // 老存档可能还留着已下架的摆件。排序只跨可见项，不能让一个空条目吃掉点击。
        const visible = props.flatMap((prop, index) => getPropType(prop.type) ? [index] : []);
        const current = visible.indexOf(this._selected);
        if (current < 0) return;
        const targetPosition = Math.max(0, Math.min(visible.length - 1, current + Math.sign(delta)));
        const target = visible[targetPosition];
        if (target === this._selected) return;
        [props[this._selected], props[target]] = [props[target], props[this._selected]];
        this._selected = target;
        this._refreshAll();
    }

    _positionSelectionOverlay() {
        const overlay = this._selectionEl;
        const scene = this._root?.querySelector('.scene');
        const node = this._root?.querySelector(`.props .prop[data-prop-index="${this._selected}"]`);
        if (!overlay || !scene || !node) return;
        const sceneRect = scene.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        overlay.style.left = `${nodeRect.left - sceneRect.left}px`;
        overlay.style.top = `${nodeRect.top - sceneRect.top}px`;
        overlay.style.width = `${nodeRect.width}px`;
        overlay.style.height = `${nodeRect.height}px`;
    }

    _markSelected() {
        const propsHost = this._root.querySelector('.props');
        const nodes = [...(propsHost?.children || [])];
        nodes.forEach(node => node.classList.toggle('selected', Number(node.dataset.propIndex) === this._selected));
        if (!this._selectionEl) return;
        const prop = this._draft?.props?.[this._selected];
        const type = prop ? getPropType(prop.type) : null;
        this._selectionEl.hidden = !type;
        if (!type) return;
        const visible = nodes.map(node => Number(node.dataset.propIndex)).filter(Number.isInteger);
        const layer = visible.indexOf(this._selected);
        const hintKey = type.spin
            ? 'PARLORTAVERN.Workshop.PropTransformHint'
            : 'PARLORTAVERN.Workshop.PropScaleHint';
        const layerStatus = this._t('PARLORTAVERN.Workshop.LayerStatus', {
            current: layer + 1,
            total: visible.length
        });
        this._selectionEl.querySelector('[data-de="selectionHint"]').textContent = `${this._t(hintKey)} · ${layerStatus}`;
        this._selectionEl.querySelector('[data-order="back"]').disabled = layer <= 0;
        this._selectionEl.querySelector('[data-order="forward"]').disabled = layer < 0 || layer >= visible.length - 1;
        this._positionSelectionOverlay();
    }

    _preview() {
        this._shell._applyDeck(this._draft);
        this._markSelected();
    }

    _refreshAll() {
        this._refreshTopbar();
        this._refreshPanel();
        this._preview();
    }
}
