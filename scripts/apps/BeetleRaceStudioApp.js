/**
 * 甲虫赛跑 · 赛事工坊（GM）
 *
 * 四个页签：赛事卡 / 甲虫 / 招式 / 气泡。预制参数只能看或复制，招式启停和台词池可单独配置。
 * 编辑的是一份草稿（this._draft），点保存才写进 world setting；切换条目时丢弃未保存的改动前会问一句。
 *
 * 文本框输入只改草稿、只刷新预览，不整窗重绘——重绘会把光标和输入法状态冲掉。
 * 结构变化（换条目、增删上场甲虫、切页签）才走 this.render()。
 */

import { BeetleRaceLibrary } from '../games/beetlerace/BeetleRaceLibrary.js';
import {
    ACTIONS,
    ACTION_IDS,
    TEMPERAMENT_IDS,
    PATTERNS,
    HORNS,
    EVENT_RATES,
    POWER_DISPLAYS,
    RACE_LIMITS,
    MOVE_LIMITS,
    PRESET_BEETLES,
    actionTunables
} from '../games/beetlerace/BeetleRaceCatalog.js';
import { BeetleActor, FxLayer, createBubble } from '../games/beetlerace/BeetleRaceRender.js';

const { ApplicationV2 } = foundry.applications.api;
const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));
const esc = (value) => foundry.utils.escapeHTML(String(value ?? ''));
const NS = 'http://www.w3.org/2000/svg';
const TABS = ['race', 'beetle', 'move', 'bubble'];
const SWATCHES = [...new Set([...PRESET_BEETLES.map(b => b.color), '#2e6f9e', '#d07a1e', '#3d3d3d', '#b8b0a0'])];

export class BeetleRaceStudioApp extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
        id: 'parlor-beetle-studio',
        classes: ['parlor-br-studio'],
        tag: 'div',
        window: { title: 'PARLOR.BeetleRace.Studio.Title', icon: 'fas fa-bug', resizable: true },
        position: { width: 1100, height: 740 }
    };

    static _instance = null;

    /** 打开（或拉到前面）。onChanged：存过东西之后回调，开桌对话用它刷新赛事卡列表 */
    static open({ tab = 'race', onChanged = null } = {}) {
        if (!game.user.isGM) {
            ui.notifications.warn(t('PARLOR.BeetleRace.Studio.GMOnly'));
            return null;
        }
        const app = new BeetleRaceStudioApp();
        if (onChanged) app._onChanged = onChanged;
        // 已经开着还在编辑的话别硬切页签，草稿会被悄悄扔掉
        if (TABS.includes(tab) && !app._dirty) app._tab = tab;
        app.render(true);
        app.bringToFront?.();
        return app;
    }

    constructor(options = {}) {
        // 设置菜单每点一次就 new 一个，同一个 id 开两扇窗会互相顶 DOM；已经开着就把那扇还回去
        if (BeetleRaceStudioApp._instance) return BeetleRaceStudioApp._instance;
        super(options);
        BeetleRaceStudioApp._instance = this;
        this._tab = 'race';
        this._selected = { race: '', beetle: '', move: '', bubble: '' };
        this._presetsOpen = { race: true, beetle: false, move: false, bubble: false };
        this._listScroll = { race: 0, beetle: 0, move: 0, bubble: 0 };
        this._renderedTab = null;
        this._renderedId = '';
        this._draft = null;
        this._dirty = false;
        this._preview = null;
        this._raf = 0;
        this._onChanged = null;
        this._hook = Hooks.on(BeetleRaceLibrary.CHANGE_HOOK, () => {
            // 别的 GM 改了素材：没在编辑就重读一遍，编辑中不打断
            if (!this.rendered || this._dirty) return;
            this._draft = null;
            this.render();
        });
    }

    async close(options = {}) {
        if (!options.force && !(await this._confirmDiscard())) return this;
        cancelAnimationFrame(this._raf);
        Hooks.off(BeetleRaceLibrary.CHANGE_HOOK, this._hook);
        BeetleRaceStudioApp._instance = null;
        return super.close(options);
    }

    // ───────── 数据 ─────────

    _list(tab = this._tab) {
        switch (tab) {
            case 'race': return BeetleRaceLibrary.listRaces();
            case 'beetle': return BeetleRaceLibrary.listBeetles();
            case 'move': return BeetleRaceLibrary.listMoves();
            default: return BeetleRaceLibrary.listBubbles();
        }
    }

    _ensureDraft() {
        const list = this._list();
        let id = this._selected[this._tab];
        if (this._draft && this._draft.__tab === this._tab && (this._draft.id === id || (!this._draft.id && !id))) return;
        let entry = list.find(item => item.id === id);
        if (!entry) {
            entry = list[0];
            id = entry?.id || '';
            this._selected[this._tab] = id;
        }
        this._draft = entry ? { ...structuredClone(entry), __tab: this._tab } : null;
        this._dirty = false;
    }

    _blank(tab) {
        switch (tab) {
            case 'race': return { id: '', name: t('PARLOR.BeetleRace.Studio.NewRaceName'), beetleIds: PRESET_BEETLES.slice(0, 4).map(b => b.id), durationSec: 30, betSeconds: 30, multiplier: 3, multipliers: {}, minBet: 1, maxBet: 0, powerDisplay: 'stars', eventRate: 'normal', parade: true };
            case 'beetle': return { id: '', name: t('PARLOR.BeetleRace.Studio.NewBeetleName'), color: '#2e6f9e', pattern: 'spots', horn: 'none', power: 5, temperament: 'steady', intro: '', catchphrase: '' };
            case 'move': return { id: '', name: t('PARLOR.BeetleRace.Studio.NewMoveName'), actionId: 'dash', bubbleId: '', bubbleIds: [], enabled: true, pool: 'cheat', duration: 0, strength: 1 };
            default: return { id: '', text: '' };
        }
    }

    async _confirmDiscard() {
        if (!this._dirty) return true;
        return foundry.applications.api.DialogV2.confirm({
            window: { title: t('PARLOR.BeetleRace.Studio.DiscardTitle') },
            content: `<p>${esc(t('PARLOR.BeetleRace.Studio.DiscardBody'))}</p>`,
            rejectClose: false
        });
    }

    // ───────── 渲染 ─────────

    async _renderHTML() {
        this._ensureDraft();
        const tabs = TABS.map(tab => `
            <button type="button" class="parlor-br-studio-tab${tab === this._tab ? ' is-on' : ''}" data-tab="${tab}">
                <i class="${{ race: 'fas fa-flag-checkered', beetle: 'fas fa-bug', move: 'fas fa-hat-wizard', bubble: 'fas fa-comment-dots' }[tab]}"></i>
                ${esc(t(`PARLOR.BeetleRace.Studio.Tab.${tab}`))}
            </button>`).join('');
        return `
            <nav class="parlor-br-studio-tabs">${tabs}</nav>
            <div class="parlor-br-studio-body">
                <aside class="parlor-br-studio-list">
                    <button type="button" class="parlor-br-btn is-accent parlor-br-studio-new" data-act="new"><i class="fas fa-plus"></i> ${esc(t(`PARLOR.BeetleRace.Studio.New.${this._tab}`))}</button>
                    <div class="parlor-br-studio-entries">${this._renderList()}</div>
                </aside>
                <section class="parlor-br-studio-edit">${this._draft ? this._renderEditor() : `<p class="parlor-br-studio-empty">${esc(t('PARLOR.BeetleRace.Studio.Empty'))}</p>`}</section>
            </div>
        `;
    }

    _replaceHTML(result, content) {
        // ApplicationV2 替换节点后会丢掉滚动状态；这里按旧 DOM 的页签记录，切页签时不会串位置。
        if (this._renderedTab) this._listScroll[this._renderedTab] = content.querySelector('.parlor-br-studio-entries')?.scrollTop || 0;
        const sameEntry = this._renderedTab === this._tab && this._renderedId === this._selected[this._tab];
        const editScroll = sameEntry ? content.querySelector('.parlor-br-studio-form')?.scrollTop || 0 : 0;
        content.innerHTML = result;
        this._bind(content);
        this._mountPreview(content);
        content.querySelector('.parlor-br-studio-entries').scrollTop = this._listScroll[this._tab];
        const form = content.querySelector('.parlor-br-studio-form');
        if (form) form.scrollTop = editScroll;
        this._renderedTab = this._tab;
        this._renderedId = this._selected[this._tab];
    }

    _renderList() {
        const list = this._list();
        const renderItem = (item) => {
            const on = item.id === this._selected[this._tab];
            let label = '';
            let meta = '';
            let dot = '';
            switch (this._tab) {
                case 'race':
                    label = item.name;
                    meta = t('PARLOR.BeetleRace.Studio.RaceMeta', { lanes: item.beetleIds.length, seconds: item.durationSec });
                    break;
                case 'beetle':
                    label = item.name;
                    meta = t('PARLOR.BeetleRace.Studio.BeetleMeta', { power: item.power, temperament: t(`PARLOR.BeetleRace.Temperament.${item.temperament}.Name`) });
                    dot = `<span class="parlor-br-studio-dot" style="background:${esc(item.color)}"></span>`;
                    break;
                case 'move':
                    label = item.name;
                    meta = `${t(`PARLOR.BeetleRace.Action.${item.actionId}.Name`)} · ${t(`PARLOR.BeetleRace.Studio.Pool.${item.pool}`)}`;
                    if (!item.enabled) meta += ` · ${t('PARLOR.BeetleRace.Studio.Disabled')}`;
                    break;
                default:
                    label = item.text;
            }
            return `<li class="${on ? 'is-on' : ''}${item.preset ? ' is-preset' : ''}${item.enabled === false ? ' is-disabled' : ''}" data-pick="${esc(item.id)}">
                ${dot}<span class="parlor-br-studio-item"><b>${esc(label)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span>
            </li>`;
        };
        const presets = list.filter(item => item.preset);
        const custom = list.filter(item => !item.preset);
        return `
            <ul class="parlor-br-studio-custom">${custom.map(renderItem).join('')}</ul>
            <details class="parlor-br-studio-folder" data-presets ${this._presetsOpen[this._tab] ? 'open' : ''}>
                <summary><i class="fas fa-folder" aria-hidden="true"></i><span>${esc(t('PARLOR.BeetleRace.Studio.PresetTag'))}</span><small>${presets.length}</small></summary>
                <ul>${presets.map(renderItem).join('')}</ul>
            </details>`;
    }

    _field(label, control, { hint = '', wide = false } = {}) {
        return `<label class="parlor-br-studio-field${wide ? ' is-wide' : ''}"><span>${esc(label)}</span>${control}${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
    }

    _select(key, options, value, { disabled = false } = {}) {
        return `<select data-key="${key}" ${disabled ? 'disabled' : ''}>${options.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
    }

    _renderEditor() {
        const d = this._draft;
        const locked = !!d.preset;
        const body = {
            race: () => this._renderRace(d, locked),
            beetle: () => this._renderBeetle(d, locked),
            move: () => this._renderMove(d, locked),
            bubble: () => this._renderBubble(d, locked)
        }[this._tab]();
        const actions = locked && this._tab === 'move'
            ? `<span class="parlor-br-studio-note" data-dirty-note>${esc(t(this._dirty ? 'PARLOR.BeetleRace.Studio.Unsaved' : 'PARLOR.BeetleRace.Studio.PresetParametersLocked'))}</span>
               <button type="button" class="parlor-br-btn" data-act="duplicate"><i class="fas fa-copy"></i> ${esc(t('PARLOR.BeetleRace.Studio.Duplicate'))}</button>
               <button type="button" class="parlor-br-btn is-accent" data-act="save"><i class="fas fa-save"></i> ${esc(t('PARLOR.BeetleRace.Studio.Save'))}</button>`
            : locked
            ? `<span class="parlor-br-studio-note"><i class="fas fa-lock"></i> ${esc(t('PARLOR.BeetleRace.Studio.PresetLocked'))}</span>
               <button type="button" class="parlor-br-btn is-accent" data-act="duplicate"><i class="fas fa-copy"></i> ${esc(t('PARLOR.BeetleRace.Studio.Duplicate'))}</button>`
            : `${d.id ? `<button type="button" class="parlor-br-btn" data-act="delete"><i class="fas fa-trash"></i> ${esc(t('PARLOR.BeetleRace.Studio.Delete'))}</button>` : ''}
               <span class="parlor-br-studio-note" data-dirty-note>${this._dirty ? esc(t('PARLOR.BeetleRace.Studio.Unsaved')) : ''}</span>
               <button type="button" class="parlor-br-btn is-accent" data-act="save"><i class="fas fa-save"></i> ${esc(t('PARLOR.BeetleRace.Studio.Save'))}</button>`;
        return `<div class="parlor-br-studio-form${locked ? ' is-locked' : ''}">${body}</div><footer class="parlor-br-studio-actions">${actions}</footer>`;
    }

    _renderBeetle(d, locked) {
        const dis = locked ? 'disabled' : '';
        const swatches = SWATCHES.map(c => `<button type="button" class="parlor-br-studio-swatch${c === d.color ? ' is-on' : ''}" style="background:${c}" data-swatch="${c}" ${dis} aria-label="${c}"></button>`).join('');
        return `
            <div class="parlor-br-studio-split">
                <div class="parlor-br-studio-grid">
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Name'), `<input type="text" data-key="name" maxlength="24" value="${esc(d.name)}" ${dis}>`)}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Power'), `<div class="parlor-br-studio-range"><input type="range" min="${RACE_LIMITS.minPower}" max="${RACE_LIMITS.maxPower}" step="1" data-key="power" data-num value="${d.power}" ${dis}><b data-out="power">${d.power}</b></div>`, { hint: t('PARLOR.BeetleRace.Studio.Hint.Power') })}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Color'), `<div class="parlor-br-studio-swatches">${swatches}<input type="color" data-key="color" value="${esc(d.color)}" ${dis}></div>`, { wide: true })}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Pattern'), this._select('pattern', PATTERNS.map(p => [p, t(`PARLOR.BeetleRace.Studio.Pattern.${p}`)]), d.pattern, { disabled: locked }))}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Horn'), this._select('horn', HORNS.map(h => [h, t(`PARLOR.BeetleRace.Studio.Horn.${h}`)]), d.horn, { disabled: locked }))}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Temperament'), this._select('temperament', TEMPERAMENT_IDS.map(id => [id, t(`PARLOR.BeetleRace.Temperament.${id}.Name`)]), d.temperament, { disabled: locked }), { hint: t('PARLOR.BeetleRace.Studio.Hint.Temperament'), wide: true })}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Intro'), `<textarea data-key="intro" maxlength="160" rows="3" ${dis}>${esc(d.intro)}</textarea>${locked ? '' : `<button type="button" class="parlor-br-btn parlor-br-studio-mini" data-act="intro"><i class="fas fa-magic"></i> ${esc(t('PARLOR.BeetleRace.Studio.IntroFromTemperament'))}</button>`}`, { wide: true, hint: t('PARLOR.BeetleRace.Studio.Hint.Intro') })}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Catchphrase'), `<input type="text" data-key="catchphrase" maxlength="40" value="${esc(d.catchphrase)}" ${dis}>`, { wide: true, hint: t('PARLOR.BeetleRace.Studio.Hint.Catchphrase') })}
                </div>
                <div class="parlor-br-studio-previewbox">
                    <div class="parlor-br-studio-preview" data-preview="beetle"></div>
                    <small>${esc(t('PARLOR.BeetleRace.Studio.PreviewHint'))}</small>
                    ${d.stats?.races ? `<div class="parlor-br-studio-stats">${esc(t('PARLOR.BeetleRace.Caption.Stats', { races: d.stats.races, wins: d.stats.wins }))}</div>` : ''}
                </div>
            </div>`;
    }

    _renderMove(d, locked) {
        const dis = locked ? 'disabled' : '';
        // 旧自定义招式仍可保存原动作，但新招式只提供本版开放的动作。
        const available = ACTION_IDS.includes(d.actionId) ? ACTION_IDS : [...ACTION_IDS, d.actionId];
        const groups = ['boost', 'stall', 'show', 'magic'].map(group => {
            const ids = available.filter(id => (group === 'magic' ? ACTIONS[id].magic : !ACTIONS[id].magic && ACTIONS[id].category === group));
            return `<optgroup label="${esc(t(`PARLOR.BeetleRace.Studio.ActionGroup.${group}`))}">${ids.map(id => `<option value="${id}" ${id === d.actionId ? 'selected' : ''}>${esc(t(`PARLOR.BeetleRace.Action.${id}.Name`))}</option>`).join('')}</optgroup>`;
        }).join('');
        const tunable = actionTunables(d.actionId);
        const def = ACTIONS[d.actionId];
        const duration = d.duration > 0 ? d.duration : def.sim.dur;
        return `
            <div class="parlor-br-studio-split">
                <div class="parlor-br-studio-grid">
                    <label class="parlor-br-studio-field parlor-br-studio-check is-wide"><input type="checkbox" data-key="enabled" ${d.enabled ? 'checked' : ''}><span>${esc(t('PARLOR.BeetleRace.Studio.Field.Enabled'))}</span></label>
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Name'), `<input type="text" data-key="name" maxlength="24" value="${esc(d.name)}" ${dis}>`)}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Pool'), `<div class="parlor-br-studio-seg">${['cheat', 'random'].map(pool => `<button type="button" data-pool="${pool}" class="${d.pool === pool ? 'is-on' : ''}" ${dis}>${esc(t(`PARLOR.BeetleRace.Studio.Pool.${pool}`))}</button>`).join('')}</div>`, { hint: t(`PARLOR.BeetleRace.Studio.Hint.Pool.${d.pool}`) })}
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.Action'), `<select data-key="actionId" data-restructure ${dis}>${groups}</select>`, { wide: true, hint: t(`PARLOR.BeetleRace.Action.${d.actionId}.Desc`) })}
                    ${tunable.duration
                        ? this._field(t('PARLOR.BeetleRace.Studio.Field.Duration'), `<div class="parlor-br-studio-range"><input type="range" min="${MOVE_LIMITS.minDuration}" max="${MOVE_LIMITS.maxDuration}" step="0.1" data-key="duration" data-num value="${duration}" ${dis}><b data-out="duration">${Number(duration).toFixed(1)}s</b></div>`, { hint: t('PARLOR.BeetleRace.Studio.Hint.Duration', { seconds: def.sim.dur }) })
                        : this._field(t('PARLOR.BeetleRace.Studio.Field.Duration'), `<div class="parlor-br-studio-fixed">${esc(t('PARLOR.BeetleRace.Studio.FixedDuration', { seconds: def.sim.dur }))}</div>`)}
                    ${tunable.strength
                        ? this._field(t('PARLOR.BeetleRace.Studio.Field.Strength'), `<div class="parlor-br-studio-range"><input type="range" min="${MOVE_LIMITS.minStrength}" max="${MOVE_LIMITS.maxStrength}" step="0.1" data-key="strength" data-num value="${d.strength}" ${dis}><b data-out="strength">×${Number(d.strength).toFixed(1)}</b></div>`, { hint: t('PARLOR.BeetleRace.Studio.Hint.Strength') })
                        : this._field(t('PARLOR.BeetleRace.Studio.Field.Strength'), `<div class="parlor-br-studio-fixed">${esc(t('PARLOR.BeetleRace.Studio.NoStrength'))}</div>`)}
                    ${this._renderMoveBubbles(d)}
                </div>
                <div class="parlor-br-studio-previewbox">
                    <div class="parlor-br-studio-preview is-lane" data-preview="move"></div>
                    <small>${esc(t('PARLOR.BeetleRace.Studio.MovePreviewHint'))}</small>
                </div>
            </div>`;
    }

    _renderMoveBubbles(d) {
        const bubbles = BeetleRaceLibrary.listBubbles();
        const byId = new Map(bubbles.map(b => [b.id, b.text]));
        const ids = d.bubbleIds || [];
        const lines = [
            ...ids.map(id => ({ text: byId.get(id) || t('PARLOR.BeetleRace.Studio.MissingBubble'), attr: `data-bubble-remove="${esc(id)}"` })),
            ...(d.__newBubbles || []).map((text, i) => ({ text, attr: `data-bubble-remove-new="${i}"` }))
        ];
        const options = [['', t('PARLOR.BeetleRace.Studio.ChooseBubble')], ...bubbles.filter(b => !ids.includes(b.id)).map(b => [b.id, b.text])];
        return `<div class="parlor-br-studio-field is-wide parlor-br-studio-bubbles">
            <span>${esc(t('PARLOR.BeetleRace.Studio.Field.Bubble'))}<small>${esc(t('PARLOR.BeetleRace.Studio.RandomBubble'))}</small></span>
            <ul>${lines.map(line => `<li><span>${esc(line.text)}</span><button type="button" class="parlor-br-btn parlor-br-studio-mini" ${line.attr} aria-label="${esc(t('PARLOR.BeetleRace.Studio.RemoveBubble'))}">×</button></li>`).join('') || `<li class="is-empty">${esc(t('PARLOR.BeetleRace.Studio.NoBubble'))}</li>`}</ul>
            ${this._select('__addBubble', options, '')}
            <div class="parlor-br-studio-bubble-add"><input type="text" data-key="__newBubble" maxlength="60" value="${esc(d.__newBubble || '')}" placeholder="${esc(t('PARLOR.BeetleRace.Studio.NewBubblePlaceholder'))}" aria-label="${esc(t('PARLOR.BeetleRace.Studio.Field.NewBubble'))}"><button type="button" class="parlor-br-btn" data-bubble-add>${esc(t('PARLOR.BeetleRace.Studio.AddBubble'))}</button></div>
        </div>`;
    }

    _renderBubble(d, locked) {
        const used = BeetleRaceLibrary.listMoves().filter(move => move.bubbleIds.includes(d.id) && d.id);
        return `
            <div class="parlor-br-studio-split">
                <div class="parlor-br-studio-grid">
                    ${this._field(t('PARLOR.BeetleRace.Studio.Field.BubbleText'), `<input type="text" data-key="text" maxlength="60" value="${esc(d.text)}" ${locked ? 'disabled' : ''}>`, { wide: true, hint: t('PARLOR.BeetleRace.Studio.Hint.BubbleText') })}
                    <div class="parlor-br-studio-field is-wide"><span>${esc(t('PARLOR.BeetleRace.Studio.UsedBy'))}</span>
                        <div class="parlor-br-studio-chips">${used.length ? used.map(move => `<span>${esc(move.name)}</span>`).join('') : `<small>${esc(t('PARLOR.BeetleRace.Studio.UsedByNone'))}</small>`}</div>
                    </div>
                </div>
                <div class="parlor-br-studio-previewbox">
                    <div class="parlor-br-studio-preview" data-preview="bubble"></div>
                </div>
            </div>`;
    }

    _renderRace(d, locked) {
        const dis = locked ? 'disabled' : '';
        const beetles = BeetleRaceLibrary.listBeetles();
        const byId = new Map(beetles.map(b => [b.id, b]));
        const lanes = d.beetleIds.map((id, i) => {
            const b = byId.get(id);
            const missing = !b;
            const odds = d.multipliers?.[id] ?? '';
            return `<li class="${missing ? 'is-missing' : ''}">
                <span class="parlor-br-studio-lane-n">${i + 1}</span>
                <span class="parlor-br-studio-dot" style="background:${esc(b?.color || '#555')}"></span>
                <span class="parlor-br-studio-lane-name">${esc(b?.name || t('PARLOR.BeetleRace.Studio.MissingBeetle'))}</span>
                <small>${b ? esc(t('PARLOR.BeetleRace.Studio.PowerShort', { power: b.power })) : ''}</small>
                <input type="number" min="${RACE_LIMITS.minMultiplier}" max="${RACE_LIMITS.maxMultiplier}" step="0.1" data-odds="${esc(id)}" value="${odds}" placeholder="×${d.multiplier}" title="${esc(t('PARLOR.BeetleRace.Studio.Hint.LaneOdds'))}" ${dis}>
                ${locked ? '' : `<button type="button" data-lane-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="↑">↑</button><button type="button" data-lane-down="${i}" ${i === d.beetleIds.length - 1 ? 'disabled' : ''} aria-label="↓">↓</button><button type="button" data-lane-remove="${i}" aria-label="×">×</button>`}
            </li>`;
        }).join('');
        const addable = beetles.filter(b => !d.beetleIds.includes(b.id));
        const canAdd = !locked && d.beetleIds.length < RACE_LIMITS.maxLanes && addable.length;
        const tooFew = d.beetleIds.filter(id => byId.has(id)).length < RACE_LIMITS.minLanes;
        return `
            <div class="parlor-br-studio-grid is-race">
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.RaceName'), `<input type="text" data-key="name" maxlength="40" value="${esc(d.name)}" ${dis}>`, { wide: true })}
                <div class="parlor-br-studio-field is-wide">
                    <span>${esc(t('PARLOR.BeetleRace.Studio.Field.Lanes', { min: RACE_LIMITS.minLanes, max: RACE_LIMITS.maxLanes }))}</span>
                    <ol class="parlor-br-studio-lanes">${lanes}</ol>
                    ${canAdd ? `<div class="parlor-br-studio-addlane">${this._select('__add', [['', t('PARLOR.BeetleRace.Studio.AddBeetle')], ...addable.map(b => [b.id, b.name])], '')}</div>` : ''}
                    ${tooFew ? `<small class="is-warn">${esc(t('PARLOR.BeetleRace.Studio.TooFewLanes', { min: RACE_LIMITS.minLanes }))}</small>` : ''}
                </div>
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.Multiplier'), `<input type="number" min="${RACE_LIMITS.minMultiplier}" max="${RACE_LIMITS.maxMultiplier}" step="0.1" data-key="multiplier" data-num value="${d.multiplier}" ${dis}>`, { hint: t('PARLOR.BeetleRace.Studio.Hint.Multiplier', { fair: Math.max(1, d.beetleIds.length) }) })}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.RaceDuration'), `<div class="parlor-br-studio-range"><input type="range" min="${RACE_LIMITS.minDuration}" max="${RACE_LIMITS.maxDuration}" step="5" data-key="durationSec" data-num value="${d.durationSec}" ${dis}><b data-out="durationSec">${d.durationSec}s</b></div>`)}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.BetSeconds'), `<div class="parlor-br-studio-range"><input type="range" min="${RACE_LIMITS.minBetSeconds}" max="${RACE_LIMITS.maxBetSeconds}" step="5" data-key="betSeconds" data-num value="${d.betSeconds}" ${dis}><b data-out="betSeconds">${d.betSeconds}s</b></div>`)}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.EventRate'), this._select('eventRate', EVENT_RATES.map(r => [r, t(`PARLOR.BeetleRace.Studio.EventRate.${r}`)]), d.eventRate, { disabled: locked }))}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.MinBet'), `<input type="number" min="1" step="1" data-key="minBet" data-num value="${d.minBet}" ${dis}>`)}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.MaxBet'), `<input type="number" min="0" step="1" data-key="maxBet" data-num value="${d.maxBet}" ${dis}>`, { hint: t('PARLOR.BeetleRace.Studio.Hint.MaxBet') })}
                ${this._field(t('PARLOR.BeetleRace.Studio.Field.PowerDisplay'), this._select('powerDisplay', POWER_DISPLAYS.map(p => [p, t(`PARLOR.Lobby.Setup.BeetleRacePower.${p}`)]), d.powerDisplay, { disabled: locked }))}
                <label class="parlor-br-studio-field parlor-br-studio-check"><input type="checkbox" data-key="parade" ${d.parade ? 'checked' : ''} ${dis}><span>${esc(t('PARLOR.BeetleRace.Studio.Field.Parade'))}</span></label>
            </div>`;
    }

    // ───────── 交互 ─────────

    _bind(root) {
        const tab = this._tab;
        root.querySelector('[data-presets]')?.addEventListener('toggle', (event) => {
            this._presetsOpen[tab] = event.currentTarget.open;
        });
        root.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', async () => {
            if (button.dataset.tab === this._tab || !(await this._confirmDiscard())) return;
            this._tab = button.dataset.tab;
            this._draft = null;
            this.render();
        }));
        root.querySelectorAll('[data-pick]').forEach(item => item.addEventListener('click', async () => {
            if (item.dataset.pick === this._selected[this._tab] || !(await this._confirmDiscard())) return;
            this._selected[this._tab] = item.dataset.pick;
            this._draft = null;
            this.render();
        }));
        root.querySelectorAll('[data-act]').forEach(button => button.addEventListener('click', () => this._onAct(button.dataset.act)));

        const form = root.querySelector('.parlor-br-studio-form');
        if (!form || (this._draft?.preset && this._tab !== 'move')) return;
        form.addEventListener('input', (event) => this._onInput(event));
        form.addEventListener('change', (event) => this._onInput(event, true));
        form.addEventListener('click', (event) => this._onFormClick(event));
        form.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing && event.target.dataset.key === '__newBubble') {
                event.preventDefault();
                this._addBubbleLine();
            }
        });
    }

    _markDirty() {
        this._dirty = true;
        const note = this.element?.querySelector('[data-dirty-note]');
        if (note) note.textContent = t('PARLOR.BeetleRace.Studio.Unsaved');
    }

    _onInput(event, committed = false) {
        const target = event.target;
        const d = this._draft;
        if (target.dataset.odds) {
            const value = Number(target.value);
            d.multipliers = { ...(d.multipliers || {}) };
            if (target.value === '' || !(value > 0)) delete d.multipliers[target.dataset.odds];
            else d.multipliers[target.dataset.odds] = value;
            this._markDirty();
            return;
        }
        const key = target.dataset.key;
        if (!key) return;
        if (d.preset && !['enabled', '__newBubble', '__addBubble'].includes(key)) return;
        if (key === '__addBubble') {
            if (committed && target.value && !d.bubbleIds.includes(target.value)) {
                d.bubbleIds = [...d.bubbleIds, target.value];
                this._markDirty();
                this.render();
            }
            return;
        }
        if (key === '__add') {
            if (committed && target.value) {
                d.beetleIds = [...d.beetleIds, target.value];
                this._markDirty();
                this.render();
            }
            return;
        }
        let value = target.type === 'checkbox' ? target.checked : target.value;
        if (target.dataset.num !== undefined) value = Number(value);
        d[key] = value;
        this._markDirty();
        const out = this.element.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = key === 'strength' ? `×${Number(value).toFixed(1)}` : (key === 'duration' || key === 'durationSec' || key === 'betSeconds' ? `${Number(value).toFixed(key === 'duration' ? 1 : 0)}s` : String(value));
        // 换动作会改变能调哪几样，得整个编辑区重画；其余只刷预览
        if (target.dataset.restructure !== undefined && committed) {
            d.duration = 0;
            d.strength = 1;
            this.render();
            return;
        }
        if (key === 'color') this.element.querySelectorAll('[data-swatch]').forEach(s => s.classList.toggle('is-on', s.dataset.swatch === value));
        this._refreshPreview({ rebuild: ['color', 'pattern', 'horn'].includes(key) });
    }

    _onFormClick(event) {
        const d = this._draft;
        if (this._tab === 'move') {
            if (event.target.closest('[data-bubble-add]')) {
                this._addBubbleLine();
                return;
            }
            const remove = event.target.closest('[data-bubble-remove]');
            const removeNew = event.target.closest('[data-bubble-remove-new]');
            if (remove || removeNew) {
                if (remove) d.bubbleIds = d.bubbleIds.filter(id => id !== remove.dataset.bubbleRemove);
                else d.__newBubbles.splice(Number(removeNew.dataset.bubbleRemoveNew), 1);
                this._markDirty();
                this.render();
                return;
            }
        }
        if (d.preset) return;
        const swatch = event.target.closest('[data-swatch]');
        if (swatch) {
            d.color = swatch.dataset.swatch;
            this.element.querySelector('[data-key="color"]').value = d.color;
            this.element.querySelectorAll('[data-swatch]').forEach(s => s.classList.toggle('is-on', s === swatch));
            this._markDirty();
            this._refreshPreview({ rebuild: true });
            return;
        }
        const pool = event.target.closest('[data-pool]');
        if (pool) {
            d.pool = pool.dataset.pool;
            this._markDirty();
            this.render();
            return;
        }
        const move = (attr, fn) => {
            const button = event.target.closest(`[${attr}]`);
            if (!button) return false;
            const i = Number(button.getAttribute(attr));
            const ids = [...d.beetleIds];
            fn(ids, i);
            d.beetleIds = ids;
            this._markDirty();
            this.render();
            return true;
        };
        if (move('data-lane-up', (ids, i) => { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; })) return;
        if (move('data-lane-down', (ids, i) => { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; })) return;
        move('data-lane-remove', (ids, i) => { ids.splice(i, 1); });
    }

    _addBubbleLine() {
        const d = this._draft;
        const line = String(d.__newBubble || '').trim();
        if (!line) return;
        d.__newBubbles = [...new Set([...(d.__newBubbles || []), line])];
        d.__newBubble = '';
        this._markDirty();
        this.render();
    }

    async _onAct(act) {
        const d = this._draft;
        if (act === 'new') {
            if (!(await this._confirmDiscard())) return;
            this._draft = { ...this._blank(this._tab), __tab: this._tab };
            this._selected[this._tab] = '';
            this._dirty = true;
            this.render();
            return;
        }
        if (act === 'duplicate' && d) {
            if (!(await this._confirmDiscard())) return;
            const copy = BeetleRaceLibrary.duplicateDraft(this._tab, d.id);
            if (!copy) return;
            this._draft = { ...copy, __tab: this._tab };
            this._selected[this._tab] = '';
            this._dirty = true;
            this.render();
            return;
        }
        if (act === 'intro' && d) {
            d.intro = BeetleRaceLibrary.introFromTemperament(d.temperament, d.name);
            const box = this.element.querySelector('[data-key="intro"]');
            if (box) box.value = d.intro;
            this._markDirty();
            return;
        }
        if (act === 'delete' && d?.id) {
            const ok = await foundry.applications.api.DialogV2.confirm({
                window: { title: t('PARLOR.BeetleRace.Studio.DeleteTitle') },
                content: `<p>${esc(t('PARLOR.BeetleRace.Studio.DeleteBody', { name: d.name || d.text || '' }))}</p>`,
                rejectClose: false
            });
            if (!ok) return;
            const remove = { race: 'removeRace', beetle: 'removeBeetle', move: 'removeMove', bubble: 'removeBubble' }[this._tab];
            await BeetleRaceLibrary[remove](d.id);
            this._draft = null;
            this._selected[this._tab] = '';
            this._dirty = false;
            this._onChanged?.();
            this.render();
            return;
        }
        if (act === 'save' && d) await this._save();
    }

    async _save() {
        const d = structuredClone(this._draft);
        const presetMove = this._tab === 'move' && d.preset;
        delete d.__tab;
        delete d.preset;
        delete d.stats;
        // 新句子先存到共用气泡库；草稿同步引用，后续保存失败再试也不会重复创建。
        if (this._tab === 'move') {
            const pending = [...new Set([...(d.__newBubbles || []), d.__newBubble].map(line => String(line || '').trim()).filter(Boolean))];
            for (const line of pending) {
                const bubble = await BeetleRaceLibrary.saveBubble({ text: line });
                if (!bubble) {
                    ui.notifications.warn(t('PARLOR.BeetleRace.Studio.SaveFailed'));
                    return;
                }
                d.bubbleIds.push(bubble.id);
                this._draft.bubbleIds = [...d.bubbleIds];
                this._draft.__newBubbles = (this._draft.__newBubbles || []).filter(text => text.trim() !== line);
                if (String(this._draft.__newBubble || '').trim() === line) this._draft.__newBubble = '';
            }
        }
        delete d.__newBubble;
        delete d.__newBubbles;
        if (this._tab === 'move' && d.duration > 0 && Math.abs(d.duration - ACTIONS[d.actionId].sim.dur) < 0.05) d.duration = 0;
        const save = { race: 'saveRace', beetle: 'saveBeetle', move: 'saveMove', bubble: 'saveBubble' }[this._tab];
        const saved = presetMove
            ? await BeetleRaceLibrary.savePresetMoveOptions(d.id, { enabled: d.enabled, bubbleIds: d.bubbleIds })
            : await BeetleRaceLibrary[save](d);
        if (!saved) {
            ui.notifications.warn(t('PARLOR.BeetleRace.Studio.SaveFailed'));
            return;
        }
        this._selected[this._tab] = saved.id;
        this._draft = null;
        this._dirty = false;
        ui.notifications.info(t('PARLOR.BeetleRace.Studio.Saved'));
        this._onChanged?.();
        this.render();
    }

    // ───────── 预览 ─────────

    _mountPreview(root) {
        cancelAnimationFrame(this._raf);
        this._preview = null;
        const host = root.querySelector('[data-preview]');
        if (!host || !this._draft) return;
        const kind = host.dataset.preview;
        const svg = document.createElementNS(NS, 'svg');
        const lane = kind === 'move';
        svg.setAttribute('viewBox', lane ? '0 0 520 220' : '0 0 360 260');
        host.appendChild(svg);
        this._preview = { kind, svg, host, x: lane ? 80 : 180, v: 0, action: null, wait: 0.6, nextIdle: 1.2 };
        this._refreshPreview({ rebuild: true });
        host.addEventListener('click', () => {
            if (kind === 'beetle') {
                const ids = ['bow', 'taunt', 'hop', 'flip', 'nap'];
                this._playPreview(ids[Math.floor(Math.random() * ids.length)]);
            } else if (kind === 'move') {
                this._playPreview(this._draft.actionId);
            }
        });
        let last = performance.now();
        const frame = (now) => {
            if (!this._preview || !host.isConnected) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            this._tickPreview(dt);
            this._raf = requestAnimationFrame(frame);
        };
        this._raf = requestAnimationFrame(frame);
    }

    _lookFor() {
        const d = this._draft;
        if (this._tab === 'beetle') return { color: d.color, pattern: d.pattern, horn: d.horn };
        return { color: '#c28e1c', pattern: 'bands', horn: 'rhino' };
    }

    _refreshPreview({ rebuild = false } = {}) {
        const p = this._preview;
        if (!p) return;
        if (rebuild || !p.actor) {
            p.svg.replaceChildren();
            p.fx = new FxLayer(p.svg);
            p.actor = p.kind === 'bubble' ? new BeetleActor({ color: '#3248a8', pattern: 'stars', horn: 'stag' }, { fx: p.fx }) : new BeetleActor(this._lookFor(), { fx: p.fx });
            p.svg.appendChild(p.actor.el);
            p.bubble = createBubble(p.svg);
        }
        const d = this._draft;
        let text = '';
        if (p.kind === 'bubble') text = d.text;
        else if (p.kind === 'move') {
            const lines = this._movePreviewLines();
            text = String(d.__newBubble || '').trim() || (lines.includes(p.text) ? p.text : lines[0]) || '';
        }
        else text = d.catchphrase;
        if (text !== p.text) {
            p.bubble.setText(text);
            p.text = text;
        }
    }

    _movePreviewLines() {
        const d = this._draft;
        const byId = new Map(BeetleRaceLibrary.listBubbles().map(b => [b.id, b.text]));
        return [...new Set([...(d.bubbleIds || []).map(id => byId.get(id)), ...(d.__newBubbles || []), String(d.__newBubble || '').trim()].filter(Boolean))];
    }

    _playPreview(actionId) {
        const p = this._preview;
        if (!p) return;
        const d = this._draft;
        const tunable = actionTunables(actionId);
        const isMove = p.kind === 'move';
        if (isMove) {
            const lines = this._movePreviewLines();
            p.text = lines[Math.floor(Math.random() * lines.length)] || '';
            p.bubble.setText(p.text);
        }
        const dur = isMove && tunable.duration && d.duration > 0 ? d.duration : ACTIONS[actionId].sim.dur;
        p.action = { id: actionId, t: 0, dur, strength: isMove && tunable.strength ? d.strength : 1, fired: false };
    }

    _tickPreview(dt) {
        const p = this._preview;
        const lane = p.kind === 'move';
        const y = lane ? 150 : 176;
        if (!p.action) {
            p.wait -= dt;
            if (p.wait <= 0) {
                if (lane) this._playPreview(this._draft.actionId);
                else if (p.kind === 'bubble') this._playPreview('bow');
                p.wait = lane ? 1.2 : 3.2;
            }
        }
        // 招式预览要看"跑起来"的效果：照模拟层的规则算速度（跟陈列馆同一套简化）
        let speed = 0;
        if (lane) {
            const base = 70;
            let target = base;
            let settle = 4;
            let kicked = false;
            if (p.action) {
                const sim = ACTIONS[p.action.id].sim;
                const k = p.action.strength;
                const prog = p.action.t / p.action.dur;
                if (sim.kind === 'mul') target *= Math.max(0.02, 1 + (sim.mul - 1) * k);
                else if (sim.kind === 'stop') { target = base * sim.crawl; settle = sim.settle; }
                else if (sim.kind === 'reverse') { target = base * sim.speed * k; settle = 8; }
                else {
                    target = 0;
                    settle = sim.kind === 'blink' ? 20 : sim.settle;
                    if (!p.action.fired && prog >= (sim.kind === 'blink' ? sim.jumpAt : sim.at)) {
                        p.action.fired = true;
                        if (sim.kind === 'blink') p.x += sim.dist * 1.6 * k;
                        else { p.v = base * sim.impulse * k; kicked = true; }
                    }
                }
            }
            // 被崩那一帧别马上阻尼，不然往后弹的劲儿当场就被吃掉一截
            if (!kicked) p.v += (target - p.v) * Math.min(1, dt * settle);
            p.x += p.v * dt;
            if (p.x > 600) p.x = -80;
            if (p.x < -80) p.x = 600;
            speed = p.v;
        }
        let actionId = '';
        let elapsed = 0;
        let duration = 0;
        if (p.action) {
            p.action.t += dt;
            actionId = p.action.id;
            elapsed = Math.min(p.action.t, p.action.dur);
            duration = p.action.dur;
            if (p.action.t >= p.action.dur) p.action = null;
        }
        const scale = lane ? 1.4 : 1.45;
        p.actor.update({ x: p.x, y, scale, speed, actionId, elapsed, duration, dt });
        const showBubble = !!p.text && (p.kind === 'bubble' || p.kind === 'beetle' || (p.action && p.action.t < 2.2));
        p.bubble.place(p.x + 8 * scale, y - 60 * scale, lane ? 1.6 : 1.2);
        p.bubble.show(showBubble);
    }
}
