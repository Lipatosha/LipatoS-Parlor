/**
 * 酒馆甲虫赛跑 · 全屏小剧场（巡游 / 下注）
 *
 * 巡游和下注时桌子整个撤掉，换成一座铺满屏幕的戏台：后墙、木地板、两侧边幕、顶上垂幔、台口一排脚灯，
 * 外加一道能拉开的大幕和两盏追光。圆台、光锥、甲虫还是 TavernRaceStage 画（1716×736 的内容 SVG），
 * 这里只管"戏院"本身，并给内容留一个盒子（contentBox），按屏幕剩下的空间等比放大。
 *
 * 开幕进度 p（0 = 大幕合着，1 = 全开）由呈现器每帧给：巡游时按主机的 paradeElapsedMs 算，各端同一刻拉开；
 * 直接进下注（第二场起）就本地播一遍。这里不自己计时。
 */

// 内容 SVG 的尺寸，跟 TavernRaceStage 一致；地面线在内容坐标 368
const CONTENT_W = 1716;
const CONTENT_H = 736;
const CONTENT_FLOOR_Y = 368;

// 开幕时间线（占 paradeIntroMs 的比例）：先亮脚灯、追光扫过大幕上的赛事名 → 大幕拉开 → 追光落到圆台上淡出
const SPAN = {
    foot: [0.02, 0.4],
    beamsIn: [0.04, 0.34],
    title: [0.3, 0.48],
    curtain: [0.2, 0.94],
    beamsDown: [0.54, 0.92]
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const span = (p, [a, b]) => clamp01((p - a) / (b - a));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

export class TavernTheatre {
    /**
     * @param {HTMLElement} host   挂在哪（呈现器给的是壳的 .stage，剧场垫在它最底下）
     * @param {object} opts        { woodHref, curtainMotion }；拉幕节奏从本体借，旧本体缺少时用本地节奏。
     */
    constructor(host, { woodHref = '', curtainMotion = null } = {}) {
        this._curtainMotion = curtainMotion;
        const root = document.createElement('div');
        root.className = 'pbr-theatre';
        root.setAttribute('aria-hidden', 'false');
        // CSS 变量里的相对地址会按样式表目录解析；先按页面的 base 解出绝对地址，也兼容 Foundry 的路由前缀。
        root.style.setProperty('--pbr-th-wood', woodHref ? `url("${new URL(woodHref, document.baseURI).href}")` : 'none');
        root.innerHTML = `
            <div class="pbr-th-wall"></div>
            <div class="pbr-th-floor"><i class="pbr-th-lip"></i></div>
            <div class="pbr-th-content"></div>
            <div class="pbr-th-curtain l"><div class="pbr-th-fabric"></div></div>
            <div class="pbr-th-curtain r"><div class="pbr-th-fabric"></div></div>
            <div class="pbr-th-title"><b></b><span></span></div>
            <div class="pbr-th-beam l"></div>
            <div class="pbr-th-beam r"></div>
            <svg class="pbr-th-drape l" viewBox="0 0 200 1000" preserveAspectRatio="none" aria-hidden="true">${drapeSvg()}</svg>
            <svg class="pbr-th-drape r" viewBox="0 0 200 1000" preserveAspectRatio="none" aria-hidden="true">${drapeSvg()}</svg>
            <svg class="pbr-th-valance" aria-hidden="true"></svg>
            <div class="pbr-th-foot"></div>
        `;
        host.prepend(root);
        this.root = root;
        this.content = root.querySelector('.pbr-th-content');
        this._curtains = [...root.querySelectorAll('.pbr-th-curtain')];
        this._fabrics = [...root.querySelectorAll('.pbr-th-fabric')];
        this._titles = [...root.querySelectorAll('.pbr-th-title')];
        this._beams = [...root.querySelectorAll('.pbr-th-beam')];
        this._valance = root.querySelector('.pbr-th-valance');
        this._foot = root.querySelector('.pbr-th-foot');
        this._bulbs = [];
        this._layoutKey = '';
        this._p = -1;
        this.scale = 1;
    }

    setTitle(name, sub) {
        for (const title of this._titles) {
            title.querySelector('b').textContent = name || '';
            title.querySelector('span').textContent = sub || '';
        }
    }

    /**
     * 按屏幕上剩下的那块排版：top = 招牌条底边，bottom = HUD 顶边（都是相对剧场根的像素）
     * 内容盒子在这块里等比放到最大、水平居中；地板从甲虫脚下往下铺到屏幕底，台口压在 HUD 上沿
     */
    layout({ width, height, top, bottom }) {
        const key = [width, height, top, bottom].map(v => Math.round(v)).join(',');
        if (key === this._layoutKey) return;
        this._layoutKey = key;
        const room = Math.max(120, bottom - top);
        const s = Math.min(width / CONTENT_W, room / CONTENT_H);
        const boxW = CONTENT_W * s;
        const boxH = CONTENT_H * s;
        const boxLeft = (width - boxW) / 2;
        const boxTop = top + (room - boxH) / 2;
        this.scale = s;
        const style = this.content.style;
        style.left = `${boxLeft.toFixed(1)}px`;
        style.top = `${boxTop.toFixed(1)}px`;
        style.width = `${boxW.toFixed(1)}px`;
        style.height = `${boxH.toFixed(1)}px`;
        // 后墙和地板的交界线放在甲虫脚下偏后一点，圆台才像立在地板上而不是贴在墙上
        const horizon = boxTop + (CONTENT_FLOOR_Y - 34) * s;
        this.root.style.setProperty('--pbr-th-top', `${top.toFixed(1)}px`);
        this.root.style.setProperty('--pbr-th-horizon', `${horizon.toFixed(1)}px`);
        // 台口那道黄铜边和脚灯压在 HUD 上沿之上一点，别被托盘盖住
        this.root.style.setProperty('--pbr-th-lip', `${Math.min(height - 8, bottom - 10).toFixed(1)}px`);
        this._buildValance(width);
        this._buildFootlights(width);
    }

    // 垂幔：一排扇形褶边 + 金流苏，个数跟着屏幕宽度走（拉伸会把扇形拉成扁的）
    _buildValance(width) {
        const h = 96;
        const n = Math.max(5, Math.round(width / 190));
        const w = width / n;
        const W = width.toFixed(1);
        const scallops = (dy = 0) => Array.from({ length: n }, (_, i) =>
            ` Q${(i * w + w / 2).toFixed(1)} ${h + 18 + dy} ${((i + 1) * w).toFixed(1)} ${h - 16 + dy}`).join('');
        const tassels = Array.from({ length: n - 1 }, (_, i) => {
            const x = ((i + 1) * w).toFixed(1);
            return `<path d="M${x} ${h - 16} v18" stroke="#d8ae48" stroke-width="3"/><circle cx="${x}" cy="${h + 6}" r="5" fill="url(#pbrth-brass)"/>`;
        }).join('');
        const svg = this._valance;
        svg.setAttribute('viewBox', `0 0 ${W} ${h + 24}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.innerHTML = `
            <defs>
                <linearGradient id="pbrth-val" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a0f0a"/><stop offset=".72" stop-color="#7a1c12"/><stop offset="1" stop-color="#3e0a07"/></linearGradient>
                <linearGradient id="pbrth-brass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0d27a"/><stop offset=".5" stop-color="#a87f22"/><stop offset="1" stop-color="#5a3a0c"/></linearGradient>
            </defs>
            <path d="M0 0 H${W} V${h - 16} L0 ${h - 16} Z" fill="url(#pbrth-val)"/>
            <path d="M0 ${h - 16}${scallops()} V${h - 16} Z" fill="url(#pbrth-val)"/>
            <path d="M0 ${h - 16}${scallops()}" fill="none" stroke="#d8ae48" stroke-width="4"/>
            <path d="M0 ${h - 23}${scallops(-7)}" fill="none" stroke="rgba(255,226,160,.26)" stroke-width="1.5"/>
            <rect x="0" y="0" width="${W}" height="10" fill="url(#pbrth-brass)"/>
            ${tassels}`;
    }

    // 脚灯：台口一排小灯泡，开幕时从左到右一盏盏亮
    _buildFootlights(width) {
        const n = Math.max(8, Math.round(width / 96));
        if (this._bulbs.length === n) return;
        this._foot.innerHTML = Array.from({ length: n }, (_, i) => `<i style="left:${(((i + 0.5) / n) * 100).toFixed(2)}%"></i>`).join('');
        this._bulbs = [...this._foot.children];
        this._p = -1;
    }

    /** 开幕进度：0 合幕，1 全开。只在变化时写样式 */
    setOpening(p) {
        const q = clamp01(p);
        if (Math.abs(q - this._p) < 0.0005) return;
        this._p = q;
        this.root.classList.toggle('is-open', q >= 1);

        const pose = this._curtainMotion?.(q);
        const c = pose?.open ?? easeInOut(span(q, SPAN.curtain));
        const shift = pose?.shift ?? 104 * c;
        const gather = pose?.gather ?? 1 - 0.08 * c;
        const swing = pose?.sway ?? Math.sin(c * Math.PI) * 0.7;
        // 整幅帷幕滑到屏幕外，布料只轻微收褶；到终点才隐藏，避免还在画面中就突然消失。
        this._curtains.forEach((node, i) => {
            const direction = i === 0 ? -1 : 1;
            node.style.transform = `translateX(${(direction * shift).toFixed(3)}%) skewY(${(direction * swing).toFixed(3)}deg)`;
            this._fabrics[i].style.transform = `scaleX(${gather.toFixed(4)})`;
            node.style.visibility = c >= 1 ? 'hidden' : '';
        });

        const title = pose?.titleOpacity ?? 1 - span(q, SPAN.title);
        this._titles.forEach(node => { node.style.opacity = title.toFixed(3); });

        // 追光：从两侧斜着扫进来，在赛事名上交叉；大幕开了之后一起压下去照圆台，再淡出交给台上的主灯
        const inT = easeOut(span(q, SPAN.beamsIn));
        const downT = easeInOut(span(q, SPAN.beamsDown));
        const angle = 38 - 24 * inT - 9 * downT;
        const beamOpacity = inT * (1 - downT);
        this._beams[0].style.transform = `rotate(${(-angle).toFixed(2)}deg)`;
        this._beams[1].style.transform = `rotate(${angle.toFixed(2)}deg)`;
        this._beams.forEach(node => { node.style.opacity = beamOpacity.toFixed(3); });

        const foot = span(q, SPAN.foot);
        const n = this._bulbs.length;
        this._bulbs.forEach((bulb, i) => bulb.classList.toggle('on', foot >= (i + 1) / (n + 1)));
    }

    destroy() {
        this.root.remove();
    }
}

// 边幕：一幅丝绒，62% 高处用金绳束一下，束口以下收窄再散到地上
function drapeSvg() {
    return `
        <defs>
            <linearGradient id="pbrth-drape" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stop-color="#2a0604"/><stop offset=".18" stop-color="#6e1810"/><stop offset=".34" stop-color="#3e0a07"/>
                <stop offset=".52" stop-color="#8a2216"/><stop offset=".7" stop-color="#4a0d0a"/><stop offset=".86" stop-color="#7a1c12"/><stop offset="1" stop-color="#2e0705"/>
            </linearGradient>
            <linearGradient id="pbrth-rope" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0d27a"/><stop offset="1" stop-color="#7a520e"/></linearGradient>
        </defs>
        <path d="M0 0 H200 C188 240 150 470 118 620 C150 740 176 870 190 1000 H0 Z" fill="url(#pbrth-drape)"/>
        <path d="M34 0 C44 260 40 480 30 1000 M86 0 C98 250 88 470 70 1000 M140 0 C140 220 120 460 96 640" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="6"/>
        <path d="M200 0 C188 240 150 470 118 620 C150 740 176 870 190 1000" fill="none" stroke="rgba(255,200,150,.12)" stroke-width="3"/>
        <path d="M0 606 C46 626 88 628 112 614" fill="none" stroke="url(#pbrth-rope)" stroke-width="12" stroke-linecap="round"/>
        <path d="M104 618 q7 26 -3 50 M112 616 q10 28 3 54" fill="none" stroke="#c9a227" stroke-width="4" stroke-linecap="round"/>`;
}
