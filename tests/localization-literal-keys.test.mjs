import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['scripts', 'templates'];
const SOURCE_EXTENSIONS = new Set(['.js', '.hbs']);

async function collectSourceFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await collectSourceFiles(fullPath));
        else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
    }

    return files;
}

function collectLeafKeys(value, prefix = '', keys = new Set()) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, child] of Object.entries(value)) {
            collectLeafKeys(child, prefix ? `${prefix}.${name}` : name, keys);
        }
    } else if (prefix) {
        keys.add(prefix);
    }
    return keys;
}

async function loadLanguageKeys(locale) {
    const contents = await readFile(path.join(ROOT, 'languages', `${locale}.json`), 'utf8');
    return collectLeafKeys(JSON.parse(contents));
}

describe('literal localization keys', () => {
    it('keeps every complete PARLOR key referenced by source in both language files', async () => {
        const files = (await Promise.all(
            SOURCE_ROOTS.map(root => collectSourceFiles(path.join(ROOT, root)))
        )).flat();
        const references = new Set();

        for (const file of files) {
            const source = await readFile(file, 'utf8');
            for (const match of source.matchAll(/PARLOR\.[A-Za-z0-9_.]+/gu)) {
                if (!match[0].endsWith('.')) references.add(match[0]);
            }
        }

        const [cnKeys, enKeys] = await Promise.all([
            loadLanguageKeys('cn'),
            loadLanguageKeys('en')
        ]);
        const missing = [...references].filter(key => !cnKeys.has(key) || !enKeys.has(key)).sort();

        assert.deepEqual(missing, []);
    });
});
