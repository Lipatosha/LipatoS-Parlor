// 甲虫赛跑音效：离线合成 → assets/beetlerace/sfx/*.ogg
//   node tools/beetle-sfx/build.mjs            全部重出
//   node tools/beetle-sfx/build.mjs go finish  只出这几条
//
// 合成要借酒馆与音乐的无头页面（那边的 /assets/samples 是 CC0 采样，授权见它的 CREDITS.md），
// 所以本机得有那个模组；成品 ogg 进本体仓库，玩家那边不需要它。
// 页面里已经按浮点峰值缩到 -1.5 dBFS，这里只收尾、转 Vorbis 单声道；各条之间的响度差在 BeetleRaceSounds.js 的音量表里调，别在这里拧。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', 'assets', 'beetlerace', 'sfx');
const TAVERN = process.env.TAVERNS_AND_MUSIC || resolve(HERE, '..', '..', '..', 'taverns-and-music');
const { runInPage } = await import(pathToFileURL(resolve(TAVERN, 'tools', 'headless.mjs')).href);

const only = process.argv.slice(2);
const recipes = readFileSync(resolve(HERE, 'recipes.js'), 'utf8');
const expression = `(async () => { ${recipes}\n return await buildBeetleSfx(${JSON.stringify(only)}); })()`;
const results = await runInPage('demo/song-generator.html', expression, { timeout: 600000 });

mkdirSync(OUT, { recursive: true });
const tmp = resolve(tmpdir(), `beetle-sfx-${process.pid}.wav`);
for (const { name, seconds, peak, wav } of results) {
    writeFileSync(tmp, Buffer.from(wav, 'base64'));
    const file = resolve(OUT, `${name}.ogg`);
    // 结尾那点混响尾巴会被压成一段静音，淡出 60 ms 收干净
    const fadeAt = Math.max(0, seconds - 0.06).toFixed(3);
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp,
        '-af', `afade=t=out:st=${fadeAt}:d=0.06`,
        '-ac', '1', '-ar', '48000', '-c:a', 'libvorbis', '-q:a', '4', file], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`${name}: ${run.stderr}`);
    console.log(`${name.padEnd(14)} ${seconds.toFixed(2)} s  raw peak ${peak}`);
}
rmSync(tmp, { force: true });
console.log(`${results.length} sounds → ${OUT}`);
