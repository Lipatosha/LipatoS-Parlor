/**
 * 酒馆甲虫赛跑 · 赛道板（垫面上那块木板）
 *
 * 形制从 tools/race-demo 的 buildBoard 搬过来（Reslin 看过的那版）：木板、六条槽道、起跑闸、¼½¾ 粉笔刻度、
 * 棋格终点 + 黄铜柱彩带、右端钱区（赔率 / 本道池 / 押注铜币）、名次火漆、倒数、撞线横幅、慢镜暗角。
 * 甲虫本身借本体的 BeetleActor（gameApi.beetles）——27 个动作动画、特效、气泡都在那边，这里只负责摆。
 *
 * 坐标 = 垫内容区 1716×736，跟壳的 .surface 一比一。道数 3–8：道高按道数算，整组竖直居中。
 */

const NS = 'http://www.w3.org/2000/svg';
const W = 1716;
const H = 736;
const INNER_TOP = 80;
const INNER_BOTTOM = 656;
const MAX_LANE_H = 112;
const GATE_X = 262;
const FINISH_X = 1478;
const TROUGH_END = 1540;
const MONEY_X = 1552;
const BADGE_X = 92;
const LIVE_X = 152;
const START_X = GATE_X + 46;
// 本体甲虫中心到鼻尖（本地单位）；换算时扣掉，撞线那一刻鼻尖正好压线
const NOSE = 50;
const LIVE_EVERY_MS = 250;
const MAX_COINS = 6;

function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
}

export class TavernRaceBoard {
    /**
     * @param {HTMLElement} host
     * @param {object[]} lanes  gameApi.getLanes() 的名牌
     * @param {object} opts     { kit: gameApi.beetles, placeLabel(n), woodHref, text: { finish } }
     */
    constructor(host, lanes, { kit, placeLabel = (n) => String(n), woodHref = '', text = {} } = {}) {
        this.kit = kit;
        this.placeLabel = placeLabel;
        this.count = lanes.length;
        this.laneH = Math.min(MAX_LANE_H, (INNER_BOTTOM - INNER_TOP) / Math.max(1, this.count));
        this.top = (INNER_TOP + INNER_BOTTOM) / 2 - (this.laneH * this.count) / 2;
        // 道窄了甲虫跟着缩，别探进隔壁道
        this.beetleScale = Math.min(1.05, this.laneH / 100);
        this._lastLiveAt = 0;
        this._lastLeader = -1;
        this._finished = new Set();
        this._bubbleText = lanes.map(() => '');
        this.root = el('svg', { class: 'pbr-board', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
        host.appendChild(this.root);
        this._build(lanes, woodHref, text);
    }

    laneY(i) {
        return this.top + this.laneH * (i + 0.5);
    }

    // 模拟里的里程（0 起跑，trackLength 撞线）→ 板上甲虫中心的 x
    toBoardX(x) {
        const track = this.kit?.trackLength || 1000;
        const finishCenter = FINISH_X - NOSE * this.beetleScale;
        return Math.min(TROUGH_END + 60, START_X + (x / track) * (finishCenter - START_X));
    }

    _build(lanes, woodHref, text) {
        const svg = this.root;
        const bottom = this.top + this.laneH * this.count;
        const defs = el('defs', {}, svg);
        defs.innerHTML = `
          <pattern id="pbrb-wood" patternUnits="userSpaceOnUse" width="360" height="360" patternTransform="rotate(90)">
            <image href="${woodHref}" width="360" height="360" preserveAspectRatio="xMidYMid slice"/>
          </pattern>
          <linearGradient id="pbrb-trough" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(0,0,0,.72)"/><stop offset=".18" stop-color="rgba(8,3,0,.5)"/>
            <stop offset=".82" stop-color="rgba(8,3,0,.44)"/><stop offset="1" stop-color="rgba(0,0,0,.6)"/>
          </linearGradient>
          <radialGradient id="pbrb-light" cx="50%" cy="42%" r="70%">
            <stop offset="0" stop-color="rgba(255,190,110,.14)"/><stop offset=".6" stop-color="rgba(255,170,80,.03)"/><stop offset="1" stop-color="rgba(0,0,0,.34)"/>
          </radialGradient>
          <radialGradient id="pbrb-slow" cx="50%" cy="50%" r="72%">
            <stop offset=".45" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(20,8,0,.62)"/>
          </radialGradient>
          <radialGradient id="pbrb-spot" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="rgba(255,206,120,.22)"/><stop offset=".6" stop-color="rgba(255,190,100,.07)"/><stop offset="1" stop-color="rgba(255,190,100,0)"/>
          </radialGradient>
          <radialGradient id="pbrb-coin" cx="35%" cy="30%" r="75%">
            <stop offset="0" stop-color="#fff1b0"/><stop offset=".45" stop-color="#dcae3c"/><stop offset="1" stop-color="#7a4d0c"/>
          </radialGradient>
          <radialGradient id="pbrb-wax" cx="38%" cy="32%" r="72%">
            <stop offset="0" stop-color="#c8513a"/><stop offset=".6" stop-color="#7e1d12"/><stop offset="1" stop-color="#420a05"/>
          </radialGradient>
          <radialGradient id="pbrb-waxgold" cx="38%" cy="32%" r="72%">
            <stop offset="0" stop-color="#fff0a8"/><stop offset=".55" stop-color="#d4a232"/><stop offset="1" stop-color="#6e4608"/>
          </radialGradient>
          ${lanes.map((lane, i) => {
              const shades = this.kit.shades(lane.color);
              return `<radialGradient id="pbrb-g${i}" cx="42%" cy="34%" r="78%">
                <stop offset="0" stop-color="${shades.light}"/><stop offset=".5" stop-color="${shades.base}"/><stop offset="1" stop-color="${shades.deep}"/></radialGradient>`;
          }).join('')}`;

        // 板子：AO 双影 → 木板 → 暖光 → 内倒角
        el('g', { class: 'pbr-plank' }, svg).innerHTML = `
          <rect x="50" y="64" width="1636" height="636" rx="20" fill="#000" opacity=".26"/>
          <rect x="44" y="55" width="1636" height="636" rx="19" fill="#000" opacity=".42"/>
          <rect x="40" y="50" width="1636" height="636" rx="18" fill="url(#pbrb-wood)" stroke="#1c0e04" stroke-width="4"/>
          <rect x="40" y="50" width="1636" height="636" rx="18" fill="rgba(46,22,6,.38)"/>
          <rect x="40" y="50" width="1636" height="636" rx="18" fill="url(#pbrb-light)"/>
          <rect x="47" y="57" width="1622" height="622" rx="14" fill="none" stroke="rgba(255,214,150,.13)" stroke-width="2"/>
          <rect x="43" y="53" width="1630" height="630" rx="16" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="1.5"/>
          <text x="858" y="72" text-anchor="middle" font-size="15" letter-spacing="10" fill="rgba(222,183,72,.5)">✦ BEETLE DERBY ✦</text>`;

        const laneLayer = el('g', { class: 'pbr-lanes' }, svg);
        const troughW = TROUGH_END - GATE_X;
        const pad = Math.max(6, this.laneH * 0.09);
        const badgeR = Math.min(29, this.laneH * 0.3);
        this.laneEls = lanes.map((lane, i) => {
            const y = this.top + this.laneH * i;
            const cy = this.laneY(i);
            const g = el('g', { class: 'pbr-lane', 'data-lane': i }, laneLayer);
            g.innerHTML = `
              <rect x="${GATE_X}" y="${y + pad}" width="${troughW}" height="${this.laneH - pad * 2}" rx="11" fill="url(#pbrb-wood)"/>
              <rect x="${GATE_X}" y="${y + pad}" width="${troughW}" height="${this.laneH - pad * 2}" rx="11" fill="url(#pbrb-trough)"/>
              <rect x="${GATE_X}" y="${y + pad}" width="${troughW}" height="${this.laneH - pad * 2}" rx="11" fill="${lane.color}" opacity=".08"/>
              <line x1="${GATE_X + 10}" y1="${y + this.laneH - pad - 0.5}" x2="${TROUGH_END - 10}" y2="${y + this.laneH - pad - 0.5}" stroke="rgba(255,214,150,.14)" stroke-width="1.5"/>
              <rect class="pbr-lanewin" x="${GATE_X - 2}" y="${y + pad - 2}" width="${troughW + 4}" height="${this.laneH - pad * 2 + 4}" rx="12" fill="rgba(255,200,90,.07)" stroke="rgba(255,214,110,.85)" stroke-width="3"/>
              <text class="pbr-lane-name" x="${GATE_X + 70}" y="${cy + 8}" font-size="${Math.min(24, this.laneH * 0.25).toFixed(1)}" letter-spacing="3" fill="rgba(240,226,196,.26)"></text>
              <circle cx="${BADGE_X + 2}" cy="${cy + 3}" r="${badgeR}" fill="#000" opacity=".35"/>
              <circle cx="${BADGE_X}" cy="${cy}" r="${badgeR}" fill="url(#pbrb-g${i})" stroke="#b98c3c" stroke-width="3"/>
              <circle cx="${BADGE_X}" cy="${cy}" r="${badgeR - 6}" fill="none" stroke="rgba(255,240,200,.25)" stroke-width="1.2"/>
              <text x="${BADGE_X}" y="${cy + badgeR * 0.31}" text-anchor="middle" font-size="${(badgeR * 0.9).toFixed(1)}" fill="#fff3d6" stroke="rgba(0,0,0,.5)" stroke-width="1" paint-order="stroke">${i + 1}</text>
              <g class="pbr-seal">
                <circle cx="${BADGE_X + 3}" cy="${cy + 4}" r="${badgeR + 2}" fill="#000" opacity=".35"/>
                <circle class="pbr-seal-disc" cx="${BADGE_X}" cy="${cy}" r="${badgeR + 2}" fill="url(#pbrb-wax)"/>
                <circle cx="${BADGE_X}" cy="${cy}" r="${badgeR - 5}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="2" stroke-dasharray="3 3"/>
                <text class="pbr-seal-text" x="${BADGE_X}" y="${cy + badgeR * 0.3}" text-anchor="middle" font-size="${(badgeR * 0.72).toFixed(1)}" font-weight="700" fill="#ffe9c0"></text>
              </g>
              <line x1="${MONEY_X}" y1="${y + pad + 5}" x2="${MONEY_X}" y2="${y + this.laneH - pad - 5}" stroke="rgba(201,162,39,.22)" stroke-width="1.5"/>
              <text class="pbr-odds" x="${MONEY_X + 12}" y="${cy - 5}" font-size="${Math.min(31, this.laneH * 0.32).toFixed(1)}" fill="#e8c96a"></text>
              <text class="pbr-pool" x="${MONEY_X + 14}" y="${cy + 13}" font-size="13.5" letter-spacing="1" fill="rgba(201,176,136,.75)"></text>
              <g class="pbr-coins" transform="translate(${MONEY_X + 24} ${cy + Math.min(30, this.laneH * 0.31)})"></g>
              <text class="pbr-live" x="${LIVE_X}" y="${cy + 9}" font-size="${Math.min(26, this.laneH * 0.27).toFixed(1)}" fill="rgba(240,226,196,.42)"></text>`;
            g.querySelector('.pbr-lane-name').textContent = lane.name;
            g.querySelector('.pbr-odds').textContent = lane.multiplierText;
            return g;
        });

        // 里程刻度 ¼ ½ ¾（粉笔线）
        const ticks = el('g', { class: 'pbr-ticks' }, svg);
        [0.25, 0.5, 0.75].forEach((q, k) => {
            const x = this.toBoardX((this.kit?.trackLength || 1000) * q) + NOSE * this.beetleScale;
            el('line', { x1: x, y1: this.top + 4, x2: x, y2: bottom - 4, stroke: 'rgba(240,226,196,.2)', 'stroke-width': 2, 'stroke-dasharray': '4 10' }, ticks);
            el('text', { x, y: this.top - 4, 'text-anchor': 'middle', 'font-size': 12, fill: 'rgba(240,226,196,.35)' }, ticks).textContent = ['¼', '½', '¾'][k];
        });

        // 终点：棋格粉笔带 + 两根黄铜柱 + 彩带
        const fin = el('g', { class: 'pbr-finish' }, svg);
        let checker = '';
        for (let yy = this.top + 4; yy < bottom - 4; yy += 11) {
            const row = Math.round((yy - this.top) / 11);
            checker += `<rect x="${FINISH_X - 11 + (row % 2) * 11}" y="${yy.toFixed(1)}" width="11" height="11" fill="rgba(240,226,196,.42)"/>`;
        }
        fin.innerHTML = `${checker}<line x1="${FINISH_X}" y1="${this.top}" x2="${FINISH_X}" y2="${bottom}" stroke="rgba(240,226,196,.25)" stroke-width="1"/>`;
        // 字摆在黄铜柱左边，居中写会被柱头盖掉一半
        el('text', { x: FINISH_X - 18, y: this.top - 6, 'text-anchor': 'end', 'font-size': 12, 'letter-spacing': 3, fill: 'rgba(240,226,196,.5)' }, fin).textContent = text.finish || 'FINIS';

        const postTop = this.top - 18;
        const postBottom = bottom + 18;
        const mid = (postTop + postBottom) / 2;
        this.ribbon = el('g', { class: 'pbr-ribbon' }, svg);
        this.ribbon.innerHTML = `
          <line class="pbr-rib a" x1="${FINISH_X}" y1="${postTop}" x2="${FINISH_X}" y2="${mid}" stroke="#8e1c14" stroke-width="5" stroke-linecap="round"/>
          <line class="pbr-rib b" x1="${FINISH_X}" y1="${mid}" x2="${FINISH_X}" y2="${postBottom}" stroke="#8e1c14" stroke-width="5" stroke-linecap="round"/>
          <line class="pbr-rib a" x1="${FINISH_X - 1.2}" y1="${postTop}" x2="${FINISH_X - 1.2}" y2="${mid}" stroke="rgba(255,190,160,.35)" stroke-width="1.4"/>
          <line class="pbr-rib b" x1="${FINISH_X - 1.2}" y1="${mid}" x2="${FINISH_X - 1.2}" y2="${postBottom}" stroke="rgba(255,190,160,.35)" stroke-width="1.4"/>`;
        // 彩带两截各绕自己那根柱子转开：转心写进 style，跟着道数变
        this.ribbon.querySelectorAll('.pbr-rib.a').forEach(node => { node.style.transformOrigin = `${FINISH_X}px ${postTop}px`; });
        this.ribbon.querySelectorAll('.pbr-rib.b').forEach(node => { node.style.transformOrigin = `${FINISH_X}px ${postBottom}px`; });
        this._ribTop = postTop;
        this._ribBottom = postBottom;
        el('g', {}, svg).innerHTML = [postTop, postBottom].map(y => `
          <circle cx="${FINISH_X + 4}" cy="${y + 5}" r="11" fill="#000" opacity=".4"/>
          <circle cx="${FINISH_X}" cy="${y}" r="11" fill="#6b4a18" stroke="#2a1606" stroke-width="2"/>
          <circle cx="${FINISH_X - 3}" cy="${y - 3}" r="5" fill="#f0d27a" opacity=".85"/>`).join('');

        // 起跑闸横梁（影子先画，开闸时影子拉远）
        this.gateShadow = el('rect', { class: 'pbr-gate-shadow', x: GATE_X - 1, y: this.top - 8, width: 18, height: bottom - this.top + 16, rx: 5, fill: '#000', opacity: '.45' }, svg);
        this.gate = el('g', { class: 'pbr-gate' }, svg);
        this.gate.innerHTML = `
          <rect x="${GATE_X - 8}" y="${this.top - 14}" width="18" height="${bottom - this.top + 28}" rx="5" fill="url(#pbrb-wood)" stroke="#1c0e04" stroke-width="2.5"/>
          <rect x="${GATE_X - 8}" y="${this.top - 14}" width="18" height="${bottom - this.top + 28}" rx="5" fill="rgba(20,8,2,.35)"/>
          <line x1="${GATE_X - 4}" y1="${this.top - 10}" x2="${GATE_X - 4}" y2="${bottom + 10}" stroke="rgba(255,214,150,.2)" stroke-width="1.5"/>
          ${lanes.map((_, i) => `<circle cx="${GATE_X + 1}" cy="${this.laneY(i)}" r="4" fill="#caa23a" stroke="#3a2408" stroke-width="1.2"/>`).join('')}`;

        this.spot = el('ellipse', { class: 'pbr-spot', cx: 0, cy: 0, rx: 230, ry: Math.max(70, this.laneH * 1.1), fill: 'url(#pbrb-spot)' }, svg);
        this.fx = this.kit.createFx(svg);
        const actorLayer = el('g', { class: 'pbr-racers' }, svg);
        this.actors = lanes.map((lane, i) => {
            const actor = this.kit.createActor({ color: lane.color, pattern: lane.pattern, horn: lane.horn, number: i + 1 }, { fx: this.fx });
            actorLayer.appendChild(actor.el);
            actor.update({ x: START_X, y: this.laneY(i), scale: this.beetleScale, dt: 1 });
            return actor;
        });
        const bubbleLayer = el('g', { class: 'pbr-bubbles' }, svg);
        this.bubbles = lanes.map(() => this.kit.createBubble(bubbleLayer));

        this.slow = el('rect', { class: 'pbr-slowmo', x: 40, y: 50, width: 1636, height: 636, rx: 18, fill: 'url(#pbrb-slow)' }, svg);
        this.flash = el('rect', { class: 'pbr-flash', x: 40, y: 50, width: 1636, height: 636, rx: 18, fill: '#fff8e4' }, svg);
        this.countLayer = el('g', { class: 'pbr-countbox' }, svg);
        this.banner = el('g', { class: 'pbr-banner' }, svg);
        this.banner.innerHTML = `
          <rect x="518" y="302" width="680" height="132" rx="14" fill="#000" opacity=".45" transform="translate(6 8)"/>
          <rect x="518" y="302" width="680" height="132" rx="14" fill="url(#pbrb-wood)" stroke="#1c0e04" stroke-width="3"/>
          <rect x="518" y="302" width="680" height="132" rx="14" fill="rgba(24,11,3,.55)"/>
          <rect x="526" y="310" width="664" height="116" rx="10" fill="none" stroke="rgba(222,183,72,.55)" stroke-width="2"/>
          <text class="pbr-banner-title" x="858" y="376" text-anchor="middle" font-size="46" font-weight="700" letter-spacing="6" fill="#ffe7a0" stroke="rgba(0,0,0,.6)" stroke-width="1.5" paint-order="stroke"></text>
          <text class="pbr-banner-sub" x="858" y="410" text-anchor="middle" font-size="17" letter-spacing="4" fill="rgba(232,201,106,.8)"></text>`;
    }

    // ───────── 钱区 ─────────

    /** lanes = gameApi.getLanes()；coinFace(backer) → { initial, self } */
    setMoney(lanes, poolLabel = (amount) => String(amount)) {
        lanes.forEach((lane, i) => {
            const g = this.laneEls[i];
            if (!g) return;
            const odds = g.querySelector('.pbr-odds');
            if (odds.textContent !== lane.multiplierText) odds.textContent = lane.multiplierText;
            g.querySelector('.pbr-pool').textContent = lane.pool ? poolLabel(lane.pool) : '';
            const coins = g.querySelector('.pbr-coins');
            const key = lane.backers.map(b => `${b.id}:${b.amount}`).join('|');
            if (coins.dataset.key === key) return;
            const before = new Set((coins.dataset.key || '').split('|').map(part => part.split(':')[0]).filter(Boolean));
            coins.dataset.key = key;
            coins.replaceChildren();
            // 有人新押了这条道，赔率字闪一下
            if (lane.backers.some(b => !before.has(b.id)) && before.size + lane.backers.length > 0) {
                odds.classList.remove('bump');
                void odds.getBBox?.();
                odds.classList.add('bump');
            }
            lane.backers.slice(0, MAX_COINS).forEach((backer, k) => {
                const coin = el('g', { class: `pbr-coin${before.has(backer.id) ? '' : ' is-new'}`, transform: `translate(${k * 22} 0)` }, coins);
                el('circle', { cx: 1.5, cy: 2.5, r: 10.5, fill: 'rgba(0,0,0,.4)' }, coin);
                el('circle', { r: 10.5, fill: 'url(#pbrb-coin)', stroke: backer.isSelf ? '#fff6cf' : '#5a3a08', 'stroke-width': backer.isSelf ? 2.2 : 1.2 }, coin);
                el('text', { y: 4, 'text-anchor': 'middle', class: 'pbr-coin-text' }, coin).textContent = [...String(backer.name || '?').replace(/^🤖\s*/u, '')][0] || '?';
            });
            if (lane.backers.length > MAX_COINS) el('text', { x: MAX_COINS * 22, y: 4, class: 'pbr-coin-more' }, coins).textContent = `+${lane.backers.length - MAX_COINS}`;
        });
    }

    /** 结算后给钱区上色：赢家那道铜币发光，其余压暗 */
    markPayout(winnerLane) {
        this.laneEls.forEach((g, i) => {
            const coins = g.querySelector('.pbr-coins');
            coins.classList.toggle('won', i === winnerLane);
            coins.classList.toggle('lost', i !== winnerLane);
        });
    }

    // ───────── 倒数 / 开闸 / 横幅 ─────────

    showCount(text, go = false) {
        this.countLayer.replaceChildren();
        const g = el('g', { class: `pbr-count${go ? ' is-go' : ''}` }, this.countLayer);
        el('circle', { cx: W / 2 + 8, cy: H / 2 + 10, r: 104, fill: 'rgba(0,0,0,.45)' }, g);
        el('circle', { cx: W / 2, cy: H / 2, r: 104, fill: 'url(#pbrb-wood)', stroke: '#1c0e04', 'stroke-width': 4 }, g);
        el('circle', { cx: W / 2, cy: H / 2, r: 104, fill: 'rgba(24,11,3,.5)' }, g);
        el('circle', { cx: W / 2, cy: H / 2, r: 90, fill: 'none', stroke: 'rgba(222,183,72,.6)', 'stroke-width': 3 }, g);
        el('text', { x: W / 2, y: H / 2 + (go ? 22 : 38), 'text-anchor': 'middle', class: 'pbr-count-text', 'font-size': go ? 66 : 110 }, g).textContent = text;
    }

    clearCount() {
        this.countLayer.replaceChildren();
    }

    openGate(open = true) {
        this.gate.classList.toggle('open', !!open);
        this.gateShadow.classList.toggle('open', !!open);
    }

    showBanner(title = '', sub = '') {
        this.banner.querySelector('.pbr-banner-title').textContent = title;
        this.banner.querySelector('.pbr-banner-sub').textContent = sub;
        this.banner.classList.toggle('show', !!title);
    }

    // ───────── 每帧 ─────────

    /**
     * @param {object|null} frame gameApi.getRaceFrame() 的结果；开跑前传 null（都站在闸后）
     * @param {number} dt
     */
    update(frame, dt = 0.016) {
        const racing = !!frame;
        const lanes = frame?.lanes || this.actors.map((_, index) => ({ index, x: 0, v: 0, action: null, done: false }));
        let leader = -1;
        let leadRank = -1;
        for (const lane of lanes) {
            const i = lane.index;
            const actor = this.actors[i];
            if (!actor) continue;
            const x = this.toBoardX(lane.x);
            const y = this.laneY(i);
            const action = lane.action;
            actor.update({
                x, y,
                scale: this.beetleScale,
                speed: lane.v * 1.1,
                actionId: action?.actionId || '',
                elapsed: action?.elapsed || 0,
                duration: action?.duration || 0,
                dt
            });
            // 撞过线的永远排在还在跑的前面，先撞线的更前
            const rank = lane.done ? 1e6 - (lane.finishStep || 0) : lane.x;
            if (racing && rank > leadRank) { leadRank = rank; leader = i; }

            // 气泡跟着甲虫，开演头两秒挂着
            const text = action?.bubble || '';
            const show = !!text && action.elapsed < Math.max(1.8, Math.min(2.6, action.duration + 0.4));
            if (text !== this._bubbleText[i]) {
                this.bubbles[i].setText(text);
                this._bubbleText[i] = text;
            }
            this.bubbles[i].place(x + 8, y - 42 * this.beetleScale, 0.95);
            this.bubbles[i].show(show);
        }

        if (leader !== this._lastLeader) {
            this.actors.forEach((actor, i) => actor.setLead(i === leader));
            this._lastLeader = leader;
        }
        if (leader >= 0) {
            this.spot.setAttribute('cx', this.toBoardX(lanes[leader].x).toFixed(1));
            this.spot.setAttribute('cy', this.laneY(leader).toFixed(1));
        }
        this.spot.classList.toggle('on', racing && leader >= 0);
        this.root.classList.toggle('slow', racing && frame.timeScale < 0.95);

        const now = performance.now();
        if (racing && now - this._lastLiveAt > LIVE_EVERY_MS) {
            this._lastLiveAt = now;
            const ranked = [...lanes].sort((a, b) => {
                if (a.done && b.done) return a.finishStep - b.finishStep;
                if (a.done !== b.done) return a.done ? -1 : 1;
                return b.x - a.x;
            });
            ranked.forEach((lane, k) => {
                const live = this.laneEls[lane.index]?.querySelector('.pbr-live');
                if (!live) return;
                live.textContent = lane.done ? '' : this.placeLabel(k + 1);
                live.classList.toggle('first', k === 0);
            });
        }
        for (const [place, laneIndex] of (frame?.order || []).entries()) {
            if (this._finished.has(laneIndex)) continue;
            this._finished.add(laneIndex);
            this._onFinish(laneIndex, place + 1);
        }
    }

    _onFinish(laneIndex, place) {
        const g = this.laneEls[laneIndex];
        if (!g) return;
        g.querySelector('.pbr-live').textContent = '';
        const seal = g.querySelector('.pbr-seal');
        seal.querySelector('.pbr-seal-text').textContent = this.placeLabel(place);
        seal.querySelector('.pbr-seal-disc').setAttribute('fill', place === 1 ? 'url(#pbrb-waxgold)' : 'url(#pbrb-wax)');
        seal.classList.add('show');
        if (place === 1) {
            const y = this.laneY(laneIndex);
            // 上半截在冠军那条道断开，下半截从那里接着往下
            this.ribbon.querySelectorAll('.pbr-rib.a').forEach(node => node.setAttribute('y2', y));
            this.ribbon.querySelectorAll('.pbr-rib.b').forEach(node => node.setAttribute('y1', y));
            // 断开后两截都收成差不多长的一小段甩在柱子边；按比例缩的话冠军在边道时另一截太长，会斜着扫过好几条道
            this.ribbon.style.setProperty('--rib-a', Math.min(1, 70 / Math.max(1, y - this._ribTop)).toFixed(3));
            this.ribbon.style.setProperty('--rib-b', Math.min(1, 70 / Math.max(1, this._ribBottom - y)).toFixed(3));
            this.ribbon.classList.add('broken');
            g.querySelector('.pbr-lanewin').classList.add('on');
            this.flash.classList.remove('go');
            void this.flash.getBBox?.();
            this.flash.classList.add('go');
        } else if (place > 3) {
            this.actors[laneIndex]?.setOut(true);
        }
    }

    // ───────── 命中 / 定位 ─────────

    laneAtPoint(clientX, clientY) {
        const rect = this.root.getBoundingClientRect();
        if (!rect.width) return -1;
        // viewBox 按 meet 缩放：算出真正的缩放比和留白
        const scale = Math.min(rect.width / W, rect.height / H);
        const offX = (rect.width - W * scale) / 2;
        const offY = (rect.height - H * scale) / 2;
        const x = (clientX - rect.left - offX) / scale;
        const y = (clientY - rect.top - offY) / scale;
        if (x < 40 || x > W - 40) return -1;
        const lane = Math.floor((y - this.top) / this.laneH);
        return lane >= 0 && lane < this.count ? lane : -1;
    }

    beetleScreenPoint(laneIndex) {
        const node = this.actors[laneIndex]?.el;
        const rect = node?.getBoundingClientRect?.();
        return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    }

    destroy() {
        this.fx?.clear?.();
        this.root.remove();
    }
}
