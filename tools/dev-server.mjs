/**
 * 离线预览用的静态服务器：从 Foundry 的 Data 目录端出去，URL 和实机一样是 /modules/parlor/…，
 * 本体和酒馆模组的 ESM 都能按原路径互相 import（file:// 下浏览器会拒绝加载模块）。
 *
 * 当 CLI 用:  node tools/dev-server.mjs [port] [首页路径]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// tools/ → parlor/ → modules/ → Data/
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// /__foundry/… 映射到本机 Foundry 安装的 public/（只读），离线页可以直接挂核心 CSS 和字体，
// 这样对话框、按钮、输入框的底子跟实机一模一样。路径换机器就用 FOUNDRY_PUBLIC 指一下；找不到就不挂。
const FOUNDRY_PUBLIC = [process.env.FOUNDRY_PUBLIC, 'G:/FVTT/V14/FoundryVTT-WindowsPortable-13.351/App/resources/app/public']
    .filter(Boolean)
    .map(path => resolve(path))
    .find(path => existsSync(join(path, 'css', 'foundry2.css'))) || null;

function resolveFile(path) {
    if (path.startsWith('/__foundry/')) {
        if (!FOUNDRY_PUBLIC) return null;
        const file = normalize(join(FOUNDRY_PUBLIC, path.slice('/__foundry/'.length)));
        return file.startsWith(FOUNDRY_PUBLIC) ? file : null;
    }
    const file = normalize(join(ROOT, path));
    // 别让 ../ 跑出 Data 目录
    return file.startsWith(ROOT) ? file : null;
}

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

export function startServer(port = 0, index = '/modules/parlor/docs/skin-demos/beetle-actions-gallery.html') {
    const server = createServer((req, res) => {
        let path = decodeURIComponent((req.url || '/').split('?')[0]);
        if (path === '/') path = index;
        const file = resolveFile(path);
        if (!file || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(`404 ${path}`);
            return;
        }
        res.writeHead(200, {
            'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        res.end(readFileSync(file));
    });
    return new Promise((ok) => {
        server.listen(port, '127.0.0.1', () => {
            const actual = server.address().port;
            ok({ port: actual, url: `http://127.0.0.1:${actual}`, close: () => new Promise(done => server.close(done)) });
        });
    });
}

// ⚠ 入口判断别手拼 file://：Windows 盘符路径要三个斜杠，用 pathToFileURL
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const index = process.argv[3] || undefined;
    const server = await startServer(Number(process.argv[2]) || 8733, index);
    console.log(`Data 目录已端出：${server.url}`);
}
