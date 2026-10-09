import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const TABLES = [
    ['blackjack', 'BlackjackTable.js'],
    ['baccarat', 'BaccaratTable.js'],
    ['dragontiger', 'DragonTigerTable.js'],
    ['casinowar', 'CasinoWarTable.js'],
    ['threecardpoker', 'ThreeCardPokerTable.js'],
    ['texasholdem', 'TexasHoldemTable.js']
];

describe('card settlement presenter themes', () => {
    for (const [gameId, fileName] of TABLES) {
        it(`${gameId} passes its detached settlement surface through PresenterHost`, async () => {
            const source = await readFile(new URL(`../scripts/games/${gameId}/${fileName}`, import.meta.url), 'utf8');

            assert.match(source, /this\._presenterHost\?\.markDetachedSurface\(popup, 'settlement'\);/u);
        });
    }
});