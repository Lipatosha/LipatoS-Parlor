import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const TABLE_FILES = [
    'scripts/games/baccarat/BaccaratTable.js',
    'scripts/games/blackjack/BlackjackTable.js',
    'scripts/games/bone21/Bone21Table.js',
    'scripts/games/crazyeights/CrazyEightsTable.js',
    'scripts/games/casinowar/CasinoWarTable.js',
    'scripts/games/dragontiger/DragonTigerTable.js',
    'scripts/games/liarsdice/LiarsDiceTable.js',
    'scripts/games/threecardpoker/ThreeCardPokerTable.js',
    'scripts/games/beetlerace/BeetleRaceTable.js',
    'scripts/games/texasholdem/TexasHoldemTable.js'
];

describe('presenter close routing', () => {
    for (const file of TABLE_FILES) {
        it(`${file} routes the presenter X through the shared session close flow`, () => {
            const source = readFileSync(file, 'utf8');

            assert.match(
                source,
                /requestClose:\s*\(\)\s*=>\s*this\._requestParlorClose\?\.\(\)\s*\?\?\s*this\.close\(\)/u
            );
            assert.doesNotMatch(source, /requestClose:\s*\(\)\s*=>\s*this\.close\(\)/u);
        });
    }
});
