/**
 * 甲虫赛跑 · 登场台（巡游）与挑选台（下注）
 *
 * 同一块舞台两种用法：
 * - parade：全桌同步。主机报第几只、这一只登场了多久，舞台就把那一只从左边请上来，演它的入场动作，挂口头禅
 * - carousel：各看各的。当前这只在灯下放大，左右两只压暗缩小，左右翻；点两边的也能翻过去
 *
 * 文字（名字、介绍、战力、倍率）不画在 SVG 里，交给桌面在舞台下方用 HTML 排：换行、字体、英文长度都好处理。
 */

import { ACTIONS, IDLE_ACTION_IDS } from './BeetleRaceCatalog.js';
import { BeetleRaceCurtain } from './BeetleRaceOpening.js';
import { BeetleActor, FxLayer, createBubble } from './BeetleRaceRender.js';
import { PARADE_STEP_MS, PARADE_INTRO_MS, paradeActionFor } from './BeetleRaceRules.js';

const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1600;
const HEIGHT = 520;
const CX = WIDTH / 2;
const FLOOR_Y = 330;
const SLOT_GAP = 470;
const WALK_IN_MS = 900;
const ACTION_AT_MS = 1100;

function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export class BeetleRaceStage {
    constructor(host, race, { onPick = null } = {}) {
        this.race = race;
        this.onPick = onPick;
        this.root = el('svg', { class: 'parlor-br-stage', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'xMidYMid meet' });
        host.appendChild(this.root);
        this.mode = 'parade';
        this.pick = 0;
        this._shown = 0;                 // 挑选台当前画到的位置（带小数，翻页时往 pick 靠）
        this._paradeIndex = -1;
        this._paradeStartedAt = 0;
        this._idle = race.lanes.map(() => ({ actionId: '', startedAt: 0, nextAt: performance.now() + 1500 + Math.random() * 2500 }));
        this._build();
        this.curtain = new BeetleRaceCurtain(host, race.name);
    }

    _build() {
        const defs = el('defs', {}, this.root);
        defs.innerHTML = `
          <linearGradient id="pbrs-cone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(255,240,196,.55)"/><stop offset=".7" stop-color="rgba(255,232,170,.14)"/><stop offset="1" stop-color="rgba(255,232,170,0)"/>
          </linearGradient>
          <radialGradient id="pbrs-pool" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="rgba(255,238,190,.5)"/><stop offset=".55" stop-color="rgba(255,228,160,.16)"/><stop offset="1" stop-color="rgba(255,228,160,0)"/>
          </radialGradient>`;
        // 压暗交给 CSS 铺满整块毡面（.parlor-br-stage-host::before），SVG 只有 520 高，在这里画会留出一条硬边
        // 聚光灯：顶上一道光锥 + 地上一个光斑，挑选台左右两只各有一个淡的
        this.cones = [-1, 0, 1].map(slot => {
            const g = el('g', { class: `parlor-br-stage-light${slot === 0 ? ' is-main' : ''}` }, this.root);
            el('path', { d: '', fill: 'url(#pbrs-cone)', class: 'parlor-br-stage-cone' }, g);
            el('ellipse', { rx: 190, ry: 58, fill: 'url(#pbrs-pool)' }, g);
            return g;
        });
        this.fx = new FxLayer(this.root);
        this.actors = this.race.lanes.map((lane, i) => {
            const actor = new BeetleActor({ color: lane.color, pattern: lane.pattern, horn: lane.horn, number: i + 1 }, { fx: this.fx });
            actor.el.classList.add('parlor-br-stage-beetle');
            actor.el.dataset.lane = String(i);
            this.root.appendChild(actor.el);
            return actor;
        });
        this.bubble = createBubble(this.root);
        this._bubbleLane = -1;

        this.root.addEventListener('click', (event) => {
            if (this.mode !== 'carousel') return;
            const lane = event.target.closest?.('[data-lane]')?.dataset.lane;
            if (lane != null && Number(lane) !== this.pick) this.setPick(Number(lane));
        });
    }

    _placeLight(g, x, strength) {
        g.setAttribute('transform', `translate(${x.toFixed(1)} 0)`);
        // 光锥从毡面顶上打下来：起点画到 SVG 上沿以外，毡面 overflow:hidden 会把多出来的切掉
        g.querySelector('path').setAttribute('d', `M-40 -420 L40 -420 L200 ${FLOOR_Y + 40} L-200 ${FLOOR_Y + 40} Z`);
        g.querySelector('ellipse').setAttribute('cy', FLOOR_Y + 28);
        g.style.opacity = strength.toFixed(3);
    }

    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        this.fx.clear();
        this.root.classList.toggle('is-carousel', mode === 'carousel');
        if (mode === 'carousel') this._shown = this.pick;
    }

    setPick(index, { notify = true } = {}) {
        const n = this.race.lanes.length;
        const next = ((Math.round(index) % n) + n) % n;
        if (next === this.pick) return;
        // 从最后一只翻到第一只时 _shown 也跟着绕一圈，别整排倒着滑回去
        const delta = next - this.pick;
        if (Math.abs(delta) > n / 2) this._shown += delta > 0 ? n : -n;
        this.pick = next;
        if (notify) this.onPick?.(next);
    }

    step(direction) {
        this.setPick(this.pick + direction);
    }

    setOpening(progress) {
        this.curtain.setOpening(progress);
    }

    /**
     * @param {object} frame
     * @param {number} frame.paradeIndex     巡游：当前第几只
     * @param {number} frame.paradeElapsedMs 巡游：从巡游开始到现在
     * @param {number} frame.dt
     */
    update({ paradeIndex = 0, paradeElapsedMs = 0, dt = 0.016 } = {}) {
        if (this.mode === 'parade') this._updateParade(paradeIndex, paradeElapsedMs, dt);
        else this._updateCarousel(dt);
    }

    _updateParade(index, elapsedMs, dt) {
        // 这一只登场了多久：以主机报的阶段时间为准，换人时从零开始。
        // 开幕那一段（主机时钟前 PARADE_INTRO_MS）台上还没人，只把灯慢慢推亮
        const opening = elapsedMs < PARADE_INTRO_MS;
        const local = Math.max(0, elapsedMs - PARADE_INTRO_MS - index * PARADE_STEP_MS);
        if (index !== this._paradeIndex) {
            this._paradeIndex = index;
            this.fx.clear();
        }
        this._placeLight(this.cones[1], CX, opening ? Math.max(0, elapsedMs / PARADE_INTRO_MS) : 1);
        this._placeLight(this.cones[0], CX - SLOT_GAP, 0);
        this._placeLight(this.cones[2], CX + SLOT_GAP, 0);

        this.actors.forEach((actor, i) => {
            if (i !== index || opening) {
                actor.el.style.display = 'none';
                return;
            }
            actor.el.style.display = '';
            const lane = this.race.lanes[i];
            const walk = Math.min(1, local / WALK_IN_MS);
            const x = -180 + (CX + 180) * easeInOut(walk);
            const actionId = paradeActionFor(lane);
            const actionMs = local - ACTION_AT_MS;
            const d0 = ACTIONS[actionId]?.sim.dur || 1;
            const acting = actionMs >= 0 && actionMs < d0 * 1000;
            actor.update({
                x, y: FLOOR_Y,
                scale: 2.1,
                speed: walk < 1 ? 160 : 0,
                actionId: acting ? actionId : '',
                elapsed: acting ? actionMs / 1000 : 0,
                duration: d0,
                dt
            });
            // 入场动作演完之后挂口头禅
            const phraseOn = lane.catchphrase && actionMs > d0 * 1000 * 0.6 && local < PARADE_STEP_MS - 300;
            if (this._bubbleLane !== i) {
                this.bubble.setText(lane.catchphrase || '');
                this._bubbleLane = i;
            }
            this.bubble.place(x + 20, FLOOR_Y - 110, 1.5);
            this.bubble.show(!!phraseOn);
        });
    }

    _updateCarousel(dt) {
        const n = this.race.lanes.length;
        this._shown += (this.pick - this._shown) * Math.min(1, dt * 9);
        if (Math.abs(this.pick - this._shown) < 0.001) this._shown = this.pick;
        const now = performance.now();
        this.bubble.show(false);

        this._placeLight(this.cones[1], CX, 1);
        this._placeLight(this.cones[0], CX - SLOT_GAP, n > 1 ? 0.35 : 0);
        this._placeLight(this.cones[2], CX + SLOT_GAP, n > 1 ? 0.35 : 0);

        this.actors.forEach((actor, i) => {
            // 离当前这只差几格（绕圈取最近的一边）
            let slot = i - this._shown;
            slot -= Math.round(slot / n) * n;
            const far = Math.abs(slot);
            if (far > 1.6) {
                actor.el.style.display = 'none';
                return;
            }
            actor.el.style.display = '';
            const x = CX + slot * SLOT_GAP;
            const scale = 2.2 - Math.min(1, far) * 0.95;
            actor.el.classList.toggle('is-dim', far > 0.5);

            // 灯下那只隔一会儿自己来一段表演，边上两只偶尔也动一动
            const idle = this._idle[i];
            if (!idle.actionId && now >= idle.nextAt) {
                idle.actionId = IDLE_ACTION_IDS[Math.floor(Math.random() * IDLE_ACTION_IDS.length)];
                idle.startedAt = now;
            }
            let actionId = '';
            let elapsed = 0;
            if (idle.actionId) {
                const d0 = ACTIONS[idle.actionId].sim.dur;
                elapsed = (now - idle.startedAt) / 1000;
                if (elapsed >= d0) {
                    idle.actionId = '';
                    idle.nextAt = now + (far < 0.5 ? 2600 : 5200) + Math.random() * 2400;
                } else {
                    actionId = idle.actionId;
                }
            }
            actor.update({ x, y: FLOOR_Y, scale, speed: 0, actionId, elapsed, duration: 0, dt });
        });
    }

    destroy() {
        this.curtain.destroy();
        this.root.remove();
    }
}
