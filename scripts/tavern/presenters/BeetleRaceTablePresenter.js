/**
 * BeetleRaceTablePresenter — 奇幻酒馆 · 甲虫赛跑桌
 *
 * 按阶段换场子：入场/下注时桌子整个撤掉，换一座铺满屏幕的小剧场（TavernTheatre 布景 + TavernRaceStage 台上），
 * 开幕拉大幕、亮追光；封盘之后剧场淡出，回到桌上的赛道板（TavernRaceBoard）。
 * 戏台下方挂名牌（名字、战力、战绩、赔率火漆、介绍、押它的人），下注时左右翻着挑。
 * HUD 中间是自己的注单，右边是注额 + 押注按钮；DM 的推进按钮也在右边，比赛中点甲虫开作弊木牌。
 *
 * 状态只在变化时推过来，比赛画面得自己开 rAF：每帧 gameApi.getRaceFrame(dt) 取位置，
 * 解说（出状况、换领跑、过半、撞线）也在帧循环里按模拟事件往链吊木牌上挂。
 * 甲虫画法借本体的（gameApi.beetles），这里不画甲虫。
 */

import { TavernTableShell, MODULE_ID } from './TavernTableShell.js';
import { TavernRaceBoard } from './beetlerace/TavernRaceBoard.js';
import { TavernRaceStage } from './beetlerace/TavernRaceStage.js';
import { TavernTheatre } from './beetlerace/TavernTheatre.js';

const PHASES = [
    { keys: ['IDLE', 'PARADE'], labelKey: 'PARLOR.BeetleRace.Phase.PARADE' },
    { keys: ['BETTING'], labelKey: 'PARLOR.BeetleRace.Phase.BETTING' },
    { keys: ['COUNTDOWN', 'RACING'], labelKey: 'PARLOR.BeetleRace.Phase.RACING' },
    { keys: ['RESOLVING'], labelKey: 'PARLOR.BeetleRace.Phase.RESOLVING' }
];
const STAGE_PHASES = new Set(['IDLE', 'PARADE', 'BETTING']);
const WOOD_HREF = `modules/${MODULE_ID}/assets/tavern/wood.jpg`;
const LEAD_CALL_GAP_MS = 1600;
const GO_SHOW_MS = 900;
const URGENT_MS = 5500;
// 直接进下注（第二场起没有巡游）时本地拉一遍大幕，不用等主机
const LOCAL_OPEN_MS = 2000;
// 解说语气 → 链吊木牌上现成的几种字样
const CATEGORY_TONE = { boost: 'raise', stall: 'fold', show: 'check' };
// 着色器预热：桌面 SVG 和摆件第一次上屏，GPU 要现编三十多个着色器（冷的时候一下卡 ~100 ms）。
// 剧场开着时桌子不画，这笔账就挪到了封盘切回桌子那一刻，正好压在倒数"3"上。
// 下注时台上最闲，趁那会儿让桌子隐形地画一小会儿，把编译提前做掉。编好的着色器存在 GPU 进程里，一个页面做一次就够
const WARM_AFTER_MS = 1500;
const WARM_HOLD_MS = 320;
let tableWarmed = false;

export class BeetleRaceTablePresenter extends TavernTableShell {
    constructor() {
        super();
        this._brState = null;
        this._br = null; // 垫面骨架（建一次）
        this._theatre = null;
        this._theatreObserver = null;
        this._openLocalAt = 0; // 本地拉幕的起点；0 = 跟主机时钟走（巡游）或者已经拉开
        this._stage = null;
        this._board = null;
        this._viewKey = '';
        this._phase = '';
        this._pick = 0;
        this._stake = 0;
        this._raf = 0;
        this._lastFrameAt = 0;
        this._countShown = 0;
        this._goAt = 0;
        this._timerText = '';
        this._plaqueKey = '';
        this._slipKey = '';
        this._resetCommentary();
        this._cheatLane = -1;
        this._cheatPanel = null;
        this._onKey = (event) => this._handleKey(event);
    }

    get gameNameKey() { return 'PARLOR.Games.BeetleRace.Name'; }
    get gameNameFallbackKey() { return 'PARLORTAVERN.Games.BeetleRace'; }
    get gameGlyph() { return '✦'; }
    get phases() { return PHASES; }

    phaseProgress(state) {
        const active = PHASES.findIndex(p => p.keys.includes(state.phase));
        return { active, done: active < 0 ? 0 : active };
    }

    mount(root, gameApi) {
        root.classList.add('pth-br');
        super.mount(root, gameApi);
        this._mountSoundToggle();
        document.addEventListener('keydown', this._onKey);
        this._startLoop();
    }

    destroy() {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        document.removeEventListener('keydown', this._onKey);
        clearTimeout(this._warmTimer);
        this._soundButton?.remove();
        this._soundButton = null;
        this._theatreObserver?.disconnect();
        this._theatreObserver = null;
        this._stage?.destroy();
        this._board?.destroy();
        this._theatre?.destroy();
        this._cheatPanel?.destroy();
        this._cheatPanel = null;
        this._br?.overlay?.remove();
        this._br?.cheat?.remove();
        this._stage = null;
        this._board = null;
        this._theatre = null;
        this._br = null;
        this._root?.classList.remove('pth-br', 'pbr-in-theatre', 'pbr-clean', 'pbr-warming');
        super.destroy();
    }

    refresh(state) {
        this._brState = state || this._api?.getState?.() || {};
        super.refresh(this._brState);
        this._syncCleanTable();
        this._syncSoundToggle();
        // 押过的道变了，灯下那只的按钮要从"押"改成"改注"；按钮本身不重建
        this._syncBetButton();
    }

    // 注单一直在（没牌也不算"只有按钮"）；右边没东西时让注单占满整行
    _syncHudLayout(hud) {
        const column = this._els.hudMid?.parentElement;
        if (!column) return;
        column.classList.remove('is-command-only', 'has-context-actions');
        column.classList.toggle('pbr-no-actions', !hud?.actions?.length);
    }

    // 赛跑没有"轮到谁"：下注阶段所有能押的人一起亮，DM 有推进按钮时也亮
    _syncHudTurn(hud) {
        this._els.hud?.classList.toggle('is-turn', !!hud && (!!hud.canBet || (hud.actions || []).some(action => action.kind === 'gm')));
    }

    // 甲虫赛跑的整套音效由本体按游戏进程放（谁下注都会"叮"），按钮这里再响就重了
    actionSoundKind() {
        return '';
    }

    tableStripStatus(state) {
        const total = (state.bets || []).reduce((sum, bet) => sum + Number(bet.amount || 0), 0);
        return [
            state.race?.name ? `<span class="ts-race">${this._esc(state.race.name)}</span>` : '',
            `<span class="ts-pot">${this._esc(this._t('PARLORTAVERN.BeetleRace.TotalPool', { amount: this._chips(total) }))}</span>`
        ];
    }

    // ── 垫面 ───────────────────────────────────────────────

    renderSurface(state) {
        const host = this._els.surface;
        if (!host || !state.race) return;
        if (!this._br || this._br.root.parentNode !== host) this._buildSurface(host);
        const lanes = this._api.getLanes?.() || [];
        this._ensureViews(state, lanes);
        if (state.phase !== this._phase) this._onPhaseChange(this._phase, state.phase, state);
        this._phase = state.phase;

        const stageMode = STAGE_PHASES.has(state.phase);
        this._br.root.dataset.mode = stageMode ? 'stage' : 'board';
        this._br.root.dataset.phase = state.phase;
        this._theatre.root.dataset.phase = state.phase;
        this._root.classList.toggle('pbr-in-theatre', stageMode);
        if (stageMode) {
            this._theatre.setTitle(state.race.name, [
                this._t('PARLOR.BeetleRace.Head.Round', { round: state.round || 1 }),
                this._t(`PARLOR.BeetleRace.Phase.${state.phase === 'BETTING' ? 'BETTING' : 'PARADE'}`)
            ].filter(Boolean).join(' · '));
            this._layoutTheatre();
        }
        this._stage.setMode(state.phase === 'PARADE' ? 'parade' : 'carousel');
        this._board.setMoney(lanes, (amount) => this._t('PARLOR.BeetleRace.Board.Pool', { amount: this._chips(amount) }));
        this._renderPlaque(state, lanes);
        this._renderDots(state, lanes);
        this._renderGmHint(state);
        if (state.phase !== 'RACING') this._closeCheat();
    }

    // 赛道留在垫面，DM 提示浮在桌面场景上；作弊木牌挂在舞台上层，拖出赛道也不能被 HUD 挡住。
    _buildSurface(host) {
        host.innerHTML = '';
        this._cheatPanel?.destroy();
        this._br?.overlay?.remove();
        this._br?.cheat?.remove();
        const root = document.createElement('div');
        root.className = 'pbr-root';
        root.innerHTML = '<div class="pbr-board-host" data-br="boardHost"></div>';
        host.appendChild(root);
        const overlay = document.createElement('div');
        overlay.className = 'pbr-overlay';
        overlay.innerHTML = `
            <div class="pbr-gm-hint" data-br="gmHint" hidden></div>
            <div class="pbr-cheat" data-br="cheat" hidden></div>
        `;
        host.parentElement.appendChild(overlay);
        this._buildTheatre();
        const box = this._theatre.content;
        box.innerHTML = `
            <div class="pbr-stage-host" data-br="stageHost"></div>
            <button type="button" class="pbr-nav prev" data-br="prev"><span aria-hidden="true">‹</span></button>
            <button type="button" class="pbr-nav next" data-br="next"><span aria-hidden="true">›</span></button>
            <div class="pbr-plaque" data-br="plaque"></div>
            <div class="pbr-dots" data-br="dots"></div>
            <div class="pbr-timer" data-br="timer"></div>
        `;
        const els = Object.fromEntries([root, overlay, box].flatMap(part => [...part.querySelectorAll('[data-br]')]).map(node => [node.dataset.br, node]));
        els.prev.setAttribute('aria-label', this._t('PARLOR.BeetleRace.Caption.Prev'));
        els.next.setAttribute('aria-label', this._t('PARLOR.BeetleRace.Caption.Next'));
        els.prev.addEventListener('click', () => this._stage?.step(-1));
        els.next.addEventListener('click', () => this._stage?.step(1));
        els.dots.addEventListener('click', (event) => {
            const dot = event.target.closest('[data-lane]');
            if (dot) this._stage?.setPick(Number(dot.dataset.lane));
        });
        els.boardHost.addEventListener('click', (event) => this._onBoardClick(event));
        els.cheat.addEventListener('click', (event) => this._onCheatClick(event));
        els.cheat.addEventListener('input', (event) => this._onCheatInput(event));
        const stage = this._root.querySelector('.stage');
        stage.appendChild(els.cheat);
        this._br = { root, overlay, ...els };
        this._cheatPanel = this._api.beetles.createCheatPanel?.(els.cheat, {
            // 初始位置仍避让赛道，拖动范围覆盖桌面；常显招式不能受垫面高度裁切。
            bounds: stage,
            anchor: overlay,
            handle: '.pbr-cheat-head'
        });
        this._viewKey = '';
        this._stage?.destroy();
        this._stage = null;
    }

    // 剧场垫在壳的 .stage 最底下：招牌、链吊播报牌、HUD 都还在它上面，播报牌正好挂在垂幔前
    _buildTheatre() {
        this._theatreObserver?.disconnect();
        this._theatre?.destroy();
        const stage = this._root.querySelector('.stage');
        this._theatre = new TavernTheatre(stage, { woodHref: WOOD_HREF, curtainMotion: this._api.beetles.curtainMotion });
        // 屏幕尺寸、HUD 高度（注单多一行就变高）变了都要重排；HUD 进场时是 transform 位移，量 offset 不量 rect
        this._theatreObserver = new ResizeObserver(() => this._layoutTheatre());
        for (const node of [this._root, this._els.hud, this._root.querySelector('.topbar')]) {
            if (node) this._theatreObserver.observe(node);
        }
    }

    _layoutTheatre() {
        const theatre = this._theatre;
        const hud = this._els.hud;
        if (!theatre || !hud || !this._root) return;
        const topbar = this._root.querySelector('.topbar');
        const scroll = this._root.scrollTop || 0;
        const top = topbar ? topbar.offsetTop + topbar.offsetHeight - scroll : 0;
        const bottom = hud.offsetTop - scroll;
        theatre.layout({ width: this._root.clientWidth, height: this._root.clientHeight, top, bottom: bottom - 6 });
    }

    // 换了一场（新种子 / 换了上场名单）就整块换新木板：火漆、彩带、铜币都回到开局样子
    _ensureViews(state, lanes) {
        const key = [state.round, lanes.map(lane => `${lane.beetleId}:${lane.color}:${lane.pattern}:${lane.horn}`).join(',')].join('|');
        if (key === this._viewKey && this._stage && this._board) return;
        const laneSig = key.split('|')[1];
        if (!this._stage || this._viewKey.split('|')[1] !== laneSig) {
            this._stage?.destroy();
            this._stage = new TavernRaceStage(this._br.stageHost, lanes, {
                kit: this._api.beetles,
                woodHref: WOOD_HREF,
                onPick: (index) => this._onPick(index)
            });
            this._stage.setPick(Math.min(this._pick, lanes.length - 1), { notify: false });
        }
        this._board?.destroy();
        this._board = new TavernRaceBoard(this._br.boardHost, lanes, {
            kit: this._api.beetles,
            woodHref: WOOD_HREF,
            placeLabel: (n) => this._t(`PARLOR.BeetleRace.Place.${Math.min(8, n)}`) || String(n),
            text: { finish: this._t('PARLOR.BeetleRace.Board.Finish') }
        });
        this._viewKey = key;
        this._resetCommentary();
        this._countShown = 0;
        if (state.phase === 'RACING' || state.phase === 'RESOLVING') this._board.openGate(true);
        if (state.phase === 'RESOLVING' && state.result?.winnerLane >= 0) this._board.markPayout(state.result.winnerLane);
    }

    _onPhaseChange(from, to, state) {
        // 巡游之后接下注，大幕早就开着；直接进下注（开桌就在下注、第二场起）才本地拉一遍
        if (to === 'BETTING') this._openLocalAt = from === 'PARADE' ? 0 : performance.now();
        if (to === 'BETTING') this._warmTableSoon();
        if (to === 'PARADE' || to === 'IDLE') this._openLocalAt = 0;
        if (to === 'BETTING') {
            // 挑选台停在第一只，别替玩家做选择
            this._stage.setPick(0, { notify: false });
            this._pick = 0;
            const hud = this._api.getHud?.();
            if (!this._stake) this._stake = Math.max(hud?.limits?.min || 1, 10);
        }
        if (to === 'COUNTDOWN') this._board.openGate(false);
        if (to === 'RACING') {
            this._goAt = performance.now();
            this._board.openGate(true);
            if (from) this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Start'), tone: 'round' });
        }
        if (to === 'RESOLVING' && state.result?.winnerLane >= 0) this._board.markPayout(state.result.winnerLane);
        this._slipKey = '';
    }

    _onPick(index) {
        this._pick = index;
        this._api.playSound?.('swish');
        const state = this._brState || {};
        const lanes = this._api.getLanes?.() || [];
        this._renderPlaque(state, lanes);
        this._renderDots(state, lanes);
        this._syncBetButton();
    }

    // 名牌：巡游时是正在登场那只，下注时是挑选台灯下那只
    _renderPlaque(state, lanes) {
        const plaque = this._br?.plaque;
        if (!plaque) return;
        const parade = state.phase === 'PARADE' || state.phase === 'IDLE';
        const stageMode = STAGE_PHASES.has(state.phase);
        const index = parade ? Math.min(Number(state.paradeIndex || 0), lanes.length - 1) : this._pick;
        const lane = lanes[index];
        if (!stageMode || !lane) {
            plaque.hidden = true;
            this._plaqueKey = '';
            return;
        }
        const key = JSON.stringify([state.phase, index, lane.backers.map(b => [b.id, b.amount]), lane.multiplierText, lane.name]);
        plaque.hidden = false;
        if (key === this._plaqueKey) return;
        this._plaqueKey = key;
        const shades = this._api.beetles.shades(lane.color);
        const backers = lane.backers.length
            ? lane.backers.map(b => `<span class="pbr-backer${b.isSelf ? ' self' : ''}">${this._esc(b.name)} · ${this._esc(this._chips(b.amount))}</span>`).join('')
            : `<span class="pbr-backer empty">${this._esc(this._t('PARLOR.BeetleRace.Caption.NoBackers'))}</span>`;
        plaque.style.setProperty('--c1', shades.light);
        plaque.style.setProperty('--c2', shades.base);
        plaque.style.setProperty('--c3', shades.deep);
        plaque.innerHTML = `
            <div class="pbr-plaque-row">
                <span class="pbr-no">${lane.number}</span>
                <div class="pbr-plaque-main">
                    <div class="pbr-plaque-name">${this._esc(lane.name)}</div>
                    <div class="pbr-plaque-meta"><span class="pw">${this._esc(lane.powerText)}</span><span>${this._esc(lane.statsText)}</span></div>
                </div>
                ${parade ? '' : `<span class="pbr-odds-seal" title="${this._esc(this._t('PARLOR.BeetleRace.Hud.Returns', { amount: '' }))}">${this._esc(lane.multiplierText)}</span>`}
            </div>
            ${lane.intro ? `<p class="pbr-plaque-intro">${this._esc(lane.intro)}</p>` : ''}
            ${parade ? '' : `<div class="pbr-backers"><span class="lbl">${this._esc(this._t('PARLOR.BeetleRace.Caption.Backers'))}</span>${backers}</div>`}
        `;
    }

    // 挑选台下面一排小圆点：几只虫一眼数得清，点哪只跳哪只；押过的带金圈
    _renderDots(state, lanes) {
        const dots = this._br?.dots;
        if (!dots) return;
        const show = state.phase === 'BETTING';
        dots.hidden = !show;
        if (!show) return;
        const mine = new Set((this._api.getHud?.()?.bets || []).map(bet => bet.lane));
        dots.innerHTML = lanes.map((lane, i) => `
            <button type="button" class="pbr-dot${i === this._pick ? ' on' : ''}${mine.has(i) ? ' mine' : ''}" data-lane="${i}" style="--c:${this._esc(lane.color)}" title="${this._esc(`${lane.number} · ${lane.name}`)}">${lane.number}</button>
        `).join('');
    }

    _renderGmHint(state) {
        const hint = this._br?.gmHint;
        if (!hint) return;
        const show = !!game.user?.isGM && state.phase === 'RACING';
        hint.hidden = !show;
        if (show && !hint.textContent) hint.textContent = this._t('PARLOR.BeetleRace.Gm.CheatHint');
    }

    // ── 帧循环 ─────────────────────────────────────────────

    _startLoop() {
        cancelAnimationFrame(this._raf);
        this._lastFrameAt = performance.now();
        const frame = (now) => {
            if (!this._root) return;
            const dt = Math.min(0.05, (now - this._lastFrameAt) / 1000);
            this._lastFrameAt = now;
            try {
                this._frame(dt);
            } catch (err) {
                console.error(`${MODULE_ID} | beetle race frame failed`, err);
            }
            this._raf = requestAnimationFrame(frame);
        };
        this._raf = requestAnimationFrame(frame);
    }

    _frame(dt) {
        const state = this._brState;
        if (!state?.race || !this._stage || !this._board) return;
        const clock = this._api.getClock?.() || {};
        this._renderTimer(state, clock);

        if (STAGE_PHASES.has(state.phase)) {
            this._theatre?.setOpening(this._curtainProgress(state, clock));
            this._stage.update({ paradeIndex: Number(state.paradeIndex || 0), paradeElapsedMs: clock.paradeElapsedMs || 0, dt });
            return;
        }

        if (state.phase === 'COUNTDOWN') {
            const total = this._api.beetles.countdownMs || 3200;
            const left = Number(clock.countdownRemainingMs || 0);
            const n = left > total * 2 / 3 ? 3 : (left > total / 3 ? 2 : 1);
            if (this._countShown !== n) {
                this._countShown = n;
                this._board.showCount(String(n));
            }
        } else if (this._countShown) {
            this._countShown = 0;
            if (state.phase === 'RACING') this._board.showCount(this._t('PARLOR.BeetleRace.Board.Go') || 'GO', true);
            else this._board.clearCount();
        }
        if (this._goAt && performance.now() - this._goAt > GO_SHOW_MS) {
            this._goAt = 0;
            this._board.clearCount();
        }

        const frame = this._api.getRaceFrame?.(dt) || null;
        this._board.update(frame, dt);
        if (frame) this._commentate(state, frame);
    }

    _warmTableSoon() {
        if (tableWarmed || this._warmTimer) return;
        this._warmTimer = setTimeout(() => {
            this._root?.classList.add('pbr-warming');
            this._warmTimer = setTimeout(() => {
                this._warmTimer = 0;
                tableWarmed = true;
                this._root?.classList.remove('pbr-warming');
            }, WARM_HOLD_MS);
        }, WARM_AFTER_MS);
    }

    // 大幕开到哪了：巡游跟主机的阶段时钟（各端同一刻拉开），下注按本地起点，等候时合着
    _curtainProgress(state, clock) {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 1;
        if (state.phase === 'IDLE') return 0;
        if (state.phase === 'PARADE') {
            const intro = this._api.beetles.paradeIntroMs || 0;
            return intro ? Number(clock.paradeElapsedMs || 0) / intro : 1;
        }
        if (!this._openLocalAt) return 1;
        const p = (performance.now() - this._openLocalAt) / LOCAL_OPEN_MS;
        if (p >= 1) this._openLocalAt = 0;
        return p;
    }

    _renderTimer(state, clock) {
        const timer = this._br?.timer;
        if (!timer) return;
        let text = '';
        if (state.phase === 'BETTING') text = this._t('PARLOR.BeetleRace.Head.BettingLeft', { seconds: Math.ceil(Number(clock.bettingRemainingMs || 0) / 1000) });
        else if (state.phase === 'PARADE') text = this._t('PARLOR.BeetleRace.Head.ParadeOf', { index: Math.min(state.race.lanes.length, Number(state.paradeIndex || 0) + 1), total: state.race.lanes.length });
        if (text === this._timerText) return;
        this._timerText = text;
        timer.textContent = text;
        timer.hidden = !text;
        timer.classList.toggle('urgent', state.phase === 'BETTING' && Number(clock.bettingRemainingMs || 0) < URGENT_MS);
    }

    // ── 解说：按模拟事件和领跑变化往木牌上挂 ─────────────────

    _resetCommentary() {
        this._eventCursor = 0;
        this._lastLeader = -1;
        this._lastLeadCall = 0;
        this._calledHalf = false;
        this._calledFinal = false;
        this._calledFinish = false;
        this._calledPhoto = false;
    }

    _commentate(state, frame) {
        const names = state.race.lanes.map(lane => lane.name);
        const events = frame.events || [];
        // 晚到的干预会让本地从头重算，事件表可能变短
        this._eventCursor = Math.min(this._eventCursor, events.length);
        while (this._eventCursor < events.length) {
            const ev = events[this._eventCursor++];
            // 暗调不解说：那本来就是要瞒着人的
            if (ev.kind === 'bias' || !ev.actionId) continue;
            const action = this._t(`PARLOR.BeetleRace.Action.${ev.actionId}.Name`);
            const tone = this._api.beetles.isMagic(ev.actionId) ? 'allin' : (CATEGORY_TONE[this._api.beetles.actionCategory(ev.actionId)] || 'check');
            this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Action', { name: names[ev.lane] || '', action }), tone });
        }

        const order = frame.order || [];
        if (order.length) {
            if (!this._calledFinish) {
                this._calledFinish = true;
                const winner = order[0];
                this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Finish', { name: names[winner] || '' }), tone: 'win' });
                const lane = (this._api.getLanes?.() || [])[winner];
                this._board.showBanner(
                    this._t('PARLOR.BeetleRace.Settlement.Winner', { name: names[winner] || '' }),
                    lane ? `${lane.number} · ${lane.multiplierText}` : ''
                );
            }
            if (!this._calledPhoto && order.length > 1) {
                this._calledPhoto = true;
                const [a, b] = order;
                const lanes = frame.lanes || [];
                if (Math.abs((lanes[b]?.finishStep || 0) - (lanes[a]?.finishStep || 0)) < 12) {
                    this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Photo', { name: names[b] || '' }), tone: 'allin' });
                }
            }
            return;
        }
        const lanes = frame.lanes || [];
        const lead = lanes.reduce((best, lane) => (!best || lane.x > best.x ? lane : best), null);
        if (!lead) return;
        const now = performance.now();
        const track = frame.trackLength || 1000;
        if (lead.index !== this._lastLeader) {
            if (this._lastLeader >= 0 && now - this._lastLeadCall > LEAD_CALL_GAP_MS && lead.x > track * 0.06) {
                this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Lead', { name: names[lead.index] || '' }), tone: 'turn' });
                this._lastLeadCall = now;
            }
            this._lastLeader = lead.index;
        }
        if (!this._calledHalf && lead.x > track * 0.5) {
            this._calledHalf = true;
            this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Half'), tone: 'deal' });
        }
        if (!this._calledFinal && lead.x > track * 0.8) {
            this._calledFinal = true;
            this._pushHerald({ text: this._t('PARLOR.BeetleRace.Herald.Final'), tone: 'raise' });
        }
    }

    // 播报快照：一人可能押好几道，按"人:道"记，不然基类只认一人一注
    _heraldSnapshot(state, status) {
        const snap = super._heraldSnapshot(state, status);
        const bets = {};
        for (const bet of state.bets || []) {
            if (!bet?.userId) continue;
            bets[`${bet.userId}:${bet.lane}`] = { userId: bet.userId, lane: Number(bet.lane), amount: Number(bet.amount || 0) };
        }
        return { ...snap, bets, raceWinner: state.phase === 'RESOLVING' ? Number(state.result?.winnerLane ?? -1) : -1, lanePhase: state.phase || '' };
    }

    _betHeraldLines(prev, next) {
        const out = [];
        const lanes = this._brState?.race?.lanes || [];
        for (const [key, bet] of Object.entries(next.bets || {})) {
            const before = prev.bets?.[key];
            if (before && before.amount === bet.amount) continue;
            const name = this._seatName(bet.userId);
            if (!name || !bet.amount) continue;
            const side = `${bet.lane + 1} · ${lanes[bet.lane]?.name || ''}`;
            out.push({ text: this._t('PARLORTAVERN.Herald.BetSide', { name, side, amount: this._chips(bet.amount) }), tone: 'raise' });
        }
        return out;
    }

    _gameHeraldLines(prev, next) {
        if (next.lanePhase === prev.lanePhase) return [];
        switch (next.lanePhase) {
            case 'PARADE': return [{ text: this._t('PARLOR.BeetleRace.Herald.Parade'), tone: 'round' }];
            case 'BETTING': return [{ text: this._t('PARLOR.BeetleRace.Herald.Betting'), tone: 'deal' }];
            case 'COUNTDOWN': return [{ text: this._t('PARLOR.BeetleRace.Herald.Closed'), tone: 'turn' }];
            default: return [];
        }
    }

    // ── HUD：中间注单，右边注额 + 押注 ─────────────────────

    _renderHudHand(hud) {
        const mid = this._els.hudMid;
        if (!mid) return;
        const key = JSON.stringify([hud.participantId, hud.canBet, hud.bets, hud.message, hud.result, hud.centerHtml, hud.staked]);
        if (key === this._slipKey && mid.firstElementChild) return;
        this._slipKey = key;
        const tickets = (hud.bets || []).map(bet => {
            const shades = this._api.beetles.shades(bet.color);
            return `<span class="pbr-ticket" style="--c1:${shades.light};--c2:${shades.base};--c3:${shades.deep}">
                <i class="no">${bet.lane + 1}</i><span class="nm">${this._esc(bet.name)}</span><b>${this._esc(this._chips(bet.amount))}</b>
                ${hud.canBet ? `<button type="button" class="x" data-remove-lane="${bet.lane}" aria-label="${this._esc(this._t('PARLOR.BeetleRace.Hud.Remove'))}">×</button>` : ''}
            </span>`;
        }).join('');
        const result = hud.result
            ? `<div class="pbr-result${hud.result.payout > 0 ? '' : ' lose'}">${this._esc(hud.message)}</div>`
            : (hud.message ? `<div class="pbr-slip-note">${this._esc(hud.message)}</div>` : '');
        mid.innerHTML = `
            <div class="pbr-slip">
                <div class="pbr-slip-head">
                    <span class="lbl">${this._esc(this._t('PARLOR.BeetleRace.Hud.Ticket'))}</span>
                    ${hud.participantId ? `<span class="tk">${this._esc(this._t('PARLOR.BeetleRace.Hud.Staked', { amount: this._chips(hud.staked || 0) }))}</span>` : ''}
                </div>
                ${tickets ? `<div class="pbr-tickets">${tickets}</div>` : ''}
                ${result}
                ${hud.centerHtml || ''}
            </div>
        `;
        mid.querySelectorAll('[data-remove-lane]').forEach(button => button.addEventListener('click', (event) => {
            const bet = (this._api.getHud?.()?.actions || []).find(action => action.kind === 'bet');
            if (bet) this._runHudAction(bet, event, button, { lane: Number(button.dataset.removeLane), amount: 0 });
        }));
        mid.querySelector('select[data-br-participant]')?.addEventListener('change', (event) => {
            this._api.selectParticipant?.(event.currentTarget.value);
        });
    }

    _renderHudActions(hud) {
        const right = this._els.hudRight;
        right.innerHTML = '';
        const actions = hud.actions || [];
        const bet = actions.find(action => action.kind === 'bet');
        const withdraw = actions.find(action => action.kind === 'withdraw');
        if (bet) {
            const limits = hud.limits || {};
            const stakeBox = document.createElement('div');
            stakeBox.className = 'pbr-stake';
            stakeBox.innerHTML = `
                <label class="lbl">${this._esc(this._t('PARLOR.BeetleRace.Hud.Stake'))}</label>
                <input type="number" min="0" step="1" value="${Math.max(0, Math.floor(this._stake))}" data-stake>
                <div class="pbr-quick">
                    ${(limits.quick || [10, 50, 100]).map(v => `<button type="button" data-add="${v}">+${v}</button>`).join('')}
                    <button type="button" data-add="0">${this._esc(this._t('PARLOR.BeetleRace.Hud.Clear'))}</button>
                </div>`;
            right.appendChild(stakeBox);
            const input = stakeBox.querySelector('[data-stake]');
            input.addEventListener('input', () => {
                this._stake = Math.max(0, Math.floor(Number(input.value) || 0));
                this._syncBetButton();
            });
            stakeBox.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => {
                const value = Number(button.dataset.add);
                this._stake = value ? Math.max(0, Math.floor(this._stake)) + value : 0;
                input.value = String(this._stake);
                this._syncBetButton();
            }));

            const row = document.createElement('div');
            row.className = 'btn-row pbr-bet-row';
            if (withdraw) row.appendChild(this._createActionButton(withdraw));
            const betButton = this._createActionButton(bet, { dataProvider: () => ({ lane: this._pick, amount: this._stake }), extraClassName: 'pbr-bet' });
            row.appendChild(betButton);
            right.appendChild(row);
            this._betButton = betButton;
            this._betAction = bet;
            this._syncBetButton();
        } else {
            this._betButton = null;
            this._betAction = null;
        }
        const gm = actions.filter(action => action.kind === 'gm');
        if (gm.length) this._appendActionButtons(right, gm, { rowClass: 'btn-row pbr-gm-row' });
    }

    // 押注按钮的字跟着"灯下那只 + 注额"变；只改字不重建，免得吞点击
    _syncBetButton() {
        const button = this._betButton;
        if (!button?.isConnected) return;
        const lane = (this._api.getLanes?.() || [])[this._pick];
        if (!lane) return;
        const hud = this._api.getHud?.();
        const current = (hud?.bets || []).some(bet => bet.lane === this._pick);
        const stake = Math.max(0, Math.floor(this._stake));
        const label = this._t(current ? 'PARLOR.BeetleRace.Hud.Change' : 'PARLOR.BeetleRace.Hud.Bet', { n: lane.number, name: lane.name });
        const returns = this._t('PARLOR.BeetleRace.Hud.Returns', { amount: this._chips(Math.floor(stake * lane.multiplier)) });
        button.innerHTML = `<i class="fas fa-coins"></i><span class="pbr-bet-label">${this._esc(label)}</span><small>${this._esc(returns)}</small>`;
        button.disabled = !!this._betAction?.disabled || stake <= 0;
    }

    // ── 音效开关 ───────────────────────────────────────────
    // 声音本身由本体按游戏进程放；这里只放一个喇叭，只给 GM：开不开是 GM 替全桌定的（跟 Foundry 设置里那项是同一个）

    _mountSoundToggle() {
        const tools = this._root?.querySelector('.ptt-corner-tools');
        if (!tools || typeof this._api?.setSoundOn !== 'function' || !this._api.canSetSound?.()) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ptt-tool pbr-sound';
        button.innerHTML = '<i aria-hidden="true"></i>';
        button.addEventListener('click', () => {
            const next = !this._api.isSoundOn();
            this._api.setSoundOn(next);
            // 设置落盘有一点延迟，先按预期状态画，免得图标慢一拍
            this._syncSoundToggle(next);
        });
        // 插在关桌按钮前面，跟 ⚒ / ✕ 排在一起
        tools.insertBefore(button, tools.querySelector('.ptt-close'));
        this._soundButton = button;
        this._syncSoundToggle();
    }

    _syncSoundToggle(on = this._api?.isSoundOn?.() !== false) {
        const button = this._soundButton;
        if (!button) return;
        const label = this._t(on ? 'PARLOR.BeetleRace.Sound.On' : 'PARLOR.BeetleRace.Sound.Off');
        button.classList.toggle('is-off', !on);
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', on ? 'false' : 'true');
        button.firstElementChild.className = on ? 'fas fa-volume-high' : 'fas fa-volume-xmark';
    }

    // ── 纯净桌面 ───────────────────────────────────────────
    // 赛道板几乎占满毛毡，DM 摆在桌上的酒杯、牌堆会压到赛道上。开不开是 GM 在开桌对话里定的（本体的全桌偏好，记住上次），
    // 这里只照着收；不动 world setting 里的赌桌预设（那是 DM 的东西，别的游戏还要用）
    _syncCleanTable() {
        if (!this._root) return;
        const hasProps = (this._api?.getTableDeck?.()?.props || []).length > 0;
        this._root.classList.toggle('pbr-clean', hasProps && !!this._api?.isCleanTable?.());
    }

    // ── 键盘 ───────────────────────────────────────────────

    _handleKey(event) {
        if (!this._root || event.target?.closest?.('input, textarea, select')) return;
        const state = this._brState || {};
        if (event.key === 'Escape' && this._cheatLane >= 0) {
            this._closeCheat();
            event.preventDefault();
            return;
        }
        if (state.phase === 'BETTING' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            this._stage?.step(event.key === 'ArrowLeft' ? -1 : 1);
            event.preventDefault();
            return;
        }
        // DM 比赛中按 1–8 直接点那一道
        if (game.user?.isGM && state.phase === 'RACING' && /^[1-8]$/u.test(event.key)) {
            const lane = Number(event.key) - 1;
            if (state.race?.lanes?.[lane]) {
                this._openCheat(lane);
                event.preventDefault();
            }
        }
    }

    // ── 作弊木牌（GM） ─────────────────────────────────────

    _onBoardClick(event) {
        if (!game.user?.isGM || this._brState?.phase !== 'RACING') return;
        const lane = this._board?.laneAtPoint(event.clientX, event.clientY) ?? -1;
        if (lane >= 0) this._openCheat(lane);
    }

    _openCheat(lane) {
        const cheats = this._api.getCheats?.();
        const racer = (this._api.getLanes?.() || [])[lane];
        if (!cheats || !racer) return;
        this._cheatLane = lane;
        this._cheats = cheats;
        const move = (entry) => {
            const tip = entry.bubble ? `${entry.actionName} · ${entry.bubble}` : entry.actionName;
            return `<button type="button" class="pbr-move ${entry.tone}" data-move="${this._esc(entry.id)}" title="${this._esc(tip)}">${this._esc(entry.name)}</button>`;
        };
        const bias = Number(cheats.biases[lane] ?? 1);
        const range = cheats.biasRange || { min: 0.4, max: 1.8, step: 0.05 };
        const shades = this._api.beetles.shades(racer.color);
        const groups = [
            { id: 'blatant', label: 'PARLOR.BeetleRace.Cheat.Blatant', hint: '' },
            { id: 'natural', label: 'PARLOR.BeetleRace.Cheat.Natural', hint: 'PARLOR.BeetleRace.Cheat.NaturalHint' },
            { id: 'bias', label: 'PARLOR.BeetleRace.Cheat.Bias', hint: 'PARLOR.BeetleRace.Cheat.BiasHint' }
        ];
        const empty = `<span class="empty">${this._esc(this._t('PARLOR.BeetleRace.Cheat.None'))}</span>`;
        const body = {
            blatant: `<div class="pbr-cheat-grid">${cheats.blatant.map(move).join('') || empty}</div>`,
            natural: `<div class="pbr-cheat-grid">${cheats.natural.map(move).join('') || empty}</div>`,
            bias: `
                <div class="pbr-cheat-bias">
                    <span>${this._esc(this._t('PARLOR.BeetleRace.Cheat.Slower'))}</span>
                    <input type="range" min="${range.min}" max="${range.max}" step="${range.step}" value="${bias}" data-cheat-bias>
                    <span>${this._esc(this._t('PARLOR.BeetleRace.Cheat.Faster'))}</span>
                    <b data-cheat-bias-value>×${bias.toFixed(2)}</b>
                    <button type="button" class="abtn gold" data-cheat-bias-apply>${this._esc(this._t('PARLOR.BeetleRace.Cheat.Apply'))}</button>
                    <button type="button" class="abtn plain" data-cheat-bias-reset>${this._esc(this._t('PARLOR.BeetleRace.Cheat.Reset'))}</button>
                </div>`
        };
        const panel = this._br.cheat;
        panel.innerHTML = `
            <div class="pbr-cheat-head">
                <span class="pbr-no" style="--c1:${shades.light};--c2:${shades.base};--c3:${shades.deep}">${racer.number}</span>
                <span class="nm">${this._esc(racer.name)}</span>
                <button type="button" class="x" data-cheat-close aria-label="${this._esc(this._t('PARLOR.Common.Close'))}">✕</button>
            </div>
            ${groups.map(group => `
                <section class="pbr-cheat-group">
                    <div class="pbr-cheat-label" ${group.hint ? `title="${this._esc(this._t(group.hint))}"` : ''}>${this._esc(this._t(group.label))}</div>
                    ${body[group.id]}
                </section>`).join('')}
        `;
        panel.hidden = false;
        this._positionCheat();
    }

    // 打开时避让一次；拖动坐标由本体换算，不能直接把屏幕像素写到缩放过的桌面上。
    _positionCheat() {
        const panel = this._br?.cheat;
        const point = this._board?.beetleScreenPoint(this._cheatLane);
        if (!panel || !point) return;
        if (this._cheatPanel) {
            this._cheatPanel.open(point);
            return;
        }
        const box = this._br.root.getBoundingClientRect();
        const side = point.x < box.left + box.width / 2 ? 'right' : 'left';
        if (panel.dataset.side !== side) panel.dataset.side = side;
    }

    _closeCheat() {
        if (this._cheatLane < 0) return;
        this._cheatLane = -1;
        this._cheatPanel?.close();
        if (this._br?.cheat) this._br.cheat.hidden = true;
    }

    _onCheatClick(event) {
        if (event.target.closest('[data-cheat-close]')) {
            this._closeCheat();
            return;
        }
        const lane = this._cheatLane;
        const cheats = this._cheats;
        if (lane < 0 || !cheats) return;
        const move = event.target.closest('[data-move]');
        if (move) {
            cheats.onCheat(lane, move.dataset.move);
            this._closeCheat();
            return;
        }
        const slider = this._br.cheat.querySelector('[data-cheat-bias]');
        if (event.target.closest('[data-cheat-bias-apply]')) {
            cheats.onBias(lane, Number(slider.value));
            this._closeCheat();
        } else if (event.target.closest('[data-cheat-bias-reset]')) {
            cheats.onBias(lane, 1);
            this._closeCheat();
        }
    }

    _onCheatInput(event) {
        if (!event.target.matches?.('[data-cheat-bias]')) return;
        const out = this._br.cheat.querySelector('[data-cheat-bias-value]');
        if (out) out.textContent = `×${Number(event.target.value).toFixed(2)}`;
    }
}
