/**
 * 甲虫赛跑 · 甲虫与动作的画法
 *
 * 经典桌、赛事工坊的预览、动作陈列馆、以后的酒馆皮都从这里拿甲虫，保证同一个动作在哪儿演都一样。
 *
 * 结构：
 * - createBeetle(look) 画一只俯视甲虫（朝 +x），返回 BeetleActor。
 * - actor.update(frame) 每帧调一次：给世界坐标、速度、当前动作和进度，它自己摆姿势、往 FxLayer 里冒特效。
 * - 每个动作是一个"姿态函数" POSES[id](p, q)：包络进度 p 和节拍 q → 身体位移/旋转/缩放、腿的模式、要显示哪些部件……
 *   延长时长只拉长中间的持续段（remapProgress），循环动作按节拍 q 走，不会变成慢动作。
 *   动作的"跑多快"归模拟层（Catalog 的 sim 字段），这里只管好不好看，改这里不会改比赛结果。
 * - CUES 是动作里某个进度点冒一次的特效，EMITTERS 是动作期间持续冒的特效。
 *
 * 这里用 Math.sin 没问题：画面不需要跨端逐位一致，只有模拟需要。
 * 渲染层里的 id 全带计数器后缀，同一页面里放多只甲虫不会串色。
 */

import { ACTIONS } from './BeetleRaceCatalog.js';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));
const lerp = (a, b, t) => a + (b - a) * t;
// 角度收到 (-180, 180]：转了两圈的甲虫回正时别再倒着转回去
const wrapAngle = (a) => ((a + 180) % 360 + 360) % 360 - 180;
const smooth = (t) => { const c = clamp01(t); return c * c * (3 - 2 * c); };
const easeOut = (t) => 1 - (1 - clamp01(t)) ** 3;
// 在 [a,b] 区间里从 0 走到 1，区间外夹住
const span = (p, a, b) => clamp01((p - a) / (b - a));
// 单个鼓包：p 在 [a,b] 内先升后降（0→1→0）
const bump = (p, a, b) => { const t = span(p, a, b); return t <= 0 || t >= 1 ? 0 : Math.sin(t * Math.PI); };
// 进场 a→b 升到 1，退场 c→d 降回 0
const window01 = (p, a, b, c, d) => smooth(span(p, a, b)) * (1 - smooth(span(p, c, d)));

function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
}

function show(node, on) {
    node.style.display = on ? '' : 'none';
}

// ───────── 颜色 ─────────

function hexToHsl(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
}

function hsl(h, s, l) {
    return `hsl(${h.toFixed(1)} ${(clamp01(s) * 100).toFixed(1)}% ${(clamp01(l) * 100).toFixed(1)}%)`;
}

/** 一个壳色 → 高光 / 本色 / 暗部 / 最深处 / 腹面 / 腿 */
export function deriveShades(hex) {
    const safe = /^#[0-9a-f]{6}$/iu.test(String(hex || '')) ? hex : '#8a5a2a';
    const { h, s, l } = hexToHsl(safe);
    return {
        light: hsl(h, s * 0.9, Math.min(0.86, l + 0.24)),
        base: safe,
        dark: hsl(h, Math.min(1, s * 1.05), Math.max(0.08, l - 0.17)),
        deep: hsl(h, Math.min(1, s * 1.1), Math.max(0.05, l - 0.28)),
        belly: hsl(h, s * 0.55, Math.min(0.66, 0.34 + l * 0.35)),
        leg: hsl(h, s * 0.4, Math.max(0.07, l * 0.3))
    };
}

// ───────── 形状 ─────────

const ELYTRA_TOP = 'M16 -1 C14 -18 4 -27 -12 -27 C-32 -27 -47 -14 -47 0 Z';
const ELYTRA_BOTTOM = 'M16 1 C14 18 4 27 -12 27 C-32 27 -47 14 -47 0 Z';
const PRONOTUM = 'M13 -18 C23 -23 35 -17 37 0 C35 17 23 23 13 18 C15 8 15 -8 13 -18 Z';
const HIND_WING_TOP = 'M8 -4 C-8 -30 -46 -50 -80 -44 C-74 -30 -46 -12 4 -2 Z';
const HIND_WING_BOTTOM = 'M8 4 C-8 30 -46 50 -80 44 C-74 30 -46 12 4 2 Z';
const SPARKLE = (x, y, r) => `M${x} ${y - r} L${x + r * 0.28} ${y - r * 0.28} L${x + r} ${y} L${x + r * 0.28} ${y + r * 0.28} L${x} ${y + r} L${x - r * 0.28} ${y + r * 0.28} L${x - r} ${y} L${x - r * 0.28} ${y - r * 0.28} Z`;

// [髋 x, 髋 y, 路径, 步态组]；上下两侧各三条，交替三脚架步态
const LEGS = [
    [18, -12, 'M18 -12 L30 -24 L44 -28', 0],
    [2, -14, 'M2 -14 L6 -28 L2 -37', 1],
    [-14, -13, 'M-14 -13 L-27 -25 L-41 -31', 0],
    [18, 12, 'M18 12 L30 24 L44 28', 1],
    [2, 14, 'M2 14 L6 28 L2 37', 0],
    [-14, 13, 'M-14 13 L-27 25 L-41 31', 1]
];
// 腹面朝天时的腿：从身体中线往两边伸，末端朝上蹬
const BELLY_LEGS = [
    [16, -8, 'M16 -8 L26 -26 L40 -30'],
    [0, -9, 'M0 -9 L2 -30 L-6 -40'],
    [-14, -8, 'M-14 -8 L-26 -26 L-40 -30'],
    [16, 8, 'M16 8 L26 26 L40 30'],
    [0, 9, 'M0 9 L2 30 L-6 40'],
    [-14, 8, 'M-14 8 L-26 26 L-40 30']
];

function patternMarkup(pattern, color) {
    switch (pattern) {
        case 'spots':
            return [[-2, -15, 5], [-24, -17, 4.2], [-35, -7, 3.4], [-13, -6, 3]]
                .flatMap(([x, y, r]) => [`<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`, `<circle cx="${x}" cy="${-y}" r="${r}" fill="${color}"/>`]).join('');
        case 'stripes':
            return [-17, -9].flatMap(y => [
                `<path d="M14 ${y} L-46 ${y * 0.55}" stroke="${color}" stroke-width="3.6" stroke-linecap="round" fill="none"/>`,
                `<path d="M14 ${-y} L-46 ${-y * 0.55}" stroke="${color}" stroke-width="3.6" stroke-linecap="round" fill="none"/>`
            ]).join('');
        case 'bands':
            return `<rect x="-10" y="-30" width="7" height="60" fill="${color}"/><rect x="-31" y="-30" width="6" height="60" fill="${color}"/>`;
        case 'stars':
            return [[-4, -16, 5], [-26, -12, 4], [-38, -4, 3]]
                .flatMap(([x, y, r]) => [`<path d="${SPARKLE(x, y, r)}" fill="${color}"/>`, `<path d="${SPARKLE(x, -y, r)}" fill="${color}"/>`]).join('');
        default:
            return '';
    }
}

function hornMarkup(horn, shades) {
    if (horn === 'rhino') {
        return `
          <path d="M42 -7.5 C52 -8 60 -6 66 -3 C69 -2.5 71 -4.5 72 -7 C74 -4 73.5 0 71 2 C65 6 54 7.5 42 7.5 Z" fill="${shades.deep}"/>
          <path d="M46 -4 C54 -4.6 61 -3.4 66 -1.2" fill="none" stroke="rgba(255,244,220,.38)" stroke-width="1.6" stroke-linecap="round"/>`;
    }
    if (horn === 'stag') {
        const jaw = (s) => `<path d="M47 ${-5 * s} C58 ${-15 * s} 72 ${-17 * s} 82 ${-8 * s} C80 ${-6 * s} 77 ${-6 * s} 75 ${-8 * s} C73 ${-5 * s} 70 ${-4 * s} 69 ${-6 * s} C64 ${-8 * s} 57 ${-7 * s} 50 ${-1.5 * s} Z" fill="${shades.deep}"/>
          <path d="M52 ${-7 * s} C60 ${-12 * s} 70 ${-13 * s} 78 ${-9 * s}" fill="none" stroke="rgba(255,244,220,.3)" stroke-width="1.2" stroke-linecap="round"/>`;
        return jaw(1) + jaw(-1);
    }
    return '<path d="M49 -4 Q56 -6 55 -1 M49 4 Q56 6 55 1" fill="none" stroke="#0e0703" stroke-width="2.2" stroke-linecap="round"/>';
}

// ───────── 特效层 ─────────

/**
 * 特效挂在世界坐标里（不跟着甲虫走）。每个特效自己靠 CSS 动画播完，到点自己摘掉。
 * 缩放 scale 跟甲虫同步，免得桌子缩小了尘土还是原来那么大。
 */
export class FxLayer {
    constructor(parent) {
        this.root = el('g', { class: 'parlor-br-fx' }, parent);
        this.scale = 1;
        this.maxLive = 180;
    }

    _group(x, y, lifeMs, className, rot = 0) {
        if (this.root.childNodes.length > this.maxLive) this.root.firstChild?.remove();
        const host = el('g', { class: 'parlor-br-fx-host', transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${this.scale.toFixed(3)})` }, this.root);
        const inner = el('g', { class: `parlor-br-fx-${className}` }, host);
        inner.style.animationDuration = `${lifeMs}ms`;
        setTimeout(() => host.remove(), lifeMs + 80);
        return inner;
    }

    dust(x, y, { count = 3, size = 1, spread = 12, back = 1, color = 'rgba(214,190,146,.55)' } = {}) {
        for (let i = 0; i < count; i++) {
            const g = this._group(x - back * i * 7 * this.scale, y + (Math.random() - 0.5) * spread * this.scale, 700 + Math.random() * 300, 'dust');
            g.style.animationDelay = `${i * 50}ms`;
            el('circle', { r: (6 + Math.random() * 4) * size, fill: color }, g);
        }
    }

    ring(x, y, size = 1, color = 'rgba(226,204,160,.6)') {
        const g = this._group(x, y, 650, 'ring');
        el('ellipse', { rx: 30 * size, ry: 18 * size, fill: 'none', stroke: color, 'stroke-width': 4 }, g);
    }

    smoke(x, y, { color = 'rgba(214,206,232,.82)', sparkles = true, size = 1 } = {}) {
        const g = this._group(x, y, 900, 'smoke');
        for (const [dx, dy, r] of [[0, 0, 18], [-14, -8, 12], [13, -9, 13], [-10, 11, 11], [12, 10, 12], [0, -16, 10]]) {
            el('circle', { cx: dx * size, cy: dy * size, r: r * size, fill: color }, g);
        }
        if (!sparkles) return;
        for (const [dx, dy] of [[-24, -18], [26, -12], [20, 20], [-22, 16]]) el('path', { d: SPARKLE(dx, dy, 5), fill: '#fff4c8' }, g);
    }

    puff(x, y, color = 'rgba(120,120,120,.55)', size = 1) {
        const g = this._group(x, y, 1100, 'puff');
        el('circle', { r: (8 + Math.random() * 5) * size, fill: color }, g);
    }

    gas(x, y) {
        const g = this._group(x, y, 900, 'gas');
        el('circle', { r: 9 + Math.random() * 5, fill: 'rgba(150,196,92,.62)' }, g);
        el('circle', { cx: -6, cy: -4, r: 5, fill: 'rgba(186,220,120,.55)' }, g);
    }

    mist(x, y) {
        const g = this._group(x, y, 800, 'mist');
        for (const [dx, dy, r] of [[8, 0, 12], [20, -8, 8], [22, 9, 9], [32, 0, 7], [14, 12, 6]]) {
            el('circle', { cx: dx, cy: dy, r, fill: 'rgba(230,244,255,.7)' }, g);
        }
    }

    skid(x, y, heading = 0) {
        const g = this._group(x, y, 2600, 'skid', heading);
        el('path', { d: 'M0 -11 L-46 -12 M0 11 L-46 12', stroke: 'rgba(30,16,6,.6)', 'stroke-width': 3.6, 'stroke-linecap': 'round', fill: 'none' }, g);
    }

    puddle(x, y, lifeMs) {
        // 泥坑比甲虫大一圈，不然全被身子挡住了
        const g = this._group(x, y, lifeMs, 'puddle');
        el('path', { d: 'M-78 -4 C-76 -40 -20 -52 30 -44 C78 -36 94 -6 80 20 C66 46 4 52 -38 42 C-68 34 -80 18 -78 -4 Z', fill: '#6a4522', opacity: 0.92 }, g);
        el('path', { d: 'M-66 -2 C-62 -30 -18 -40 26 -34 C64 -28 78 -6 68 14 C56 36 6 40 -30 32 C-56 26 -68 14 -66 -2 Z', fill: '#4e3217' }, g);
        el('path', { d: 'M-48 -18 C-26 -30 8 -30 34 -24', fill: 'none', stroke: 'rgba(255,230,190,.3)', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
        el('ellipse', { cx: 52, cy: 20, rx: 8, ry: 4, fill: 'rgba(255,230,190,.18)' }, g);
    }

    splat(x, y, color = '#5a3a1c') {
        for (let i = 0; i < 2; i++) {
            const g = this._group(x + (Math.random() - 0.5) * 50 * this.scale, y + (Math.random() - 0.5) * 50 * this.scale, 700, 'splat');
            el('circle', { r: 2.5 + Math.random() * 3, fill: color }, g);
        }
    }

    crumb(x, y, lifeMs) {
        const g = this._group(x, y, lifeMs, 'crumb');
        el('ellipse', { cx: 2.5, cy: 3.5, rx: 12, ry: 8, fill: 'rgba(0,0,0,.32)' }, g);
        el('path', { d: 'M-11 -3 L-5 -9 L6 -8 L12 -1 L7 7 L-5 8 Z', fill: '#d9a55a', stroke: '#6b4210', 'stroke-width': 1.5 }, g);
        el('path', { d: 'M-5 -4 L4 -5 L6 2', fill: 'none', stroke: '#f3d59a', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.85 }, g);
    }

    bits(x, y, color = '#e2b56c') {
        const g = this._group(x, y, 600, 'bits');
        for (let i = 0; i < 3; i++) el('rect', { x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 10, width: 2.8, height: 2.8, fill: color }, g);
    }

    glyph(x, y, char, { color = '#fff4c8', size = 16, lifeMs = 1300, kind = 'float' } = {}) {
        const g = this._group(x, y, lifeMs, kind);
        const text = el('text', { 'text-anchor': 'middle', 'font-size': size, 'font-weight': 700, fill: color, stroke: 'rgba(30,12,2,.7)', 'stroke-width': 3, 'paint-order': 'stroke', 'font-family': 'Georgia, serif' }, g);
        text.textContent = char;
    }

    sparkle(x, y, color = '#fff0b0', size = 8) {
        const g = this._group(x, y, 700, 'pop');
        el('path', { d: SPARKLE(0, 0, size), fill: color }, g);
    }

    confetti(x, y) {
        const colors = ['#f2c14e', '#e0605a', '#6fb7e8', '#86c96b', '#d98ee8'];
        for (let i = 0; i < 7; i++) {
            const g = this._group(x, y, 900, 'confetti', Math.random() * 360);
            g.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
            g.style.setProperty('--dy', `${-20 - Math.random() * 40}px`);
            el('rect', { x: -2.5, y: -1.5, width: 5, height: 3, fill: colors[i % colors.length] }, g);
        }
    }

    // 施法：脚下一圈会转的法阵，颜色分法术
    rune(x, y, color = '#ffd76a') {
        const g = this._group(x, y, 1100, 'rune');
        el('circle', { r: 46, fill: 'none', stroke: color, 'stroke-width': 2.4, opacity: 0.9 }, g);
        el('circle', { r: 38, fill: 'none', stroke: color, 'stroke-width': 1.2, 'stroke-dasharray': '3 5', opacity: 0.8 }, g);
        const star = [];
        for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + i * (TAU * 2 / 5);
            star.push(`${(Math.cos(a) * 36).toFixed(1)} ${(Math.sin(a) * 36).toFixed(1)}`);
        }
        el('path', { d: `M${star.join(' L')} Z`, fill: 'none', stroke: color, 'stroke-width': 1.4, opacity: 0.75 }, g);
        for (let i = 0; i < 8; i++) {
            const a = i * TAU / 8;
            el('rect', { x: Math.cos(a) * 42 - 2, y: Math.sin(a) * 42 - 2, width: 4, height: 4, fill: color, transform: `rotate(45 ${Math.cos(a) * 42} ${Math.sin(a) * 42})` }, g);
        }
    }

    // 雷击：一道锯齿闪电从上方劈到甲虫身上，外加一圈白光
    bolt(x, y) {
        const g = this._group(x, y, 420, 'bolt');
        const pts = [[8, -230], [-10, -170], [12, -150], [-14, -90], [10, -70], [-6, -18], [0, 0]];
        const d = `M${pts.map(([px, py]) => `${px} ${py}`).join(' L')}`;
        el('path', { d, fill: 'none', stroke: 'rgba(160,190,255,.55)', 'stroke-width': 16, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
        el('path', { d, fill: 'none', stroke: '#fff7c4', 'stroke-width': 6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
        const flash = this._group(x, y, 500, 'flashring');
        el('circle', { r: 40, fill: 'rgba(255,250,210,.7)' }, flash);
    }

    shards(x, y) {
        for (let i = 0; i < 8; i++) {
            const g = this._group(x, y, 800, 'shard', i * 45 + Math.random() * 20);
            g.style.setProperty('--dx', `${34 + Math.random() * 26}px`);
            el('path', { d: 'M0 -4 L12 0 L0 5 Z', fill: 'rgba(210,240,255,.85)', stroke: 'rgba(255,255,255,.9)', 'stroke-width': 0.8 }, g);
        }
    }

    slime(x, y) {
        const g = this._group(x, y, 2600, 'slime');
        el('ellipse', { rx: 10, ry: 5, fill: 'rgba(214,236,190,.35)' }, g);
        el('ellipse', { cx: -2, cy: -1.5, rx: 5, ry: 1.4, fill: 'rgba(255,255,255,.45)' }, g);
    }

    ballAway(x, y, size) {
        const g = this._group(x, y, 900, 'ballaway');
        el('circle', { r: size, fill: '#5b3a1e', stroke: '#2e1a0a', 'stroke-width': 1.5 }, g);
    }

    clear() {
        this.root.replaceChildren();
    }
}

// ───────── 姿态 ─────────

/**
 * 姿态字段（都有默认值，姿态函数只写它要改的）：
 * dx dy        身体相对中心的位移（本地单位）
 * rot          朝向偏转（度）
 * sx sy        拉伸（sy<0 = 翻过去露出腹面）
 * size         整体放大（巨化术）
 * lift         离地高度 0..1（影子外移变淡、身子放大）
 * legs         walk | flail | brace | tuck | still | kick
 * legSpeed     步态快慢系数
 * elytra       鞘翅张开 0..1        wings / flap  后翅显隐、在不在扇
 * alpha        整只的不透明度（闪现、钻地）
 * shake        身体高频抖动幅度
 * antennaDroop 触角下垂 0..1（打瞌睡、被雷劈）
 * trail        速度线 none | dust | gold
 * form         beetle | ball | mound | snail  —— 换成别的样子（滚成球 / 钻进土里 / 变成蜗牛）
 * dung         推着的粪球大小 0..1   aura  加速术金光 0..1   ice  冰块 0..1   soot  焦黑 0..1
 */
const REST = Object.freeze({
    dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, size: 1, lift: 0, legs: 'walk', legSpeed: 1,
    elytra: 0, wings: 0, flap: false, alpha: 1, shake: 0, antennaDroop: 0, trail: 'none',
    form: 'beetle', formMix: 1, dung: 0, aura: 0, ice: 0, soot: 0
});

/**
 * 姿态函数签名：(p, q)
 * - p：包络进度 0..1。入场、收尾两段按原速走，延长时长只拉长中间的"持续段"（见 SUSTAIN / remapProgress）
 * - q：按默认时长算的"节拍"= 已过秒数 / 默认时长。蹬腿、扭动、呼吸这些循环都用 q，
 *      所以延长时长不会把动作放慢——Reslin 定的：延长是多演一会儿，不是慢动作
 */
export const POSES = {
    idle: () => ({}),

    dash: (p, q) => ({
        sx: 1 + 0.08 * bump(p, 0, 0.3) + 0.03,
        sy: 1 - 0.05 * bump(p, 0, 0.3) - 0.02,
        legSpeed: 2.1,
        trail: 'dust',
        rot: 2 * Math.sin(q * TAU * 5)
    }),

    fly: (p, q) => {
        const lift = easeOut(span(p, 0.05, 0.22)) * (1 - smooth(span(p, 0.82, 0.97)));
        const open = window01(p, 0, 0.14, 0.9, 1);
        return {
            lift,
            elytra: open,
            wings: open,
            flap: open > 0.3,
            legs: lift > 0.3 ? 'tuck' : 'walk',
            legSpeed: 1.6,
            dy: -4 * lift + 2.5 * Math.sin(q * TAU * 6) * lift,
            rot: 4 * Math.sin(q * TAU * 2) * lift
        };
    },

    hop: (p) => {
        const hops = 3;
        const k = Math.min(hops - 1, Math.floor(p * hops));
        const t = p * hops - k;
        const air = Math.sin(clamp01(t) * Math.PI);
        const land = 1 - clamp01(Math.abs(t - 1) / 0.18) + (k > 0 ? 1 - clamp01(t / 0.12) : 0);
        return {
            lift: air * 0.55,
            sx: 1 + 0.12 * land - 0.04 * air,
            sy: 1 - 0.14 * land + 0.05 * air,
            legs: air > 0.25 ? 'tuck' : 'brace'
        };
    },

    blink: (p, q) => {
        const out = smooth(span(p, 0.3, 0.44));
        const back = smooth(span(p, 0.46, 0.6));
        const visible = p < 0.45 ? 1 - out : back;
        return {
            alpha: visible,
            sx: lerp(0.55, 1, visible) + 0.08 * bump(p, 0.55, 0.75),
            sy: lerp(0.55, 1, visible) + 0.08 * bump(p, 0.55, 0.75),
            shake: 1.4 * span(p, 0, 0.3) * (1 - out),
            legs: p > 0.6 ? 'walk' : 'still',
            rot: p > 0.6 ? 8 * Math.sin(q * TAU * 4) * (1 - span(p, 0.6, 1)) : 0
        };
    },

    jet: (p, q) => ({
        shake: 1.2,
        sx: 1.06,
        sy: 0.95,
        legSpeed: 2,
        rot: 3 * Math.sin(q * TAU * 7)
    }),

    roll: (p, q) => {
        // 前 12% 缩成一团，后 12% 再摊开；中间整只换成一个会滚的球
        const curl = window01(p, 0, 0.12, 0.88, 1);
        return {
            form: curl > 0.5 ? 'ball' : 'beetle',
            formMix: curl > 0.5 ? (curl - 0.5) * 2 : 1 - curl * 2,
            sx: curl > 0.5 ? 1 : 1 - 0.35 * curl * 2,
            sy: curl > 0.5 ? 1 : 1 - 0.1 * curl * 2,
            legs: 'tuck',
            dy: 1.5 * Math.sin(q * TAU * 5) * curl
        };
    },

    dig: (p) => {
        const sink = window01(p, 0, 0.16, 0.84, 1);
        return {
            form: sink > 0.55 ? 'mound' : 'beetle',
            formMix: sink > 0.55 ? (sink - 0.55) / 0.45 : 1 - sink / 0.55 * 0.6,
            alpha: sink > 0.55 ? 1 : 1 - sink * 0.9,
            sx: 1 - 0.3 * Math.min(1, sink / 0.55),
            sy: 1 - 0.3 * Math.min(1, sink / 0.55),
            shake: 0.8 * bump(p, 0, 0.18) + 0.8 * bump(p, 0.82, 1),
            legs: 'flail',
            legSpeed: 1.6
        };
    },

    brake: (p, q) => {
        const hit = bump(p, 0, 0.22);
        const wob = p > 0.18 && p < 0.55 ? Math.sin((q - 0.18) * TAU * 3.2) * (1 - span(p, 0.18, 0.55)) : 0;
        return {
            sx: 1 - 0.1 * hit,
            sy: 1 + 0.06 * hit,
            dx: 3 * hit,
            rot: 7 * wob,
            legs: p < 0.55 ? 'brace' : 'still'
        };
    },

    // 转圈按秒转，延长就多转几圈；收尾那 30% 角速度线性降到零（对角速度积分，别倒着转回去）
    spin: (p, q) => {
        const u = span(p, 0.7, 1);
        const beforeOutro = q - Math.max(0, p - 0.7);
        return {
            rot: 720 * (beforeOutro + 0.3 * (u - u * u / 2)),
            legs: 'flail',
            legSpeed: 2.4,
            shake: 0.6 * u
        };
    },

    flip: (p, q) => {
        // 绕身体长轴翻过去：sy 从 1 走到 -1，停着蹬腿，再翻回来
        let sy;
        if (p < 0.16) sy = Math.cos(span(p, 0, 0.16) * Math.PI);
        else if (p < 0.8) sy = -1;
        else if (p < 0.94) sy = -Math.cos(span(p, 0.8, 0.94) * Math.PI);
        else sy = 1;
        // 经过侧面那一下别缩成零（看起来像消失），最少留一条侧影
        if (Math.abs(sy) < 0.22) sy = sy < 0 ? -0.22 : 0.22;
        const onBack = p > 0.16 && p < 0.8;
        return {
            sy,
            sx: 1 + 0.06 * bump(p, 0.08, 0.2) + 0.06 * bump(p, 0.86, 0.98),
            rot: onBack ? 9 * Math.sin(q * TAU * 3.5) : 0,
            dy: onBack ? 1.5 * Math.sin(q * TAU * 7) : 0,
            legs: 'kick'
        };
    },

    snack: (p, q) => ({
        legs: 'still',
        dx: 2.2 * Math.sin(q * TAU * 7) * span(p, 0.08, 0.9),
        sx: 1 - 0.03 * Math.abs(Math.sin(q * TAU * 7)),
        rot: 3 * Math.sin(q * TAU * 2)
    }),

    nap: (p, q) => {
        const sleepy = window01(p, 0, 0.15, 0.86, 0.94);
        const startle = bump(p, 0.9, 1);
        return {
            legs: 'still',
            sx: 1 + 0.025 * Math.sin(q * TAU * 2.5) * sleepy,
            sy: 1 + 0.035 * Math.sin(q * TAU * 2.5) * sleepy,
            antennaDroop: sleepy,
            lift: startle * 0.35,
            rot: -4 * sleepy
        };
    },

    moonwalk: (p, q) => ({
        legSpeed: 1.4,
        rot: 5 * Math.sin(q * TAU * 3),
        dy: 1.5 * Math.sin(q * TAU * 6)
    }),

    wander: (p, q) => {
        const fade = window01(p, 0, 0.1, 0.85, 1);
        return {
            dy: 16 * Math.sin(q * TAU * 1.5) * fade,
            rot: 26 * Math.cos(q * TAU * 1.5) * fade,
            legSpeed: 0.9
        };
    },

    trip: (p) => {
        const tumble = span(p, 0.1, 0.55);
        return {
            rot: p < 0.1 ? 12 * span(p, 0, 0.1) : 12 + 348 * easeOut(tumble),
            lift: bump(p, 0.1, 0.55) * 0.5,
            sx: 1 + 0.1 * bump(p, 0.52, 0.66),
            sy: 1 - 0.12 * bump(p, 0.52, 0.66),
            dx: 6 * bump(p, 0.08, 0.6),
            legs: p < 0.6 ? 'flail' : 'still',
            shake: 0.8 * span(p, 0.62, 0.85) * (1 - span(p, 0.85, 1))
        };
    },

    sneeze: (p, q) => {
        // 憋气（往后仰、鼓起来）→ 阿嚏（往前一冲的姿势，身子却被崩着往后滑）→ 晃晃脑袋
        const build = span(p, 0, 0.42);
        const blast = bump(p, 0.42, 0.62);
        const holding = p < 0.42 ? 1 : 0;
        return {
            sx: 1 + 0.06 * build * holding - 0.12 * blast,
            sy: 1 + 0.05 * build * holding + 0.06 * blast,
            dx: -4 * build * holding + 7 * blast,
            rot: holding ? -6 * build : 6 * Math.sin((q - 0.42) * TAU * 3) * (1 - span(p, 0.42, 1)),
            legs: p < 0.45 ? 'brace' : (p < 0.75 ? 'flail' : 'still'),
            shake: 0.5 * span(p, 0.25, 0.42) * holding
        };
    },

    mud: (p, q) => ({
        legs: 'flail',
        legSpeed: 2.8,
        shake: 0.9 * window01(p, 0, 0.1, 0.85, 1),
        sx: 1 - 0.05 * Math.abs(Math.sin(q * TAU * 6)),
        dy: 1.6 * Math.sin(q * TAU * 5),
        rot: 5 * Math.sin(q * TAU * 2.5)
    }),

    dungball: (p, q) => ({
        dung: smooth(span(p, 0, 0.85)) * (p < 0.94 ? 1 : 0),
        legSpeed: 2,
        rot: 3 * Math.sin(q * TAU * 3),
        sx: 1 + 0.03 * Math.sin(q * TAU * 6),
        dx: -2 * span(p, 0, 0.9)
    }),

    taunt: (p, q) => {
        const turn = smooth(span(p, 0, 0.22)) - smooth(span(p, 0.8, 1));
        const mid = p > 0.2 && p < 0.8;
        const wiggle = mid ? Math.sin(q * TAU * 6) : 0;
        return {
            rot: 180 * turn + 6 * wiggle,
            dx: 2 * wiggle,
            legs: turn > 0.1 && turn < 0.9 ? 'walk' : 'still',
            legSpeed: 0.8
        };
    },

    // 按节拍一下一下鞠躬，延长就多鞠几个
    bow: (p, q) => {
        const beat = (q * 2.3) % 1;
        const dip = p < 0.82 ? bump(beat, 0.05, 0.85) : 0;
        return { sx: 1 - 0.12 * dip, dx: 4 * dip, legs: 'still' };
    },

    cheer: (p, q) => {
        const air = Math.sin(((q * 3) % 1) * Math.PI) * window01(p, 0, 0.02, 0.95, 1);
        return {
            lift: air * 0.3,
            sx: 1 - 0.05 * air,
            sy: 1 + 0.06 * air,
            legs: 'flail',
            legSpeed: 1.6,
            rot: 4 * Math.sin(q * TAU * 3)
        };
    },

    dance: (p, q) => {
        const on = window01(p, 0, 0.08, 0.9, 1);
        return {
            dx: 7 * Math.cos(q * TAU * 2) * on,
            dy: 7 * Math.sin(q * TAU * 2) * on,
            rot: 24 * Math.sin(q * TAU * 4) * on,
            lift: 0.18 * Math.abs(Math.sin(q * TAU * 4)) * on,
            legs: 'flail',
            legSpeed: 0.9
        };
    },

    haste: (p) => ({
        aura: window01(p, 0, 0.1, 0.9, 1),
        legSpeed: 3.2,
        trail: 'gold',
        sx: 1.05,
        sy: 0.96,
        shake: 0.3
    }),

    enlarge: (p, q) => {
        const grow = smooth(span(p, 0, 0.14)) * (1 - smooth(span(p, 0.86, 1)));
        return {
            size: 1 + 0.75 * grow + 0.14 * bump(p, 0.1, 0.24) - 0.1 * bump(p, 0.86, 0.96),
            legSpeed: 0.75,
            rot: 3 * Math.sin(q * TAU * 2.5) * grow,
            dy: 1.2 * Math.abs(Math.sin(q * TAU * 5)) * grow
        };
    },

    freeze: (p) => {
        const ice = p < 0.9 ? smooth(span(p, 0, 0.1)) : 0;
        return {
            ice,
            legs: 'still',
            shake: 0.7 * span(p, 0.78, 0.9) * (p < 0.9 ? 1 : 0) + 1.2 * bump(p, 0.9, 1),
            antennaDroop: 0.3 * ice
        };
    },

    zap: (p, q) => ({
        soot: p < 0.04 ? 0 : 1 - smooth(span(p, 0.72, 0.98)),
        lift: 0.35 * bump(p, 0.02, 0.12),
        shake: 1.6 * span(p, 0.02, 0.06) * (1 - span(p, 0.06, 0.4)),
        legs: p < 0.35 ? 'flail' : 'still',
        legSpeed: 3,
        antennaDroop: 0.6 * window01(p, 0.05, 0.1, 0.8, 1),
        rot: p > 0.8 ? 10 * Math.sin(q * TAU * 6) * (1 - span(p, 0.8, 1)) : 0
    }),

    snail: (p, q) => {
        // 变身在两团烟里完成：0.1 之前、0.9 之后是甲虫，中间是蜗牛
        const snail = p >= 0.1 && p < 0.9;
        return {
            form: snail ? 'snail' : 'beetle',
            formMix: 1,
            dy: snail ? 0.8 * Math.sin(q * TAU * 3) : 0,
            legs: 'still'
        };
    }
};

// 延长时长时要被拉长的"持续段"（按默认时长的进度）。没列出的动作不开放时长，照原样播
const SUSTAIN = {
    brake: [0.55, 0.9], spin: [0.12, 0.7], flip: [0.16, 0.8], snack: [0.1, 0.88], nap: [0.15, 0.86],
    moonwalk: [0.1, 0.9], wander: [0.1, 0.85], trip: [0.62, 0.85], taunt: [0.22, 0.8], bow: [0.05, 0.8],
    cheer: [0.02, 0.95], mud: [0.1, 0.85], dungball: [0.05, 0.85], dance: [0.08, 0.9],
    freeze: [0.1, 0.78], zap: [0.12, 0.72], snail: [0.12, 0.88]
};

/**
 * 已过秒数 → 包络进度 p。时长跟默认一样就是 elapsed/d0；
 * 延长了：入场 [0,a] 和收尾 [b,1] 各按原速，中间那段匀速拉长；缩短了：整体按比例压缩。
 */
export function remapProgress(actionId, elapsed, duration, d0) {
    const total = Math.max(0.001, duration);
    const window = SUSTAIN[actionId];
    if (!window || total <= d0 + 1e-6) return clamp01(elapsed / total);
    const [a, b] = window;
    const introEnd = a * d0;
    const outroStart = total - (1 - b) * d0;
    if (elapsed <= introEnd) return elapsed / d0;
    if (elapsed >= outroStart) return clamp01(b + (elapsed - outroStart) / d0);
    return a + (b - a) * ((elapsed - introEnd) / (outroStart - introEnd));
}

// 一次性特效：各动作在哪个进度点冒什么。o 是甲虫当前的世界坐标与缩放
const CUES = {
    dash: [{ at: 0, fx: (fx, o) => fx.dust(o.tailX, o.y, { count: 4, size: 1.2 }) }],
    fly: [
        { at: 0.04, fx: (fx, o) => fx.dust(o.x, o.y, { count: 3 }) },
        { at: 0.95, fx: (fx, o) => fx.ring(o.x, o.y, o.scale) }
    ],
    hop: [0.32, 0.65, 0.98].map(at => ({ at, fx: (fx, o) => fx.dust(o.x, o.y, { count: 2, size: 0.8, spread: 20 }) })),
    blink: [
        { at: 0.36, fx: (fx, o) => fx.smoke(o.x, o.y) },
        { at: 0.47, fx: (fx, o) => fx.smoke(o.x, o.y) }
    ],
    jet: [{ at: 0, fx: (fx, o) => { fx.gas(o.tailX, o.y); fx.gas(o.tailX - 8 * o.scale, o.y - 5 * o.scale); } }],
    roll: [
        { at: 0.06, fx: (fx, o) => fx.dust(o.x, o.y, { count: 3, spread: 20 }) },
        { at: 0.92, fx: (fx, o) => fx.dust(o.x, o.y, { count: 3, spread: 20 }) }
    ],
    dig: [
        { at: 0.02, fx: (fx, o) => fx.dust(o.x, o.y, { count: 5, spread: 30, color: 'rgba(120,82,44,.7)' }) },
        { at: 0.86, fx: (fx, o) => { fx.dust(o.x, o.y, { count: 6, spread: 34, color: 'rgba(120,82,44,.75)', back: -1 }); fx.ring(o.x, o.y, o.scale, 'rgba(150,104,60,.6)'); } }
    ],
    brake: [
        { at: 0, fx: (fx, o) => { fx.skid(o.tailX + 4 * o.scale, o.y, 0); fx.glyph(o.x, o.topY, '!', { color: '#ffd46b', size: 24, lifeMs: 900, kind: 'mark' }); } },
        { at: 0.05, fx: (fx, o) => fx.dust(o.noseX, o.y, { count: 3, back: -1 }) }
    ],
    spin: [{ at: 0.72, fx: (fx, o) => { fx.glyph(o.x - 12 * o.scale, o.topY, '✦', { size: 13, kind: 'orbit' }); fx.glyph(o.x + 12 * o.scale, o.topY, '✦', { size: 11, kind: 'orbit' }); } }],
    flip: [
        { at: 0.12, fx: (fx, o) => fx.dust(o.x, o.y, { count: 3, spread: 26 }) },
        { at: 0.95, fx: (fx, o) => fx.dust(o.x, o.y, { count: 3, spread: 26 }) }
    ],
    snack: [{ at: 0, fx: (fx, o, dur) => fx.crumb(o.noseX + 6 * o.scale, o.y, dur * 1000) }],
    nap: [{ at: 0.9, fx: (fx, o) => fx.glyph(o.x, o.topY, '!', { color: '#ffd46b', size: 20, lifeMs: 800, kind: 'mark' }) }],
    wander: [{ at: 0.05, fx: (fx, o) => fx.glyph(o.x, o.topY, '?', { color: '#cfe6ff', size: 20, lifeMs: 1200, kind: 'mark' }) }],
    trip: [
        { at: 0.08, fx: (fx, o) => fx.dust(o.x, o.y, { count: 2 }) },
        { at: 0.56, fx: (fx, o) => fx.dust(o.x, o.y, { count: 4, spread: 26 }) },
        { at: 0.64, fx: (fx, o) => fx.glyph(o.x, o.topY, '✦', { size: 12, kind: 'orbit' }) }
    ],
    sneeze: [
        { at: 0.44, fx: (fx, o) => { fx.mist(o.noseX, o.y); fx.dust(o.tailX, o.y, { count: 2, back: 1 }); } }
    ],
    mud: [{ at: 0, fx: (fx, o, dur) => fx.puddle(o.x, o.y, dur * 1000 + 900) }],
    dungball: [{ at: 0.94, fx: (fx, o) => fx.ballAway(o.noseX + 24 * o.scale, o.y, 26 * o.scale) }],
    taunt: [{ at: 0.3, fx: (fx, o) => fx.glyph(o.x, o.topY, '♪', { color: '#f6d6ff', size: 18 }) }],
    bow: [{ at: 0.82, fx: (fx, o) => { fx.sparkle(o.x - 14 * o.scale, o.topY); fx.sparkle(o.x + 14 * o.scale, o.topY + 6 * o.scale, '#ffe38a'); } }],
    cheer: [0, 0.34, 0.67].map(at => ({ at, fx: (fx, o) => fx.confetti(o.x, o.topY) })),
    dance: [{ at: 0.05, fx: (fx, o) => fx.glyph(o.x, o.topY, '♫', { color: '#ffe6a8', size: 20 }) }],
    haste: [{ at: 0, fx: (fx, o) => { fx.rune(o.x, o.y, '#ffd76a'); fx.sparkle(o.x, o.topY, '#fff2a8', 11); } }],
    enlarge: [
        { at: 0, fx: (fx, o) => fx.rune(o.x, o.y, '#ff9e6a') },
        { at: 0.12, fx: (fx, o) => fx.ring(o.x, o.y, o.scale * 1.6) }
    ],
    freeze: [
        { at: 0, fx: (fx, o) => fx.rune(o.x, o.y, '#9fdcff') },
        { at: 0.9, fx: (fx, o) => fx.shards(o.x, o.y) }
    ],
    zap: [
        { at: 0.02, fx: (fx, o) => { fx.bolt(o.x, o.y); fx.smoke(o.x, o.y, { color: 'rgba(90,90,96,.7)', sparkles: false, size: 0.8 }); } },
        { at: 0.1, fx: (fx, o) => fx.glyph(o.x + 10 * o.scale, o.topY, '⚡', { color: '#fff3a0', size: 18, kind: 'mark' }) }
    ],
    snail: [
        { at: 0, fx: (fx, o) => fx.rune(o.x, o.y, '#a6e07c') },
        { at: 0.08, fx: (fx, o) => fx.smoke(o.x, o.y, { color: 'rgba(196,232,170,.8)' }) },
        { at: 0.88, fx: (fx, o) => fx.smoke(o.x, o.y, { color: 'rgba(196,232,170,.8)' }) }
    ]
};

// 持续特效：每隔多少秒冒一次（when 返回 false 时不冒）
const EMITTERS = {
    dash: { every: 0.14, fx: (fx, o) => fx.dust(o.tailX, o.y, { count: 1, size: 0.8 }) },
    fly: { every: 0.09, when: (pose) => pose.lift > 0.4, fx: (fx, o) => fx.dust(o.tailX, o.y, { count: 1, size: 0.5 }) },
    jet: { every: 0.07, fx: (fx, o) => fx.gas(o.tailX, o.y + (Math.random() - 0.5) * 10 * o.scale) },
    roll: { every: 0.16, when: (pose) => pose.form === 'ball', fx: (fx, o) => fx.dust(o.x - 24 * o.scale, o.y + 10 * o.scale, { count: 1, size: 0.6 }) },
    dig: { every: 0.1, when: (pose) => pose.form === 'mound', fx: (fx, o) => fx.bits(o.x - 26 * o.scale, o.y + (Math.random() - 0.5) * 20 * o.scale, '#7a5230') },
    snack: { every: 0.3, fx: (fx, o) => fx.bits(o.noseX + 6 * o.scale, o.y) },
    nap: { every: 0.45, when: (pose) => pose.antennaDroop > 0.5, fx: (fx, o) => fx.glyph(o.x + 16 * o.scale, o.topY, Math.random() < 0.5 ? 'Z' : 'z', { color: '#dfe8ff', size: 20, lifeMs: 1600, kind: 'zzz' }) },
    moonwalk: { every: 0.4, fx: (fx, o) => fx.glyph(o.x, o.topY, '♪', { color: '#f6d6ff', size: 15 }) },
    mud: { every: 0.12, fx: (fx, o) => fx.splat(o.x, o.y) },
    dungball: { every: 0.25, when: (pose) => pose.dung > 0.1, fx: (fx, o) => fx.bits(o.noseX + 30 * o.scale, o.y + 14 * o.scale, '#6b4a26') },
    dance: { every: 0.35, fx: (fx, o) => fx.glyph(o.x + (Math.random() - 0.5) * 40 * o.scale, o.topY, Math.random() < 0.5 ? '♪' : '♫', { color: '#ffe6a8', size: 16 }) },
    haste: { every: 0.08, when: (pose) => pose.aura > 0.3, fx: (fx, o) => fx.sparkle(o.tailX + (Math.random() - 0.3) * 30 * o.scale, o.y + (Math.random() - 0.5) * 40 * o.scale, '#ffe38a', 5) },
    enlarge: { every: 0.32, fx: (fx, o) => fx.dust(o.x, o.y + 20 * o.scale, { count: 2, size: 1.3, spread: 40 }) },
    freeze: { every: 0.3, when: (pose) => pose.ice > 0.5, fx: (fx, o) => fx.glyph(o.x + (Math.random() - 0.5) * 60 * o.scale, o.topY + 10 * o.scale, '❄', { color: '#e6f6ff', size: 13, lifeMs: 1400 }) },
    zap: { every: 0.18, when: (pose) => pose.soot > 0.3, fx: (fx, o) => fx.puff(o.x + (Math.random() - 0.5) * 30 * o.scale, o.y - 10 * o.scale, 'rgba(80,80,86,.5)', 0.8) },
    snail: { every: 0.2, when: (pose) => pose.form === 'snail', fx: (fx, o) => fx.slime(o.x - 34 * o.scale, o.y + 2 * o.scale) }
};

// ───────── 甲虫 ─────────

export class BeetleActor {
    /**
     * @param {object} look  { color, pattern, horn, number? }
     * @param {object} opts  { fx: FxLayer | null }
     */
    constructor(look = {}, { fx = null } = {}) {
        this.look = look;
        this.fx = fx;
        this.shades = deriveShades(look.color);
        this.id = `pbr${++uid}`;
        this.gait = Math.random() * TAU;
        this.roll = 0;
        this.pose = { ...REST };
        this._cueKey = '';
        this._firedCues = new Set();
        this._emitClock = 0;
        this._lastProgress = 0;
        this._build();
    }

    get el() { return this.root; }

    _build() {
        const s = this.shades;
        const id = this.id;
        this.root = el('g', { class: 'parlor-br-beetle' });

        const defs = el('defs', {}, this.root);
        defs.innerHTML = `
          <radialGradient id="${id}-shell" cx="42%" cy="30%" r="80%">
            <stop offset="0" stop-color="${s.light}"/><stop offset=".48" stop-color="${s.base}"/><stop offset="1" stop-color="${s.deep}"/>
          </radialGradient>
          <radialGradient id="${id}-ball" cx="38%" cy="32%" r="70%">
            <stop offset="0" stop-color="${s.light}"/><stop offset=".55" stop-color="${s.base}"/><stop offset="1" stop-color="${s.deep}"/>
          </radialGradient>
          <radialGradient id="${id}-belly" cx="50%" cy="40%" r="70%">
            <stop offset="0" stop-color="${s.belly}"/><stop offset="1" stop-color="${s.dark}"/>
          </radialGradient>
          <linearGradient id="${id}-wing" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="rgba(236,244,255,.62)"/><stop offset="1" stop-color="rgba(190,206,230,.28)"/>
          </linearGradient>
          <radialGradient id="${id}-aura" cx="50%" cy="50%" r="50%">
            <stop offset=".45" stop-color="rgba(255,220,110,0)"/><stop offset=".8" stop-color="rgba(255,214,100,.35)"/><stop offset="1" stop-color="rgba(255,214,100,0)"/>
          </radialGradient>
          <clipPath id="${id}-clip-top"><path d="${ELYTRA_TOP}"/></clipPath>
          <clipPath id="${id}-clip-bottom"><path d="${ELYTRA_BOTTOM}"/></clipPath>
          <clipPath id="${id}-clip-ball"><circle r="27"/></clipPath>`;

        this.lead = el('g', { class: 'parlor-br-lead' }, this.root);
        el('ellipse', { rx: 58, ry: 33, fill: 'none', stroke: 'rgba(255,214,110,.8)', 'stroke-width': 3, 'stroke-dasharray': '7 6' }, this.lead);

        // 加速术的金光：在影子下面，跟着身体一起放大
        this.aura = el('g', { class: 'parlor-br-aura' }, this.root);
        el('ellipse', { rx: 74, ry: 48, fill: `url(#${id}-aura)` }, this.aura);
        el('ellipse', { rx: 62, ry: 38, fill: 'none', stroke: 'rgba(255,226,130,.75)', 'stroke-width': 2, 'stroke-dasharray': '10 8', class: 'parlor-br-aura-ring' }, this.aura);

        this.shadow = el('g', { class: 'parlor-br-shadow' }, this.root);
        el('ellipse', { cx: 9, cy: 10, rx: 54, ry: 31, fill: '#000', opacity: 0.2 }, this.shadow);
        el('ellipse', { cx: 4, cy: 5, rx: 44, ry: 23, fill: '#000', opacity: 0.32 }, this.shadow);

        this.rig = el('g', { class: 'parlor-br-rig' }, this.root);

        this.trail = el('g', { class: 'parlor-br-trail' }, this.rig);
        this.trail.innerHTML = `
          <path d="M-58 -14 H-112 M-62 0 H-130 M-58 14 H-106" stroke="rgba(255,236,190,.55)" stroke-width="3" stroke-linecap="round"/>
          <path d="M-60 -7 H-94 M-60 7 H-92" stroke="${s.light}" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>`;
        this.goldTrail = el('g', { class: 'parlor-br-trail' }, this.rig);
        this.goldTrail.innerHTML = `
          <path d="M-56 -16 H-120 M-60 0 H-140 M-56 16 H-116" stroke="rgba(255,222,120,.75)" stroke-width="3.2" stroke-linecap="round"/>
          <path d="M-60 -8 H-100 M-60 8 H-98" stroke="rgba(255,250,210,.8)" stroke-width="1.8" stroke-linecap="round"/>`;

        // 后翅：平时收在鞘翅底下（scale 0），起飞时展开扇动
        this.wingTop = el('g', {}, this.rig);
        this.wingBottom = el('g', {}, this.rig);
        for (const [g, d, sign] of [[this.wingTop, HIND_WING_TOP, -1], [this.wingBottom, HIND_WING_BOTTOM, 1]]) {
            el('path', { d, fill: `url(#${id}-wing)`, stroke: 'rgba(120,130,150,.5)', 'stroke-width': 1 }, g);
            el('path', { d: `M4 ${2 * sign} C-20 ${22 * sign} -48 ${36 * sign} -74 ${40 * sign} M-6 ${8 * sign} C-26 ${18 * sign} -44 ${24 * sign} -62 ${26 * sign}`, fill: 'none', stroke: 'rgba(110,120,140,.45)', 'stroke-width': 0.9 }, g);
        }

        this.legGroup = el('g', {}, this.rig);
        this.legs = LEGS.map(([hx, hy, d, group]) => {
            const g = el('g', {}, this.legGroup);
            el('path', { d, fill: 'none', stroke: '#0c0603', 'stroke-width': 4.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
            el('path', { d, fill: 'none', stroke: s.leg, 'stroke-width': 2.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
            el('path', { d, fill: 'none', stroke: 'rgba(255,226,180,.28)', 'stroke-width': 1, 'stroke-linecap': 'round' }, g);
            return { g, hx, hy, group };
        });

        // 推的粪球：在头前面，越推越大
        this.dung = el('g', { style: 'display:none' }, this.rig);
        el('circle', { cx: 3, cy: 4, r: 1, fill: 'rgba(0,0,0,.35)', class: 'dung-shadow' }, this.dung);
        el('circle', { r: 1, fill: '#5b3a1e', stroke: '#2e1a0a', 'stroke-width': 1.5, class: 'dung-ball' }, this.dung);
        this.dungSpecks = el('g', {}, this.dung);
        for (const [x, y] of [[-0.4, -0.3], [0.3, 0.2], [-0.1, 0.45], [0.45, -0.35], [-0.5, 0.2]]) {
            el('path', { d: `M${x * 20} ${y * 20} l4 -1`, stroke: '#b89a56', 'stroke-width': 1.3, 'stroke-linecap': 'round' }, this.dungSpecks);
        }

        // 背面（平时看到的这面）
        this.top = el('g', {}, this.rig);
        this.antennae = [-1, 1].map(side => {
            const g = el('g', {}, this.top);
            el('path', { d: `M47 ${5 * side} C58 ${11 * side} 62 ${19 * side} 71 ${22 * side}`, fill: 'none', stroke: '#150b05', 'stroke-width': 2.2, 'stroke-linecap': 'round' }, g);
            el('circle', { cx: 71.5, cy: 22.3 * side, r: 2.6, fill: '#150b05' }, g);
            return { g, side };
        });
        this.top.insertAdjacentHTML('beforeend', `
          <ellipse cx="42" cy="0" rx="9.5" ry="10.5" fill="#1a100a"/>
          ${hornMarkup(this.look.horn, s)}
          <circle cx="44.5" cy="-7" r="2.7" fill="#050302"/><circle cx="44.5" cy="7" r="2.7" fill="#050302"/>
          <circle cx="45.3" cy="-7.8" r="0.95" fill="#fff"/><circle cx="45.3" cy="6.2" r="0.95" fill="#fff"/>
          <path d="${PRONOTUM}" fill="${s.deep}"/>
          <path d="M16 -14 C24 -17 31 -12 33 -4" fill="none" stroke="rgba(255,240,210,.24)" stroke-width="2" stroke-linecap="round"/>`);

        // 鞘翅左右两半各自一个 group，起飞时绕前端内角转开
        this.elytraTop = el('g', {}, this.top);
        this.elytraBottom = el('g', {}, this.top);
        const pattern = patternMarkup(this.look.pattern, s.dark);
        for (const [g, d, sign, clipId] of [[this.elytraTop, ELYTRA_TOP, -1, `${id}-clip-top`], [this.elytraBottom, ELYTRA_BOTTOM, 1, `${id}-clip-bottom`]]) {
            el('path', { d, fill: `url(#${id}-shell)` }, g);
            if (pattern) {
                // 每半边只按自己的轮廓裁：两半各画一整套花纹，裁掉的那半看不见；
                // 裁切跟着半边一起转，鞘翅张开时花纹不会漂在空中
                const clip = el('g', { 'clip-path': `url(#${clipId})`, opacity: 0.55 }, g);
                clip.innerHTML = pattern;
            }
            el('path', { d, fill: 'none', stroke: 'rgba(0,0,0,.45)', 'stroke-width': 1.6 }, g);
            el('ellipse', { cx: -6, cy: 14 * sign, rx: 15, ry: 4, fill: '#fff', opacity: sign < 0 ? 0.3 : 0.14, transform: `rotate(${-8 * sign} -6 ${14 * sign})` }, g);
        }
        this.seam = el('line', { x1: 16, y1: 0, x2: -47, y2: 0, stroke: 'rgba(0,0,0,.55)', 'stroke-width': 1.8 }, this.top);

        if (this.look.number != null) {
            this.badge = el('g', {}, this.top);
            el('circle', { cx: -17, cy: 0, r: 10.5, fill: '#f3e6c6', stroke: '#2a1606', 'stroke-width': 1.6 }, this.badge);
            const text = el('text', { x: -17, y: 4.6, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#2a1606', 'font-family': 'Georgia, serif' }, this.badge);
            text.textContent = String(this.look.number);
        }

        // 被雷劈的焦黑：盖在背面上
        // 照壳和前胸的轮廓涂黑，别用一整块椭圆（会比身子大一圈）
        this.soot = el('g', { style: 'display:none' }, this.top);
        for (const d of [ELYTRA_TOP, ELYTRA_BOTTOM, PRONOTUM]) el('path', { d, fill: '#141010' }, this.soot);
        for (const [x, y] of [[-20, -10], [4, 12], [-34, 8]]) el('circle', { cx: x, cy: y, r: 3, fill: 'rgba(255,170,90,.55)' }, this.soot);

        // 腹面（翻肚皮时换上）
        this.belly = el('g', { style: 'display:none' }, this.rig);
        this.bellyLegs = BELLY_LEGS.map(([hx, hy, d]) => {
            const g = el('g', {}, this.belly);
            el('path', { d, fill: 'none', stroke: '#0c0603', 'stroke-width': 4.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
            el('path', { d, fill: 'none', stroke: s.leg, 'stroke-width': 2.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
            return { g, hx, hy };
        });
        this.belly.insertAdjacentHTML('beforeend', `
          <ellipse cx="-6" cy="0" rx="44" ry="25" fill="url(#${id}-belly)" stroke="rgba(0,0,0,.45)" stroke-width="1.6"/>
          ${[-30, -18, -6, 6].map(x => `<path d="M${x} -22 Q${x + 4} 0 ${x} 22" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.6"/>`).join('')}
          <ellipse cx="30" cy="0" rx="10" ry="12" fill="${s.deep}"/>
          <ellipse cx="42" cy="0" rx="8" ry="9" fill="#1a100a"/>
          <ellipse cx="-10" cy="-10" rx="18" ry="4" fill="#fff" opacity=".2"/>`);

        // 滚成球：一颗壳色的球，上面的节纹按滚过的距离往后走
        this.ball = el('g', { style: 'display:none' }, this.rig);
        el('circle', { r: 27, fill: `url(#${id}-ball)`, stroke: 'rgba(0,0,0,.45)', 'stroke-width': 1.6 }, this.ball);
        this.ballBands = el('g', { 'clip-path': `url(#${id}-clip-ball)` }, this.ball);
        for (let i = -3; i <= 3; i++) {
            el('path', { d: `M${i * 13} -30 Q${i * 13 - 7} 0 ${i * 13} 30`, fill: 'none', stroke: s.deep, 'stroke-width': 2.4, opacity: 0.55 }, this.ballBands);
        }
        el('ellipse', { cx: -8, cy: -11, rx: 10, ry: 5, fill: '#fff', opacity: 0.3 }, this.ball);

        // 钻地：一个往前拱的土包
        this.mound = el('g', { style: 'display:none' }, this.rig);
        el('path', { d: 'M-40 2 C-38 -18 -12 -26 14 -22 C34 -18 44 -6 42 6 C40 18 20 24 -6 23 C-26 22 -42 16 -40 2 Z', fill: '#6d4a26', stroke: '#3c2610', 'stroke-width': 1.6 }, this.mound);
        el('path', { d: 'M-26 -8 C-12 -16 8 -16 24 -10', fill: 'none', stroke: 'rgba(255,220,170,.28)', 'stroke-width': 3, 'stroke-linecap': 'round' }, this.mound);
        for (const [x, y, r] of [[-18, 6, 3], [6, -4, 2.6], [20, 8, 2.2], [-4, 12, 2]]) el('circle', { cx: x, cy: y, r, fill: '#8a6236' }, this.mound);
        el('path', { d: 'M40 -4 L50 -8 M40 4 L50 8', stroke: '#150b05', 'stroke-width': 2, 'stroke-linecap': 'round' }, this.mound);

        // 变蜗牛：壳用甲虫自己的颜色，一眼看得出是谁变的
        this.snail = el('g', { style: 'display:none' }, this.rig);
        this.snail.innerHTML = `
          <path d="M-40 4 C-40 -10 -20 -14 10 -12 C34 -11 50 -8 58 -2 C62 2 58 8 50 9 C30 12 -10 16 -30 14 C-38 13 -40 10 -40 4 Z" fill="#cdb98c" stroke="#7a6640" stroke-width="1.5"/>
          <path d="M50 -4 C56 -14 60 -20 62 -26 M50 4 C58 10 62 16 64 22" fill="none" stroke="#b8a274" stroke-width="3" stroke-linecap="round"/>
          <circle cx="62.5" cy="-26.5" r="3" fill="#2a1e10"/><circle cx="64.5" cy="22.5" r="3" fill="#2a1e10"/>
          <circle cx="-4" cy="0" r="26" fill="url(#${id}-ball)" stroke="rgba(0,0,0,.45)" stroke-width="1.6"/>
          <path d="M-4 0 m-3 -3 a4 4 0 1 1 7 4 a8 8 0 1 1 -13 -8 a13 13 0 1 1 20 14 a18 18 0 0 1 -26 -2" fill="none" stroke="${s.deep}" stroke-width="2.6" stroke-linecap="round"/>
          <ellipse cx="-12" cy="-12" rx="9" ry="4" fill="#fff" opacity=".3"/>`;

        // 冰冻术的冰块：盖在最上面
        this.ice = el('g', { style: 'display:none' }, this.rig);
        this.ice.innerHTML = `
          <rect x="-62" y="-44" width="146" height="88" rx="12" fill="rgba(190,232,255,.42)" stroke="rgba(236,250,255,.95)" stroke-width="2.4"/>
          <path d="M-50 -34 L-20 -34 M-54 -20 L-44 -30 M60 30 L76 14 M66 36 L78 24" stroke="rgba(255,255,255,.85)" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M-10 -44 L0 -20 L-14 4 M40 44 L30 22" stroke="rgba(255,255,255,.4)" stroke-width="1.4" fill="none"/>`;
    }

    setLead(on) {
        this.root.classList.toggle('is-lead', !!on);
    }

    setOut(on) {
        this.root.classList.toggle('is-out', !!on);
    }

    /**
     * @param {object} frame
     * @param {number} frame.x  frame.y  世界坐标（甲虫中心）
     * @param {number} frame.scale  甲虫缩放
     * @param {number} frame.speed  前进速度（本地单位/秒，给步态用；倒着走传负数）
     * @param {string} frame.actionId  当前动作，没有就 idle
     * @param {number} frame.elapsed   动作开始后过了多少秒
     * @param {number} frame.duration  这次动作的总时长（秒）；0 = 用动作默认时长
     * @param {number} frame.dt  离上一帧多少秒
     */
    update({ x = 0, y = 0, scale = 1, speed = 0, actionId = '', elapsed = 0, duration = 0, dt = 0.016 } = {}) {
        const d0 = ACTIONS[actionId]?.sim.dur || 1;
        const total = duration > 0 ? duration : d0;
        const progress = actionId ? remapProgress(actionId, elapsed, total, d0) : 0;
        const beat = elapsed / d0;
        const key = actionId ? `${actionId}:${Math.round(total * 1000)}` : '';
        if (key !== this._cueKey || progress < this._lastProgress - 0.2) {
            this._cueKey = key;
            this._firedCues.clear();
            this._emitClock = 0;
        }
        this._lastProgress = progress;

        const poseFn = POSES[actionId] || POSES.idle;
        const target = { ...REST, ...poseFn(progress, beat) };
        // 动作切换时别瞬间跳姿势：位置类字段做一点指数平滑（翻身的 sy、转圈的 rot 例外，它们要的就是干脆）
        const k = Math.min(1, dt * 16);
        const prev = this.pose;
        const pose = { ...target };
        for (const field of ['dx', 'dy', 'sx', 'size', 'lift', 'elytra', 'wings', 'antennaDroop', 'aura', 'ice', 'soot']) {
            pose[field] = prev[field] + (target[field] - prev[field]) * k;
        }
        // 没动作时把朝向慢慢拧回正前方；转圈转了 720° 的，先折回 ±180° 再回正
        if (!actionId) pose.rot = wrapAngle(prev.rot) * (1 - k);
        this.pose = pose;

        this.roll += speed * dt;
        this._applyPose(pose, { speed, dt });

        const shake = pose.shake ? `translate(${((Math.random() - 0.5) * 2 * pose.shake).toFixed(2)} ${((Math.random() - 0.5) * 2 * pose.shake).toFixed(2)}) ` : '';
        const grow = (1 + 0.28 * pose.lift) * pose.size;
        this.root.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})`);
        this.rig.setAttribute('transform', `${shake}translate(${pose.dx.toFixed(2)} ${(pose.dy - 10 * pose.lift).toFixed(2)}) rotate(${pose.rot.toFixed(2)}) scale(${(pose.sx * grow).toFixed(4)} ${(Math.abs(pose.sy) * grow).toFixed(4)})`);
        this.root.style.opacity = pose.alpha < 0.999 ? pose.alpha.toFixed(3) : '';
        const shadowOff = 18 * pose.lift;
        const shadowScale = (1 - 0.25 * pose.lift) * pose.size * (pose.form === 'ball' ? 0.7 : 1);
        this.shadow.setAttribute('transform', `translate(${(pose.dx + shadowOff).toFixed(2)} ${(pose.dy + shadowOff * 1.3).toFixed(2)}) scale(${shadowScale.toFixed(3)})`);
        this.shadow.style.opacity = pose.form === 'mound' ? '0.4' : (pose.alpha * (1 - 0.5 * pose.lift)).toFixed(3);
        this.trail.style.opacity = pose.trail === 'dust' ? '1' : '0';
        this.goldTrail.style.opacity = pose.trail === 'gold' ? '1' : '0';
        this.aura.style.display = pose.aura > 0.02 ? '' : 'none';
        this.aura.setAttribute('transform', `translate(${pose.dx.toFixed(2)} ${pose.dy.toFixed(2)}) scale(${(pose.size * (0.9 + 0.1 * pose.aura)).toFixed(3)})`);
        this.aura.style.opacity = pose.aura.toFixed(3);

        if (this.fx) this._fireFx(actionId, progress, total, dt, pose, { x, y, scale });
    }

    _applyPose(pose, { speed, dt }) {
        const form = pose.form;
        const flipped = pose.sy < 0;
        const isBeetle = form === 'beetle';
        show(this.top, isBeetle && !flipped);
        show(this.belly, isBeetle && flipped);
        show(this.legGroup, isBeetle && !flipped);
        show(this.ball, form === 'ball');
        show(this.mound, form === 'mound');
        show(this.snail, form === 'snail');
        show(this.soot, pose.soot > 0.02);
        this.soot.style.opacity = (pose.soot * 0.82).toFixed(3);
        show(this.ice, pose.ice > 0.02);
        this.ice.style.opacity = pose.ice.toFixed(3);
        this.ice.setAttribute('transform', `scale(${(0.7 + 0.3 * pose.ice).toFixed(3)})`);

        if (form === 'ball') {
            this.ball.setAttribute('transform', `scale(${(0.7 + 0.3 * pose.formMix).toFixed(3)})`);
            // 节纹往后走 = 球在往前滚；13 是节纹间距
            const offset = -((this.roll * 0.9) % 13 + 13) % 13;
            this.ballBands.setAttribute('transform', `translate(${offset.toFixed(2)} 0)`);
        }
        if (form === 'mound') {
            this.mound.setAttribute('transform', `scale(${(0.6 + 0.4 * pose.formMix).toFixed(3)} ${(0.6 + 0.4 * pose.formMix + 0.05 * Math.sin(this.roll * 0.3)).toFixed(3)})`);
        }
        if (form === 'snail') {
            const stretch = 1 + 0.06 * Math.sin(this.roll * 0.25);
            this.snail.setAttribute('transform', `scale(${stretch.toFixed(3)} 1)`);
        }

        show(this.dung, pose.dung > 0.02 && isBeetle);
        if (pose.dung > 0.02) {
            const r = 8 + 20 * pose.dung;
            const cx = 50 + r;
            this.dung.setAttribute('transform', `translate(${cx.toFixed(1)} 0)`);
            this.dung.querySelector('.dung-ball').setAttribute('r', r.toFixed(1));
            this.dung.querySelector('.dung-shadow').setAttribute('r', r.toFixed(1));
            this.dungSpecks.setAttribute('transform', `scale(${(r / 20).toFixed(3)}) rotate(${(this.roll * 3).toFixed(1)})`);
        }

        // 步态：按走过的距离推进，所以跑得快腿就倒腾得快，停下来腿就停
        const moving = Math.min(1, Math.abs(speed) / 40);
        let gaitRate;
        if (pose.legs === 'flail') gaitRate = 22 * pose.legSpeed;
        else if (pose.legs === 'kick') gaitRate = 26;
        else if (pose.legs === 'walk') gaitRate = (Math.abs(speed) * 0.17 + 2 * moving) * pose.legSpeed;
        else gaitRate = 0;
        this.gait += gaitRate * dt;

        if (flipped) {
            this.bellyLegs.forEach((leg, i) => {
                const a = 26 * Math.sin(this.gait + i * 1.3);
                leg.g.setAttribute('transform', `rotate(${a.toFixed(1)} ${leg.hx} ${leg.hy})`);
            });
        } else {
            for (const leg of this.legs) {
                const side = leg.hy < 0 ? 1 : -1;
                let a = 0;
                let s = 1;
                switch (pose.legs) {
                    case 'walk': a = Math.sin(this.gait + (leg.group ? Math.PI : 0)) * 19 * Math.max(moving, pose.legSpeed > 1.2 ? 1 : moving) * side; break;
                    case 'flail': a = Math.sin(this.gait * 1.3 + leg.hx) * 28 * side; break;
                    case 'brace': a = -18 * side; break;
                    case 'tuck': a = 28 * side; s = 0.62; break;
                    case 'kick': a = Math.sin(this.gait + leg.hx) * 24 * side; break;
                    default: a = 0;
                }
                leg.g.setAttribute('transform', `translate(${leg.hx} ${leg.hy}) rotate(${a.toFixed(1)}) scale(${s}) translate(${-leg.hx} ${-leg.hy})`);
            }
        }

        // 鞘翅绕前端内角往外转：上半边正角度、下半边负角度才是往外开
        const open = 38 * pose.elytra;
        this.elytraTop.setAttribute('transform', `rotate(${open.toFixed(1)} 14 -3)`);
        this.elytraBottom.setAttribute('transform', `rotate(${(-open).toFixed(1)} 14 3)`);
        this.seam.style.opacity = pose.elytra > 0.05 ? '0' : '';
        const flap = pose.flap ? 0.55 + 0.45 * Math.abs(Math.sin(performance.now() / 32)) : 1;
        const wing = pose.wings;
        this.wingTop.setAttribute('transform', `translate(8 -3) scale(${wing.toFixed(3)} ${(wing * flap).toFixed(3)}) translate(-8 3)`);
        this.wingBottom.setAttribute('transform', `translate(8 3) scale(${wing.toFixed(3)} ${(wing * flap).toFixed(3)}) translate(-8 -3)`);
        show(this.wingTop, wing > 0.02 && isBeetle);
        show(this.wingBottom, wing > 0.02 && isBeetle);

        const droop = pose.antennaDroop;
        const wave = 6 * Math.sin(performance.now() / 170);
        for (const ant of this.antennae) {
            const a = (wave * (1 - droop) + 34 * droop) * ant.side;
            ant.g.setAttribute('transform', `rotate(${a.toFixed(1)} 47 ${5 * ant.side})`);
        }
    }

    _fireFx(actionId, progress, duration, dt, pose, pos) {
        const scale = pos.scale * pose.size;
        const o = {
            x: pos.x + pose.dx * pos.scale,
            y: pos.y + pose.dy * pos.scale,
            scale,
            noseX: pos.x + (pose.dx + 52 * pose.size) * pos.scale,
            tailX: pos.x + (pose.dx - 50 * pose.size) * pos.scale,
            topY: pos.y + (pose.dy - 40 * pose.size) * pos.scale
        };
        this.fx.scale = scale;
        for (const [index, cue] of (CUES[actionId] || []).entries()) {
            if (progress >= cue.at && !this._firedCues.has(index)) {
                this._firedCues.add(index);
                cue.fx(this.fx, o, duration);
            }
        }
        const emitter = EMITTERS[actionId];
        if (emitter && (!emitter.when || emitter.when(pose))) {
            this._emitClock += dt;
            while (this._emitClock >= emitter.every) {
                this._emitClock -= emitter.every;
                emitter.fx(this.fx, o);
            }
        }
    }
}

export function createBeetle(look, opts) {
    return new BeetleActor(look, opts);
}

// ───────── 气泡 ─────────

const CJK = /[　-鿿＀-￯]/u;

/** 气泡断行：有空格的（英文等）按单词折，最多三行；中日文按字数平分 */
export function wrapBubbleText(value, { latinWidth = 20, cjkWidth = 12, maxLines = 3 } = {}) {
    const clean = String(value || '').replace(/\s+/gu, ' ').trim();
    if (!clean) return [];
    const chars = [...clean];
    if (/\s/u.test(clean) && !CJK.test(clean)) {
        const lines = [];
        let line = '';
        for (const word of clean.split(' ')) {
            const next = line ? `${line} ${word}` : word;
            if (line && [...next].length > latinWidth) {
                lines.push(line);
                line = word;
            } else {
                line = next;
            }
        }
        if (line) lines.push(line);
        if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(' '));
        return lines;
    }
    if (chars.length <= cjkWidth) return [clean];
    const count = Math.min(maxLines, Math.ceil(chars.length / cjkWidth));
    const per = Math.ceil(chars.length / count);
    const lines = [];
    for (let i = 0; i < chars.length; i += per) lines.push(chars.slice(i, i + per).join(''));
    return lines;
}

function estimateWidth(line, fontSize) {
    return [...line].reduce((w, ch) => w + (CJK.test(ch) ? fontSize : fontSize * 0.56), 0);
}

/**
 * 气泡：挂在甲虫头顶，不跟着身体转。
 * 宽度优先用浏览器量出来的文字长度（英文、中文、换了字体都准），量不到（还没挂进页面）再按字符估。
 * 返回 { el, place(x, y, scale), setText(text), show(on) }。
 */
export function createBubble(parent) {
    const root = el('g', { class: 'parlor-br-bubble' }, parent);
    const box = el('rect', { rx: 10, ry: 10, fill: '#fffaf0', stroke: '#3a2408', 'stroke-width': 2 }, root);
    el('path', { d: 'M-7 0 L7 0 L0 11 Z', fill: '#fffaf0', stroke: '#3a2408', 'stroke-width': 2, 'stroke-linejoin': 'round' }, root);
    // 盖住尾巴和框之间那段描边，让尾巴看起来是从框里长出来的
    const tailMask = el('rect', { x: -6, y: -3, width: 12, height: 4, fill: '#fffaf0' }, root);
    const text = el('text', { 'text-anchor': 'middle', 'font-size': 15, fill: '#2a1606' }, root);
    void tailMask;
    return {
        el: root,
        setText(value) {
            const clean = String(value || '').trim();
            const lines = wrapBubbleText(clean);
            const spans = lines.map((line, i) => {
                const span = el('tspan', { x: 0, dy: i === 0 ? 0 : 18 });
                span.textContent = line;
                return span;
            });
            text.replaceChildren(...spans);
            let widest = 0;
            for (let i = 0; i < spans.length; i++) {
                let measured = 0;
                try { measured = spans[i].getComputedTextLength(); } catch { measured = 0; }
                widest = Math.max(widest, measured > 0 ? measured : estimateWidth(lines[i], 15));
            }
            const width = Math.max(40, widest + 24);
            const height = 16 + lines.length * 18;
            box.setAttribute('x', -width / 2);
            box.setAttribute('y', -height);
            box.setAttribute('width', width);
            box.setAttribute('height', height);
            text.setAttribute('y', -height + 22);
            root.dataset.empty = clean ? '' : '1';
        },
        place(x, y, scale = 1) {
            root.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})`);
        },
        show(on) {
            root.classList.toggle('is-on', !!on);
        }
    };
}
