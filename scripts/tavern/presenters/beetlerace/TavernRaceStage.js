/**
 * 酒馆甲虫赛跑 · 登场台（巡游）与挑选台（下注）
 *
 * 台上的东西：光锥、一只黄铜包边的圆木台、甲虫、口头禅气泡。戏院本身（后墙、地板、帷幕、垂幔、大幕）
 * 归 TavernTheatre，全屏铺；这里是放进剧场内容盒子里的 1716×736 画布。
 * - parade：全桌同步。主机报第几只、登场了多久，这一只从左边走上台、演入场动作、挂口头禅
 * - carousel：各看各的。当前这只站在圆台上放大打光，左右两只压暗缩小；点两边的也能翻过去
 * 名字、介绍、赔率这些字交给呈现器在戏台下方用 HTML 排（换行和英文长度都好处理），SVG 里不画字。
 * 节奏（开幕多久、每只登场多久）跟本体一致，从 gameApi.beetles 拿。
 */

const NS = 'http://www.w3.org/2000/svg';
const W = 1716;
const H = 736;
const CX = W / 2;
// 地面定在垫面一半略低：下方要留给名牌木匾，再低脚和圆台就被名牌盖住了
const FLOOR_Y = 368;
const SLOT_GAP = 470;
const WALK_IN_MS = 900;
const ACTION_AT_MS = 1100;
const MAIN_SCALE = 2.05;
const SIDE_SCALE = 1.15;
const IDLE_ACTIONS = ['bow', 'taunt', 'hop'];

function el(tag, attrs = {}, parent = null) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (parent) parent.appendChild(node);
    return node;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

export class TavernRaceStage {
    /**
     * @param {HTMLElement} host
     * @param {object[]} lanes  gameApi.getLanes() 的名牌（要 color/pattern/horn/catchphrase/paradeActionId）
     * @param {object} opts     { kit: gameApi.beetles, woodHref, onPick(index) }
     */
    constructor(host, lanes, { kit, woodHref = '', onPick = null } = {}) {
        this.kit = kit;
        this.lanes = lanes;
        this.onPick = onPick;
        this.mode = 'parade';
        this.pick = 0;
        this._shown = 0;
        this._paradeIndex = -1;
        this._bubbleLane = -1;
        this._idle = lanes.map(() => ({ actionId: '', startedAt: 0, nextAt: performance.now() + 1500 + Math.random() * 2500 }));
        this.root = el('svg', { class: 'pbr-stage', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
        host.appendChild(this.root);
        this._build(woodHref);
    }

    _build(woodHref) {
        const svg = this.root;
        el('defs', {}, svg).innerHTML = `
          <pattern id="pbrs-wood" patternUnits="userSpaceOnUse" width="360" height="360" patternTransform="rotate(90)">
            <image href="${woodHref}" width="360" height="360" preserveAspectRatio="xMidYMid slice"/>
          </pattern>
          <linearGradient id="pbrs-cone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(255,226,160,.5)"/><stop offset=".72" stop-color="rgba(255,214,140,.12)"/><stop offset="1" stop-color="rgba(255,214,140,0)"/>
          </linearGradient>
          <radialGradient id="pbrs-pool" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="rgba(255,222,160,.46)"/><stop offset=".55" stop-color="rgba(255,206,130,.14)"/><stop offset="1" stop-color="rgba(255,206,130,0)"/>
          </radialGradient>
          <linearGradient id="pbrs-brass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#f0d27a"/><stop offset=".5" stop-color="#a87f22"/><stop offset="1" stop-color="#5a3a0c"/>
          </linearGradient>`;

        // 光锥：顶上打下来，挑选台两边各一盏淡的
        this.cones = [-1, 0, 1].map(slot => {
            const g = el('g', { class: `pbrs-light${slot === 0 ? ' main' : ''}` }, svg);
            el('path', { d: `M-46 50 L46 50 L230 ${FLOOR_Y + 48} L-230 ${FLOOR_Y + 48} Z`, fill: 'url(#pbrs-cone)' }, g);
            el('ellipse', { cx: 0, cy: FLOOR_Y + 36, rx: 230, ry: 58, fill: 'url(#pbrs-pool)' }, g);
            return g;
        });

        // 圆木台：黄铜包边，主角站在上面
        el('g', { class: 'pbrs-pedestal' }, svg).innerHTML = `
          <ellipse cx="${CX + 6}" cy="${FLOOR_Y + 52}" rx="236" ry="56" fill="#000" opacity=".4"/>
          <ellipse cx="${CX}" cy="${FLOOR_Y + 44}" rx="232" ry="54" fill="url(#pbrs-brass)"/>
          <ellipse cx="${CX}" cy="${FLOOR_Y + 36}" rx="224" ry="48" fill="url(#pbrs-wood)"/>
          <ellipse cx="${CX}" cy="${FLOOR_Y + 36}" rx="224" ry="48" fill="rgba(40,18,4,.35)"/>
          <ellipse cx="${CX}" cy="${FLOOR_Y + 36}" rx="206" ry="41" fill="none" stroke="rgba(255,214,150,.18)" stroke-width="2"/>`;

        this.fx = this.kit.createFx(svg);
        this.actors = this.lanes.map((lane, i) => {
            const actor = this.kit.createActor({ color: lane.color, pattern: lane.pattern, horn: lane.horn, number: i + 1 }, { fx: this.fx });
            actor.el.classList.add('pbrs-beetle');
            actor.el.dataset.lane = String(i);
            svg.appendChild(actor.el);
            return actor;
        });
        this.bubble = this.kit.createBubble(svg);

        this.root.addEventListener('click', (event) => {
            if (this.mode !== 'carousel') return;
            const lane = event.target.closest?.('[data-lane]')?.dataset.lane;
            if (lane != null && Number(lane) !== this.pick) this.setPick(Number(lane));
        });
    }

    _placeLight(g, x, strength) {
        g.setAttribute('transform', `translate(${x.toFixed(1)} 0)`);
        g.style.opacity = strength.toFixed(3);
    }

    setMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        this.fx.clear?.();
        this.root.classList.toggle('is-carousel', mode === 'carousel');
        if (mode === 'carousel') this._shown = this.pick;
    }

    setPick(index, { notify = true } = {}) {
        const n = this.lanes.length;
        const next = ((Math.round(index) % n) + n) % n;
        if (next === this.pick) return;
        // 从最后一只翻到第一只时显示位置也跟着绕一圈，别整排倒着滑回去
        const delta = next - this.pick;
        if (Math.abs(delta) > n / 2) this._shown += delta > 0 ? n : -n;
        this.pick = next;
        if (notify) this.onPick?.(next);
    }

    step(direction) {
        this.setPick(this.pick + direction);
    }

    update({ paradeIndex = 0, paradeElapsedMs = 0, dt = 0.016 } = {}) {
        if (this.mode === 'parade') this._updateParade(paradeIndex, paradeElapsedMs, dt);
        else this._updateCarousel(dt);
    }

    _updateParade(index, elapsedMs, dt) {
        const stepMs = this.kit.paradeStepMs || 4200;
        const introMs = this.kit.paradeIntroMs || 0;
        // 开幕那一段台上还没人：大幕和追光归剧场，这里只让主灯在后半段推亮，接住落下来的追光
        const opening = elapsedMs < introMs;
        const local = Math.max(0, elapsedMs - introMs - index * stepMs);
        if (index !== this._paradeIndex) {
            this._paradeIndex = index;
            this.fx.clear?.();
        }
        const lamp = opening ? Math.max(0, Math.min(1, (elapsedMs / introMs - 0.6) / 0.35)) : 1;
        this._placeLight(this.cones[1], CX, lamp);
        this._placeLight(this.cones[0], CX - SLOT_GAP, 0);
        this._placeLight(this.cones[2], CX + SLOT_GAP, 0);

        this.actors.forEach((actor, i) => {
            if (i !== index || opening) {
                actor.el.style.display = 'none';
                return;
            }
            actor.el.style.display = '';
            actor.el.classList.remove('is-dim');
            const lane = this.lanes[i];
            const walk = Math.min(1, local / WALK_IN_MS);
            const x = 60 + (CX - 60) * easeInOut(walk);
            const actionId = lane.paradeActionId || 'bow';
            const actionMs = local - ACTION_AT_MS;
            const d0 = this.kit.actionDuration?.(actionId) || 1;
            const acting = actionMs >= 0 && actionMs < d0 * 1000;
            actor.update({
                x, y: FLOOR_Y,
                scale: MAIN_SCALE,
                speed: walk < 1 ? 160 : 0,
                actionId: acting ? actionId : '',
                elapsed: acting ? actionMs / 1000 : 0,
                duration: d0,
                dt
            });
            // 入场动作演完大半再挂口头禅，换下一只之前收掉
            const phraseOn = !!lane.catchphrase && actionMs > d0 * 1000 * 0.6 && local < stepMs - 300;
            if (this._bubbleLane !== i) {
                this.bubble.setText(lane.catchphrase || '');
                this._bubbleLane = i;
            }
            this.bubble.place(x + 20, FLOOR_Y - 112, 1.5);
            this.bubble.show(phraseOn);
        });
    }

    _updateCarousel(dt) {
        const n = this.lanes.length;
        this._shown += (this.pick - this._shown) * Math.min(1, dt * 9);
        if (Math.abs(this.pick - this._shown) < 0.001) this._shown = this.pick;
        const now = performance.now();
        this.bubble.show(false);

        this._placeLight(this.cones[1], CX, 1);
        this._placeLight(this.cones[0], CX - SLOT_GAP, n > 1 ? 0.3 : 0);
        this._placeLight(this.cones[2], CX + SLOT_GAP, n > 1 ? 0.3 : 0);

        this.actors.forEach((actor, i) => {
            // 离当前这只差几格（绕圈取近的那边）
            let slot = i - this._shown;
            slot -= Math.round(slot / n) * n;
            const far = Math.abs(slot);
            if (far > 1.6) {
                actor.el.style.display = 'none';
                return;
            }
            actor.el.style.display = '';
            const x = CX + slot * SLOT_GAP;
            const scale = MAIN_SCALE - Math.min(1, far) * (MAIN_SCALE - SIDE_SCALE);
            // 边上两只站得靠后一点，像在后台候场
            const y = FLOOR_Y - Math.min(1, far) * 30;
            actor.el.classList.toggle('is-dim', far > 0.5);

            // 灯下那只隔一会儿自己来一段，边上两只偶尔也动动
            const idle = this._idle[i];
            if (!idle.actionId && now >= idle.nextAt) {
                const actions = this.kit.idleActionIds || IDLE_ACTIONS;
                idle.actionId = actions[Math.floor(Math.random() * actions.length)];
                idle.startedAt = now;
            }
            let actionId = '';
            let elapsed = 0;
            if (idle.actionId) {
                const d0 = this.kit.actionDuration?.(idle.actionId) || 1;
                elapsed = (now - idle.startedAt) / 1000;
                if (elapsed >= d0) {
                    idle.actionId = '';
                    idle.nextAt = now + (far < 0.5 ? 2600 : 5200) + Math.random() * 2400;
                } else {
                    actionId = idle.actionId;
                }
            }
            actor.update({ x, y, scale, speed: 0, actionId, elapsed, duration: 0, dt });
        });
    }

    destroy() {
        this.fx?.clear?.();
        this.root.remove();
    }
}
