/**
 * Presenter 语言键防回归:数据面/酒馆呈现器里引用的每个 PARLOR.* 键,
 * cn.json 和 en.json 都必须有——缺键会在实机 HUD 上裸奔显示键名(踩过两轮)。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectFiles() {
    const files = [];
    const gamesDir = path.join(root, 'scripts', 'games');
    for (const game of fs.readdirSync(gamesDir)) {
        const dir = path.join(gamesDir, game);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('PresenterData.js')) files.push(path.join(dir, file));
        }
    }
    // tavern 是同 modules 目录下的独立仓库;单独 checkout parlor 时跳过
    const tavernDir = path.resolve(root, '..', 'parlor-themes-tavern', 'scripts', 'presenters');
    if (fs.existsSync(tavernDir)) {
        for (const file of fs.readdirSync(tavernDir)) {
            if (file.endsWith('.js')) files.push(path.join(tavernDir, file));
        }
    }
    return files;
}

function collectKeys(files) {
    const keys = new Set();
    for (const file of files) {
        const src = fs.readFileSync(file, 'utf8');
        for (const match of src.matchAll(/'(PARLOR\.[A-Za-z0-9.]+)'/gu)) keys.add(match[1]);
    }
    return keys;
}

function lookup(obj, key) {
    return key.split('.').reduce((node, part) => (node && typeof node === 'object') ? node[part] : undefined, obj);
}

describe('presenter language keys', () => {
    const keys = collectKeys(collectFiles());

    for (const lang of ['cn', 'en']) {
        it(`${lang}.json covers every referenced PARLOR.* key`, () => {
            const json = JSON.parse(fs.readFileSync(path.join(root, 'languages', `${lang}.json`), 'utf8'));
            const missing = [...keys].filter(key => lookup(json, key) === undefined).sort();
            assert.deepEqual(missing, [], `missing in ${lang}.json:\n${missing.join('\n')}`);
        });
    }
});
