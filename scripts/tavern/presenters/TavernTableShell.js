/**
 * TavernTableShell — 奇幻酒馆桌 · 多游戏共用呈现壳
 *
 * Presenter API v1 的酒馆壳基类。招牌 / 链吊播报牌 / 桌台 SVG / 木托盘 HUD / 背景引擎
 * 多张牌桌的共同结构收在这里;gameApi 的 getSeats/getStatus/getHud 形状统一,
 * 所以播报/名录/HUD 的渲染也共用。子类只实现"垫面内容 + 阶段灯 + 游戏名"这几处真正的差异。
 *
 * 信息分工(别混):
 *   链吊木牌 = 播报器,只说"刚刚发生了什么"(轮到谁/谁下了多少/谁弃了)
 *   HUD 顶条 = 常驻表况(游戏名/底池/当前注),不随事件跳动
 *   HUD 本体 = 只关乎"你自己";轮到你时整台发光,没轮到就安静待着
 *   名录抽屉 = 全桌账目,平时收起来,要看再拉开
 *
 * 子类钩子:
 *   get gameNameKey / gameNameFallbackKey / gameGlyph   游戏名(铭文条)
 *   get phases()                  [{labelKey}] 阶段灯序列
 *   phaseProgress(state)          { active, done } 当前阶段索引 + 已完成数
 *   renderSurface(state)          垫面中央内容(公共牌 / 庄闲手牌 / 叫点擂台)
 *   tableStripStatus(state)       铭文条上游戏名之后的表况片段(底池等)
 *   actionSoundKind(action)       HUD 动作音效，骰子桌覆盖为空
 *   _heraldSnapshot(state,status) 播报用的扁平快照(必须全是原始值,见方法注释)
 *   _heraldLines(prev, next)      两帧快照之间要播报的句子
 *   _collectActionData()          点操作按钮时从垫上输入采集的数据(德州=加注额)
 *   get handLayout()              'row' 平铺(默认)/ 'fan' 扇形;扇形下手牌可点(cards[].onClick),见 _renderHudHandFan
 *   handCardPlayed(entry, slot)   扇形手牌被点出去的瞬间(子类记出发位置做飞牌)
 *
 * 生命周期:new → mount(root, gameApi) → refresh(state)* → onEvent(event)* → destroy()
 */

import { renderPropSvg, getPropType, propBaseWidth } from '../props/PropLibrary.js';
import { isPropOnFelt } from '../props/TableGeometry.js';
import { getTableStylePreset, getWoodPreset, woodAssetPath } from '../props/WoodPresets.js';
import { TavernDeckEditor } from './TavernDeckEditor.js';

export const MODULE_ID = 'parlor';
const ASSET = `modules/${MODULE_ID}/assets/tavern`;

// hex 颜色乘系数(>1 提亮,<1 压暗),毛毡/桌角单色参数派生渐变档用
function shadeHex(hex, factor) {
    const m = /^#?([0-9a-f]{6})$/iu.exec(String(hex || '').trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

const HERALD_MAX = 3; // 木牌上同时挂几句;再多就顶掉最旧的

// 名录抽屉的开合是纯客户端偏好,记在 localStorage 自己的命名空间下,不占本体 settings。
// 隐私模式/测试环境里 localStorage 可能不存在或直接抛,读写都当没记住处理
const ROSTER_OPEN_KEY = `${MODULE_ID}:roster-open`;
function readRosterOpen() {
    try { return globalThis.localStorage?.getItem(ROSTER_OPEN_KEY) === '1'; } catch { return false; }
}
function writeRosterOpen(open) {
    try { globalThis.localStorage?.setItem(ROSTER_OPEN_KEY, open ? '1' : '0'); } catch { /* 记不住就算了 */ }
}

export class TavernTableShell {
    constructor() {
        this._root = null;
        this._api = null;
        this._els = {};
        this._pointerHandler = null;
        this._lastActionSig = null; // 操作区上次的动作签名,只在动作真变时重建(免按钮 DOM churn 吞点击)
        this._dealCounts = {}; // 各牌区上次的真实牌数,用于只给新发的牌加发牌动画
        this._deckSig = ''; // 赌桌预设签名,变了才重刷桌台外观(refresh 高频,别每次都动 DOM)
        this._backdropSrc = ''; // 背景媒体当前 src,同源只调样式不重建(视频重建会重播闪烁)
        this._entranceTimer = null;
        this._heraldSnap = null; // 上一帧的播报快照,新旧对比推导出要播什么
        this._heraldLast = ''; // 上一句播报原文,连着两次一样就不重复挂牌
        this._seatNames = new Map(); // id → 名字,播报句子里点名用
        this._rosterOpen = readRosterOpen();
        // 扇形手牌:签名没变就不重建(牌带点击监听,重建瞬间会吞点击);出牌请求在途时整手锁住
        this._lastHandSig = null;
        this._fanHand = null;
        this._fanKeys = null;
        this._handBusy = false;
        this._handBusyTimer = null;
        this._flights = new Set(); // 飞行中的幽灵牌,destroy 时一起收
    }

    // ── 生命周期 ─────────────────────────────────────────────

    mount(root, gameApi) {
        this._root = root;
        this._api = gameApi;
        root.classList.add('ptt-root');
        root.dataset.tableStyle = 'semi-real';
        root.innerHTML = this._shellHtml();
        this._cacheEls();
        this._playEntrance(); // 首帧绘制前挂上入场类,避免可见态先闪一下
        this._initAmbience();
        this._syncDeck(true); // 赌桌预设(桌名/桌角/毛毡/画风/背景/摆件),背景也在 _applyDeck 里统一挂
        this._els.close?.addEventListener('click', () => this._api?.requestClose?.());
        this._els.rosterTab?.addEventListener('click', () => this._toggleRoster());
        this._els.rosterClose?.addEventListener('click', () => this._toggleRoster(false));
        this._syncRosterDrawer();
        this._mountDeckEditorButton();
        this.refresh(gameApi.getState?.());
    }

    // 桌台工坊入口:GM 才看得见的 ⚒ 按钮,开当前赌桌的编辑模式。
    // 和关桌按钮同挂在右上角工具位里,别再各自绝对定位互相压
    _mountDeckEditorButton() {
        const tools = this._root?.querySelector('.ptt-corner-tools');
        if (!game.user?.isGM || !tools) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ptt-tool ptt-edit';
        btn.title = this._t('PARLORTAVERN.Workshop.EditTable');
        btn.setAttribute('aria-label', btn.title);
        btn.textContent = '⚒';
        btn.addEventListener('click', () => {
            this._deckEditor = this._deckEditor || new TavernDeckEditor(this);
            this._deckEditor.open();
        });
        tools.prepend(btn);
    }

    refresh(state) {
        if (!this._root) return;
        this._syncDeck(); // 预设是 world setting,别的客户端改了这里靠签名比对跟上
        const st = state || this._api?.getState?.() || {};
        // 座位/表况各拉一次给下游共用:名录、播报点名、HUD 轮次判定都要它,别各问各的
        const seats = this._api?.getSeats?.() || [];
        const status = this._api?.getStatus?.() || {};
        this._seatNames = new Map(seats.map(s => [s.id, s.name]));
        this._renderPhaseBar(st);
        this._renderHerald(st, status);
        this._renderRoster(seats);
        this.renderSurface(st);
        this._renderTableStrip(st);
        this._renderHud(st, seats);
    }

    onEvent(_event) {
        // 语义事件(发牌飞牌/开盅/结算金光)留后续;不消费也正确,动画是增量
    }

    destroy() {
        if (this._pointerHandler) {
            window.removeEventListener('pointermove', this._pointerHandler);
            this._pointerHandler = null;
        }
        if (this._entranceTimer) { clearTimeout(this._entranceTimer); this._entranceTimer = null; }
        this._releaseHandLock();
        this._cancelFlights();
        this._fanHand = null;
        this._fanKeys = null;
        this._lastHandSig = null;
        this._deckEditor?.close(false);
        this._deckEditor = null;
        this._root?.classList.remove('ptt-root');
        this._root = null;
        this._api = null;
        this._els = {};
    }

    // 开桌入场:招牌落下→木匾坠落摇晃→桌台浮现→托盘升起(动画在 CSS 的 .pth-entering 下)。
    // 播完即摘类,不影响后续 refresh;reduced-motion 直接跳过。
    _playEntrance() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        this._root.classList.add('pth-entering');
        this._entranceTimer = setTimeout(() => {
            this._root?.classList.remove('pth-entering');
            this._entranceTimer = null;
        }, 2600);
    }

    // ── 子类钩子(默认空实现)───────────────────────────────

    get gameNameKey() { return ''; }
    get gameNameFallbackKey() { return ''; }
    get gameGlyph() { return '♠'; }
    get phases() { return []; }
    phaseProgress(_state) { return { active: -1, done: 0 }; }
    renderSurface(_state) {}
    tableStripStatus(_state) { return []; }

    // 纸牌桌默认给操作一个落牌声；骰子桌要明确覆盖为空，不然所有“掷骰/叫点”都会听成发牌。
    actionSoundKind(_action) { return 'placed'; }

    // 手牌布局。'fan' 是甩牌桌用的扇形:手牌会涨到十几张,平铺撑不住,扇形自动压间距;
    // 扇形下 cards[].onClick 会被接成点牌直接出。其他桌不动,默认还是平铺
    get handLayout() { return 'row'; }
    handCardPlayed(_entry, _slot) {}

    // 点操作按钮时采集垫上数字输入的金额。德州加注框 / 21点下注框都是 number input,泛化一把抓。
    // 需要多值的游戏(说谎骰叫点=数量+点数)自行覆盖本钩子
    _collectActionData() {
        const input = this._root?.querySelector('.hud input[type="number"]');
        return input ? { amount: Number(input.value) } : {};
    }

    // ── 壳 DOM ──────────────────────────────────────────────

    _shellHtml() {
        const leave = this._esc(this._t('PARLORTAVERN.Actions.LeaveTable'));
        return `
            <div class="ambience" aria-hidden="true"></div>
            <div class="ptt-corner-tools">
                <button type="button" class="ptt-tool ptt-close" title="${leave}" aria-label="${leave}">✕</button>
            </div>
            <div class="stage">
                <header class="topbar">
                    <div class="brand">
                        <b data-el="deckName"></b>
                    </div>
                    <div class="phasebar" data-el="phasebar"></div>
                </header>

                <div class="herald-strip">
                    <div class="herald-chains"><i></i><i></i></div>
                    <div class="herald">
                        <div class="herald-rail">
                            <span data-el="hrPhase"></span>
                            <span data-el="hrRound"></span>
                            <span data-el="hrSub"></span>
                        </div>
                        <div class="herald-feed" data-el="heraldFeed"></div>
                    </div>
                </div>

                <div class="scene-wrap">
                    <div class="scene">
                        ${this._tableArtSvg()}
                        <div class="props"></div>
                        <div class="table-grade" aria-hidden="true"></div>
                        <div class="pth-topzone" data-el="topZone"></div>
                        <div class="surface" data-el="surface"></div>
                    </div>
                </div>

                <div class="hud" data-el="hud">
                    <div class="hud-inner">
                        <div class="hud-top">
                            <div class="hud-strip" data-el="hudTop"></div>
                            <button type="button" class="roster-tab" data-el="rosterTab" aria-expanded="false">
                                <i class="rt-mark"></i><span data-el="rosterCount">0</span>
                            </button>
                        </div>
                        <div class="hud-grid">
                            <div class="hud-col hud-profile" data-el="hudProfile"></div>
                            <div class="hud-col mid">
                                <div class="hud-mid" data-el="hudMid"></div>
                                <div class="hud-right" data-el="hudRight"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <aside class="roster-drawer" data-el="rosterDrawer">
                    <div class="rd-head">
                        <span>${this._esc(this._t('PARLORTAVERN.Roster.Title'))}</span>
                        <button type="button" class="rd-close" data-el="rosterClose">✕</button>
                    </div>
                    <div class="roster" data-el="roster"></div>
                </aside>
            </div>
        `;
    }

    // 桌台保留 B 半写实与 C 全手绘两套正式材质。两套共用坐标、桌角和摆件层，
    // 画风切换只隐藏 SVG 子层，不重建桌台，编辑预览和各游戏桌都走同一条路径。
    _tableArtSvg() {
        return `
            <svg class="table-art" viewBox="0 0 2200 1080" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                <defs>
                    <pattern id="pttw-wood" patternUnits="userSpaceOnUse" width="420" height="420" patternTransform="rotate(2)">
                        <image href="${ASSET}/wood.jpg" width="420" height="420" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <radialGradient id="pttw-wood-shade" cx="50%" cy="46%" r="76%">
                        <stop offset="0" stop-color="rgba(46,24,8,.12)"/><stop offset=".64" stop-color="rgba(24,12,4,.30)"/><stop offset="1" stop-color="rgba(7,3,1,.58)"/>
                    </radialGradient>
                    <radialGradient id="pttw-light" cx="50%" cy="40%" r="70%">
                        <stop offset="0" stop-color="rgba(255,190,100,.16)"/><stop offset=".55" stop-color="rgba(255,170,80,.05)"/><stop offset="1" stop-color="rgba(255,170,80,0)"/>
                    </radialGradient>
                    <radialGradient id="pttw-pad-b" data-el="padGradient" cx="50%" cy="42%" r="78%">
                        <stop offset="0" stop-color="#5c1c21"/><stop offset=".55" stop-color="#451317"/><stop offset="1" stop-color="#2c0a0d"/>
                    </radialGradient>
                    <pattern id="pttw-paper-b" width="72" height="62" patternUnits="userSpaceOnUse">
                        <g fill="#edc18e"><circle cx="7" cy="9" r=".65" opacity=".15"/><circle cx="29" cy="21" r=".5" opacity=".13"/><circle cx="55" cy="8" r=".75" opacity=".14"/><circle cx="64" cy="39" r=".55" opacity=".12"/><circle cx="18" cy="51" r=".7" opacity=".13"/></g>
                        <g fill="#160602"><circle cx="17" cy="29" r=".6" opacity=".18"/><circle cx="44" cy="15" r=".5" opacity=".15"/><circle cx="58" cy="54" r=".7" opacity=".17"/><circle cx="35" cy="44" r=".55" opacity=".14"/></g>
                    </pattern>
                    <filter id="pttw-surface-b" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">
                        <feGaussianBlur in="SourceGraphic" stdDeviation=".20" result="soft"/>
                        <feColorMatrix in="soft" type="saturate" values=".52" result="muted"/>
                        <feComponentTransfer in="muted" result="colorized">
                            <feFuncR type="gamma" amplitude="1.07" exponent=".92" offset=".010"/>
                            <feFuncG type="gamma" amplitude=".88" exponent="1.01" offset=".002"/>
                            <feFuncB type="gamma" amplitude=".68" exponent="1.08" offset="0"/>
                        </feComponentTransfer>
                        <feTurbulence type="fractalNoise" baseFrequency=".009 .068" numOctaves="2" seed="31" result="brush"/>
                        <feColorMatrix in="brush" type="saturate" values="0" result="brushGray"/>
                        <feComponentTransfer in="brushGray" result="brushTone">
                            <feFuncR type="linear" slope=".26" intercept=".36"/><feFuncG type="linear" slope=".26" intercept=".36"/><feFuncB type="linear" slope=".26" intercept=".36"/><feFuncA type="linear" slope=".11"/>
                        </feComponentTransfer>
                        <feBlend in="colorized" in2="brushTone" mode="soft-light" result="painted"/>
                        <feComposite in="painted" in2="SourceAlpha" operator="in"/>
                    </filter>
                    <filter id="pttw-noise-b" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
                        <feTurbulence type="fractalNoise" baseFrequency=".62" numOctaves="2" seed="11" result="n"/>
                        <feColorMatrix type="saturate" values="0" in="n" result="g"/>
                        <feComponentTransfer in="g" result="grain">
                            <feFuncR type="linear" slope=".12" intercept=".44"/><feFuncG type="linear" slope=".12" intercept=".44"/><feFuncB type="linear" slope=".12" intercept=".44"/><feFuncA type="table" tableValues="1 1"/>
                        </feComponentTransfer>
                        <feBlend in="SourceGraphic" in2="grain" mode="overlay" result="blend"/>
                        <feComposite in="blend" in2="SourceAlpha" operator="in"/>
                    </filter>
                    <clipPath id="pttw-table-clip-b"><rect x="114" y="78" width="1972" height="924" rx="96"/></clipPath>
                    <path id="pttw-arc-b" d="M740 430 Q1100 352 1460 430" fill="none"/>

                    <linearGradient id="pttw-wood-c" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stop-color="#71401f"/><stop offset=".24" stop-color="#65351a"/><stop offset=".52" stop-color="#4f2511"/><stop offset=".78" stop-color="#3b190b"/><stop offset="1" stop-color="#271006"/>
                    </linearGradient>
                    <radialGradient id="pttw-light-c" cx="42%" cy="30%" r="84%">
                        <stop offset="0" stop-color="rgba(255,205,127,.13)"/><stop offset=".58" stop-color="rgba(255,181,88,.02)"/><stop offset="1" stop-color="rgba(10,3,1,.48)"/>
                    </radialGradient>
                    <radialGradient id="pttw-pad-c" data-el="padGradient" cx="46%" cy="36%" r="82%">
                        <stop offset="0" stop-color="#612129"/><stop offset=".55" stop-color="#46141a"/><stop offset="1" stop-color="#290a0d"/>
                    </radialGradient>
                    <pattern id="pttw-paper-c" width="64" height="56" patternUnits="userSpaceOnUse">
                        <g fill="#f0c18c"><circle cx="5" cy="8" r=".7" opacity=".20"/><circle cx="24" cy="17" r=".55" opacity=".16"/><circle cx="48" cy="6" r=".8" opacity=".18"/><circle cx="57" cy="31" r=".6" opacity=".15"/><circle cx="15" cy="43" r=".75" opacity=".17"/><circle cx="39" cy="50" r=".55" opacity=".14"/></g>
                        <g fill="#180703"><circle cx="13" cy="22" r=".65" opacity=".22"/><circle cx="36" cy="11" r=".55" opacity=".18"/><circle cx="53" cy="45" r=".8" opacity=".20"/><circle cx="29" cy="37" r=".6" opacity=".17"/><circle cx="7" cy="53" r=".5" opacity=".16"/></g>
                        <g fill="none" stroke="#e2a26d" stroke-width=".7" stroke-linecap="round" opacity=".12"><path d="M18 5 l5 -1"/><path d="M42 29 l6 -1"/><path d="M2 34 l4 -.7"/></g>
                    </pattern>
                    <filter id="pttw-surface-c" x="-3%" y="-3%" width="106%" height="106%" color-interpolation-filters="sRGB">
                        <feTurbulence type="fractalNoise" baseFrequency=".008 .065" numOctaves="2" seed="37" result="brush"/>
                        <feColorMatrix in="brush" type="saturate" values="0" result="brushGray"/>
                        <feComponentTransfer in="brushGray" result="brushTone">
                            <feFuncR type="linear" slope=".30" intercept=".34"/><feFuncG type="linear" slope=".30" intercept=".34"/><feFuncB type="linear" slope=".30" intercept=".34"/><feFuncA type="linear" slope=".16"/>
                        </feComponentTransfer>
                        <feBlend in="SourceGraphic" in2="brushTone" mode="soft-light" result="brushed"/>
                        <feTurbulence type="fractalNoise" baseFrequency=".42" numOctaves="2" seed="19" result="paper"/>
                        <feColorMatrix in="paper" type="saturate" values="0" result="paperGray"/>
                        <feComponentTransfer in="paperGray" result="paperTone">
                            <feFuncR type="linear" slope=".16" intercept=".41"/><feFuncG type="linear" slope=".16" intercept=".41"/><feFuncB type="linear" slope=".16" intercept=".41"/><feFuncA type="linear" slope=".10"/>
                        </feComponentTransfer>
                        <feBlend in="brushed" in2="paperTone" mode="overlay" result="painted"/>
                        <feComposite in="painted" in2="SourceAlpha" operator="in"/>
                    </filter>
                    <clipPath id="pttw-table-clip-c"><rect x="114" y="78" width="1972" height="924" rx="96"/></clipPath>
                    <clipPath id="pttw-felt-clip-c"><rect x="242" y="172" width="1716" height="736" rx="88"/></clipPath>
                    <path id="pttw-arc-c" d="M740 430 Q1100 352 1460 430" fill="none"/>

                    <linearGradient id="pttw-iron" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stop-color="#4c525c"/><stop offset=".5" stop-color="#2b2f36"/><stop offset="1" stop-color="#14161a"/>
                    </linearGradient>
                    <pattern id="pttw-metal" patternUnits="userSpaceOnUse" width="300" height="300" patternTransform="rotate(20)">
                        <image href="${ASSET}/metal.jpg" width="300" height="300" preserveAspectRatio="xMidYMid slice"/>
                    </pattern>
                    <linearGradient id="pttw-metal-sheen" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stop-color="rgba(255,240,200,.5)"/><stop offset=".4" stop-color="rgba(180,150,90,.12)"/><stop offset="1" stop-color="rgba(50,34,12,.5)"/>
                    </linearGradient>
                    <linearGradient id="pttw-brass" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stop-color="#eccf78"/><stop offset=".5" stop-color="#a87f22"/><stop offset="1" stop-color="#6b4a17"/>
                    </linearGradient>
                    <linearGradient id="pttw-gold-line" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stop-color="#fff2c8"/><stop offset=".3" stop-color="#e2bd58"/><stop offset=".6" stop-color="#9a6f1c"/><stop offset="1" stop-color="#e8c96a"/>
                    </linearGradient>
                </defs>

                <g class="ptt-style-layer ptt-style-semi-real">
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-wood)" filter="url(#pttw-surface-b)" stroke="#241207" stroke-width="12"/>
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-paper-b)" opacity=".26"/>
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-wood-shade)"/>
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-light)"/>
                    <rect x="136" y="100" width="1928" height="880" rx="80" fill="none" stroke="rgba(255,214,150,.07)" stroke-width="2"/>
                    <g clip-path="url(#pttw-table-clip-b)">
                        <g fill="none" stroke="rgba(18,8,2,.52)" stroke-width="2.8">
                            <path d="M114 309 C620 305 1512 313 2086 308"/><path d="M114 540 C650 536 1490 544 2086 539"/><path d="M114 771 C590 767 1540 775 2086 770"/>
                        </g>
                        <g fill="none" stroke="rgba(255,214,150,.045)" stroke-width="1.4">
                            <path d="M114 312.5 C620 308.5 1512 316.5 2086 311.5"/><path d="M114 543.5 C650 539.5 1490 547.5 2086 542.5"/><path d="M114 774.5 C590 770.5 1540 778.5 2086 773.5"/>
                        </g>
                        <g fill="none" stroke="rgba(18,8,2,.37)" stroke-width="2.3">
                            <path d="M560 78 C557 158 563 231 560 309"/><path d="M1560 309 C1557 388 1564 462 1560 540"/><path d="M780 540 C777 620 784 696 780 771"/><path d="M1380 771 C1377 849 1384 926 1380 1002"/>
                        </g>
                        <g fill="none" stroke-linecap="round">
                            <path d="M184 178 C316 154 454 157 586 180 M810 218 C954 196 1118 198 1264 219 M1514 166 C1658 145 1816 147 1954 166" stroke="rgba(245,204,145,.055)" stroke-width="2.1"/>
                            <path d="M258 650 C394 629 530 631 668 651 M960 702 C1094 681 1248 683 1390 704 M1518 856 C1660 835 1816 837 1945 855" stroke="rgba(24,8,2,.12)" stroke-width="1.9"/>
                        </g>
                    </g>
                    <ellipse cx="196" cy="700" rx="26" ry="14" fill="none" stroke="rgba(52,26,8,.35)" stroke-width="4"/>
                    <path d="M1900 130 l50 -13 M1911 141 l38 -9" stroke="rgba(20,9,2,.4)" stroke-width="2.5" stroke-linecap="round"/>
                </g>

                <g class="ptt-style-layer ptt-style-handdraw">
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-wood-c)" filter="url(#pttw-surface-c)" stroke="#211005" stroke-width="12"/>
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-paper-c)" opacity=".38"/>
                    <g clip-path="url(#pttw-table-clip-c)">
                        <g fill="none" stroke-linecap="round">
                            <g stroke="rgba(255,220,157,.10)" stroke-width="2.3">
                                <path d="M178 158 C305 137 438 140 566 163"/><path d="M748 232 C902 208 1076 211 1228 234"/><path d="M1464 157 C1618 135 1794 137 1954 159"/>
                                <path d="M244 604 C382 582 548 584 688 605"/><path d="M946 704 C1090 681 1262 684 1408 706"/><path d="M1518 856 C1662 835 1825 836 1952 853"/>
                            </g>
                            <g stroke="rgba(21,7,2,.22)" stroke-width="2.1">
                                <path d="M218 422 C366 399 522 402 652 422"/><path d="M846 478 C1002 454 1170 457 1320 479"/><path d="M1502 390 C1640 370 1792 372 1924 392"/>
                                <path d="M362 842 C492 822 628 824 746 844"/><path d="M1112 910 C1254 889 1405 892 1530 911"/>
                            </g>
                        </g>
                        <g stroke-linecap="round" stroke-linejoin="round">
                            <g transform="translate(352 226) rotate(-7)">
                                <path d="M-39 1 C-27 -8 -10 -11 8 -7 C20 -5 24 0 17 5 C5 11 -15 10 -30 7 C-40 5 -45 3 -39 1Z" fill="rgba(31,11,4,.28)"/>
                                <path d="M-88 8 C-65 1 -49 -1 -34 2 M18 4 C43 10 67 10 91 4 M-52 -7 C-36 -15 -18 -17 -1 -12" fill="none" stroke="rgba(27,9,3,.20)" stroke-width="2.3"/>
                                <path d="M-24 -2 C-9 -7 7 -6 19 -2" fill="none" stroke="rgba(231,160,91,.09)" stroke-width="1.4"/>
                            </g>
                            <g transform="translate(1742 456) rotate(7)">
                                <path d="M-47 0 C-32 -10 -9 -12 13 -8 C28 -5 34 0 25 6 C10 13 -16 11 -35 7 C-47 4 -53 2 -47 0Z" fill="rgba(29,10,3,.30)"/>
                                <path d="M-98 7 C-74 -1 -57 -2 -42 1 M26 4 C53 11 78 11 101 3 M-66 -10 C-47 -18 -25 -19 -5 -13" fill="none" stroke="rgba(27,9,3,.22)" stroke-width="2.5"/>
                                <path d="M-30 -3 C-12 -9 8 -8 24 -3" fill="none" stroke="rgba(231,160,91,.08)" stroke-width="1.5"/>
                            </g>
                            <g transform="translate(590 892) rotate(-5)">
                                <path d="M-32 1 C-22 -7 -7 -9 9 -6 C20 -4 25 0 18 5 C7 10 -11 9 -24 6 C-33 4 -37 2 -32 1Z" fill="rgba(30,10,3,.24)"/>
                                <path d="M-69 6 C-52 0 -40 -1 -28 2 M19 3 C37 8 54 8 70 3 M-45 -7 C-31 -13 -16 -14 -2 -10" fill="none" stroke="rgba(27,9,3,.17)" stroke-width="2"/>
                            </g>
                        </g>
                    </g>
                    <rect x="114" y="78" width="1972" height="924" rx="96" fill="url(#pttw-light-c)"/>
                    <rect x="128" y="92" width="1944" height="896" rx="85" fill="none" stroke="rgba(255,222,162,.09)" stroke-width="3"/>
                    <rect x="139" y="103" width="1922" height="874" rx="76" fill="none" stroke="rgba(17,6,2,.28)" stroke-width="2"/>
                </g>

                <g data-el="corners"></g>

                <g data-el="felt">
                    <g class="ptt-style-layer ptt-style-semi-real">
                        <rect x="242" y="172" width="1716" height="736" rx="88" fill="url(#pttw-pad-b)" filter="url(#pttw-noise-b)"/>
                        <rect x="242" y="172" width="1716" height="736" rx="88" fill="none" stroke="rgba(201,162,39,.55)" stroke-width="2.5"/>
                        <rect x="254" y="184" width="1692" height="712" rx="78" fill="none" stroke="rgba(201,162,39,.28)" stroke-width="1.5" stroke-dasharray="7 7"/>
                        <g transform="translate(1100,560)">
                            <ellipse rx="128" ry="80" fill="none" stroke="rgba(201,162,39,.20)" stroke-width="2"/>
                            <ellipse rx="104" ry="62" fill="none" stroke="rgba(201,162,39,.12)" stroke-width="1.5" stroke-dasharray="9 8"/>
                            <path d="M0,-52 L13,-10 L88,0 L13,10 L0,52 L-13,10 L-88,0 L-13,-10 Z" fill="rgba(201,162,39,.10)"/>
                            <text y="15" text-anchor="middle" font-family="Parlor Cinzel,Georgia,serif" font-size="42" fill="rgba(201,162,39,.28)" letter-spacing="4">G</text>
                        </g>
                        <text font-family="Parlor Cinzel,Georgia,serif" font-size="21" fill="rgba(201,162,39,.32)" letter-spacing="9">
                            <textPath href="#pttw-arc-b" startOffset="50%" text-anchor="middle" data-el="arcName"></textPath>
                        </text>
                        <text x="1100" y="760" text-anchor="middle" font-family="Georgia,serif" font-size="15" letter-spacing="6" fill="rgba(201,162,39,.18)" font-style="italic">hold'em · blackjack · liar's dice — nightly</text>
                    </g>

                    <g class="ptt-style-layer ptt-style-handdraw">
                        <rect x="242" y="172" width="1716" height="736" rx="88" fill="url(#pttw-pad-c)" filter="url(#pttw-surface-c)"/>
                        <rect x="242" y="172" width="1716" height="736" rx="88" fill="url(#pttw-paper-c)" opacity=".32"/>
                        <g clip-path="url(#pttw-felt-clip-c)" fill="none" stroke-linecap="round">
                            <path d="M330 280 C520 252 744 255 930 282 M1240 252 C1455 223 1684 228 1870 256" stroke="rgba(241,177,158,.065)" stroke-width="3"/>
                            <path d="M300 462 C520 434 742 438 930 464 M1290 512 C1480 487 1694 490 1882 514" stroke="rgba(246,193,165,.045)" stroke-width="2.4"/>
                            <path d="M332 706 C530 680 754 684 940 710 M1250 746 C1468 718 1692 721 1870 746" stroke="rgba(20,5,7,.12)" stroke-width="2.6"/>
                            <path d="M508 842 C700 820 906 822 1088 843 M1370 838 C1510 820 1670 821 1812 839" stroke="rgba(18,5,6,.10)" stroke-width="2.2"/>
                        </g>
                        <rect x="242" y="172" width="1716" height="736" rx="88" fill="none" stroke="rgba(205,164,48,.66)" stroke-width="3"/>
                        <rect x="255" y="185" width="1690" height="710" rx="77" fill="none" stroke="rgba(222,184,83,.30)" stroke-width="1.8" stroke-dasharray="9 8"/>
                        <g transform="translate(1100,560)">
                            <ellipse rx="128" ry="80" fill="none" stroke="rgba(222,183,72,.23)" stroke-width="2.5"/>
                            <ellipse rx="104" ry="62" fill="none" stroke="rgba(222,183,72,.14)" stroke-width="1.6" stroke-dasharray="9 8"/>
                            <path d="M0,-52 L13,-10 L88,0 L13,10 L0,52 L-13,10 L-88,0 L-13,-10 Z" fill="rgba(222,183,72,.12)"/>
                            <text y="15" text-anchor="middle" font-family="Parlor Cinzel,Georgia,serif" font-size="42" fill="rgba(222,183,72,.31)" letter-spacing="4">G</text>
                        </g>
                        <text font-family="Parlor Cinzel,Georgia,serif" font-size="21" fill="rgba(222,183,72,.35)" letter-spacing="9">
                            <textPath href="#pttw-arc-c" startOffset="50%" text-anchor="middle" data-el="arcName"></textPath>
                        </text>
                        <text x="1100" y="760" text-anchor="middle" font-family="Georgia,serif" font-size="15" letter-spacing="6" fill="rgba(222,183,72,.20)" font-style="italic">hold'em · blackjack · liar's dice — nightly</text>
                    </g>
                </g>
            </svg>
        `;
    }

    _cacheEls() {
        const q = sel => this._root.querySelector(sel);
        this._els = {
            close: q('.ptt-close'),
            ambience: q('.ambience'),
            phasebar: q('[data-el="phasebar"]'),
            hrPhase: q('[data-el="hrPhase"]'),
            hrRound: q('[data-el="hrRound"]'),
            hrSub: q('[data-el="hrSub"]'),
            heraldFeed: q('[data-el="heraldFeed"]'),
            corners: q('[data-el="corners"]'),
            felt: q('[data-el="felt"]'),
            topZone: q('[data-el="topZone"]'),
            surface: q('[data-el="surface"]'),
            hud: q('[data-el="hud"]'),
            hudTop: q('[data-el="hudTop"]'),
            hudProfile: q('[data-el="hudProfile"]'),
            hudMid: q('[data-el="hudMid"]'),
            hudRight: q('[data-el="hudRight"]'),
            rosterTab: q('[data-el="rosterTab"]'),
            rosterClose: q('[data-el="rosterClose"]'),
            rosterDrawer: q('[data-el="rosterDrawer"]'),
            rosterCount: q('[data-el="rosterCount"]'),
            roster: q('[data-el="roster"]')
        };
    }

    // ── 背景引擎「酒馆之夜」(移植 demo LAYERS) ──────────────

    _initAmbience() {
        const host = this._els.ambience;
        if (!host) return;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const el = (cls, st) => { const n = document.createElement('div'); n.className = cls; Object.assign(n.style, st || {}); return n; };

        const LAYERS = [
            // 默认氛围 = 纯光影零几何:失焦的光怎么看都成立,酒馆感靠色温/火星/烟/木制家具本身承担
            { type: 'wash', depth: 2 },
            { type: 'glow', depth: 2, x: '8%', y: '84%', r: 300, color: 'rgba(255,140,50,.10)', fl: 'f2' },
            { type: 'glow', depth: 3, x: '20%', y: '17%', r: 80, color: 'rgba(255,170,80,.10)', fl: 'f2' },
            { type: 'glow', depth: 3, x: '91%', y: '60%', r: 60, color: 'rgba(255,170,80,.08)' },
            { type: 'glow', depth: 2, x: '86%', y: '12%', r: 180, color: 'rgba(255,190,110,.06)' },
            { type: 'glow', depth: 4, x: '68%', y: '88%', r: 130, color: 'rgba(255,160,70,.05)' },
            { type: 'beam' },
            { type: 'smoke', depth: 5, x: '40%', y: '24%', w: 380, h: 110, dur: '30s' },
            { type: 'smoke', depth: 5, x: '58%', y: '34%', w: 300, h: 90, dur: '38s' },
            { type: 'dust', depth: 6, count: 26 },
            { type: 'sparks', depth: 4, count: 3 },
            { type: 'vig' }
        ];

        const media = el('bg-media');
        host.appendChild(media);
        this._els.bgMedia = media;

        for (const L of LAYERS) {
            let node = null;
            if (L.type === 'wash') {
                node = el('amb');
                node.style.background = 'radial-gradient(58% 46% at 10% 92%, rgba(255,130,45,.09), transparent 72%), radial-gradient(46% 40% at 88% 6%, rgba(255,190,110,.045), transparent 75%), linear-gradient(180deg, transparent 55%, rgba(0,0,0,.28))';
            } else if (L.type === 'glow') {
                node = el('amb');
                node.appendChild(el('amb-glow' + (L.fl ? ' flicker' + (L.fl === 'f2' ? ' f2' : '') : ''), { left: L.x, top: L.y, width: L.r * 2 + 'px', height: L.r * 2 + 'px', background: `radial-gradient(circle, ${L.color}, transparent 70%)` }));
            } else if (L.type === 'beam') {
                node = el('amb amb-beam');
                node.style.background = 'radial-gradient(46% 62% at 50% 6%, rgba(255,196,120,.13), rgba(255,180,100,.05) 46%, transparent 72%), radial-gradient(22% 48% at 50% 2%, rgba(255,214,150,.10), transparent 70%)';
            } else if (L.type === 'smoke') {
                node = el('amb');
                node.appendChild(el('amb-smoke', { left: L.x, top: L.y, width: L.w + 'px', height: L.h + 'px', background: 'radial-gradient(closest-side, rgba(240,232,220,.045), transparent)', '--dur': L.dur }));
            } else if (L.type === 'dust') {
                node = el('amb');
                for (let i = 0; i < L.count; i++) {
                    const s = (1 + Math.random() * 1.6).toFixed(1);
                    node.appendChild(el('amb-dust', { left: (30 + Math.random() * 40).toFixed(1) + '%', top: (10 + Math.random() * 62).toFixed(1) + '%', width: s + 'px', height: s + 'px', '--dur': (18 + Math.random() * 22).toFixed(1) + 's', '--delay': (-Math.random() * 30).toFixed(1) + 's', '--dx': ((Math.random() - .5) * 90).toFixed(0) + 'px', '--dy': (-70 - Math.random() * 110).toFixed(0) + 'px', '--o': (0.25 + Math.random() * 0.5).toFixed(2) }));
                }
            } else if (L.type === 'sparks') {
                node = el('amb');
                for (let i = 0; i < L.count; i++) {
                    node.appendChild(el('amb-spark', { left: (9 + Math.random() * 6).toFixed(1) + '%', top: (74 + Math.random() * 6).toFixed(1) + '%', '--dur': (5 + Math.random() * 4).toFixed(1) + 's', '--delay': (-Math.random() * 9).toFixed(1) + 's', '--dx': ((Math.random() - .5) * 50).toFixed(0) + 'px' }));
                }
            } else if (L.type === 'vig') {
                node = el('amb amb-vig');
            }
            if (!node) continue;
            if (L.depth) node.dataset.depth = L.depth;
            host.appendChild(node);
        }

        if (!reduced) {
            let raf = 0;
            this._pointerHandler = e => {
                if (raf) return;
                raf = requestAnimationFrame(() => {
                    raf = 0;
                    const nx = e.clientX / innerWidth - .5, ny = e.clientY / innerHeight - .5;
                    host.querySelectorAll('[data-depth]').forEach(l => {
                        const d = +l.dataset.depth;
                        l.style.transform = `translate(${(-nx * d).toFixed(1)}px, ${(-ny * d).toFixed(1)}px)`;
                    });
                });
            };
            window.addEventListener('pointermove', this._pointerHandler, { passive: true });
        }
    }

    // 背景媒体层:赌桌预设的 backdrop 优先,没配则回退全局外观上传的桌面背景,
    // 都没有就纯氛围引擎。src 没变只调样式不重建 DOM——编辑器拖滑杆时视频不能重播闪烁
    _applyBackdrop(deck = null) {
        const media = this._els.bgMedia;
        if (!media) return;
        const bd = deck?.backdrop?.src ? deck.backdrop : null;
        let url = bd?.src || '';
        if (!url) {
            const g = this._api?.getTableBackdrop?.();
            // 本体 getTableBackdrop 给的是 {path,isVideo};url/src/裸串是兼容旧形态
            url = g?.path || g?.url || g?.src || (typeof g === 'string' ? g : '') || '';
        }
        if (!url) {
            media.innerHTML = '';
            this._backdropSrc = '';
            return;
        }
        if (url !== this._backdropSrc) {
            this._backdropSrc = url;
            const isVideo = /\.(webm|mp4|m4v|ogv)(\?|$)/iu.test(url);
            if (isVideo) {
                media.innerHTML = `<video src="${url}" autoplay loop muted playsinline></video>`;
            } else {
                // 用户上传的背景常是好几兆的大图：直接塞进去，浏览器会在第一次画它时当场解码，开桌那一帧就顿一下。
                // 先在后台 decode 完再换上；旧背景留到新图好了再撤（工坊里换背景不闪黑），解码失败也照样挂上去交给浏览器
                const img = new Image();
                img.alt = '';
                img.decoding = 'async';
                img.src = url;
                img.decode().catch(() => {}).then(() => {
                    if (this._backdropSrc !== url || !this._els.bgMedia) return;
                    this._els.bgMedia.replaceChildren(img);
                    this._styleBackdrop(this._backdropDeck);
                });
            }
        }
        this._backdropDeck = bd;
        this._styleBackdrop(bd);
    }

    // 三参只在走 deck 背景时上行内样式;全局背景保持 CSS 里的默认压暗失焦
    _styleBackdrop(bd) {
        const node = this._els.bgMedia?.firstElementChild;
        if (!node) return;
        if (bd) {
            const blur = Number(bd.blur ?? 4);
            const bright = Number(bd.bright ?? 0.5);
            node.style.filter = `brightness(${bright}) saturate(.82) blur(${blur}px)`;
            node.style.opacity = String(Number(bd.opacity ?? 1));
        } else {
            node.style.filter = '';
            node.style.opacity = '';
        }
    }

    // ── 赌桌预设(桌台工坊 W5):桌名/桌角/毛毡/画风/摆件 ────

    // 预设是 world setting:mount 时必刷,refresh 时签名比对(高频调用别每次动 DOM)
    _syncDeck(force = false) {
        const deck = this._api?.getTableDeck?.() ?? null;
        const sig = deck ? JSON.stringify(deck) : '';
        if (!force && sig === this._deckSig) return;
        this._deckSig = sig;
        this._applyDeck(deck);
    }

    _applyDeck(deck) {
        // 桌名只读用户预设；没填就留空，别再塞主题自己的酒馆名。
        const name = String(deck?.name || '').trim();
        const brand = this._root?.querySelector('[data-el="deckName"]');
        if (brand) {
            brand.textContent = name;
            brand.hidden = !name;
        }
        this._root?.querySelectorAll('[data-el="arcName"]').forEach(arc => {
            arc.textContent = name ? `✦ ${name} ✦` : '';
        });

        // Parlor 核心仍把主题侧桌面预设存在 surface.wood。新值同时带画风与 B 版木材，
        // 老木纹 id 则直接归到 B，避免旧桌保存前后突然换材质。
        const surfaceId = deck?.surface?.wood;
        const tableStyle = getTableStylePreset(surfaceId);
        if (this._root) this._root.dataset.tableStyle = tableStyle.id;

        // 毛毡是赌桌预设的一部分，隐藏时连压边、徽记和铭文一起收掉，只露完整木面。
        const feltVisible = deck?.felt?.visible !== false;
        this._els.felt?.classList.toggle('is-hidden', !feltVisible);
        this._root?.classList.toggle('ptt-felt-hidden', !feltVisible);

        // 两套毛毡共用玩家选色，但各自保留光心和纹理结构。
        const feltColor = deck?.felt?.color || '#5c1c21';
        this._root?.querySelectorAll('[data-el="padGradient"]').forEach(gradient => {
            const stops = gradient.querySelectorAll('stop');
            if (stops.length !== 3) return;
            stops[0].setAttribute('stop-color', shadeHex(feltColor, 1.0));
            stops[1].setAttribute('stop-color', shadeHex(feltColor, 0.76));
            stops[2].setAttribute('stop-color', shadeHex(feltColor, 0.48));
        });

        // B 的照片底纹继续兼容旧木纹；C 不读照片，但仍让隐藏层保持正确，切换时不用重载。
        const wood = getWoodPreset(surfaceId);
        const pattern = this._root?.querySelector('#pttw-wood');
        const woodImg = pattern?.querySelector('image');
        if (pattern && woodImg) {
            const href = woodAssetPath(wood);
            if (woodImg.getAttribute('href') !== href) woodImg.setAttribute('href', href);
            for (const node of [pattern, woodImg]) {
                node.setAttribute('width', wood.tile);
                node.setAttribute('height', wood.tile);
            }
            woodImg.style.filter = wood.filter || '';
        }
        // 老会话可能残留旧滤镜的行内样式,清一次
        const art = this._root?.querySelector('.table-art');
        if (art) art.style.filter = '';

        this._renderCorners(deck?.corner?.style || 'metal', deck?.corner?.color || '');
        this._renderDeckProps(deck?.props || [], { feltVisible });
        this._applyBackdrop(deck);
    }

    // 摆件:PropLibrary 出图,x/y 0-1 → 百分比;宽度 = 基准宽 / 2200 × scale。
    //
    // 基准宽分两种:带 __sz 标记的走 type.size(真实尺寸),没标记的老存档继续走 viewBox 宽。
    // 本体 sanitizeProp 白名单存不下额外字段,所以标记塞在 styles 里(见 PropLibrary)。
    // 别改成一律用 size——DM 已经摆好的桌子会整桌变尺寸。
    //
    // 影子不画进 svg:这里单独出一层,不吃 --rot(转了摆件影子不能跟着转到上边去)。
    // 全桌都固定朝右下，桌面和摆件才像受同一盏顶灯照着。
    _renderDeckProps(props, { feltVisible = true } = {}) {
        const host = this._root?.querySelector('.props');
        if (!host) return;
        host.innerHTML = (props || []).map((p, i) => {
            const svg = renderPropSvg(p.type, p.colors, p.styles);
            if (!svg) return '';
            const type = getPropType(p.type);
            const [viewW, viewH] = type.view.split(' ').slice(2).map(Number);
            const widthPct = (propBaseWidth(p.type, p) / 2200) * 100 * (Number(p.scale) || 1);
            const rot = type.spin ? (Number(p.rot) || 0) : 0;
            const surfaceClass = isPropOnFelt(p.x, p.y, feltVisible) ? 'on-felt' : 'on-wood';

            return `<div class="prop ${surfaceClass}" data-prop-index="${i}" style="`
                + `z-index:${i};left:${(p.x * 100).toFixed(2)}%;top:${(p.y * 100).toFixed(2)}%;`
                + `width:${widthPct.toFixed(2)}%;`
                + `--rot:${rot}deg;--ar:${(viewH / viewW).toFixed(3)};`
                // 带火的摆件之间错拍闪,别一桌蜡烛齐明齐暗
                + `--flick-delay:${((i % 3) * 1.15).toFixed(2)}s`
                + `">${'<i class="pshadow"></i>'}${svg}</div>`;
        }).join('');
    }

    // 桌角:三样式(金属贴图/无/花纹贵族)× 金属色。color 给了就用单色派生渐变盖掉贴图基调
    _renderCorners(style = 'metal', color = '') {
        const g = this._els.corners;
        if (!g) return;
        if (style === 'none') { g.innerHTML = ''; return; }

        let piece;
        if (style === 'filigree') {
            const stroke = color || '#e2bd58';
            piece = `
            <g fill="none" stroke="${stroke}" stroke-linecap="round">
                <path d="M138 320 Q138 138 320 138" stroke-width="4"/>
                <path d="M160 320 Q160 160 320 160" stroke-width="1.6" opacity=".65"/>
                <path d="M138 320 Q182 300 176 256 Q172 224 200 214 Q224 206 226 232" stroke-width="3"/>
                <path d="M320 138 Q300 182 256 176 Q224 172 214 200 Q206 224 232 226" stroke-width="3"/>
                <path d="M226 232 Q238 214 258 220 Q272 224 268 244" stroke-width="2.4"/>
                <path d="M148 214 Q120 210 116 182" stroke-width="2.2" opacity=".8"/>
                <path d="M214 148 Q210 120 182 116" stroke-width="2.2" opacity=".8"/>
            </g>
            <path d="M150 150 l7 -16 7 16 -7 16 Z" fill="${stroke}"/>
            <circle cx="245" cy="245" r="6" fill="${stroke}"/>
            <circle cx="245" cy="245" r="10" fill="none" stroke="${stroke}" stroke-width="1.4" opacity=".6"/>`;
        } else {
            const cornerPath = 'M120 258 V166 Q120 104 182 104 H274 V148 H198 Q164 148 164 182 V258 Z';
            // 有自定义色 → 单色派生渐层盖掉黄铜基调;没有 → 走贴图+默认黄铜
            const tint = color
                ? `<path d="${cornerPath}" fill="${color}" opacity=".78" style="mix-blend-mode:multiply"/>
                   <path d="${cornerPath}" fill="${shadeHex(color, 1.5)}" opacity=".24"/>`
                : `<path d="${cornerPath}" fill="url(#pttw-brass)" opacity=".62" style="mix-blend-mode:multiply"/>`;
            const rivet = color ? shadeHex(color, 1.45) : '#e2c878';
            piece = `
            <path d="${cornerPath}" fill="url(#pttw-metal)" stroke="#241204" stroke-width="3"/>
            ${tint}
            <path d="${cornerPath}" fill="url(#pttw-metal-sheen)" opacity=".5"/>
            <path d="${cornerPath}" fill="none" stroke="rgba(255,236,180,.2)" stroke-width="1.2"/>
            <g fill="${rivet}" stroke="#6b4a17" stroke-width="1"><circle cx="144" cy="208" r="5"/><circle cx="144" cy="128" r="5"/><circle cx="234" cy="126" r="5"/></g>`;
        }
        const mirror = ['', 'translate(2200,0) scale(-1,1)', 'translate(0,1080) scale(1,-1)', 'translate(2200,1080) scale(-1,-1)'];
        g.innerHTML = mirror.map(t => `<g transform="${t}">${piece}</g>`).join('');
    }

    // ── 共用数据接线(gameApi → 壳) ─────────────────────────

    // 阶段灯:序列 + 当前/已完成由子类的 phases/phaseProgress 决定
    _renderPhaseBar(state) {
        const bar = this._els.phasebar;
        if (!bar) return;
        const phases = this.phases;
        const { active, done } = this.phaseProgress(state);
        bar.innerHTML = phases.map((p, i) => {
            const cls = i < done ? ' done' : (i === active ? ' on' : '');
            return `<span class="plight${cls}">${this._esc(this._t(p.labelKey))}</span>`;
        }).join('');
    }

    // ── 链吊木牌 · 播报器 ───────────────────────────────────
    //
    // 本体那条语义事件通道(PresenterHost.dispatch)至今没人调用,所以播报只能靠
    // 前后两帧状态对比推出来。对比的对象必须是 _heraldSnapshot 拍下的扁平快照:
    // getState() 每次返回新对象,但 playerStates 是活引用,直接留着下一帧就已经被改过了。

    _renderHerald(state, status) {
        this._setText('hrPhase', status.phase);
        this._setText('hrRound', status.round);
        this._setText('hrSub', status.sub);

        const next = this._heraldSnapshot(state, status);
        const prev = this._heraldSnap;
        this._heraldSnap = next;
        // 首帧不倒放历史,只挂一句"现在轮到谁"当开场白
        const lines = prev ? this._heraldLines(prev, next) : this._heraldOpening(next);
        for (const line of lines) this._pushHerald(line);
    }

    // 播报快照:只准放原始值(字符串/数字/纯对象副本),不许挂 state 上的活引用。
    // bets 是 GameBase 给所有桌的统一下注记录,收在基类里对比,下注型牌桌就不用各写一遍
    _heraldSnapshot(state, status) {
        const bets = {};
        for (const bet of state.bets || []) {
            if (!bet?.userId) continue;
            bets[bet.userId] = {
                side: bet.side || '',
                // 三张扑克把底注写在 anteAmount 上,其余桌都是 amount
                amount: Number(bet.amount ?? bet.anteAmount ?? 0),
                decision: bet.decision || ''
            };
        }
        return {
            phase: status.phase || '',
            round: status.round || '',
            title: status.title || '',
            sub: status.sub || '',
            bets
        };
    }

    _heraldOpening(next) {
        const out = [{ text: this._t('PARLORTAVERN.Herald.TableOpen'), tone: 'round' }];
        if (next.title) out.push({ text: next.title, tone: 'turn' });
        return out;
    }

    // 播报主干:开局 → 下注 → 各桌自己的戏 → 轮到谁。
    // 子类别覆盖这个方法,覆盖下面三个钩子就行,免得每家都要重排一遍顺序
    _heraldLines(prev, next) {
        const out = [];
        const newRound = !!next.round && next.round !== prev.round;
        // 开局那一帧所有座位都是新建的,逐座对比全是噪音,下注等下一帧再说
        if (newRound) out.push(...this._roundOpenLines(next));
        else out.push(...this._betHeraldLines(prev, next));
        out.push(...this._gameHeraldLines(prev, next, newRound));
        if (next.title && next.title !== prev.title) out.push({ text: next.title, tone: 'turn' });
        return out.filter(line => line && line.text);
    }

    // 开新局报什么。默认"第 N 局 · 盲注/底注";德州要点名庄和两家盲注,自己覆盖
    _roundOpenLines(next) {
        return [{ text: [next.round, next.sub].filter(Boolean).join(' · '), tone: 'round' }];
    }

    // 各桌特有的动作(弃牌/爆牌/开战/叫点…),默认没有
    _gameHeraldLines(_prev, _next, _newRound) { return []; }

    // 下注区名字(闲/庄/龙/虎…)。不分区的桌不覆盖,报成"下注 N"就够
    _betSideLabel(_side) { return ''; }

    // 有人新下注或改注就播一句。不走 bets 的桌(德州/说谎骰)这里天然空转
    _betHeraldLines(prev, next) {
        const out = [];
        for (const [id, bet] of Object.entries(next.bets || {})) {
            const before = prev.bets?.[id];
            if (before && before.amount === bet.amount && before.side === bet.side) continue;
            const name = this._seatName(id);
            if (!name || !bet.amount) continue;
            const side = this._betSideLabel(bet.side);
            const amount = this._chips(bet.amount);
            out.push({
                text: side
                    ? this._t('PARLORTAVERN.Herald.BetSide', { name, side, amount })
                    : this._t('PARLORTAVERN.Herald.Bet', { name, amount }),
                tone: 'raise'
            });
        }
        return out;
    }

    // 挂一句到木牌上:追加式(不重建旧行,不然每条新消息都会把整块闪一遍)。
    // 超额那行先塌下去再摘——直接 remove 整列会瞬间跳一格,看着像闪。
    // 行高固定在 CSS 里,所以塌的过程中留在牌上的三行只是平移+换字号,不会重排
    _pushHerald({ text, tone = '' } = {}) {
        const feed = this._els.heraldFeed;
        const line = String(text || '').trim();
        if (!feed || !line || line === this._heraldLast) return;
        this._heraldLast = line;

        const node = document.createElement('div');
        node.className = `hline${tone ? ` t-${tone}` : ''} is-new`;
        node.innerHTML = `<i class="hmark"></i><span>${this._esc(line)}</span>`;
        feed.appendChild(node);

        while (feed.children.length > HERALD_MAX) {
            const oldest = feed.firstElementChild;
            // 已经在塌的那行不再等,连播时直接摘掉,免得堆一列半死不活的
            if (oldest.dataset.out || feed.children.length > HERALD_MAX + 1) {
                oldest.remove();
                continue;
            }
            oldest.dataset.out = '1';
            oldest.classList.add('is-out');
            setTimeout(() => oldest.remove(), 320);
            break;
        }
    }

    _seatName(id) {
        return this._seatNames.get(id) || '';
    }

    // ── 在座名录抽屉 ────────────────────────────────────────

    // 名录平时收着,拉开是从右侧边栏滑出来(桌台居中,两侧本来就是空的),不压桌面
    _toggleRoster(force = null) {
        this._rosterOpen = force === null ? !this._rosterOpen : !!force;
        writeRosterOpen(this._rosterOpen);
        this._syncRosterDrawer();
    }

    _syncRosterDrawer() {
        this._root?.classList.toggle('roster-open', this._rosterOpen);
        this._els.rosterTab?.setAttribute('aria-expanded', String(this._rosterOpen));
    }

    // 在座名录:当前行动者整行金框(.turn);弃牌/出局/爆牌整行压灰(.off);自己那行带"你"标
    _renderRoster(seats = this._api?.getSeats?.() || []) {
        const host = this._els.roster;
        if (!host) return;
        const isOff = cls => ['is-folded', 'is-out', 'is-bust'].some(c => (cls || '').includes(c));
        // 名录行带头像图片,机器人局每步都重建整列会一直闪;数据没变就不动
        const sig = JSON.stringify(seats.map(seat => [
            seat.id, seat.name, seat.avatarHtml || '', (seat.badges || [])[0] || null, seat.chips ?? '',
            !!seat.highlight, seat.className || '', !!seat.isSelf
        ]));
        if (sig === this._rosterSig && host.children.length === seats.length) return;
        this._rosterSig = sig;
        host.innerHTML = seats.map(seat => {
            const rowCls = ['prow', seat.highlight ? 'turn' : '', isOff(seat.className) ? 'off' : '', seat.isSelf ? 'self' : ''].filter(Boolean).join(' ');
            // 身份徽章取头一枚(庄/盲等)接筹码;状态(弃牌/等待)靠整行灰化表达,不再单列
            const badge = (seat.badges || [])[0];
            const meta = [
                badge ? this._badge(badge.label, badge.className) : '',
                seat.chips ? `<span class="rcp">${this._esc(seat.chips)}</span>` : ''
            ].filter(Boolean).join('');
            const selfMark = seat.isSelf
                ? `<span class="self-mark">${this._esc(this._t('PARLORTAVERN.Status.You'))}</span>`
                : '';
            return `<div class="${rowCls}" data-pid="${this._esc(seat.id)}">
                <div class="ava">${seat.avatarHtml || this._initial(seat.name)}</div>
                <span class="rnm">${this._esc(seat.name)}${selfMark}</span>
                ${meta}
            </div>`;
        }).join('');
        this._setText('rosterCount', seats.length);
        this._els.rosterTab?.classList.toggle('is-empty', !seats.length);
    }

    // 牌飞向别的玩家时的落点:抽屉开着飞到他那行,收着就飞向抽屉把手
    // (收起来的行没有尺寸,直接飞过去等于飞到屏幕角落)
    _seatAnchor(participantId) {
        if (!participantId) return null;
        if (this._rosterOpen) {
            const rows = this._els.roster?.querySelectorAll?.('.prow') || [];
            for (const row of rows) {
                if (row.dataset?.pid === participantId) return row;
            }
        }
        return this._els.rosterTab || null;
    }

    // HUD 铭文条 = 游戏名 + 子类给的表况片段。旁观也照显,不依赖 getHud
    _renderTableStrip(state) {
        const el = this._els.hudTop;
        if (!el) return;
        el.innerHTML = [
            `<span class="ts-game">${this.gameGlyph} ${this._esc(this._t(this.gameNameKey) || this._t(this.gameNameFallbackKey))}</span>`,
            ...this.tableStripStatus(state)
        ].filter(Boolean).join('<span class="rune">·</span>');
    }

    _renderHud(state, seats = this._api?.getSeats?.() || []) {
        const hud = this._api?.getHud?.();
        this._syncHudLayout(hud);
        this._syncHudTurn(hud, seats);
        // 无可控席位(纯旁观):留极简 HUD(hudTop 由 _renderTableStrip 管,这里不碰)
        if (!hud) {
            this._els.hudProfile.innerHTML = '';
            this._els.hudMid.innerHTML = `<span class="dealer-lbl">${this._esc(this._t('PARLORTAVERN.Status.Spectating'))}</span>`;
            this._els.hudRight.innerHTML = '';
            this._lastActionSig = null;
            this._lastHandSig = null;
            this._fanHand = null;
            this._fanKeys = null;
            return;
        }

        this._renderHudIdentity(hud.identity || {});
        this._renderHudHand(hud);

        // 操作区只在"动作集/aside 结构"真变时重建。不信任 gameApi.traySignature 是否完整
        // (21点漏了 pendingAction),也不能每次 refresh 都重建——按钮 DOM 频繁换新会把落在
        // 重建瞬间的点击吞掉(发牌按钮"多次失灵")。aside 只看有无(内容变=草稿输入,不重建以护焦点)。
        const actionSig = JSON.stringify({
            a: (hud.actions || []).map(x => [
                x.label, !!x.disabled, x.className || '', x.kind || '', x.face || 0, x.minQuantity || 0, x.suit || ''
            ]),
            aside: !!hud.asideHtml,
            claimDraft: hud.claimDraft ? Number(hud.claimDraft.quantity || 1) : null
        });
        if (actionSig === this._lastActionSig) return;
        this._lastActionSig = actionSig;
        this._renderHudActions(hud);
    }

    // 轮次暗示:轮到你,整台 HUD 点亮呼吸;没轮到就安静压暗。
    // 判定优先信任座位数据(本体已经算好 highlight/isSelf),多控时按 HUD 当前选中的那位算;
    // 完全没席位又给了按钮(GM 推进)也算"在等你",不然 DM 永远看不到提示
    _syncHudTurn(hud, seats) {
        const hudEl = this._els.hud;
        if (!hudEl) return;
        const owner = hud?.ownerId ? seats.find(s => s.id === hud.ownerId) : null;
        const self = seats.find(s => s.isSelf);
        const mine = owner ? !!owner.highlight
            : self ? !!self.highlight
            : !!hud?.actions?.length;
        hudEl.classList.toggle('is-turn', mine);
    }

    _syncHudLayout(hud) {
        const column = this._els.hudMid?.parentElement;
        if (!column) return;

        const hasActions = !!hud?.actions?.length;
        const hasMainContent = !!(
            hud?.cards?.length
            || hud?.diceValues?.length
            || hud?.strength
            || hud?.centerHtml
        );
        // GM 只有推进按钮时别保留空手牌槽和固定操作占位；有规则说明时，按钮也要贴着规则走。
        column.classList.toggle('is-command-only', hasActions && !hasMainContent && !hud?.asideHtml);
        column.classList.toggle('has-context-actions', hasActions && !!hud?.centerHtml && !hud?.asideHtml);
    }

    _renderHudIdentity(id) {
        // 档案栏:头像 + 身份 + 筹码。战绩四格(局数/胜/连胜/净收益)等本体补 session 统计后再填
        this._els.hudProfile.innerHTML = `
            <div class="who">
                <div class="crest">${id.crest || this._initial(id.name)}</div>
                <div class="pid">
                    <span class="tag">${this._esc(id.tag || '')}</span>
                    <span class="name">${this._esc(id.name || '')}</span>
                    <span class="credits">${this._esc(id.credits || '')}</span>
                    <span class="sub">${this._esc(id.sub || '')}</span>
                </div>
            </div>`;
    }

    // 手牌/骰:renderCard 出真实牌面(吃玩家卡面设置);centerHtml = 参与者切换(多控时)
    _renderHudHand(hud) {
        if (this.handLayout === 'fan') {
            this._renderHudHandFan(hud);
            return;
        }
        const mid = this._els.hudMid;
        mid.innerHTML = '';
        const dealt = [];
        const cards = hud.cards || [];
        if (cards.length) {
            const hand = document.createElement('div');
            hand.className = 'hand';
            cards.forEach(c => {
                const el = this._card(c.card, c);
                hand.appendChild(el);
                if (c.card) dealt.push(el); // 只有真牌参与发牌动画,占位背面不算
            });
            mid.appendChild(hand);
        }
        this._dealNew('hand', dealt);
        this._renderHudExtras(hud, mid);
    }

    // 扇形手牌:每张牌套一个 .pth-fan-slot,位置/旋转全由 CSS 按 --n/--i 算(行内 transform 会压掉 hover)。
    // 只在签名变了才重建:牌上挂着点击监听,每次 refresh 都换 DOM 会把落在重建瞬间的点击吞掉(21点按钮踩过)。
    // 新牌按"牌身份"识别不按下标——本体把手牌排了序,新抽的牌会插在中间
    _renderHudHandFan(hud) {
        const mid = this._els.hudMid;
        if (!mid) return;
        const cards = hud.cards || [];
        const sig = this._handSignature(hud);
        if (sig === this._lastHandSig && this._fanHand && this._fanHand.parentNode === mid) return;
        this._lastHandSig = sig;
        this._releaseHandLock();
        mid.innerHTML = '';

        const prevKeys = this._fanKeys || new Set();
        const nextKeys = new Set();
        const seen = {};
        const hand = document.createElement('div');
        hand.className = 'hand is-fan';
        hand.style.setProperty('--n', String(cards.length));
        let fresh = 0;

        cards.forEach((entry, index) => {
            const base = `${entry.card?.rank ?? ''}-${entry.card?.suit ?? ''}`;
            seen[base] = (seen[base] || 0) + 1;
            const key = `${base}#${seen[base]}`; // 两副牌时同一张会出现两次,加序号区分
            nextKeys.add(key);

            const slot = document.createElement('div');
            const mode = entry.playable === true ? 'is-playable' : entry.playable === false ? 'is-inert' : 'is-static';
            slot.className = `pth-fan-slot ${mode}`;
            slot.style.setProperty('--i', String(index));
            slot.dataset.key = key;
            const el = this._card(entry.card, entry);
            // 发牌动画挂在牌上不挂在槽上:pttDealIn 收尾是 transform:none,挂槽上会把扇形位置抹掉
            if (entry.card && !prevKeys.has(key)) {
                el.classList?.add('ptt-deal');
                el.style?.setProperty('--deal-delay', `${fresh * 70}ms`);
                fresh += 1;
            }
            slot.appendChild(el);
            if (typeof entry.onClick === 'function') {
                slot.addEventListener('click', event => this._onHandCardClick(event, entry, slot, hand));
            }
            hand.appendChild(slot);
        });

        mid.appendChild(hand);
        this._fanHand = hand;
        this._fanKeys = nextKeys;
        if (fresh) this._api?.playSound?.(prevKeys.size === 0 && fresh > 1 ? 'deal' : 'placed');
        this._dealCounts.hand = cards.filter(c => c.card).length;
        this._renderHudExtras(hud, mid);
    }

    _handSignature(hud) {
        return JSON.stringify({
            o: hud.ownerId || '',
            c: (hud.cards || []).map(c => [
                c.card?.rank ?? '', c.card?.suit ?? '', c.playable ?? null,
                !!(c.faceDown ?? c.startFaceDown), !!c.idleFaceDown, typeof c.onClick === 'function'
            ]),
            s: hud.strength ? [hud.strength.tier ?? 0, hud.strength.label || ''] : null,
            d: hud.diceValues || null,
            x: hud.centerHtml || ''
        });
    }

    _onHandCardClick(event, entry, slot, hand) {
        if (this._handBusy || entry.playable !== true) return;
        const sound = this.actionSoundKind({ kind: 'play', card: entry.card });
        if (sound) this._api?.playSound?.(sound);
        this.handCardPlayed(entry, slot);
        this._lockHand(hand, entry.onClick(event, { card: entry.card }));
    }

    // 出牌在途时整手锁住,免得连点两张。成功后本体刷新会换新手牌(签名变→重建→解锁);
    // 被拒会拿到 {ok:false} 也解锁;onClick 不返回 Promise 的话 1.5s 兜底
    _lockHand(hand, result) {
        this._handBusy = true;
        hand?.classList?.add('is-busy');
        clearTimeout(this._handBusyTimer);
        this._handBusyTimer = setTimeout(() => this._releaseHandLock(), 1500);
        Promise.resolve(result).catch(() => null).then(() => this._releaseHandLock());
    }

    _releaseHandLock() {
        this._handBusy = false;
        clearTimeout(this._handBusyTimer);
        this._handBusyTimer = null;
        this._fanHand?.classList?.remove('is-busy');
    }

    _renderHudExtras(hud, mid) {
        // 骰子游戏(骨骰21等):hud.diceValues 画成酒馆骰(tavern.css 的 .die 点阵),替代牌位
        if (Array.isArray(hud.diceValues) && hud.diceValues.length) {
            const row = document.createElement('div');
            row.className = 'dice-row';
            row.innerHTML = hud.diceValues.map(v => {
                const val = Math.max(1, Math.min(6, Number(v) || 1));
                return `<div class="die" data-v="${val}">${'<i></i>'.repeat(val)}</div>`;
            }).join('');
            mid.appendChild(row);
        }

        // 牌力块(德州/21点/三张):牌型名 + 七格宝石 + 一句话提示,demo 的 THREE KINGS 形制
        if (hud.strength) {
            const s = document.createElement('div');
            s.className = 'strength';
            const tier = Math.max(0, Math.min(7, Number(hud.strength.tier ?? 0)));
            const gems = Array.from({ length: 7 }, (_, i) => `<i${i < tier ? ' class="on"' : ''}></i>`).join('');
            s.innerHTML = `
                <span class="lbl">${this._esc(hud.strength.title || this._t('PARLORTAVERN.Status.HandStrength'))}</span>
                <span class="val">${this._esc(hud.strength.label || '')}</span>
                <div class="eqrow"><div class="gems">${gems}</div></div>
                ${hud.strength.note ? `<span class="outs">${this._esc(hud.strength.note)}</span>` : ''}`;
            mid.appendChild(s);
        }

        if (hud.centerHtml) {
            const ctx = document.createElement('div');
            ctx.innerHTML = hud.centerHtml;
            mid.appendChild(ctx.firstElementChild || ctx);
            // 多控参与者切换:改选后重拉 HUD。选中态由本体 resolveSelectedParticipantId 决定,
            // gameApi 暂无 setter——单控是常态(select 不出现),多控切换留契约补 setter 后接。
            // 按 select 标签泛化匹配,不写死某游戏的 id
            mid.querySelector('select')?.addEventListener('change', () => this._renderHud(this._api.getState?.() || {}));
        }
    }

    _renderHudActions(hud) {
        const right = this._els.hudRight;
        right.innerHTML = '';

        if (hud.asideHtml) {
            const aside = document.createElement('div');
            aside.innerHTML = hud.asideHtml;
            const injected = aside.firstElementChild || aside;
            right.appendChild(injected);
            // 快捷档按钮设值到 aside 里的数字输入(泛化:不写死某游戏的输入 id)
            const input = right.querySelector('input[type="number"]');
            right.querySelectorAll('[data-raise-quick]').forEach(btn => {
                btn.addEventListener('click', () => { if (input) input.value = btn.dataset.raiseQuick; });
            });
        }

        this._appendActionButtons(right, hud.actions || []);
    }

    _appendActionButtons(host, actions, { rowClass = 'btn-row', dataProvider = null } = {}) {
        if (!host || !actions.length) return null;
        const row = document.createElement('div');
        row.className = rowClass;
        actions.forEach(action => row.appendChild(this._createActionButton(action, { dataProvider })));
        host.appendChild(row);
        return row;
    }

    _createActionButton(action, { dataProvider = null, extraClassName = '' } = {}) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = ['abtn', action.className || 'plain', extraClassName].filter(Boolean).join(' ');
        btn.disabled = !!action.disabled;
        btn.innerHTML = `${action.icon ? `<i class="${action.icon}"></i>` : ''}${this._esc(action.label || '')}`;
        btn.addEventListener('click', event => {
            const data = typeof dataProvider === 'function'
                ? dataProvider(action, btn)
                : this._collectActionData();
            this._runHudAction(action, event, btn, data);
        });
        return btn;
    }

    _runHudAction(action, event, button, data = {}) {
        const soundKind = this.actionSoundKind(action);
        if (soundKind) this._api?.playSound?.(soundKind);
        return action.onClick?.(event, { ...(data || {}), button });
    }

    // ── 小工具 ──────────────────────────────────────────────

    // 对峙牌组:公共牌局游戏(百家乐闲庄/龙虎/战争庄家/三张庄家)的通用垫面单元。
    // label 为空时完全不建标题节点；plaque 只给需要明确双方身份的桌面使用。
    _duelGroup({ label, labelVariant = '', cards = [], total = '', win = false, dealZone = '' }) {
        const g = document.createElement('div');
        g.className = [
            'pth-duel',
            win ? 'win' : '',
            labelVariant === 'plaque' ? 'has-side-plaque' : ''
        ].filter(Boolean).join(' ');
        const labelHtml = label ? `<div class="pth-duel-lbl">${this._esc(label)}</div>` : '';
        g.innerHTML = `${labelHtml}<div class="cards-row"></div>${total !== '' ? `<div class="pth-duel-total">${this._esc(String(total))}</div>` : ''}`;
        const row = g.querySelector('.cards-row');
        const dealt = [];
        for (const item of cards) {
            const card = item && item.card !== undefined ? item.card : item;
            const el = this._card(card, { faceDown: !!(item && item.faceDown) || !card });
            row.appendChild(el);
            if (card) dealt.push(el);
        }
        if (dealZone) this._dealNew(dealZone, dealt);
        return g;
    }

    // 幽灵飞牌:body 上临时放一张牌从 from 矩形飞到 to 矩形(座位→弃牌堆、牌堆→座位)。
    // 从 21点的私有实现参数化而来;reduced-motion 直接不飞。新动作到来时子类可 _cancelFlights 打断
    _flyCardGhost({ card = null, faceDown = false, from = null, to = null, scale = 0.6, delay = 0, rotate = 8, duration = 280 } = {}) {
        if (!from || !to || !globalThis.document?.body) return null;
        if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return null;

        const ghost = this._card(card, { faceDown });
        ghost.classList?.add('ptt-card-flight');
        Object.assign(ghost.style, {
            position: 'fixed', left: `${from.left}px`, top: `${from.top}px`,
            width: `${from.width}px`, height: `${from.height}px`, margin: '0',
            pointerEvents: 'none', zIndex: '100001', opacity: '0.98',
            transition: `transform ${duration}ms cubic-bezier(.18,1,.22,1), opacity ${duration}ms ease`
        });
        document.body.appendChild(ghost);
        this._flights.add(ghost);

        const moveX = (to.left + to.width / 2) - (from.left + from.width / 2);
        const moveY = (to.top + to.height / 2) - (from.top + from.height / 2);
        setTimeout(() => {
            if (!this._flights.has(ghost)) return;
            (globalThis.requestAnimationFrame || (fn => fn()))(() => {
                ghost.style.transform = `translate(${moveX}px, ${moveY}px) scale(${scale}) rotate(${rotate}deg)`;
                ghost.style.opacity = '0.12';
            });
        }, delay);
        setTimeout(() => {
            ghost.remove();
            this._flights.delete(ghost);
        }, duration + delay + 60);
        return ghost;
    }

    _cancelFlights() {
        for (const ghost of this._flights) ghost.remove?.();
        this._flights.clear();
    }

    // 发牌动画:只给"这一轮新出现的真牌"加 .ptt-deal(牌数从 prev 增到 now 的那几张),
    // 交错入场。牌数减少=新一局清台,只更计数不 animate;下次增加又会触发。els 只传真牌。
    _dealNew(zoneKey, els) {
        const prev = this._dealCounts[zoneKey] ?? 0;
        const now = els.length;
        if (now > prev) {
            for (let i = prev; i < now; i++) {
                els[i]?.classList?.add('ptt-deal');
                els[i]?.style?.setProperty('--deal-delay', `${(i - prev) * 90}ms`);
            }
        }
        if (now > prev) this._api?.playSound?.('placed');
        this._dealCounts[zoneKey] = now;
    }

    // 牌:走本体 CardRenderer,拿不到就退化成羊皮纸背面占位,永不崩。
    // hint 用数据映射的提示语义(startFaceDown/idleFaceDown/hoverReveal),
    // CardRenderer 只认 faceDown/size,悬停揭示由本类接(隐私:手牌默认扣着,悬停翻开)
    _card(card, hint = {}) {
        const faceDown = hint.faceDown ?? hint.startFaceDown ?? false;
        try {
            // 不透传映射层的 size('hud' 是原生 260×364 大卡);酒馆牌尺寸交给 tavern.css,
            // 免得撞上 core 的固定宽高把牌面裁掉。默认走 core 'normal',我方 CSS 再统一改写宽高
            const node = this._api?.renderCard?.(card, { faceDown });
            if (node instanceof HTMLElement || node instanceof SVGElement) {
                if (hint.hoverReveal && node instanceof HTMLElement) {
                    node.addEventListener('mouseenter', () => {
                        node.classList.remove('face-down');
                        this._api?.playSound?.('flip');
                    });
                    node.addEventListener('mouseleave', () => { if (hint.idleFaceDown) node.classList.add('face-down'); });
                }
                return node;
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | renderCard failed`, err);
        }
        const fallback = document.createElement('div');
        fallback.className = 'fcard back';
        fallback.innerHTML = '<div class="seal"><i>G</i></div>';
        return fallback;
    }

    _badge(label, className) {
        return `<span class="badge${className ? ' ' + className : ''}">${this._esc(label)}</span>`;
    }

    // 骰子:酒馆 .die 形制(data-v + n 个 pip,CSS 按 nth-child 摆点)。说谎骰用它,不吃核心 .parlor-ld-die
    _die(value) {
        const v = Math.max(1, Math.min(6, Math.floor(Number(value) || 1)));
        const el = document.createElement('div');
        el.className = 'die';
        el.dataset.v = String(v);
        el.innerHTML = '<i></i>'.repeat(v);
        return el;
    }

    _initial(name) {
        return this._esc(String(name || '?').trim().charAt(0) || '?');
    }

    _setText(key, value) {
        const el = this._els[key];
        if (el) el.textContent = value ?? '';
    }

    // 缺失键时 Foundry 回显键名本身;这里归一成空串,好让上层的 `|| 兜底` 生效
    _t(key, data) {
        const out = this._api?.t?.(key, data);
        return (out == null || out === key) ? '' : out;
    }

    _chips(value) {
        return this._api?.formatChips?.(value) ?? String(Number(value || 0));
    }

    _esc(value) {
        return String(value ?? '')
            .replace(/&/gu, '&amp;')
            .replace(/</gu, '&lt;')
            .replace(/>/gu, '&gt;')
            .replace(/"/gu, '&quot;')
            .replace(/'/gu, '&#39;');
    }
}
