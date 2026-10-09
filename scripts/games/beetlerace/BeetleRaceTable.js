/**
 * 甲虫赛跑 · 经典桌
 *
 * 主角是甲虫：不设左右座位列，中间一张大桌按阶段换舞台——巡游时是登场台、下注时是挑选台、比赛时是赛道板。
 * 押注的人收成一条"看台"，底部是自己的注单；DM 多一条工具栏，比赛中点甲虫弹作弊面板。
 *
 * 本地模拟：比赛画面全靠这一端自己跑 BeetleRaceSim（跟主机同一份 spec）。
 * 收到新的干预：都排在当前步之后就原地接上，有晚到的就从头重算（_syncSim）。
 * 时钟看 gameInstance.getClock()（收到状态那一刻换算的），不看本机 Date，别跟主机对表。
 *
 * 主题接管 table:beetlerace 时整张经典桌不开，改由 PresenterHost 挂主题呈现器；
 * 本地模拟照样由这里的 _runner 跑，主题每帧调 gameApi.getRaceFrame 取位置，甲虫画法经 gameApi.beetles 借用本体的。
 * 结算弹窗两种模式都是本体自己的（挂在 body 上）。
 */

import { SocketManager, SOCKET_EVENTS } from '../../core/SocketManager.js';
import { BotManager } from '../../core/BotManager.js';
import { ParlorAppearance } from '../../core/AppearanceConfig.js';
import { SettlementManager } from '../../core/SettlementManager.js';
import { PresenterRegistry } from '../../core/PresenterRegistry.js';
import { TableDecks } from '../../core/TableDecks.js';
import { PresenterHost } from '../../ui/PresenterHost.js';
import {
    getControlledParticipants,
    getDisplayParticipant,
    getParticipantName
} from '../../core/ParticipantRoster.js';
import { ACTIONS, IDLE_ACTION_IDS, TRACK_LENGTH } from './BeetleRaceCatalog.js';
import { curtainMotion } from './BeetleRaceOpening.js';
import { BeetleRaceCheatPanel } from './BeetleRaceCheatPanel.js';
import { BeetleRaceRunner } from './BeetleRaceRunner.js';
import { BeetleRaceBoard } from './BeetleRaceBoard.js';
import { BeetleRaceStage } from './BeetleRaceStage.js';
import { BeetleActor, FxLayer, createBubble, deriveShades } from './BeetleRaceRender.js';
import {
    buildBeetleRaceCheats,
    buildBeetleRaceHud,
    buildBeetleRaceLanes,
    buildBeetleRaceSeatEntries,
    buildBeetleRaceStatus
} from './BeetleRacePresenterData.js';
import { COUNTDOWN_MS, PARADE_STEP_MS, PARADE_INTRO_MS, paradeActionFor, stakeOf, betOn } from './BeetleRaceRules.js';
import { BEETLE_SOUNDS, BeetleRaceSoundDirector, beetleSoundSrc, isBeetleSoundOn, setBeetleSoundOn } from './BeetleRaceSounds.js';
import { getBeetlePref } from './BeetleRacePrefs.js';

const OVERLAY_ID = 'parlor-br-overlay';
const SETTLEMENT_ID = 'parlor-br-settlement';
const SURFACE = 'table:beetlerace';
const PRESENTER_HOST_ID = 'parlor-br-presenter';
// 呈现器走 requestAction 的这几个是 DM 推进 / 作弊，其余都是玩家以某个席位的名义下注
const GM_ACTIONS = new Set(['skipParade', 'closeBetting', 'cheat', 'bias', 'newRound', 'finishGame']);

// 甲虫的画法归本体（跟牌面一样），主题借来摆进自己的赛道里；动作动画、特效、气泡都在里面
const BEETLE_KIT = Object.freeze({
    trackLength: TRACK_LENGTH,
    createActor: (look, options = {}) => new BeetleActor(look, options),
    createFx: (parent) => new FxLayer(parent),
    createBubble: (parent) => createBubble(parent),
    createCheatPanel: (panel, options) => new BeetleRaceCheatPanel(panel, options),
    curtainMotion,
    idleActionIds: IDLE_ACTION_IDS,
    shades: (hex) => deriveShades(hex),
    actionCategory: (actionId) => ACTIONS[actionId]?.category || '',
    isMagic: (actionId) => !!ACTIONS[actionId]?.magic,
    // 动作的默认时长（秒）：巡游、挑选台上的表演按这个算播完没有
    actionDuration: (actionId) => ACTIONS[actionId]?.sim.dur || 1,
    // 巡游每只登场多久、开跑前倒数多久，主题排自己的节奏要跟主机对上
    paradeStepMs: PARADE_STEP_MS,
    paradeIntroMs: PARADE_INTRO_MS,
    countdownMs: COUNTDOWN_MS
});
const ACTION_LOCK_MS = 360;
let soundsPreloaded = false;
const HERALD_LINES = 2;
const LEAD_CALL_GAP_MS = 1600;
const QUICK_STAKES = [10, 50, 100];

const ERROR_KEYS = Object.freeze({
    'phase': 'WrongPhase',
    'not-player': 'NotPlayer',
    'invalid-lane': 'InvalidLane',
    'invalid-amount': 'InvalidAmount',
    'below-min': 'BelowMin',
    'above-max': 'AboveMax',
    'chips': 'NotEnough',
    'finished': 'AlreadyFinished',
    'invalid-move': 'InvalidMove'
});

export class BeetleRaceTable {
    constructor({ gameInstance }) {
        this.gameInstance = gameInstance;
        this._overlay = null;
        this._presenterHost = null;
        this._dismissedByUser = false;
        this._selectedParticipantId = '';
        this._actionRequests = new Map();
        this._stake = 0;
        this._raf = 0;
        this._lastFrame = 0;
        this._stage = null;
        this._board = null;
        this._runner = new BeetleRaceRunner();
        this._eventCursor = 0;
        this._herald = [];
        this._lastLeadCall = 0;
        this._calledHalf = false;
        this._calledFinal = false;
        this._lastLeader = -1;
        this._goShownAt = 0;
        this._prevPhase = '';
        this._keys = {};
        this._cheatLane = -1;
        this._cheatPanel = null;
        this._openLocalAt = 0;
        this._settlementShown = false;
        this._settlementFocus = null;
        this._onKeyDown = (event) => this._handleKey(event);
        this._sounds = null;
        this._soundRaf = 0;
    }

    get sessionId() { return this.gameInstance.sessionId; }

    render(force) {
        if (force) this._dismissedByUser = false;
        if (this._dismissedByUser) return;
        this.open();
    }

    open() {
        if (this._dismissedByUser) return;
        const themeId = ParlorAppearance.getActiveThemeId();
        const PresenterClass = PresenterRegistry.resolve(themeId, SURFACE);
        if (PresenterClass && !PresenterHost.hasCrashed(themeId, SURFACE)) {
            this._openPresenter(PresenterClass, themeId);
            return;
        }
        this._openNative();
    }

    _openNative() {
        if (this._dismissedByUser) return;
        if (this._overlay) {
            this.refresh();
            return;
        }
        document.querySelectorAll(`#${OVERLAY_ID}`).forEach(node => node.remove());
        this._createOverlay();
        document.addEventListener('keydown', this._onKeyDown);
        this._resetSounds();
        this.refresh();
        this._startLoop();
    }

    close({ dismiss = true } = {}) {
        if (this._presenterHost) {
            if (dismiss) this._dismissedByUser = true;
            this._presenterHost.destroy();
            this._presenterHost = null;
            this._stopSoundLoop();
            clearTimeout(this._settlementTimer);
            document.querySelectorAll(`#${SETTLEMENT_ID}`).forEach(node => node.remove());
            this._settlementShown = false;
            this._settlementFocus = null;
            this._actionRequests.clear();
            return;
        }
        this._closeNative({ dismiss });
    }

    _closeNative({ dismiss = true } = {}) {
        if (dismiss) this._dismissedByUser = true;
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        document.removeEventListener('keydown', this._onKeyDown);
        this._stage?.destroy();
        this._board?.destroy();
        this._cheatPanel?.destroy();
        this._cheatPanel = null;
        this._cheatLane = -1;
        this._stage = null;
        this._board = null;
        document.querySelectorAll(`#${SETTLEMENT_ID}`).forEach(node => node.remove());
        document.querySelectorAll(`#${OVERLAY_ID}`).forEach(node => node.remove());
        this._overlay = null;
        this._actionRequests.clear();
        clearTimeout(this._settlementTimer);
        this._settlementShown = false;
        this._keys = {};
    }

    // ───────── 主题呈现器 ─────────

    _openPresenter(PresenterClass, themeId) {
        const state = this.gameInstance.getState();
        this._syncSim(state);
        if (this._presenterHost) {
            this._presenterHost.refresh(state);
            this._syncSettlement(state);
            return;
        }
        if (this._overlay) this._closeNative({ dismiss: false });

        let host = null;
        host = new PresenterHost({
            surface: SURFACE,
            hostId: PRESENTER_HOST_ID,
            themeId,
            gameApi: this._createPresenterGameApi(),
            PresenterClass,
            onFallback: () => {
                if (this._presenterHost === host) this._presenterHost = null;
                this._openNative();
            }
        });
        this._presenterHost = host;
        host.open(state);
        if (this._presenterHost === host) {
            this._syncSettlement(state);
            this._resetSounds();
            this._startSoundLoop();
        }
    }

    _createPresenterGameApi() {
        const getState = () => this.gameInstance.getState();
        const helpers = () => this._getPresenterDataHelpers();
        return Object.freeze({
            getState,
            getClock: () => this.gameInstance.getClock(),
            getSeats: () => buildBeetleRaceSeatEntries(getState(), helpers()),
            getStatus: () => buildBeetleRaceStatus(getState(), helpers()),
            getHud: () => buildBeetleRaceHud(getState(), helpers()),
            getLanes: () => buildBeetleRaceLanes(getState(), helpers()),
            getCheats: () => buildBeetleRaceCheats(getState(), helpers()),
            getPrivate: () => ({ participantId: this._getSelectedParticipantId(getState()) }),
            getRaceFrame: (dt = 0.016) => this._raceFrame(dt),
            beetles: BEETLE_KIT,
            requestAction: (action, data = {}) => this._requestPresenterAction(action, data),
            selectParticipant: (participantId) => {
                this._selectedParticipantId = String(participantId || '');
                this.refresh();
            },
            // 甲虫自己的整套音效（swish 这种界面声主题也能喊），别的名字还是走牌声
            playSound: (kind) => (BEETLE_SOUNDS[kind] != null ? this._playBeetleSound(kind) : ParlorAppearance.playCardSound?.(kind)),
            // 全桌甲虫音效开没开（GM 定）；setSoundOn 只有 GM 调得动，改了所有客户端的桌子一起刷新
            isSoundOn: () => isBeetleSoundOn(),
            canSetSound: () => !!game.user?.isGM,
            // 纯净桌面（GM 开桌时定）：带摆件的主题比赛时把摆件收起来；经典桌本来就没摆件
            isCleanTable: () => getBeetlePref('cleanTable'),
            setSoundOn: (on) => setBeetleSoundOn(on),
            formatChips: (amount) => `${Number(amount || 0)}`,
            getTableBackdrop: () => ParlorAppearance.getTableBackdrop?.() ?? null,
            getTableDeck: () => TableDecks.getActive(),
            openPopup: () => null,
            // 不能直接拆 presenter root，否则活 session 还占着大厅，下一局会被误判成"已有游戏"
            requestClose: () => this._requestParlorClose?.() ?? this.close(),
            t: (key, data) => this._t(key, data)
        });
    }

    _getPresenterDataHelpers() {
        return {
            t: (key, data) => this._t(key, data),
            formatChips: (amount) => `${Number(amount || 0)}`,
            getParticipantName: (state, participantId) => this._playerName(state, participantId),
            getDisplayParticipant: (state, participantId) => this._describe(state, participantId),
            getControlledParticipantIds: (state) => this._getSelectableParticipantIds(state),
            resolveSelectedParticipantId: (state) => this._getSelectedParticipantId(state),
            isGM: () => game.user.isGM,
            // 自测局的 DM、机器人席位不动账，显示成无限
            getBalance: (participantId) => (this._isExempt(this.gameInstance.getState(), participantId) ? '∞' : SettlementManager.getDisplayBalance(participantId)),
            isActionPending: (key) => this._actionRequests.has(key),
            actionCategory: (actionId) => ACTIONS[actionId]?.category || '',
            isMagicAction: (actionId) => !!ACTIONS[actionId]?.magic,
            paradeActionFor: (lane) => paradeActionFor(lane),
            requestAction: (action, data) => this._requestPresenterAction(action, data)
        };
    }

    // 动作路由。跟疯狂八那份不同：这里 lane / amount / moveId / mul 都是正经参数，一个都不能剥
    _requestPresenterAction(action, data = {}) {
        const safeAction = String(action || '').trim();
        if (!safeAction) return Promise.resolve({ ok: false, reason: 'missing-action' });
        const payload = { ...(data || {}) };
        delete payload.button;
        delete payload.gm;

        if (GM_ACTIONS.has(safeAction)) {
            delete payload.participantId;
            const key = safeAction === 'cheat' || safeAction === 'bias' ? `gm:${safeAction}:${payload.lane}` : `gm:${safeAction}`;
            return this._requestGMAction({ action: safeAction, data: payload, key });
        }

        const state = this.gameInstance.getState();
        const participantId = String(payload.participantId || this._getSelectedParticipantId(state) || '');
        delete payload.participantId;
        if (!participantId) return Promise.resolve({ ok: false, reason: 'missing-participant' });
        this._selectedParticipantId = participantId;
        return this._requestPlayerAction({ userId: participantId, action: safeAction, data: payload });
    }

    /** 主题每帧调一次：推进本地模拟，交出这一帧每道甲虫的位置和正在做的动作 */
    _raceFrame(dt) {
        const state = this.gameInstance.getState();
        this._syncSim(state);
        const sim = this._runner.advance(state, this.gameInstance.getClock(), Math.min(0.05, Math.max(0, Number(dt) || 0)));
        if (!sim) return null;
        return {
            trackLength: TRACK_LENGTH,
            lanes: sim.getLanes(),
            timeScale: sim.timeScale,
            order: [...sim.finishedOrder],
            // 事件表直接给引用：主题自己拿游标读新增的；重算过的话表会变短，游标记得夹一下
            events: sim.events,
            settled: sim.settled,
            step: sim.step
        };
    }

    handlePrivateUpdate() {}

    // ───────── 音效 ─────────
    // 什么时候响归 BeetleRaceSoundDirector，这里只管喂它每帧的状态、把名字换成文件放出来。
    // 经典桌在自己的帧循环里喂；主题模式下帧循环在呈现器里，本体另开一个很轻的循环，主题不用管音效也照样有

    _resetSounds() {
        this._sounds = new BeetleRaceSoundDirector({
            play: (name) => this._playBeetleSound(name),
            introMs: PARADE_INTRO_MS,
            stepMs: PARADE_STEP_MS,
            countdownMs: COUNTDOWN_MS,
            trackLength: TRACK_LENGTH,
            paradeActionFor: (lane) => paradeActionFor(lane),
            isMagic: (actionId) => !!ACTIONS[actionId]?.magic
        });
        if (!soundsPreloaded) {
            soundsPreloaded = true;
            ParlorAppearance.preloadEffects?.(Object.keys(BEETLE_SOUNDS).map(beetleSoundSrc));
        }
    }

    _playBeetleSound(name) {
        const gain = BEETLE_SOUNDS[name];
        if (gain == null || !isBeetleSoundOn()) return;
        ParlorAppearance.playEffect?.(beetleSoundSrc(name), gain);
    }

    _tickSound() {
        if (!this._sounds) return;
        const state = this.gameInstance.getState();
        try {
            this._sounds.tick({ state, clock: this.gameInstance.getClock(), sim: this._runner.sim, mine: this._getSelectableParticipantIds(state) });
        } catch (err) {
            console.error('parlor | beetle race sound failed', err);
        }
    }

    _startSoundLoop() {
        cancelAnimationFrame(this._soundRaf);
        const loop = () => {
            if (!this._presenterHost) return;
            this._tickSound();
            this._soundRaf = requestAnimationFrame(loop);
        };
        this._soundRaf = requestAnimationFrame(loop);
    }

    _stopSoundLoop() {
        cancelAnimationFrame(this._soundRaf);
        this._soundRaf = 0;
    }

    // ───────── 骨架 ─────────

    _createOverlay() {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.innerHTML = `
            <div class="parlor-br-backdrop"></div>
            <div class="parlor-br-layout">
                <header class="parlor-br-head">
                    <div class="parlor-br-badge"><i class="fas fa-bug"></i><span data-br="gameName"></span></div>
                    <div class="parlor-br-head-main">
                        <div class="parlor-br-head-title"><span data-br="raceName"></span><span class="parlor-br-head-round" data-br="round"></span></div>
                        <div class="parlor-br-herald" data-br="herald"></div>
                    </div>
                    <div class="parlor-br-head-side">
                        <button type="button" class="parlor-br-sound" data-br="sound"><i class="fas fa-volume-high"></i></button>
                        <span class="parlor-br-phase" data-br="phase"></span>
                        <span class="parlor-br-timer" data-br="timer"></span>
                    </div>
                </header>
                <div class="parlor-br-table">
                    <div class="parlor-br-felt">
                        <div class="parlor-br-stage-host" data-br="stageHost"></div>
                        <div class="parlor-br-board-host" data-br="boardHost"></div>
                        <button type="button" class="parlor-br-nav prev" data-br="prev" aria-label=""><i class="fas fa-chevron-left"></i></button>
                        <button type="button" class="parlor-br-nav next" data-br="next" aria-label=""><i class="fas fa-chevron-right"></i></button>
                        <div class="parlor-br-caption" data-br="caption"></div>
                    </div>
                    <div class="parlor-br-gm" data-br="gm"></div>
                </div>
                <div class="parlor-br-stands" data-br="stands"></div>
                <div class="parlor-br-hud" data-br="hud"></div>
            </div>
            <div class="parlor-br-cheat" data-br="cheat" hidden></div>
            <button type="button" class="parlor-br-close" data-br="close"><span aria-hidden="true">×</span></button>
        `;
        this._els = Object.fromEntries([...overlay.querySelectorAll('[data-br]')].map(node => [node.dataset.br, node]));
        this._els.close.title = this._t('PARLOR.Common.Close');
        this._els.close.setAttribute('aria-label', this._t('PARLOR.Common.Close'));
        this._els.prev.setAttribute('aria-label', this._t('PARLOR.BeetleRace.Caption.Prev'));
        this._els.next.setAttribute('aria-label', this._t('PARLOR.BeetleRace.Caption.Next'));
        this._els.gameName.textContent = this._t('PARLOR.Games.BeetleRace.Name');

        overlay.querySelector('.parlor-br-backdrop').addEventListener('click', (event) => event.stopPropagation());
        this._els.close.addEventListener('click', () => this._requestParlorClose?.() ?? this.close());
        this._els.prev.addEventListener('click', () => this._stage?.step(-1));
        this._els.next.addEventListener('click', () => this._stage?.step(1));
        this._els.boardHost.addEventListener('click', (event) => this._onBoardClick(event));
        this._els.hud.addEventListener('click', (event) => this._onHudClick(event));
        this._els.hud.addEventListener('change', (event) => this._onHudChange(event));
        this._els.gm.addEventListener('click', (event) => this._onGmClick(event));
        this._els.sound.addEventListener('click', () => {
            setBeetleSoundOn(!isBeetleSoundOn());
            this._renderSoundButton(!isBeetleSoundOn());
        });
        this._els.cheat.addEventListener('click', (event) => this._onCheatClick(event));
        this._els.cheat.addEventListener('input', (event) => this._onCheatInput(event));

        document.body.appendChild(overlay);
        ParlorAppearance.applyAppearanceToElement?.(overlay);
        this._overlay = overlay;
        this._cheatPanel = new BeetleRaceCheatPanel(this._els.cheat, {
            bounds: overlay.querySelector('.parlor-br-felt'),
            handle: '.parlor-br-cheat-head'
        });

        const state = this.gameInstance.getState();
        this._stage = new BeetleRaceStage(this._els.stageHost, state.race, {
            onPick: () => {
                this._playBeetleSound('swish');
                this._renderCaption(this.gameInstance.getState(), true);
            }
        });
        this._board = new BeetleRaceBoard(this._els.boardHost, state.race, {
            t: (key, data) => this._t(key, data),
            placeLabel: (n) => this._t(`PARLOR.BeetleRace.Place.${Math.min(8, n)}`)
        });
    }

    // ───────── 刷新（收到状态时） ─────────

    refresh() {
        if (this._presenterHost) {
            const state = this.gameInstance.getState();
            this._syncSim(state);
            this._presenterHost.refresh(state);
            // 结算弹窗挂在 body 上、不在呈现器 root 里，主题模式下也得由本体自己开关
            this._syncSettlement(state);
            return;
        }
        this._refreshNative();
    }

    _refreshNative() {
        if (!this._overlay) return;
        const state = this.gameInstance.getState();
        if (state.phase !== this._prevPhase) this._onPhaseChange(this._prevPhase, state.phase, state);
        this._prevPhase = state.phase;

        const stageMode = state.phase === 'PARADE' || state.phase === 'BETTING' || state.phase === 'IDLE';
        this._overlay.dataset.phase = state.phase;
        this._overlay.classList.toggle('is-stage', stageMode);
        this._stage.setMode(state.phase === 'PARADE' ? 'parade' : 'carousel');

        this._syncSim(state);
        this._renderHead(state);
        this._renderSoundButton();
        this._renderCaption(state);
        this._renderGm(state);
        this._renderStands(state);
        this._renderHud(state);
        this._board.setBets(state.bets, (id) => this._coinFace(state, id));
        this._syncSettlement(state);
        if (state.phase !== 'RACING') this._closeCheat();
    }

    _onPhaseChange(from, to, state) {
        if (to === 'BETTING') {
            this._openLocalAt = from === 'PARADE' ? 0 : performance.now();
            this._resetRaceView();
            // 进下注时挑选台先停在赔率最高的冷门上还是第一只？停第一只，别替玩家做选择
            this._stage.setPick(0, { notify: false });
            if (!this._stake) this._stake = Math.max(state.race.minBet || 1, 10);
        }
        if (to === 'COUNTDOWN') this._board.openGate(false);
        if (to === 'RACING') {
            this._goShownAt = performance.now();
            this._board.openGate(true);
            this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Start'), 'start');
        }
        if (to === 'RESOLVING' && state.result?.winnerLane >= 0) this._board.markPayout(state.result.winnerLane);
        this._renderHud(state, true);
    }

    // 新一场：赛道板整个换一块新的，撞线火漆、彩带、筹码都回到开局样子
    _resetRaceView() {
        const race = this.gameInstance.getState().race;
        this._board?.destroy();
        this._board = new BeetleRaceBoard(this._els.boardHost, race, {
            t: (key, data) => this._t(key, data),
            placeLabel: (n) => this._t(`PARLOR.BeetleRace.Place.${Math.min(8, n)}`)
        });
        this._runner.reset();
        this._eventCursor = 0;
        this._herald = [];
        this._calledHalf = false;
        this._calledFinal = false;
        this._lastLeader = -1;
    }

    // ───────── 本地模拟 ─────────

    _syncSim(state) {
        // 新建的模拟从头解说；重算的事件表会重新生成，游标在解说里按长度夹一下就行
        if (this._runner.sync(state) === 'created') this._eventCursor = 0;
    }

    // ───────── 每帧 ─────────

    _startLoop() {
        cancelAnimationFrame(this._raf);
        this._lastFrame = performance.now();
        const frame = (now) => {
            if (!this._overlay) return;
            const dt = Math.min(0.05, (now - this._lastFrame) / 1000);
            this._lastFrame = now;
            try {
                this._frame(dt);
            } catch (err) {
                console.error('parlor | beetle race frame failed', err);
            }
            this._raf = requestAnimationFrame(frame);
        };
        this._raf = requestAnimationFrame(frame);
    }

    _frame(dt) {
        const state = this.gameInstance.getState();
        const clock = this.gameInstance.getClock();
        this._renderTimer(state, clock);
        this._tickSound();

        if (this._overlay.classList.contains('is-stage')) {
            this._stage.setOpening(this._curtainProgress(state, clock));
            this._stage.update({ paradeIndex: state.paradeIndex, paradeElapsedMs: clock.paradeElapsedMs, dt });
            return;
        }

        if (state.phase === 'COUNTDOWN') {
            const left = clock.countdownRemainingMs;
            const n = left > COUNTDOWN_MS * 2 / 3 ? 3 : (left > COUNTDOWN_MS / 3 ? 2 : 1);
            if (this._countShown !== n) {
                this._countShown = n;
                this._board.showCount(String(n));
            }
        } else if (this._countShown) {
            this._countShown = 0;
            if (state.phase === 'RACING') this._board.showCount(this._t('PARLOR.BeetleRace.Board.Go'), true);
        }
        if (this._goShownAt && performance.now() - this._goShownAt > 900) {
            this._goShownAt = 0;
            this._board.clearCount();
        }

        const sim = this._runner.advance(state, clock, dt);
        if (!sim) {
            this._board.update({ lanes: null, dt, racing: false });
            return;
        }
        const lanes = sim.getLanes();
        this._board.update({ lanes, timeScale: sim.timeScale, order: sim.finishedOrder, dt, racing: true });
        this._commentate(state, sim, lanes);
    }

    _curtainProgress(state, clock) {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 1;
        if (state.phase === 'IDLE') return 0;
        if (state.phase === 'PARADE') return Number(clock.paradeElapsedMs || 0) / PARADE_INTRO_MS;
        if (!this._openLocalAt) return 1;
        const progress = (performance.now() - this._openLocalAt) / 2000;
        if (progress >= 1) this._openLocalAt = 0;
        return progress;
    }

    // on 不传就按设置画；点按钮那一下设置还没落盘，先按预期状态画，免得图标慢一拍
    _renderSoundButton(on = isBeetleSoundOn()) {
        const button = this._els?.sound;
        if (!button) return;
        // 玩家看不到这个按钮：开不开是 GM 替全桌定的
        button.hidden = !game.user?.isGM;
        const label = this._t(on ? 'PARLOR.BeetleRace.Sound.On' : 'PARLOR.BeetleRace.Sound.Off');
        button.classList.toggle('is-off', !on);
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', on ? 'false' : 'true');
        button.querySelector('i').className = on ? 'fas fa-volume-high' : 'fas fa-volume-xmark';
    }

    _renderTimer(state, clock) {
        let text = '';
        if (state.phase === 'BETTING') text = this._t('PARLOR.BeetleRace.Head.BettingLeft', { seconds: Math.ceil(clock.bettingRemainingMs / 1000) });
        else if (state.phase === 'PARADE') text = this._t('PARLOR.BeetleRace.Head.ParadeOf', { index: Math.min(state.race.lanes.length, state.paradeIndex + 1), total: state.race.lanes.length });
        if (text !== this._timerText) {
            this._timerText = text;
            this._els.timer.textContent = text;
            this._els.timer.classList.toggle('is-urgent', state.phase === 'BETTING' && clock.bettingRemainingMs < 5500);
        }
    }

    // ───────── 解说 ─────────

    _commentate(state, sim, lanes) {
        const events = sim.events;
        this._eventCursor = Math.min(this._eventCursor, events.length);
        while (this._eventCursor < events.length) {
            const ev = events[this._eventCursor++];
            // 暗调不解说：那本来就是要瞒着人的
            if (ev.kind === 'bias' || !ev.actionId) continue;
            const name = state.race.lanes[ev.lane]?.name || '';
            const action = this._t(`PARLOR.BeetleRace.Action.${ev.actionId}.Name`);
            this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Action', { name, action }), ACTIONS[ev.actionId]?.category || 'show');
        }
        if (sim.finishedOrder.length) {
            if (!this._calledFinish) {
                this._calledFinish = true;
                const winner = sim.finishedOrder[0];
                this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Finish', { name: state.race.lanes[winner].name }), 'win');
            }
            if (!this._calledPhoto && sim.finishedOrder.length > 1) {
                this._calledPhoto = true;
                const [a, b] = sim.finishedOrder;
                if (Math.abs(sim.lanes[b].finishStep - sim.lanes[a].finishStep) < 12) {
                    this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Photo', { name: state.race.lanes[b].name }), 'boost');
                }
            }
            return;
        }
        this._calledFinish = false;
        this._calledPhoto = false;
        const lead = lanes.reduce((best, lane) => (lane.x > best.x ? lane : best), lanes[0]);
        const now = performance.now();
        if (lead && lead.index !== this._lastLeader) {
            if (this._lastLeader >= 0 && now - this._lastLeadCall > LEAD_CALL_GAP_MS && lead.x > 60) {
                this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Lead', { name: state.race.lanes[lead.index].name }), 'lead');
                this._lastLeadCall = now;
            }
            this._lastLeader = lead.index;
        }
        if (!this._calledHalf && lead.x > 500) {
            this._calledHalf = true;
            this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Half'), 'start');
        }
        if (!this._calledFinal && lead.x > 800) {
            this._calledFinal = true;
            this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Final'), 'lead');
        }
    }

    _pushHerald(text, tone = '') {
        if (!text || this._herald[this._herald.length - 1]?.text === text) return;
        this._herald.push({ text, tone });
        this._herald = this._herald.slice(-HERALD_LINES);
        this._els.herald.innerHTML = this._herald.map((line, i) => `
            <div class="parlor-br-herald-line tone-${this._escape(line.tone)}${i === this._herald.length - 1 ? ' is-new' : ''}">${this._escape(line.text)}</div>
        `).join('');
    }

    // ───────── 头部 / 字幕 ─────────

    _renderHead(state) {
        this._els.raceName.textContent = state.race?.name || '';
        this._els.round.textContent = this._t('PARLOR.BeetleRace.Head.Round', { round: state.round });
        this._els.phase.textContent = this._t(`PARLOR.BeetleRace.Phase.${state.phase}`);
        if (state.phase === 'PARADE' && !this._herald.length) this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Parade'), 'start');
        if (state.phase === 'BETTING' && this._heraldPhase !== 'BETTING') this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Betting'), 'start');
        if (state.phase === 'COUNTDOWN' && this._heraldPhase !== 'COUNTDOWN') this._pushHerald(this._t('PARLOR.BeetleRace.Herald.Closed'), 'lead');
        this._heraldPhase = state.phase;
    }

    _powerText(race, lane) {
        switch (race.powerDisplay) {
            case 'number': return this._t('PARLOR.BeetleRace.Caption.PowerNumber', { power: lane.power });
            case 'stars': {
                const stars = Math.max(1, Math.round(lane.power / 2));
                return `${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;
            }
            default: return this._t('PARLOR.BeetleRace.Caption.PowerHidden');
        }
    }

    _renderCaption(state, force = false) {
        const race = state.race;
        const parade = state.phase === 'PARADE';
        const index = parade ? Math.min(state.paradeIndex, race.lanes.length - 1) : this._stage.pick;
        const lane = race.lanes[index];
        if (!lane) return;
        const backers = parade ? [] : state.bets.filter(bet => bet.lane === index);
        const key = JSON.stringify([state.phase, index, backers.map(bet => [bet.userId, bet.amount])]);
        if (!force && key === this._captionKey) return;
        this._captionKey = key;
        const shades = deriveShades(lane.color);
        const stats = lane.stats?.races ? this._t('PARLOR.BeetleRace.Caption.Stats', { races: lane.stats.races, wins: lane.stats.wins }) : this._t('PARLOR.BeetleRace.Caption.Debut');
        const backerHtml = backers.length
            ? backers.map(bet => `<span class="parlor-br-backer">${this._escape(this._playerName(state, bet.userId))} · ${bet.amount}</span>`).join('')
            : `<span class="parlor-br-backer is-empty">${this._escape(this._t('PARLOR.BeetleRace.Caption.NoBackers'))}</span>`;
        this._els.caption.innerHTML = `
            <div class="parlor-br-caption-plate" style="--br-c:${this._escape(lane.color)};--br-cd:${this._escape(shades.dark)}">
                <span class="parlor-br-caption-num">${index + 1}</span>
                <div class="parlor-br-caption-main">
                    <div class="parlor-br-caption-name">${this._escape(lane.name)}</div>
                    <div class="parlor-br-caption-meta">
                        <span class="parlor-br-caption-power">${this._escape(this._powerText(race, lane))}</span>
                        <span>${this._escape(stats)}</span>
                        ${parade ? '' : `<span class="parlor-br-caption-odds">×${Number(lane.multiplier).toFixed(1)}</span>`}
                    </div>
                </div>
            </div>
            <p class="parlor-br-caption-intro">${this._escape(lane.intro || '')}</p>
            ${parade ? '' : `<div class="parlor-br-backers"><span class="parlor-br-backers-label">${this._escape(this._t('PARLOR.BeetleRace.Caption.Backers'))}</span>${backerHtml}</div>`}
        `;
        this._renderHud(this.gameInstance.getState());
    }

    // ───────── DM 工具栏 ─────────

    _renderGm(state) {
        if (!game.user.isGM) {
            this._els.gm.hidden = true;
            return;
        }
        const key = state.phase;
        if (key === this._gmKey) return;
        this._gmKey = key;
        const buttons = [];
        if (state.phase === 'PARADE') buttons.push(['skipParade', 'fas fa-forward', 'PARLOR.BeetleRace.Gm.SkipParade']);
        if (state.phase === 'BETTING') buttons.push(['closeBetting', 'fas fa-flag-checkered', 'PARLOR.BeetleRace.Gm.CloseBetting']);
        const hint = state.phase === 'RACING' ? `<span class="parlor-br-gm-hint"><i class="fas fa-hat-wizard"></i> ${this._escape(this._t('PARLOR.BeetleRace.Gm.CheatHint'))}</span>` : '';
        this._els.gm.hidden = !buttons.length && !hint;
        this._els.gm.innerHTML = `
            <span class="parlor-br-gm-tag">${this._escape(this._t('PARLOR.BeetleRace.Gm.Tag'))}</span>
            ${buttons.map(([action, icon, label]) => `<button type="button" class="parlor-br-btn is-accent" data-gm="${action}"><i class="${icon}"></i> ${this._escape(this._t(label))}</button>`).join('')}
            ${hint}
        `;
    }

    _onGmClick(event) {
        const button = event.target.closest('[data-gm]');
        if (!button) return;
        this._requestGMAction({ action: button.dataset.gm, button });
    }

    // ───────── 作弊面板 ─────────

    _onBoardClick(event) {
        if (!game.user.isGM) return;
        const state = this.gameInstance.getState();
        if (state.phase !== 'RACING') return;
        const lane = this._board.laneAtPoint(event.clientX, event.clientY);
        if (lane < 0) return;
        this._openCheat(lane);
    }

    _openCheat(lane) {
        const state = this.gameInstance.getState();
        if (!game.user.isGM || state.phase !== 'RACING' || !state.race.lanes[lane]) return;
        if (this._runner.sim?.lanes[lane]?.done) {
            ui.notifications.info(this._t('PARLOR.BeetleRace.Error.AlreadyFinished'));
            return;
        }
        this._cheatLane = lane;
        const racer = state.race.lanes[lane];
        const moves = state.race.cheats || [];
        const moveButton = (move) => {
            const def = ACTIONS[move.actionId];
            const tone = def?.magic ? 'is-magic' : (def?.category === 'boost' ? 'is-boost' : 'is-stall');
            const action = this._t(`PARLOR.BeetleRace.Action.${move.actionId}.Name`);
            const tip = move.bubble ? `${action} · ${move.bubble}` : action;
            return `<button type="button" class="parlor-br-cheat-move ${tone}" data-move="${this._escape(move.id)}" title="${this._escape(tip)}">${this._escape(move.name)}</button>`;
        };
        const cheats = moves.filter(move => move.pool === 'cheat');
        const natural = moves.filter(move => move.pool === 'random');
        const bias = Number(state.biases?.[lane] ?? 1);
        this._els.cheat.innerHTML = `
            <div class="parlor-br-cheat-head">
                <span class="parlor-br-cheat-dot" style="background:${this._escape(racer.color)}">${lane + 1}</span>
                <span class="parlor-br-cheat-title">${this._escape(racer.name)}</span>
                <button type="button" class="parlor-br-cheat-x" data-cheat-close aria-label="${this._escape(this._t('PARLOR.Common.Close'))}">×</button>
            </div>
            <div class="parlor-br-cheat-sec">${this._escape(this._t('PARLOR.BeetleRace.Cheat.Blatant'))}</div>
            <div class="parlor-br-cheat-grid">${cheats.map(moveButton).join('') || `<span class="parlor-br-cheat-empty">${this._escape(this._t('PARLOR.BeetleRace.Cheat.None'))}</span>`}</div>
            <div class="parlor-br-cheat-sec" title="${this._escape(this._t('PARLOR.BeetleRace.Cheat.NaturalHint'))}">${this._escape(this._t('PARLOR.BeetleRace.Cheat.Natural'))}</div>
            <div class="parlor-br-cheat-grid">${natural.map(moveButton).join('') || `<span class="parlor-br-cheat-empty">${this._escape(this._t('PARLOR.BeetleRace.Cheat.None'))}</span>`}</div>
            <div class="parlor-br-cheat-sec" title="${this._escape(this._t('PARLOR.BeetleRace.Cheat.BiasHint'))}">${this._escape(this._t('PARLOR.BeetleRace.Cheat.Bias'))}</div>
            <div class="parlor-br-cheat-bias">
                <span>${this._escape(this._t('PARLOR.BeetleRace.Cheat.Slower'))}</span>
                <input type="range" min="0.4" max="1.8" step="0.05" value="${bias}" data-cheat-bias>
                <span>${this._escape(this._t('PARLOR.BeetleRace.Cheat.Faster'))}</span>
                <b data-cheat-bias-value>×${bias.toFixed(2)}</b>
                <button type="button" class="parlor-br-btn" data-cheat-bias-apply>${this._escape(this._t('PARLOR.BeetleRace.Cheat.Apply'))}</button>
                <button type="button" class="parlor-br-btn" data-cheat-bias-reset>${this._escape(this._t('PARLOR.BeetleRace.Cheat.Reset'))}</button>
            </div>
        `;
        this._els.cheat.hidden = false;
        this._positionCheat();
    }

    // 只在打开时避让甲虫；比赛中换边会抢走鼠标下的按钮，拖过的位置由用户掌握。
    _positionCheat() {
        this._cheatPanel.open(this._board.beetleScreenPoint(this._cheatLane));
    }

    _closeCheat() {
        if (this._cheatLane < 0) return;
        this._cheatLane = -1;
        this._cheatPanel?.close();
        this._els.cheat.hidden = true;
    }

    _onCheatClick(event) {
        if (event.target.closest('[data-cheat-close]')) {
            this._closeCheat();
            return;
        }
        const lane = this._cheatLane;
        const move = event.target.closest('[data-move]');
        if (move) {
            this._requestGMAction({ action: 'cheat', data: { lane, moveId: move.dataset.move }, key: `gm:cheat:${lane}`, button: move });
            this._closeCheat();
            return;
        }
        const slider = this._els.cheat.querySelector('[data-cheat-bias]');
        if (event.target.closest('[data-cheat-bias-apply]')) {
            this._requestGMAction({ action: 'bias', data: { lane, mul: Number(slider.value) }, key: `gm:bias:${lane}` });
            this._closeCheat();
        } else if (event.target.closest('[data-cheat-bias-reset]')) {
            this._requestGMAction({ action: 'bias', data: { lane, mul: 1 }, key: `gm:bias:${lane}` });
            this._closeCheat();
        }
    }

    _onCheatInput(event) {
        if (!event.target.matches('[data-cheat-bias]')) return;
        this._els.cheat.querySelector('[data-cheat-bias-value]').textContent = `×${Number(event.target.value).toFixed(2)}`;
    }

    _handleKey(event) {
        if (!this._overlay || event.target.closest?.('input, textarea, select')) return;
        const state = this.gameInstance.getState();
        if (event.key === 'Escape' && this._cheatLane >= 0) {
            this._closeCheat();
            event.preventDefault();
            return;
        }
        if (state.phase === 'BETTING' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            this._stage.step(event.key === 'ArrowLeft' ? -1 : 1);
            event.preventDefault();
            return;
        }
        // DM 比赛中按 1–8 直接点这条道的虫
        if (game.user.isGM && state.phase === 'RACING' && /^[1-8]$/u.test(event.key)) {
            const lane = Number(event.key) - 1;
            if (state.race.lanes[lane]) {
                this._openCheat(lane);
                event.preventDefault();
            }
        }
    }

    // ───────── 看台 ─────────

    _renderStands(state) {
        const people = [...state.playerIds];
        const res = state.phase === 'RESOLVING' ? state.result : null;
        const key = JSON.stringify([state.phase, people, state.bets, res?.rows?.map(row => [row.id, row.net])]);
        if (key === this._standsKey) return;
        this._standsKey = key;
        if (!people.length) {
            this._els.stands.innerHTML = '';
            return;
        }
        const selfIds = new Set(getControlledParticipants(state).map(entry => entry.id));
        this._els.stands.innerHTML = `
            <span class="parlor-br-stands-label">${this._escape(this._t('PARLOR.BeetleRace.Stands.Label'))}</span>
            ${people.map(id => {
                const display = this._describe(state, id);
                const bets = state.bets.filter(bet => bet.userId === id);
                const row = res?.rows?.find(entry => entry.id === id);
                const chips = bets.map(bet => {
                    const lane = state.race.lanes[bet.lane];
                    return `<span class="parlor-br-stand-bet" style="--br-c:${this._escape(lane.color)}"><i>${bet.lane + 1}</i>${bet.amount}</span>`;
                }).join('');
                const net = row ? `<span class="parlor-br-stand-net ${row.net > 0 ? 'is-up' : row.net < 0 ? 'is-down' : ''}">${row.net > 0 ? '+' : ''}${row.net}</span>` : '';
                return `<div class="parlor-br-stand${selfIds.has(id) ? ' is-self' : ''}">
                    <span class="parlor-br-stand-ava">${display.avatarHtml || this._escape((display.name || '?').slice(0, 1))}</span>
                    <span class="parlor-br-stand-name">${this._escape(display.name || '')}</span>
                    ${chips || `<span class="parlor-br-stand-idle">${this._escape(this._t('PARLOR.BeetleRace.Stands.Watching'))}</span>`}
                    ${net}
                </div>`;
            }).join('')}
        `;
    }

    _coinFace(state, participantId) {
        const name = this._playerName(state, participantId).replace(/^🤖\s*/u, '');
        const self = getControlledParticipants(state).some(entry => entry.id === participantId);
        return { initial: [...name][0] || '?', self };
    }

    // ───────── 注单 ─────────

    _getSelectableParticipantIds(state) {
        return getControlledParticipants(state).map(entry => entry.id).filter(id => state.playerIds.includes(id));
    }

    _getSelectedParticipantId(state) {
        const ids = this._getSelectableParticipantIds(state);
        if (!ids.includes(this._selectedParticipantId)) this._selectedParticipantId = ids[0] || '';
        return this._selectedParticipantId;
    }

    _isExempt(state, participantId) {
        return BotManager.isBot(participantId) || (state.exemptParticipantIds || []).includes(participantId);
    }

    _renderHud(state, force = false) {
        const id = this._getSelectedParticipantId(state);
        const pick = this._stage?.pick ?? 0;
        const key = JSON.stringify([state.phase, id, pick, this._stake, state.bets.filter(bet => bet.userId === id), state.result?.rows?.find(row => row.id === id), this._getSelectableParticipantIds(state)]);
        if (!force && key === this._hudKey) return;
        this._hudKey = key;
        const hud = this._els.hud;
        if (!id) {
            hud.innerHTML = `<div class="parlor-br-hud-watch"><i class="fas fa-eye"></i> ${this._escape(this._t(game.user.isGM ? 'PARLOR.BeetleRace.Hud.GmWatching' : 'PARLOR.BeetleRace.Hud.Watching'))}</div>`;
            return;
        }
        const display = this._describe(state, id);
        const exempt = this._isExempt(state, id);
        const balance = exempt ? '∞' : SettlementManager.getDisplayBalance(id);
        const staked = stakeOf(state.bets, id);
        const ids = this._getSelectableParticipantIds(state);
        const selector = ids.length > 1
            ? `<select class="parlor-br-hud-who-select" data-hud-who>${ids.map(pid => `<option value="${this._escape(pid)}" ${pid === id ? 'selected' : ''}>${this._escape(this._playerName(state, pid))}</option>`).join('')}</select>`
            : `<span class="parlor-br-hud-who-name">${this._escape(display.name || '')}</span>`;
        const mine = state.bets.filter(bet => bet.userId === id);
        const ticket = mine.length
            ? mine.map(bet => {
                const lane = state.race.lanes[bet.lane];
                const canRemove = state.phase === 'BETTING';
                return `<span class="parlor-br-ticket" style="--br-c:${this._escape(lane.color)}">
                    <i>${bet.lane + 1}</i><span>${this._escape(lane.name)}</span><b>${bet.amount}</b>
                    ${canRemove ? `<button type="button" data-hud-remove="${bet.lane}" aria-label="${this._escape(this._t('PARLOR.BeetleRace.Hud.Remove'))}">×</button>` : ''}
                </span>`;
            }).join('')
            // 提示"去挑一只"只在下注时有意义，别的阶段就是空着
            : `<span class="parlor-br-ticket-empty">${state.phase === 'BETTING' ? this._escape(this._t('PARLOR.BeetleRace.Hud.NoBets')) : '—'}</span>`;

        let action = '';
        if (state.phase === 'BETTING') {
            const lane = state.race.lanes[pick];
            const current = betOn(state.bets, id, pick)?.amount || 0;
            const stake = Math.max(0, Math.floor(Number(this._stake) || 0));
            const returns = Math.floor(stake * Number(lane.multiplier));
            action = `
                <div class="parlor-br-hud-stake">
                    <label>${this._escape(this._t('PARLOR.BeetleRace.Hud.Stake'))}</label>
                    <input type="number" min="0" step="1" value="${stake}" data-hud-stake>
                    <div class="parlor-br-hud-quick">
                        ${QUICK_STAKES.map(v => `<button type="button" data-hud-add="${v}">+${v}</button>`).join('')}
                        <button type="button" data-hud-add="0">${this._escape(this._t('PARLOR.BeetleRace.Hud.Clear'))}</button>
                    </div>
                </div>
                <div class="parlor-br-hud-buttons">
                    <button type="button" class="parlor-br-btn" data-hud-clear ${mine.length ? '' : 'disabled'}>${this._escape(this._t('PARLOR.BeetleRace.Hud.Withdraw'))}</button>
                    <button type="button" class="parlor-br-btn is-accent is-big" data-hud-bet ${stake > 0 ? '' : 'disabled'}>
                        ${this._escape(this._t(current ? 'PARLOR.BeetleRace.Hud.Change' : 'PARLOR.BeetleRace.Hud.Bet', { n: pick + 1, name: lane.name }))}
                        <small>${this._escape(this._t('PARLOR.BeetleRace.Hud.Returns', { amount: returns }))}</small>
                    </button>
                </div>`;
        } else if (state.phase === 'RESOLVING' && state.result?.rows) {
            const row = state.result.rows.find(entry => entry.id === id);
            action = row
                ? `<div class="parlor-br-hud-result ${row.net > 0 ? 'is-up' : 'is-down'}">${this._escape(this._t(row.payout > 0 ? 'PARLOR.BeetleRace.Hud.Won' : 'PARLOR.BeetleRace.Hud.Lost', { amount: row.payout > 0 ? row.payout : row.staked }))}</div>`
                : `<div class="parlor-br-hud-result">${this._escape(this._t('PARLOR.BeetleRace.Hud.NoBetThisRound'))}</div>`;
        } else if (state.phase !== 'PARADE') {
            action = `<div class="parlor-br-hud-result">${this._escape(this._t(mine.length ? 'PARLOR.BeetleRace.Hud.Locked' : 'PARLOR.BeetleRace.Hud.NoBetThisRound'))}</div>`;
        } else {
            action = `<div class="parlor-br-hud-result">${this._escape(this._t('PARLOR.BeetleRace.Hud.WaitParade'))}</div>`;
        }

        hud.innerHTML = `
            <div class="parlor-br-hud-who">
                <span class="parlor-br-hud-ava">${display.avatarHtml || this._escape((display.name || '?').slice(0, 1))}</span>
                <div class="parlor-br-hud-id">
                    ${selector}
                    <span class="parlor-br-hud-balance">${this._escape(this._t('PARLOR.BeetleRace.Hud.Balance', { amount: balance }))}</span>
                    <span class="parlor-br-hud-sub">${this._escape(this._t('PARLOR.BeetleRace.Hud.Staked', { amount: staked }))}</span>
                </div>
            </div>
            <div class="parlor-br-hud-ticket">
                <span class="parlor-br-hud-label">${this._escape(this._t('PARLOR.BeetleRace.Hud.Ticket'))}</span>
                <div class="parlor-br-hud-tickets">${ticket}</div>
            </div>
            <div class="parlor-br-hud-action">${action}</div>
        `;
    }

    _onHudClick(event) {
        const state = this.gameInstance.getState();
        const id = this._getSelectedParticipantId(state);
        const add = event.target.closest('[data-hud-add]');
        if (add) {
            const value = Number(add.dataset.hudAdd);
            this._stake = value ? Math.max(0, Math.floor(Number(this._stake) || 0)) + value : 0;
            this._renderHud(state, true);
            return;
        }
        const remove = event.target.closest('[data-hud-remove]');
        if (remove && id) {
            this._requestPlayerAction({ userId: id, action: 'placeBet', data: { lane: Number(remove.dataset.hudRemove), amount: 0 }, button: remove });
            return;
        }
        if (event.target.closest('[data-hud-clear]') && id) {
            this._requestPlayerAction({ userId: id, action: 'clearBets', button: event.target.closest('button') });
            return;
        }
        const bet = event.target.closest('[data-hud-bet]');
        if (bet && id) {
            this._requestPlayerAction({ userId: id, action: 'placeBet', data: { lane: this._stage.pick, amount: Math.floor(Number(this._stake) || 0) }, button: bet });
        }
    }

    _onHudChange(event) {
        if (event.target.matches('[data-hud-stake]')) {
            this._stake = Math.max(0, Math.floor(Number(event.target.value) || 0));
            this._renderHud(this.gameInstance.getState(), true);
        } else if (event.target.matches('[data-hud-who]')) {
            this._selectedParticipantId = event.target.value;
            this._renderHud(this.gameInstance.getState(), true);
        }
    }

    // ───────── 结算 ─────────

    _syncSettlement(state) {
        if (state.phase !== 'RESOLVING') {
            // 离开结算（下一场开盘）就把"弹过了"清掉，两种模式都走这一处
            this._settlementShown = false;
            clearTimeout(this._settlementTimer);
            this._setSettlementActive(false);
            document.querySelector(`#${SETTLEMENT_ID}`)?.remove();
            return;
        }
        // 撞线之后本地可能还在慢镜里：等这一端也跑完再弹，别把冲线挡住
        if (this._settlementShown) return;
        if (!this._runner.settled) {
            clearTimeout(this._settlementTimer);
            this._settlementTimer = setTimeout(() => this._syncSettlement(this.gameInstance.getState()), 400);
            return;
        }
        this._settlementShown = true;
        this._settlementTimer = setTimeout(() => this._showSettlement(this.gameInstance.getState()), 900);
    }

    _setSettlementActive(active) {
        if (active) this._settlementFocus = document.activeElement;
        if (this._overlay) this._overlay.inert = active;
        if (this._presenterHost?.root) this._presenterHost.root.inert = active;
        if (!active && this._settlementFocus?.isConnected) this._settlementFocus.focus();
        if (!active) this._settlementFocus = null;
    }

    _showSettlement(state) {
        if (state.phase !== 'RESOLVING' || (!this._overlay && !this._presenterHost)) return;
        document.querySelector(`#${SETTLEMENT_ID}`)?.remove();
        const result = state.result || {};
        const popup = document.createElement('div');
        popup.id = SETTLEMENT_ID;
        const order = state.order || [];
        const podium = order.slice(0, 3).map((laneIndex, place) => {
            const lane = state.race.lanes[laneIndex];
            return `<li class="parlor-br-podium-${place + 1}" style="--br-c:${this._escape(lane.color)}">
                <span class="parlor-br-podium-place">${this._escape(this._t(`PARLOR.BeetleRace.Place.${place + 1}`))}</span>
                <span class="parlor-br-podium-dot">${laneIndex + 1}</span>
                <span class="parlor-br-podium-name">${this._escape(lane.name)}</span>
                ${place === 0 ? `<span class="parlor-br-podium-odds">×${Number(lane.multiplier).toFixed(1)}</span>` : ''}
            </li>`;
        }).join('');
        const rows = (result.rows || []).map(row => `
            <tr class="${row.payout > 0 ? 'is-winner' : ''}">
                <td>${this._escape(this._playerName(state, row.id))}</td>
                <td><div class="parlor-br-settlement-bets">${row.stakes.map(stake => `<span class="parlor-br-stand-bet" style="--br-c:${this._escape(state.race.lanes[stake.lane].color)}"><i>${stake.lane + 1}</i>${stake.amount}</span>`).join('')}</div></td>
                <td>${row.payout}</td>
                <td class="${row.net > 0 ? 'is-up' : row.net < 0 ? 'is-down' : ''}">${row.net > 0 ? '+' : ''}${row.net}</td>
            </tr>`).join('');
        const winner = state.race.lanes[result.winnerLane];
        popup.innerHTML = `
            <div class="parlor-br-settlement-box" role="dialog" aria-modal="true" aria-labelledby="br-settlement-title">
                <div class="parlor-br-settlement-title" id="br-settlement-title">${this._escape(winner ? this._t('PARLOR.BeetleRace.Settlement.Winner', { name: winner.name }) : this._t('PARLOR.BeetleRace.Settlement.Aborted'))}</div>
                <ol class="parlor-br-podium">${podium}</ol>
                ${rows
                    ? `<div class="parlor-br-settlement-scroll"><table class="parlor-br-settlement-table">
                        <thead><tr>
                            <th>${this._escape(this._t('PARLOR.BeetleRace.Settlement.Player'))}</th>
                            <th>${this._escape(this._t('PARLOR.BeetleRace.Settlement.Bets'))}</th>
                            <th>${this._escape(this._t('PARLOR.BeetleRace.Settlement.Payout'))}</th>
                            <th>${this._escape(this._t('PARLOR.BeetleRace.Settlement.Net'))}</th>
                        </tr></thead><tbody>${rows}</tbody></table></div>`
                    : `<div class="parlor-br-settlement-empty">${this._escape(this._t('PARLOR.BeetleRace.Settlement.NoBets'))}</div>`}
                <div class="parlor-br-settlement-actions">
                    ${game.user.isGM
                        ? `<button type="button" class="parlor-br-btn" data-settle="finishGame"><i class="fas fa-door-closed"></i> ${this._escape(this._t('PARLOR.Common.Finish'))}</button>
                           <button type="button" class="parlor-br-btn is-accent" data-settle="newRound"><i class="fas fa-redo"></i> ${this._escape(this._t('PARLOR.BeetleRace.Settlement.Next'))}</button>`
                        : `<button type="button" class="parlor-br-btn" data-settle="dismiss"><i class="fas fa-times"></i> ${this._escape(this._t('PARLOR.Common.CloseResult'))}</button>`}
                </div>
            </div>
        `;
        document.body.appendChild(popup);
        // 主题模式下给弹窗打上主题标记，主题 CSS 按 data-presenter-theme 换皮
        this._presenterHost?.markDetachedSurface(popup, 'settlement');
        this._setSettlementActive(true);
        popup.querySelector('button')?.focus();
        popup.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-settle]');
            if (!button) return;
            if (button.dataset.settle === 'dismiss') {
                popup.remove();
                this._setSettlementActive(false);
                return;
            }
            const buttons = popup.querySelectorAll('button');
            buttons.forEach(entry => { entry.disabled = true; });
            try {
                await this._requestGMAction({ action: button.dataset.settle, button });
            } finally {
                buttons.forEach(entry => { if (entry.isConnected) entry.disabled = false; });
            }
        });
    }

    // ───────── 杂项 ─────────

    _describe(state, participantId) {
        const info = getDisplayParticipant(state, participantId);
        if (BotManager.isBot(participantId) && !info.name) info.name = BotManager.getBotName(participantId);
        return info;
    }

    _playerName(state, participantId) {
        if (!participantId) return '';
        if (BotManager.isBot(participantId)) return BotManager.getBotName(participantId);
        return getParticipantName(state, participantId);
    }

    async _runSocketAction(actionKey, button, request) {
        const running = this._actionRequests.get(actionKey);
        if (button) button.disabled = true;
        if (running) return running;
        const startedAt = Date.now();
        const pending = (async () => {
            try {
                const result = await request();
                if (result?.ok === false) this._showActionError(result);
                return result;
            } catch (error) {
                console.error('parlor | beetle race socket action failed:', error);
                ui.notifications.error(this._t('PARLOR.BeetleRace.Error.RequestFailed'));
                return { ok: false, reason: 'request-failed' };
            } finally {
                const rest = ACTION_LOCK_MS - (Date.now() - startedAt);
                if (rest > 0) await new Promise(resolve => setTimeout(resolve, rest));
                this._actionRequests.delete(actionKey);
                if (button?.isConnected) button.disabled = false;
            }
        })();
        this._actionRequests.set(actionKey, pending);
        return pending;
    }

    _showActionError(result) {
        const key = ERROR_KEYS[result?.reason];
        if (!key) return;
        ui.notifications.warn(this._t(`PARLOR.BeetleRace.Error.${key}`, { min: result.min ?? '', max: result.max ?? '', balance: result.balance ?? '' }));
    }

    _requestGMAction({ action, data = {}, key = `gm:${action}`, button = null }) {
        return this._runSocketAction(key, button, () => SocketManager.requestGM(SOCKET_EVENTS.GM_ACTION, { sessionId: this.sessionId, action, data }));
    }

    _requestPlayerAction({ userId, action, data = {}, key = `player:${userId}:${action}`, button = null }) {
        return this._runSocketAction(key, button, () => SocketManager.requestGM(SOCKET_EVENTS.PLAYER_ACTION, { sessionId: this.sessionId, userId, action, data }));
    }

    _escape(value) {
        return foundry.utils.escapeHTML(String(value ?? ''));
    }

    _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }
}
