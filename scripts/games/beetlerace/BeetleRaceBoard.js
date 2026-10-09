/**
 * 甲虫赛跑 · 赛道板（经典皮）
 *
 * 一块 SVG：左端道次徽章 + 实时名次，中间槽道，终点彩带，右端钱区（倍率、本道押了谁）。
 * 甲虫、特效、气泡都挂在这块板上；每帧由桌面拿本地模拟的快照调 update() 摆一遍。
 *
 * 坐标：viewBox 宽 1600，每条道高 LANE_H。模拟坐标 0..TRACK_LENGTH 映射到 起跑线..终点线。
 * 板子只画"现在是什么样"，比赛进行到哪一步、谁作弊了，都是模拟说了算，这里不做判断。
 */

import { TRACK_LENGTH } from './BeetleRaceCatalog.js';
import { BeetleActor, FxLayer, createBubble, deriveShades } from './BeetleRaceRender.js';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1600;
const LANE_H = 104;
const TOP = 46;
const BOTTOM = 34;
const MEDAL_X = 62;
const LIVE_X = 118;
const GATE_X = 196;
const START_X = 250;          // 甲虫中心的起跑位置
const FINISH_X = 1352;
const TROUGH_END = 1420;
const MONEY_X = 1436;

function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
}

// 甲虫中心相对鼻尖的偏移（本地单位 × 缩放），让"撞线"那一刻鼻尖正好压线
const NOSE = 50;

export class BeetleRaceBoard {
    /**
     * @param {HTMLElement} host  挂载的容器
     * @param {object} race       开局快照
     * @param {object} opts       { t, placeLabel(n) }  名次标签由桌面按语言给（壹贰叁 / 1st 2nd）
     */
    constructor(host, race, { t = (k) => k, placeLabel = (n) => String(n) } = {}) {
        this.race = race;
        this.t = t;
        this.placeLabel = placeLabel;
        this.lanes = race.lanes.length;
        this.height = TOP + this.lanes * LANE_H + BOTTOM;
        // 道多了甲虫缩小一点，别挤到隔壁道
        this.beetleScale = this.lanes >= 7 ? 0.92 : 1.05;
        this.root = el('svg', { class: 'parlor-br-board', viewBox: `0 0 ${WIDTH} ${this.height}`, preserveAspectRatio: 'xMidYMid meet' });
        host.appendChild(this.root);
        this._build();
        this._lastLeader = -1;
        this._finishedShown = new Set();
        this._lastLiveAt = 0;
    }

    laneY(i) {
        return TOP + LANE_H * i + LANE_H / 2;
    }

    toBoardX(x) {
        return START_X + (x / TRACK_LENGTH) * (FINISH_X - NOSE * this.beetleScale - START_X);
    }

    _build() {
        const defs = el('defs', {}, this.root);
        defs.innerHTML = `
          <linearGradient id="pbrb-trough" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(0,0,0,.42)"/><stop offset=".18" stop-color="rgba(0,0,0,.14)"/>
            <stop offset=".82" stop-color="rgba(0,0,0,.1)"/><stop offset="1" stop-color="rgba(0,0,0,.34)"/>
          </linearGradient>
          <radialGradient id="pbrb-spot" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="rgba(255,236,170,.22)"/><stop offset=".6" stop-color="rgba(255,226,150,.06)"/><stop offset="1" stop-color="rgba(255,226,150,0)"/>
          </radialGradient>
          <radialGradient id="pbrb-slow" cx="50%" cy="50%" r="72%">
            <stop offset=".45" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,.55)"/>
          </radialGradient>
          <radialGradient id="pbrb-coin" cx="35%" cy="30%" r="75%">
            <stop offset="0" stop-color="#fff1b0"/><stop offset=".45" stop-color="#dcae3c"/><stop offset="1" stop-color="#7a4d0c"/>
          </radialGradient>
          <radialGradient id="pbrb-seal-gold" cx="38%" cy="32%" r="72%">
            <stop offset="0" stop-color="#fff0a8"/><stop offset=".55" stop-color="#d4a232"/><stop offset="1" stop-color="#6e4608"/>
          </radialGradient>
          <radialGradient id="pbrb-seal" cx="38%" cy="32%" r="72%">
            <stop offset="0" stop-color="#6fae8e"/><stop offset=".6" stop-color="#2f6a4f"/><stop offset="1" stop-color="#143727"/>
          </radialGradient>`;

        const trackTop = TOP;
        const trackBottom = TOP + this.lanes * LANE_H;
        const ticks = el('g', { class: 'parlor-br-board-ticks' }, this.root);
        for (const q of [0.25, 0.5, 0.75]) {
            const x = this.toBoardX(TRACK_LENGTH * q) + NOSE * this.beetleScale;
            el('line', { x1: x, y1: trackTop - 4, x2: x, y2: trackBottom + 4, class: 'parlor-br-board-tick' }, ticks);
            el('text', { x, y: trackTop - 12, 'text-anchor': 'middle', class: 'parlor-br-board-ticklabel' }, ticks).textContent = ['¼', '½', '¾'][[0.25, 0.5, 0.75].indexOf(q)];
        }

        this.laneEls = this.race.lanes.map((lane, i) => {
            const y = TOP + LANE_H * i;
            const cy = this.laneY(i);
            const shades = deriveShades(lane.color);
            const g = el('g', { class: 'parlor-br-lane', 'data-lane': i }, this.root);
            g.innerHTML = `
              <rect class="parlor-br-lane-trough" x="${GATE_X - 6}" y="${y + 8}" width="${TROUGH_END - GATE_X + 6}" height="${LANE_H - 16}" rx="12"/>
              <rect x="${GATE_X - 6}" y="${y + 8}" width="${TROUGH_END - GATE_X + 6}" height="${LANE_H - 16}" rx="12" fill="url(#pbrb-trough)"/>
              <rect x="${GATE_X - 6}" y="${y + 8}" width="${TROUGH_END - GATE_X + 6}" height="${LANE_H - 16}" rx="12" fill="${lane.color}" opacity=".07"/>
              <rect class="parlor-br-lane-win" x="${GATE_X - 8}" y="${y + 6}" width="${TROUGH_END - GATE_X + 10}" height="${LANE_H - 12}" rx="13"/>
              <text class="parlor-br-lane-name" x="${GATE_X + 70}" y="${cy + 7}"></text>
              <circle cx="${MEDAL_X + 3}" cy="${cy + 3}" r="27" fill="rgba(0,0,0,.35)"/>
              <circle class="parlor-br-lane-medal" cx="${MEDAL_X}" cy="${cy}" r="27" fill="${lane.color}" stroke="${shades.dark}"/>
              <circle cx="${MEDAL_X}" cy="${cy}" r="21" fill="none" stroke="rgba(255,244,214,.35)" stroke-width="1.2"/>
              <text class="parlor-br-lane-num" x="${MEDAL_X}" y="${cy + 9}">${i + 1}</text>
              <g class="parlor-br-lane-seal">
                <circle cx="${MEDAL_X + 3}" cy="${cy + 4}" r="29" fill="rgba(0,0,0,.35)"/>
                <circle class="parlor-br-seal-disc" cx="${MEDAL_X}" cy="${cy}" r="29"/>
                <circle cx="${MEDAL_X}" cy="${cy}" r="22" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="2" stroke-dasharray="3 3"/>
                <text class="parlor-br-seal-text" x="${MEDAL_X}" y="${cy + 10}"></text>
              </g>
              <text class="parlor-br-lane-live" x="${LIVE_X}" y="${cy + 10}"></text>
              <line x1="${MONEY_X - 8}" y1="${y + 16}" x2="${MONEY_X - 8}" y2="${y + LANE_H - 16}" class="parlor-br-money-rule"/>
              <text class="parlor-br-lane-odds" x="${MONEY_X + 8}" y="${cy - 6}">×${Number(lane.multiplier).toFixed(1)}</text>
              <text class="parlor-br-lane-pool" x="${MONEY_X + 10}" y="${cy + 14}"></text>
              <g class="parlor-br-lane-coins" transform="translate(${MONEY_X + 20} ${cy + 32})"></g>`;
            g.querySelector('.parlor-br-lane-name').textContent = lane.name;
            return g;
        });

        // 终点：棋格粉笔带 + 两根柱子 + 彩带
        const finish = el('g', { class: 'parlor-br-finish' }, this.root);
        for (let yy = trackTop + 4, row = 0; yy < trackBottom - 4; yy += 12, row++) {
            el('rect', { x: FINISH_X - 12 + (row % 2) * 12, y: yy, width: 12, height: 12, class: 'parlor-br-finish-check' }, finish);
        }
        // 标签挪到柱子右边，别压在柱头上
        el('text', { x: FINISH_X + 18, y: trackTop - 6, 'text-anchor': 'start', class: 'parlor-br-board-ticklabel' }, finish).textContent = this.t('PARLOR.BeetleRace.Board.Finish');
        this.ribbon = el('g', { class: 'parlor-br-ribbon' }, this.root);
        this.ribbonA = el('line', { x1: FINISH_X, y1: trackTop - 10, x2: FINISH_X, y2: (trackTop + trackBottom) / 2, class: 'parlor-br-rib a' }, this.ribbon);
        this.ribbonB = el('line', { x1: FINISH_X, y1: (trackTop + trackBottom) / 2, x2: FINISH_X, y2: trackBottom + 10, class: 'parlor-br-rib b' }, this.ribbon);
        this.ribbonA.style.transformOrigin = `${FINISH_X}px ${trackTop - 10}px`;
        this.ribbonB.style.transformOrigin = `${FINISH_X}px ${trackBottom + 10}px`;
        for (const y of [trackTop - 10, trackBottom + 10]) {
            el('circle', { cx: FINISH_X + 4, cy: y + 5, r: 10, fill: 'rgba(0,0,0,.4)' }, this.root);
            el('circle', { cx: FINISH_X, cy: y, r: 10, class: 'parlor-br-post' }, this.root);
            el('circle', { cx: FINISH_X - 3, cy: y - 3, r: 4, fill: '#fff2c4', opacity: 0.8 }, this.root);
        }

        // 起跑闸：一根横梁，开跑时往上抬
        this.gate = el('g', { class: 'parlor-br-gate' }, this.root);
        el('rect', { x: GATE_X - 9, y: trackTop - 2, width: 16, height: trackBottom - trackTop + 4, rx: 5, class: 'parlor-br-gate-beam' }, this.gate);
        for (let i = 0; i < this.lanes; i++) el('circle', { cx: GATE_X - 1, cy: this.laneY(i), r: 4, class: 'parlor-br-gate-stud' }, this.gate);

        this.spot = el('ellipse', { rx: 240, ry: 110, fill: 'url(#pbrb-spot)', class: 'parlor-br-spot' }, this.root);
        this.fx = new FxLayer(this.root);
        this.actorLayer = el('g', {}, this.root);
        this.actors = this.race.lanes.map((lane, i) => {
            const actor = new BeetleActor({ color: lane.color, pattern: lane.pattern, horn: lane.horn, number: i + 1 }, { fx: this.fx });
            this.actorLayer.appendChild(actor.el);
            actor.update({ x: START_X, y: this.laneY(i), scale: this.beetleScale, dt: 1 });
            return actor;
        });
        this.bubbleLayer = el('g', {}, this.root);
        this.bubbles = this.race.lanes.map(() => createBubble(this.bubbleLayer));
        this._bubbleText = this.race.lanes.map(() => '');

        this.slow = el('rect', { x: 0, y: 0, width: WIDTH, height: this.height, fill: 'url(#pbrb-slow)', class: 'parlor-br-slowmo' }, this.root);
        this.flash = el('rect', { x: 0, y: 0, width: WIDTH, height: this.height, class: 'parlor-br-flash' }, this.root);
        this.countLayer = el('g', { class: 'parlor-br-countbox' }, this.root);
    }

    // ───────── 钱区 ─────────

    /** bets: [{ userId, lane, amount }]；people: id → { initial, self } */
    setBets(bets = [], people = () => ({ initial: '?', self: false })) {
        this.race.lanes.forEach((_, i) => {
            const onLane = bets.filter(bet => bet.lane === i);
            const pool = onLane.reduce((sum, bet) => sum + bet.amount, 0);
            const lane = this.laneEls[i];
            lane.querySelector('.parlor-br-lane-pool').textContent = pool ? this.t('PARLOR.BeetleRace.Board.Pool', { amount: pool }) : '';
            const coins = lane.querySelector('.parlor-br-lane-coins');
            const key = onLane.map(bet => bet.userId).join('|');
            if (coins.dataset.key === key) return;
            const before = new Set((coins.dataset.key || '').split('|').filter(Boolean));
            coins.dataset.key = key;
            coins.replaceChildren();
            onLane.slice(0, 6).forEach((bet, k) => {
                const who = people(bet.userId);
                const g = el('g', { class: `parlor-br-coin${before.has(bet.userId) ? '' : ' is-new'}`, transform: `translate(${k * 22} 0)` }, coins);
                el('circle', { cx: 1.5, cy: 2.5, r: 10.5, fill: 'rgba(0,0,0,.4)' }, g);
                el('circle', { r: 10.5, fill: 'url(#pbrb-coin)', stroke: who.self ? '#fff6cf' : '#5a3a08', 'stroke-width': who.self ? 2.2 : 1.2 }, g);
                el('text', { y: 4, 'text-anchor': 'middle', class: 'parlor-br-coin-text' }, g).textContent = who.initial;
            });
            if (onLane.length > 6) el('text', { x: 6 * 22, y: 4, class: 'parlor-br-coin-more' }, coins).textContent = `+${onLane.length - 6}`;
        });
    }

    // ───────── 倒数 / 开闸 ─────────

    showCount(text, go = false) {
        this.countLayer.replaceChildren();
        const cx = WIDTH / 2;
        const cy = this.height / 2;
        const g = el('g', { class: `parlor-br-count${go ? ' is-go' : ''}` }, this.countLayer);
        el('circle', { cx: cx + 8, cy: cy + 10, r: 96, fill: 'rgba(0,0,0,.4)' }, g);
        el('circle', { cx, cy, r: 96, class: 'parlor-br-count-ring' }, g);
        el('circle', { cx, cy, r: 80, class: 'parlor-br-count-face' }, g);
        el('text', { x: cx, y: cy + (go ? 30 : 42), class: 'parlor-br-count-text' }, g).textContent = text;
    }

    clearCount() {
        this.countLayer.replaceChildren();
    }

    openGate(open = true) {
        this.gate.classList.toggle('is-open', !!open);
    }

    // ───────── 每帧 ─────────

    /**
     * @param {object} frame
     * @param {object[]} frame.lanes     BeetleRaceSim.getLanes() 的快照；比赛前传 null（都站在起跑线）
     * @param {number}   frame.timeScale 模拟的时间流速（<1 = 慢镜）
     * @param {number[]} frame.order     已撞线的道次顺序
     * @param {number}   frame.dt        离上一帧的真实秒数
     * @param {boolean}  frame.racing
     */
    update({ lanes = null, timeScale = 1, order = [], dt = 0.016, racing = false } = {}) {
        const now = performance.now();
        let leader = -1;
        let leadX = -1;
        (lanes || this.race.lanes.map((_, index) => ({ index, x: 0, v: 0, action: null, done: false }))).forEach((lane) => {
            const i = lane.index;
            const x = this.toBoardX(lane.x);
            const y = this.laneY(i);
            const action = lane.action;
            this.actors[i].update({
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
            if (racing && rank > leadX) { leadX = rank; leader = i; }

            // 气泡跟着甲虫，开演头两秒挂着
            const text = action?.bubble || '';
            const showBubble = !!text && action.elapsed < Math.max(1.8, Math.min(2.6, action.duration + 0.4));
            if (text !== this._bubbleText[i]) {
                this.bubbles[i].setText(text);
                this._bubbleText[i] = text;
            }
            this.bubbles[i].place(x + 8, y - 42 * this.beetleScale, 0.95);
            this.bubbles[i].show(showBubble);
        });

        if (leader !== this._lastLeader) {
            this.actors.forEach((actor, i) => actor.setLead(i === leader));
            this._lastLeader = leader;
        }
        if (leader >= 0) {
            const lane = lanes[leader];
            this.spot.setAttribute('cx', this.toBoardX(lane.x).toFixed(1));
            this.spot.setAttribute('cy', this.laneY(leader));
        }
        this.spot.classList.toggle('is-on', racing && leader >= 0);
        this.root.classList.toggle('is-slow', racing && timeScale < 0.95);

        // 名次：比赛中每 0.25 秒刷一次左端的实时名次，撞线的盖火漆
        if (racing && lanes && now - this._lastLiveAt > 250) {
            this._lastLiveAt = now;
            const ranked = [...lanes].sort((a, b) => {
                if (a.done && b.done) return a.finishStep - b.finishStep;
                if (a.done !== b.done) return a.done ? -1 : 1;
                return b.x - a.x;
            });
            ranked.forEach((lane, k) => {
                const live = this.laneEls[lane.index].querySelector('.parlor-br-lane-live');
                live.textContent = lane.done ? '' : this.placeLabel(k + 1);
                live.classList.toggle('is-first', k === 0);
            });
        }
        for (const [place, laneIndex] of order.entries()) {
            if (this._finishedShown.has(laneIndex)) continue;
            this._finishedShown.add(laneIndex);
            this._onFinish(laneIndex, place + 1);
        }
    }

    _onFinish(laneIndex, place) {
        const lane = this.laneEls[laneIndex];
        lane.querySelector('.parlor-br-lane-live').textContent = '';
        const seal = lane.querySelector('.parlor-br-lane-seal');
        seal.querySelector('.parlor-br-seal-text').textContent = this.placeLabel(place);
        seal.classList.toggle('is-gold', place === 1);
        seal.classList.add('is-on');
        if (place === 1) {
            const y = this.laneY(laneIndex);
            this.ribbonA.setAttribute('y2', y);
            this.ribbonB.setAttribute('y1', y);
            // 断开后两截都收成差不多长的一小段甩在柱子边；按比例缩的话，冠军在第一道时下半截太长，会斜着扫过好几条道
            const top = Number(this.ribbonA.getAttribute('y1'));
            const bottom = Number(this.ribbonB.getAttribute('y2'));
            this.ribbonA.style.setProperty('--rib-scale', Math.min(1, 70 / Math.max(1, y - top)).toFixed(3));
            this.ribbonB.style.setProperty('--rib-scale', Math.min(1, 70 / Math.max(1, bottom - y)).toFixed(3));
            this.ribbon.classList.add('is-broken');
            lane.classList.add('is-winner');
            this.flash.classList.remove('is-go');
            void this.flash.getBBox();
            this.flash.classList.add('is-go');
        } else if (place > 3) {
            this.actors[laneIndex].setOut(true);
        }
    }

    /** 结算后给钱区上色：赢家那道筹码发光，其余压暗 */
    markPayout(winnerLane) {
        this.laneEls.forEach((lane, i) => {
            lane.querySelector('.parlor-br-lane-coins').classList.toggle('is-won', i === winnerLane);
            lane.querySelector('.parlor-br-lane-coins').classList.toggle('is-lost', i !== winnerLane);
        });
    }

    /** 屏幕坐标下某条道右端钱区的位置（飞金币用） */
    coinRect(laneIndex) {
        return this.laneEls[laneIndex]?.querySelector('.parlor-br-lane-coins')?.getBoundingClientRect() || null;
    }

    /** 屏幕坐标 → 离哪只甲虫最近（GM 点虫作弊用） */
    laneAtPoint(clientX, clientY) {
        const rect = this.root.getBoundingClientRect();
        if (!rect.width) return -1;
        const y = ((clientY - rect.top) / rect.height) * this.height;
        const i = Math.floor((y - TOP) / LANE_H);
        return i >= 0 && i < this.lanes ? i : -1;
    }

    beetleScreenPoint(laneIndex) {
        const actor = this.actors[laneIndex];
        const rect = actor?.el.getBoundingClientRect?.();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    }

    destroy() {
        this.root.remove();
    }
}
