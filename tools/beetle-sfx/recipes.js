// 甲虫赛跑音效配方：在酒馆与音乐的无头页面里离线合成（那边的 /assets/samples 全是 CC0 采样）。
// 这个文件被 build.mjs 原样塞进页面执行，所以不写 import/export，入口是 buildBeetleSfx(only)。
//
// 两类声音：
// - 有音高的（号角、钢片琴、手风琴、单簧管、手鼓）直接取采样，按清单里的音区换算变调
// - 乐器发不出来的（布幕呼声、闸门、电流、快门、刹车）用噪声和振荡器现合
// 每条出来都是单声道 48k，由 build.mjs 统一压峰值、转 ogg。响度差别靠运行时的音量表，不在这里拧。

const SR = 48000;
const SAMPLE_ROOT = '/assets/samples/';
let manifestPromise = null;
const decoded = new Map();
const decodeCtx = new OfflineAudioContext(1, 1, SR);

function manifest() {
    manifestPromise ??= fetch(SAMPLE_ROOT + 'manifest.json').then(r => r.json());
    return manifestPromise;
}

async function sampleBuffer(file) {
    if (!decoded.has(file)) {
        decoded.set(file, fetch(SAMPLE_ROOT + file).then(r => r.arrayBuffer()).then(b => decodeCtx.decodeAudioData(b)));
    }
    return decoded.get(file);
}

const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

// 确定性的"随机"：同一条配方每次合出来一样，改一处不会把别处也带变
function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
        s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d);
        s ^= s + Math.imul(s ^ (s >>> 7), 0x297a2d39);
        return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    };
}

function makeKit(ctx, seed = 1) {
    const rand = rng(seed);
    const master = ctx.createGain();
    master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 3;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    master.connect(comp).connect(ctx.destination);

    // 一点小房间混响：酒馆里放的，不是录音棚
    const verb = ctx.createConvolver();
    const irLen = Math.floor(SR * 0.9);
    const ir = ctx.createBuffer(1, irLen, SR);
    const d = ir.getChannelData(0);
    for (let i = 0; i < irLen; i++) d[i] = (rand() * 2 - 1) * Math.exp(-i / (SR * 0.18)) * 0.5;
    verb.buffer = ir;
    const verbSend = ctx.createGain();
    verbSend.gain.value = 0.16;
    verbSend.connect(verb).connect(master);

    const noiseBuf = (kind) => {
        const len = SR * 3;
        const buf = ctx.createBuffer(1, len, SR);
        const data = buf.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, brown = 0;
        for (let i = 0; i < len; i++) {
            const w = rand() * 2 - 1;
            if (kind === 'pink') {
                b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
                data[i] = (b0 + b1 + b2 + w * 0.1848) * 1.6;
            } else if (kind === 'brown') {
                brown = (brown + 0.02 * w) / 1.02;
                data[i] = brown * 3.5;
            } else {
                data[i] = w;
            }
        }
        return buf;
    };
    const noises = { white: noiseBuf('white'), pink: noiseBuf('pink'), brown: noiseBuf('brown') };

    // 包络：attack 线性上去，hold，release 指数落下
    const env = (param, t, { peak = 1, attack = 0.005, hold = 0, release = 0.2, from = 0 } = {}) => {
        param.setValueAtTime(from, t);
        param.linearRampToValueAtTime(peak, t + attack);
        param.setValueAtTime(peak, t + attack + hold);
        param.setTargetAtTime(0, t + attack + hold, Math.max(0.005, release / 4));
    };
    const route = (node, { dry = 1, wet = 1 } = {}) => {
        if (dry) { const g = ctx.createGain(); g.gain.value = dry; node.connect(g).connect(master); }
        if (wet) { const g = ctx.createGain(); g.gain.value = wet; node.connect(g).connect(verbSend); }
    };

    return {
        ctx, rand,
        // 有音高的采样：清单里挑力度层和音区，按半音换算播放速率；glideTo 做滑音（单簧管"哇哇"）
        async note(inst, midi, t, { dur = 0.5, vel = 0.7, gain = 1, glideTo = null, glideTime = 0.3, release, vibrato = null, wet = 1 } = {}) {
            const m = await manifest();
            const I = m.instruments[inst];
            if (!I) throw new Error(`no instrument ${inst}`);
            const layer = I.layers.find(l => vel <= l.maxVelocity) || I.layers[I.layers.length - 1];
            const zone = layer.zones.find(z => midi >= z.lo && midi <= z.hi)
                || layer.zones.reduce((best, z) => (Math.abs(z.root - midi) < Math.abs(best.root - midi) ? z : best), layer.zones[0]);
            const buf = await sampleBuffer(zone.file);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const rate = (mm) => 2 ** ((mm - zone.root) / 12 - (zone.tune || 0) / 1200);
            src.playbackRate.setValueAtTime(rate(midi), t);
            if (glideTo != null) src.playbackRate.exponentialRampToValueAtTime(rate(glideTo), t + glideTime);
            if (zone.loop && I.kind !== 'oneshot') {
                src.loop = true;
                src.loopStart = zone.loop[0];
                src.loopEnd = zone.loop[1];
            }
            if (vibrato) {
                const lfo = ctx.createOscillator();
                lfo.frequency.value = vibrato.rate;
                const depth = ctx.createGain();
                depth.gain.value = vibrato.depth;
                lfo.connect(depth).connect(src.detune);
                lfo.start(t + (vibrato.delay || 0));
                lfo.stop(t + dur + 1);
            }
            const g = ctx.createGain();
            // zone.gain 跟作曲器一样直接乘：它是把同一层各样本拉齐响度的系数，本身在 0.1–0.45 之间，再整体抬一下
            const level = gain * (zone.gain ?? 0.3) * 2.6 * (0.35 + vel * 0.65);
            const rel = release ?? I.release ?? 0.2;
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(level, t + 0.004);
            g.gain.setValueAtTime(level, t + dur);
            g.gain.setTargetAtTime(0, t + dur, Math.max(0.01, rel / 3));
            src.connect(g);
            route(g, { wet });
            src.start(t);
            src.stop(t + dur + rel * 3 + 0.1);
        },
        // 无音高采样（手鼓、沙锤）：rate 调松紧
        async hit(file, t, { gain = 1, rate = 1, wet = 1 } = {}) {
            const buf = await sampleBuffer(file);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            const g = ctx.createGain();
            g.gain.value = gain;
            src.connect(g);
            route(g, { wet });
            src.start(t);
        },
        // 噪声：带通/低通/高通扫频，可选振幅调制（翅膀扑、打呼、滚动）
        noise(t, dur, { color = 'white', type = 'bandpass', f0 = 1000, f1 = null, q = 1, gain = 0.5, attack = 0.01, release = 0.1, am = null, wet = 0.6, curve = 'exp' } = {}) {
            const src = ctx.createBufferSource();
            src.buffer = noises[color];
            src.loop = true;
            const filter = ctx.createBiquadFilter();
            filter.type = type;
            filter.Q.value = q;
            filter.frequency.setValueAtTime(f0, t);
            if (f1 != null) {
                if (curve === 'exp') filter.frequency.exponentialRampToValueAtTime(f1, t + dur);
                else filter.frequency.linearRampToValueAtTime(f1, t + dur);
            }
            const g = ctx.createGain();
            env(g.gain, t, { peak: gain, attack, hold: Math.max(0, dur - attack), release });
            let tail = g;
            if (am) {
                const vca = ctx.createGain();
                vca.gain.value = 1 - am.depth / 2;
                const lfo = ctx.createOscillator();
                lfo.type = am.shape || 'sine';
                lfo.frequency.setValueAtTime(am.rate, t);
                if (am.rateTo) lfo.frequency.linearRampToValueAtTime(am.rateTo, t + dur);
                const depth = ctx.createGain();
                depth.gain.value = am.depth / 2;
                lfo.connect(depth).connect(vca.gain);
                lfo.start(t);
                lfo.stop(t + dur + release + 0.2);
                g.connect(vca);
                tail = vca;
            }
            src.connect(filter).connect(g);
            route(tail, { wet });
            src.start(t, rand() * 2);
            src.stop(t + dur + release * 4 + 0.2);
        },
        // 振荡器：音高包络 + 可选颤音；type=square/sawtooth 时串个低通别太刺
        tone(t, dur, { type = 'sine', f0 = 440, f1 = null, glide = dur, gain = 0.3, attack = 0.005, release = 0.1, vibrato = null, lowpass = null, wet = 0.5, curve = 'exp' } = {}) {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.setValueAtTime(f0, t);
            if (f1 != null) {
                if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(f1, t + glide);
                else osc.frequency.linearRampToValueAtTime(f1, t + glide);
            }
            if (vibrato) {
                const lfo = ctx.createOscillator();
                lfo.frequency.setValueAtTime(vibrato.rate, t);
                if (vibrato.rateTo) lfo.frequency.linearRampToValueAtTime(vibrato.rateTo, t + dur);
                const depth = ctx.createGain();
                depth.gain.setValueAtTime(vibrato.depth, t);
                if (vibrato.depthTo != null) depth.gain.linearRampToValueAtTime(vibrato.depthTo, t + dur);
                lfo.connect(depth).connect(osc.detune);
                lfo.start(t);
                lfo.stop(t + dur + release + 0.2);
            }
            let head = osc;
            if (lowpass) {
                const lp = ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = lowpass;
                osc.connect(lp);
                head = lp;
            }
            const g = ctx.createGain();
            env(g.gain, t, { peak: gain, attack, hold: Math.max(0, dur - attack), release });
            head.connect(g);
            route(g, { wet });
            osc.start(t);
            osc.stop(t + dur + release * 4 + 0.2);
        },
        // 金属一声（闸门、铃）：几个不成谐波的分音一起衰减
        metal(t, { freqs = [320, 870, 1460, 2210], gain = 0.3, decay = 0.4, wet = 0.8 } = {}) {
            freqs.forEach((f, i) => {
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = f;
                const g = ctx.createGain();
                g.gain.setValueAtTime(gain / (1 + i * 0.6), t);
                g.gain.setTargetAtTime(0, t, decay / (3 + i));
                osc.connect(g);
                route(g, { wet });
                osc.start(t);
                osc.stop(t + decay * 2 + 0.2);
            });
        }
    };
}

// 常用的几种采样文件
const BODHRAN = { small: 'bodhran/small-hit-v2-rr1.ogg', small2: 'bodhran/small-hit-v2-rr2.ogg', smallLoud: 'bodhran/small-hit-v3-rr1.ogg', large: 'bodhran/large-hit-v3-rr1.ogg', largeMuted: 'bodhran/large-hitmuted-v3-rr1.ogg', hand: 'bodhran/small-hand.ogg' };
const RIM = { hit: 'rim/hit-v2-rr1.ogg', soft: 'rim/hit-v1-rr1.ogg', shake: 'rim/shake-rr1.ogg', shake2: 'rim/shake-rr2.ogg' };

// ─────────────────────────── 配方 ───────────────────────────
// [名字, 时长秒, 种子, async (k, ctx) => {}]
const RECIPES = [
    // ── 开幕 / 出场 ──
    // 开幕 2.4 秒：手鼓滚奏一路推上去，0.8 s 大幕一拉（布的呼声），1.95 s 一记重鼓 + 号角 + 钢片琴收住
    ['intro', 3.2, 11, async (k) => {
        for (let t = 0.05, i = 0; t < 1.9; i++) {
            const p = t / 1.9;
            await k.hit(i % 2 ? BODHRAN.small : BODHRAN.small2, t, { gain: 0.15 + p * 0.75, rate: 1.05 + (i % 3) * 0.02, wet: 0.4 });
            t += 0.085 - p * 0.04;
        }
        await k.hit(RIM.shake, 1.2, { gain: 0.35 });
        k.noise(0.75, 1.1, { color: 'pink', type: 'bandpass', f0: 350, f1: 1800, q: 0.7, gain: 0.55, attack: 0.25, release: 0.5 });
        await k.hit(BODHRAN.large, 1.95, { gain: 1.1 });
        for (const m of [60, 64, 67]) await k.note('horn', m, 1.95, { dur: 0.7, vel: 0.9, gain: 0.7 });
        for (const [m, dt] of [[84, 0], [91, 0.06], [96, 0.12]]) await k.note('glockenspiel', m, 1.97 + dt, { dur: 0.6, vel: 0.7, gain: 0.5 });
    }],
    // 直接进下注时本地拉一下幕：布声 + 一串钢片琴往上走
    ['curtain', 1.6, 12, async (k) => {
        k.noise(0.02, 0.9, { color: 'pink', type: 'bandpass', f0: 300, f1: 1600, q: 0.7, gain: 0.55, attack: 0.18, release: 0.4 });
        for (const [m, dt] of [[79, 0.45], [84, 0.52], [88, 0.59], [91, 0.66]]) await k.note('glockenspiel', m, dt, { dur: 0.35, vel: 0.5, gain: 0.45 });
    }],
    // 每只甲虫站上圆台："嗒—哒！"，三个调轮着用，一排听下来不单调
    ...[['entrance-a', 0], ['entrance-b', 2], ['entrance-c', 5]].map(([name, up], i) => [name, 1.3, 20 + i, async (k) => {
        const root = 60 + up;
        await k.note('concertina', root + 7 - 12, 0.02, { dur: 0.1, vel: 0.7, gain: 0.7 });
        for (const m of [root, root + 4, root + 7]) await k.note('concertina', m, 0.16, { dur: 0.42, vel: 0.8, gain: 0.55 });
        await k.note('horn', root - 12, 0.16, { dur: 0.45, vel: 0.7, gain: 0.5 });
        await k.hit(BODHRAN.smallLoud, 0.16, { gain: 0.6 });
        await k.note('glockenspiel', root + 24, 0.17, { dur: 0.5, vel: 0.5, gain: 0.3 });
    }]),
    // 巡游完、开下注：小铃两下
    ['bell', 1.4, 13, async (k) => {
        k.metal(0.01, { freqs: [1318, 3120, 4350, 5870], gain: 0.28, decay: 1.1 });
        k.metal(0.22, { freqs: [1568, 3710, 5160], gain: 0.22, decay: 1.0 });
    }],

    // ── 下注 ──
    // 铜币落桌：几个高分音叮一下，外加一声轻碰
    ['bet', 0.7, 30, async (k) => {
        k.metal(0.005, { freqs: [2350, 3780, 5230, 6890], gain: 0.22, decay: 0.35, wet: 0.5 });
        k.metal(0.075, { freqs: [2580, 4120, 5710], gain: 0.14, decay: 0.28, wet: 0.5 });
        k.noise(0.004, 0.012, { type: 'highpass', f0: 3000, gain: 0.25, release: 0.02, wet: 0.2 });
    }],
    // 挑选台翻页：轻轻一扫
    ['swish', 0.4, 31, async (k) => {
        k.noise(0.0, 0.2, { color: 'pink', type: 'bandpass', f0: 1800, f1: 700, q: 1.2, gain: 0.35, attack: 0.05, release: 0.1, wet: 0.3 });
    }],
    // 封盘前最后几秒：钟表"嗒"
    ['tick', 0.25, 32, async (k) => {
        await k.hit(RIM.soft, 0.0, { gain: 0.8, rate: 1.6, wet: 0.2 });
    }],

    // ── 倒数 / 开闸 ──
    ...[['count-3', 79], ['count-2', 79], ['count-1', 84]].map(([name, m], i) => [name, 0.8, 40 + i, async (k) => {
        await k.hit(BODHRAN.smallLoud, 0.0, { gain: 0.7 });
        await k.note('glockenspiel', m, 0.0, { dur: 0.3, vel: 0.8, gain: 0.55 });
    }]),
    // 开跑：闸门"哐"一声抬起 + 号角吹一句"嗒—嗒嗒—嗒！"
    ['go', 1.6, 44, async (k) => {
        k.metal(0.0, { freqs: [310, 820, 1390, 2170, 3050], gain: 0.4, decay: 0.45 });
        k.noise(0.0, 0.05, { color: 'white', type: 'bandpass', f0: 1200, q: 0.8, gain: 0.5, release: 0.08 });
        await k.hit(BODHRAN.large, 0.02, { gain: 0.9 });
        for (const [m, t, d] of [[67, 0.12, 0.12], [67, 0.26, 0.08], [67, 0.36, 0.08], [72, 0.46, 0.55]]) await k.note('horn', m, t, { dur: d, vel: 0.95, gain: 0.8 });
        await k.hit(RIM.hit, 0.46, { gain: 0.5 });
    }],

    // ── 比赛当中的场面 ──
    // 最后冲刺：手鼓加速滚 + 手风琴半音一路往上爬
    ['final', 1.6, 50, async (k) => {
        for (let t = 0, i = 0; t < 1.1; i++) {
            await k.hit(i % 2 ? BODHRAN.small : BODHRAN.small2, t, { gain: 0.3 + t * 0.5, wet: 0.3 });
            t += 0.09 - t * 0.04;
        }
        for (let i = 0; i < 8; i++) await k.note('concertina', 67 + i, 0.1 + i * 0.12, { dur: 0.11, vel: 0.6 + i * 0.04, gain: 0.45 });
        await k.hit(RIM.shake, 1.05, { gain: 0.5 });
    }],
    // 撞线：铃连敲三下 + 号角大三和弦 + 重鼓
    ['finish', 2.6, 51, async (k) => {
        for (const [t, g] of [[0, 0.32], [0.14, 0.28], [0.28, 0.34]]) k.metal(t, { freqs: [1046, 2480, 3560, 4920], gain: g, decay: 1.2 });
        await k.hit(BODHRAN.large, 0.3, { gain: 1.1 });
        for (const m of [60, 64, 67, 72]) await k.note('horn', m, 0.3, { dur: 1.1, vel: 0.95, gain: 0.55 });
        for (const [m, dt] of [[84, 0.3], [88, 0.38], [91, 0.46], [96, 0.54]]) await k.note('glockenspiel', m, dt, { dur: 0.8, vel: 0.7, gain: 0.35 });
        await k.hit(RIM.shake, 0.32, { gain: 0.6 });
        await k.hit(RIM.shake2, 0.62, { gain: 0.5 });
    }],
    // 险胜：老式相机快门"咔嚓" + 闪光灯充电的细高音
    ['photo', 1.0, 52, async (k) => {
        k.noise(0.0, 0.01, { type: 'highpass', f0: 2500, gain: 0.8, release: 0.02, wet: 0.3 });
        k.noise(0.055, 0.012, { type: 'highpass', f0: 1800, gain: 0.6, release: 0.03, wet: 0.3 });
        k.tone(0.1, 0.5, { f0: 2800, f1: 7200, glide: 0.5, gain: 0.07, attack: 0.05, release: 0.15, wet: 0.2 });
    }],

    // ── 结算 ──
    // 赢了：手风琴 + 号角 + 钢片琴一串琶音，落在主和弦上
    ['win', 2.4, 60, async (k) => {
        const run = [60, 64, 67, 72, 76];
        for (let i = 0; i < run.length; i++) await k.note('concertina', run[i], i * 0.1, { dur: 0.12, vel: 0.75, gain: 0.5 });
        for (const m of [60, 64, 67, 72]) await k.note('concertina', m, 0.55, { dur: 0.9, vel: 0.85, gain: 0.45 });
        for (const m of [48, 55, 64]) await k.note('horn', m, 0.55, { dur: 0.9, vel: 0.9, gain: 0.5 });
        await k.hit(BODHRAN.large, 0.55, { gain: 0.9 });
        for (const [m, dt] of [[84, 0.55], [91, 0.62], [96, 0.7], [100, 0.78]]) await k.note('glockenspiel', m, dt, { dur: 0.8, vel: 0.6, gain: 0.3 });
    }],
    // 输了：单簧管"哇—哇—哇—哇～"，最后一声往下滑还带颤
    ['lose', 2.2, 61, async (k) => {
        const notes = [[55, 0.0, 0.32], [54, 0.4, 0.32], [53, 0.8, 0.32]];
        for (const [m, t, d] of notes) await k.note('clarinet', m, t, { dur: d, vel: 0.75, gain: 0.8 });
        await k.note('clarinet', 52, 1.2, { dur: 0.75, vel: 0.8, gain: 0.8, glideTo: 50, glideTime: 0.7, vibrato: { rate: 6, depth: 40, delay: 0.15 } });
    }],

    // ── 27 个动作：比赛里出状况、DM 下手时各自一声 ──
    // 冲一下：短促的一声"嗖"
    ['act-dash', 0.6, 101, async (k) => {
        k.noise(0.0, 0.3, { color: 'pink', type: 'bandpass', f0: 500, f1: 3200, q: 1.4, gain: 0.6, attack: 0.03, release: 0.15 });
        k.tone(0.02, 0.25, { f0: 600, f1: 1800, gain: 0.08, release: 0.08 });
    }],
    // 起飞：翅膀扑棱 + 往上飘的哨音
    ['act-fly', 1.3, 102, async (k) => {
        k.noise(0.0, 1.0, { color: 'pink', type: 'bandpass', f0: 900, f1: 1400, q: 0.8, gain: 0.45, attack: 0.05, release: 0.2, am: { rate: 26, depth: 0.95, shape: 'triangle' } });
        k.tone(0.15, 0.8, { f0: 700, f1: 2000, gain: 0.1, attack: 0.1, release: 0.2, vibrato: { rate: 7, depth: 30 } });
    }],
    // 蹦一下：弹簧"嘣～"
    ['act-hop', 0.7, 103, async (k) => {
        k.tone(0.0, 0.45, { f0: 160, f1: 520, glide: 0.18, gain: 0.35, release: 0.15, vibrato: { rate: 22, depth: 90, depthTo: 5 }, wet: 0.3 });
    }],
    // 瞬移：一声"咻"没了，另一头"叮"出来
    ['act-blink', 1.0, 104, async (k) => {
        k.tone(0.0, 0.18, { f0: 900, f1: 3400, gain: 0.2, release: 0.05 });
        k.noise(0.0, 0.16, { type: 'bandpass', f0: 2000, f1: 6000, q: 2, gain: 0.25, release: 0.05 });
        await k.note('glockenspiel', 96, 0.42, { dur: 0.4, vel: 0.6, gain: 0.45 });
        k.tone(0.42, 0.15, { f0: 3400, f1: 1200, gain: 0.12, release: 0.05 });
    }],
    // 喷射：屁股后面一股气，越来越响
    ['act-jet', 1.2, 105, async (k) => {
        k.noise(0.0, 0.9, { color: 'pink', type: 'lowpass', f0: 400, f1: 3000, q: 0.5, gain: 0.6, attack: 0.08, release: 0.25 });
        k.tone(0.0, 0.9, { type: 'sawtooth', f0: 70, f1: 140, gain: 0.12, lowpass: 600, attack: 0.05, release: 0.2 });
    }],
    // 急刹：鞋底蹭地的尖叫
    ['act-brake', 0.9, 106, async (k) => {
        k.noise(0.0, 0.6, { type: 'bandpass', f0: 2600, f1: 2100, q: 9, gain: 0.55, attack: 0.02, release: 0.1, am: { rate: 34, depth: 0.5 } });
        k.tone(0.0, 0.55, { type: 'square', f0: 1900, f1: 1500, gain: 0.05, lowpass: 3500, vibrato: { rate: 30, depth: 60 } });
    }],
    // 原地打转：呼呼地转
    ['act-spin', 1.0, 107, async (k) => {
        k.noise(0.0, 0.8, { color: 'pink', type: 'bandpass', f0: 700, q: 3, gain: 0.5, attack: 0.05, release: 0.15, am: { rate: 7, depth: 0.9, rateTo: 11 } });
        k.tone(0.0, 0.8, { f0: 500, gain: 0.05, vibrato: { rate: 7, depth: 300, rateTo: 11 }, release: 0.1 });
    }],
    // 翻肚皮：闷闷一声"咚"，接着往下掉的一个音
    ['act-flip', 1.0, 108, async (k) => {
        await k.hit(BODHRAN.largeMuted, 0.0, { gain: 1.0 });
        k.tone(0.0, 0.35, { f0: 220, f1: 70, gain: 0.3, release: 0.1, wet: 0.2 });
        await k.note('glockenspiel', 79, 0.2, { dur: 0.2, vel: 0.4, gain: 0.25, glideTo: 72, glideTime: 0.2 });
    }],
    // 偷吃：咔哧咔哧嚼三口
    ['act-snack', 1.0, 109, async (k) => {
        for (const t of [0.0, 0.26, 0.52]) {
            for (let j = 0; j < 5; j++) k.noise(t + j * 0.018 + k.rand() * 0.01, 0.012, { type: 'highpass', f0: 1800 + k.rand() * 2000, gain: 0.35 + k.rand() * 0.3, release: 0.02, wet: 0.2 });
            k.noise(t, 0.06, { color: 'brown', type: 'lowpass', f0: 500, gain: 0.3, release: 0.05, wet: 0.1 });
        }
    }],
    // 打盹：呼——噜，吸气粗、呼气带哨
    ['act-nap', 1.8, 110, async (k) => {
        k.noise(0.0, 0.7, { color: 'brown', type: 'lowpass', f0: 220, f1: 380, q: 4, gain: 0.8, attack: 0.3, release: 0.12, am: { rate: 38, depth: 0.7 } });
        k.tone(0.85, 0.6, { f0: 1100, f1: 700, glide: 0.6, gain: 0.07, attack: 0.1, release: 0.25, wet: 0.3 });
        k.noise(0.85, 0.6, { color: 'pink', type: 'bandpass', f0: 900, f1: 600, q: 2, gain: 0.18, attack: 0.1, release: 0.25 });
    }],
    // 太空步：贝斯往下一滑，配两下打板
    ['act-moonwalk', 1.3, 111, async (k) => {
        await k.note('bass', 43, 0.0, { dur: 0.35, vel: 0.8, gain: 0.8, glideTo: 38, glideTime: 0.3 });
        await k.hit(RIM.hit, 0.0, { gain: 0.5 });
        await k.note('bass', 45, 0.45, { dur: 0.45, vel: 0.8, gain: 0.8, glideTo: 40, glideTime: 0.4 });
        await k.hit(RIM.hit, 0.45, { gain: 0.5 });
        await k.hit(RIM.shake, 0.7, { gain: 0.35 });
    }],
    // 东张西望：吹着口哨乱逛
    ['act-wander', 1.4, 112, async (k) => {
        const line = [[79, 0.0, 0.18], [83, 0.2, 0.14], [81, 0.36, 0.2], [76, 0.6, 0.3]];
        for (const [m, t, d] of line) await k.note('whistle', m, t, { dur: d, vel: 0.6, gain: 0.6, vibrato: { rate: 5, depth: 20, delay: 0.05 } });
    }],
    // 绊一跤：两下踉跄 + "哎哟"往下掉
    ['act-trip', 0.9, 113, async (k) => {
        await k.hit(BODHRAN.hand, 0.0, { gain: 0.7 });
        await k.hit(BODHRAN.largeMuted, 0.13, { gain: 0.8 });
        await k.note('concertina', 72, 0.2, { dur: 0.25, vel: 0.5, gain: 0.4, glideTo: 65, glideTime: 0.25 });
    }],
    // 挑衅："噗噜噜"吐舌头
    ['act-taunt', 0.8, 114, async (k) => {
        k.tone(0.0, 0.45, { type: 'sawtooth', f0: 120, f1: 95, gain: 0.25, lowpass: 900, attack: 0.02, release: 0.08, wet: 0.2 });
        k.noise(0.0, 0.45, { color: 'pink', type: 'bandpass', f0: 600, q: 1, gain: 0.35, release: 0.08, am: { rate: 30, depth: 1, shape: 'square' }, wet: 0.2 });
    }],
    // 鞠躬：竖琴两个音，客客气气
    ['act-bow', 1.0, 115, async (k) => {
        await k.note('harp', 67, 0.0, { dur: 0.4, vel: 0.6, gain: 0.7 });
        await k.note('harp', 72, 0.18, { dur: 0.6, vel: 0.6, gain: 0.7 });
    }],
    // 欢呼：钢片琴往上蹦 + 沙锤一抖
    ['act-cheer', 1.0, 116, async (k) => {
        for (const [m, t] of [[79, 0], [84, 0.07], [88, 0.14], [91, 0.21]]) await k.note('glockenspiel', m, t, { dur: 0.35, vel: 0.6, gain: 0.4 });
        await k.hit(RIM.shake, 0.05, { gain: 0.5 });
    }],
    // 滚成球：骨碌骨碌
    ['act-roll', 1.4, 117, async (k) => {
        k.noise(0.0, 1.1, { color: 'brown', type: 'lowpass', f0: 500, q: 1, gain: 0.7, attack: 0.1, release: 0.2, am: { rate: 9, depth: 0.8 } });
        for (let t = 0; t < 1.0; t += 0.11) await k.hit(BODHRAN.hand, t, { gain: 0.25, rate: 1.3, wet: 0.2 });
    }],
    // 刨地钻下去：沙沙几下 + 土里闷响
    ['act-dig', 1.3, 118, async (k) => {
        for (let i = 0; i < 6; i++) k.noise(i * 0.13, 0.08, { color: 'pink', type: 'bandpass', f0: 1400 + k.rand() * 800, q: 1.5, gain: 0.5, attack: 0.02, release: 0.05, wet: 0.2 });
        k.noise(0.3, 0.9, { color: 'brown', type: 'lowpass', f0: 180, gain: 0.6, attack: 0.2, release: 0.3, wet: 0.1 });
    }],
    // 打喷嚏："啊…啊…阿嚏！"两口吸气往上扬，最后一下炸开
    ['act-sneeze', 1.2, 119, async (k) => {
        k.noise(0.0, 0.22, { color: 'pink', type: 'bandpass', f0: 700, f1: 1100, q: 4, gain: 0.45, attack: 0.08, release: 0.06, wet: 0.3 });
        k.noise(0.3, 0.26, { color: 'pink', type: 'bandpass', f0: 800, f1: 1500, q: 4, gain: 0.55, attack: 0.1, release: 0.05, wet: 0.3 });
        k.noise(0.62, 0.14, { color: 'white', type: 'bandpass', f0: 3000, f1: 1200, q: 0.6, gain: 1.0, attack: 0.004, release: 0.12, wet: 0.5 });
        k.tone(0.62, 0.1, { f0: 420, f1: 200, gain: 0.2, release: 0.06 });
    }],
    // 陷进泥里："咕叽"一声
    ['act-mud', 1.0, 120, async (k) => {
        k.noise(0.0, 0.25, { color: 'brown', type: 'lowpass', f0: 1400, f1: 200, q: 6, gain: 0.8, attack: 0.02, release: 0.1, wet: 0.2 });
        k.tone(0.05, 0.2, { f0: 320, f1: 110, gain: 0.3, release: 0.08, wet: 0.2 });
        k.tone(0.42, 0.12, { f0: 180, f1: 260, gain: 0.18, release: 0.05, wet: 0.2 });
    }],
    // 推粪球：又沉又慢地滚
    ['act-dungball', 1.6, 121, async (k) => {
        k.noise(0.0, 1.3, { color: 'brown', type: 'lowpass', f0: 260, q: 2, gain: 0.9, attack: 0.2, release: 0.3, am: { rate: 4, depth: 0.7 } });
        k.tone(0.0, 1.3, { f0: 62, gain: 0.2, attack: 0.2, release: 0.3, vibrato: { rate: 4, depth: 40 } });
    }],
    // 跳舞：手风琴一小段吉格
    ['act-dance', 1.6, 122, async (k) => {
        const jig = [72, 76, 79, 76, 74, 77, 81, 79];
        for (let i = 0; i < jig.length; i++) {
            await k.note('concertina', jig[i], i * 0.15, { dur: 0.12, vel: 0.65, gain: 0.5 });
            if (i % 2 === 0) await k.hit(RIM.soft, i * 0.15, { gain: 0.4 });
        }
    }],
    // ── 法术（DM 明着作弊）：个个都要一听就知道"有人动手了" ──
    // 加速术：一串往上冲的钢片琴 + 拉长的"嗖"
    ['act-haste', 1.4, 131, async (k) => {
        for (let i = 0; i < 7; i++) await k.note('glockenspiel', 79 + i * 2, i * 0.045, { dur: 0.3, vel: 0.55, gain: 0.35 });
        k.noise(0.1, 0.7, { color: 'pink', type: 'bandpass', f0: 800, f1: 4200, q: 1.2, gain: 0.5, attack: 0.1, release: 0.3 });
        k.tone(0.1, 0.6, { f0: 500, f1: 2600, gain: 0.08, release: 0.2, vibrato: { rate: 12, depth: 40 } });
    }],
    // 巨化术："呜——嘭！"越长越大，最后一声重鼓
    ['act-enlarge', 1.6, 132, async (k) => {
        k.tone(0.0, 0.8, { type: 'sawtooth', f0: 80, f1: 240, gain: 0.25, lowpass: 1200, attack: 0.05, release: 0.05, wet: 0.4 });
        k.tone(0.0, 0.8, { type: 'sine', f0: 160, f1: 480, gain: 0.15, release: 0.05, wet: 0.4 });
        await k.hit(BODHRAN.large, 0.82, { gain: 1.1 });
        await k.note('horn', 48, 0.82, { dur: 0.5, vel: 0.9, gain: 0.6 });
    }],
    // 冰冻术：冰晶一片叮当 + 细碎的冰裂声
    ['act-freeze', 1.8, 133, async (k) => {
        const cluster = [96, 100, 103, 98, 101, 105, 108];
        for (let i = 0; i < cluster.length; i++) await k.note('glockenspiel', cluster[i], i * 0.06, { dur: 0.8, vel: 0.45, gain: 0.3, wet: 1.2 });
        for (let i = 0; i < 12; i++) k.noise(0.1 + k.rand() * 0.8, 0.008, { type: 'highpass', f0: 5000, gain: 0.3 + k.rand() * 0.3, release: 0.015, wet: 0.6 });
        k.noise(0.0, 1.0, { type: 'highpass', f0: 6000, gain: 0.08, attack: 0.1, release: 0.4 });
    }],
    // 雷击：先一声电流噼啪，再一记闷雷
    ['act-zap', 1.6, 134, async (k) => {
        k.tone(0.0, 0.45, { type: 'sawtooth', f0: 60, gain: 0.3, lowpass: 2500, release: 0.05, vibrato: { rate: 50, depth: 300 }, wet: 0.3 });
        k.noise(0.0, 0.45, { type: 'bandpass', f0: 3000, q: 0.8, gain: 0.7, release: 0.05, am: { rate: 45, depth: 1, shape: 'square' }, wet: 0.4 });
        k.noise(0.4, 0.9, { color: 'brown', type: 'lowpass', f0: 300, f1: 80, gain: 1.0, attack: 0.01, release: 0.5, wet: 0.8 });
        await k.hit(BODHRAN.large, 0.4, { gain: 0.9, rate: 0.8 });
    }],
    // 变蜗牛：滑哨一路往下泄气，末尾单簧管"哇～"
    ['act-snail', 2.0, 135, async (k) => {
        k.tone(0.0, 1.1, { f0: 1500, f1: 260, glide: 1.1, gain: 0.25, attack: 0.02, release: 0.1, vibrato: { rate: 6, depth: 25 } });
        await k.note('clarinet', 50, 1.0, { dur: 0.6, vel: 0.7, gain: 0.7, glideTo: 47, glideTime: 0.6, vibrato: { rate: 5, depth: 30, delay: 0.1 } });
    }]
];

async function renderRecipe([name, seconds, seed, build]) {
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
    const kit = makeKit(ctx, seed);
    await build(kit, ctx);
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);
    // 16 位 wav，交回 node 那边转 ogg
    const bytes = new ArrayBuffer(44 + data.length * 2);
    const v = new DataView(bytes);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true);
    v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length * 2, true);
    // 渲染出来是浮点，叠得厚的几条会超过 1：先按浮点峰值整体缩到 -1.5 dBFS 再量化，别在写 wav 时硬切出削波
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const scale = peak > 0 ? 0.84 / peak : 1;
    for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * scale)) * 32767, true);
    let bin = '';
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { name, seconds, peak: +peak.toFixed(3), wav: btoa(bin) };
}

async function buildBeetleSfx(only = null) {
    const list = only?.length ? RECIPES.filter(r => only.includes(r[0])) : RECIPES;
    const out = [];
    for (const recipe of list) out.push(await renderRecipe(recipe));
    return out;
}
