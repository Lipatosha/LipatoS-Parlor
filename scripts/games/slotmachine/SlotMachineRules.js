const REEL_ROWS = 3;
const REEL_COLUMNS = 5;

const SLOT_BET_STEP = 1;

// 符号图形现在是程序化 SVG（见 SlotSymbols.js），这里只留玩法数据：
// id / 文案 / 配色 palette / 赔付 pays。原来那套精灵表坐标（sprite）连同贴图已删。
const SLOT_SYMBOLS = Object.freeze({
    bell: {
        id: 'bell',
        labelKey: 'PARLOR.SlotMachine.Symbol.Bell',
        shortLabel: 'BELL',
        palette: { main: '#f4b44a', accent: '#fff2b8', ink: '#4f2503' },
        pays: { 3: 3, 4: 12, 5: 26 }
    },
    watermelon: {
        id: 'watermelon',
        labelKey: 'PARLOR.SlotMachine.Symbol.Watermelon',
        shortLabel: 'MELON',
        palette: { main: '#ee6678', accent: '#8fdc8a', ink: '#531321' },
        pays: { 3: 3, 4: 12, 5: 26 }
    },
    seven: {
        id: 'seven',
        labelKey: 'PARLOR.SlotMachine.Symbol.Seven',
        shortLabel: '777',
        palette: { main: '#ffde67', accent: '#fff6cc', ink: '#5c2203' },
        pays: { 3: 8, 4: 20, 5: 44 }
    },
    wild: {
        id: 'wild',
        labelKey: 'PARLOR.SlotMachine.Symbol.Wild',
        shortLabel: 'WILD',
        palette: { main: '#7bd1ff', accent: '#effaff', ink: '#0f3551' },
        pays: { 3: 15, 4: 32, 5: 60 }
    },
    orange: {
        id: 'orange',
        labelKey: 'PARLOR.SlotMachine.Symbol.Orange',
        shortLabel: 'ORANGE',
        palette: { main: '#ffb05d', accent: '#fff0ca', ink: '#5a2702' },
        pays: { 3: 2, 4: 7, 5: 15 }
    },
    lemon: {
        id: 'lemon',
        labelKey: 'PARLOR.SlotMachine.Symbol.Lemon',
        shortLabel: 'LEMON',
        palette: { main: '#ffe36b', accent: '#fff8d0', ink: '#5b4604' },
        pays: { 3: 1, 4: 5, 5: 11 }
    },
    scatter: {
        id: 'scatter',
        labelKey: 'PARLOR.SlotMachine.Symbol.Scatter',
        shortLabel: 'STAR',
        palette: { main: '#f5b0ff', accent: '#fff0ff', ink: '#52215c' },
        pays: {}
    },
    banana: {
        id: 'banana',
        labelKey: 'PARLOR.SlotMachine.Symbol.Banana',
        shortLabel: 'BANANA',
        palette: { main: '#f0d154', accent: '#fff6c7', ink: '#584204' },
        pays: { 3: 1, 4: 5, 5: 11 }
    },
    plum: {
        id: 'plum',
        labelKey: 'PARLOR.SlotMachine.Symbol.Plum',
        shortLabel: 'PLUM',
        palette: { main: '#c49dff', accent: '#f4ebff', ink: '#402164' },
        pays: { 3: 1, 4: 5, 5: 11 }
    },
    apple: {
        id: 'apple',
        labelKey: 'PARLOR.SlotMachine.Symbol.Apple',
        shortLabel: 'APPLE',
        palette: { main: '#ff7e72', accent: '#ffe1d9', ink: '#612117' },
        pays: { 3: 2, 4: 7, 5: 15 }
    },
    pear: {
        id: 'pear',
        labelKey: 'PARLOR.SlotMachine.Symbol.Pear',
        shortLabel: 'PEAR',
        palette: { main: '#d5e96b', accent: '#f5ffd0', ink: '#43510f' },
        pays: { 3: 1, 4: 4, 5: 10 }
    },
    strawberry: {
        id: 'strawberry',
        labelKey: 'PARLOR.SlotMachine.Symbol.Strawberry',
        shortLabel: 'BERRY',
        palette: { main: '#ff6a7a', accent: '#ffd5dc', ink: '#61212b' },
        pays: { 3: 2, 4: 9, 5: 20 }
    }
});

const SLOT_SYMBOL_IDS = Object.freeze(Object.keys(SLOT_SYMBOLS));
const SLOT_RANDOM_SYMBOL_IDS = Object.freeze(SLOT_SYMBOL_IDS.filter(id => id !== 'scatter'));
const SLOT_SCATTER_PAYS = Object.freeze({
    3: 2,
    4: 6,
    5: 15
});

const SLOT_REELS = Object.freeze([
    ['lemon', 'orange', 'pear', 'apple', 'bell', 'plum', 'banana', 'watermelon', 'strawberry', 'lemon', 'apple', 'wild', 'orange', 'bell', 'banana', 'plum', 'pear', 'seven', 'apple', 'orange', 'banana', 'watermelon', 'lemon', 'bell', 'scatter', 'plum', 'strawberry', 'orange', 'apple', 'banana', 'lemon', 'pear'],
    ['apple', 'lemon', 'banana', 'bell', 'orange', 'strawberry', 'plum', 'watermelon', 'pear', 'apple', 'bell', 'orange', 'wild', 'banana', 'lemon', 'plum', 'apple', 'orange', 'seven', 'bell', 'banana', 'pear', 'lemon', 'watermelon', 'apple', 'scatter', 'plum', 'orange', 'banana', 'bell', 'lemon', 'strawberry'],
    ['plum', 'lemon', 'apple', 'bell', 'orange', 'banana', 'watermelon', 'plum', 'pear', 'lemon', 'apple', 'bell', 'strawberry', 'wild', 'orange', 'banana', 'plum', 'lemon', 'apple', 'seven', 'orange', 'banana', 'watermelon', 'lemon', 'scatter', 'bell', 'plum', 'apple', 'orange', 'banana', 'pear', 'strawberry'],
    ['banana', 'orange', 'bell', 'plum', 'apple', 'watermelon', 'lemon', 'pear', 'banana', 'orange', 'wild', 'apple', 'bell', 'plum', 'strawberry', 'lemon', 'banana', 'seven', 'orange', 'apple', 'watermelon', 'bell', 'banana', 'scatter', 'plum', 'lemon', 'orange', 'apple', 'bell', 'banana', 'pear', 'strawberry'],
    ['orange', 'apple', 'lemon', 'plum', 'bell', 'banana', 'watermelon', 'orange', 'pear', 'apple', 'bell', 'wild', 'strawberry', 'lemon', 'plum', 'banana', 'orange', 'seven', 'apple', 'bell', 'watermelon', 'lemon', 'orange', 'scatter', 'banana', 'plum', 'apple', 'bell', 'orange', 'lemon', 'pear', 'strawberry']
]);

function getRandomInt(max) {
    return Math.floor(Math.random() * max);
}

function createEmptyBoard() {
    return Array.from({ length: REEL_ROWS }, () => Array.from({ length: REEL_COLUMNS }, () => null));
}

function createBoardFromStops(stops) {
    const board = createEmptyBoard();
    for (let col = 0; col < REEL_COLUMNS; col++) {
        const strip = SLOT_REELS[col];
        const stop = Number(stops[col] || 0);
        for (let row = 0; row < REEL_ROWS; row++) {
            board[row][col] = strip[(stop + row) % strip.length];
        }
    }
    return board;
}

function getSymbolPayouts(symbolId, paytable = null) {
    const pays = paytable?.[symbolId] || (symbolId === 'scatter' ? SLOT_SCATTER_PAYS : SLOT_SYMBOLS[symbolId]?.pays) || {};
    return {
        3: Number(pays[3] || 0),
        4: Number(pays[4] || 0),
        5: Number(pays[5] || 0)
    };
}

function collectWayMatches(board, symbolId) {
    const reels = [];
    for (let col = 0; col < REEL_COLUMNS; col++) {
        const matches = [];
        for (let row = 0; row < REEL_ROWS; row++) {
            const currentId = board?.[row]?.[col] || null;
            if (symbolId === 'wild') {
                if (currentId === 'wild') matches.push([row, col]);
                continue;
            }
            if (currentId === symbolId || currentId === 'wild') {
                matches.push([row, col]);
            }
        }
        if (!matches.length) break;
        reels.push(matches);
    }
    return reels;
}

function evaluateWaysForSymbol(board, symbolId, paytable = null) {
    const reels = collectWayMatches(board, symbolId);
    const count = reels.length;
    const multiplier = Number(getSymbolPayouts(symbolId, paytable)?.[count] || 0);
    if (!multiplier) return null;

    const ways = reels.reduce((total, entries) => total * entries.length, 1);
    const seen = new Set();
    const positions = [];
    reels.flat().forEach(([row, col]) => {
        const key = `${row}:${col}`;
        if (seen.has(key)) return;
        seen.add(key);
        positions.push([row, col]);
    });

    return {
        symbolId,
        count,
        ways,
        multiplier,
        payoutMultiplier: ways * multiplier,
        positions
    };
}

function countScatter(board) {
    let scatterCount = 0;
    for (const row of board || []) {
        for (const symbolId of row || []) {
            if (symbolId === 'scatter') scatterCount += 1;
        }
    }
    return scatterCount;
}

function evaluateSlotSpin(board, { paytable = null } = {}) {
    const winningWays = [];
    let wayMultiplierTotal = 0;
    let hitWaysTotal = 0;

    SLOT_SYMBOL_IDS.forEach(symbolId => {
        if (symbolId === 'scatter') return;
        const result = evaluateWaysForSymbol(board, symbolId, paytable);
        if (!result) return;
        winningWays.push(result);
        wayMultiplierTotal += result.payoutMultiplier;
        hitWaysTotal += result.ways;
    });

    const scatterCount = countScatter(board);
    const scatterMultiplier = Number(getSymbolPayouts('scatter', paytable)?.[scatterCount] || 0);

    return {
        winningWays,
        winningLines: winningWays,
        hitWays: hitWaysTotal,
        hitLines: hitWaysTotal,
        wayMultiplierTotal,
        lineMultiplierTotal: wayMultiplierTotal,
        scatterCount,
        scatterMultiplier,
        hasWin: winningWays.length > 0 || scatterMultiplier > 0
    };
}

function calculateSlotPayout(spinSummary, totalBet) {
    const safeTotalBet = roundChip(Math.max(0, Number(totalBet || 0)));
    const payoutMultiplier = Number((spinSummary?.wayMultiplierTotal ?? spinSummary?.lineMultiplierTotal) || 0);
    const wayPayout = roundChip(payoutMultiplier * safeTotalBet);
    const scatterPayout = roundChip((spinSummary?.scatterMultiplier || 0) * safeTotalBet);
    const totalPayout = roundChip(wayPayout + scatterPayout);
    const hitWays = Number((spinSummary?.hitWays ?? spinSummary?.hitLines) || 0);

    return {
        stake: safeTotalBet,
        lineBet: safeTotalBet,
        totalBet: safeTotalBet,
        wayPayout,
        linePayout: wayPayout,
        scatterPayout,
        totalPayout,
        net: roundChip(totalPayout - safeTotalBet),
        hitWays,
        hitLines: hitWays,
        scatterCount: Number(spinSummary?.scatterCount || 0),
        hasWin: totalPayout > 0
    };
}

function calculateSlotPayoutFromTotalBet(spinSummary, totalBet) {
    const safeTotalBet = roundChip(Math.max(0, Number(totalBet || 0)));
    const payoutMultiplier = Number((spinSummary?.wayMultiplierTotal ?? spinSummary?.lineMultiplierTotal) || 0);
    const wayPayout = roundChip(payoutMultiplier * safeTotalBet);
    const scatterPayout = roundChip((spinSummary?.scatterMultiplier || 0) * safeTotalBet);
    const totalPayout = roundChip(wayPayout + scatterPayout);
    const hitWays = Number((spinSummary?.hitWays ?? spinSummary?.hitLines) || 0);

    return {
        stake: safeTotalBet,
        lineBet: safeTotalBet,
        totalBet: safeTotalBet,
        wayPayout,
        linePayout: wayPayout,
        scatterPayout,
        totalPayout,
        net: roundChip(totalPayout - safeTotalBet),
        hitWays,
        hitLines: hitWays,
        scatterCount: Number(spinSummary?.scatterCount || 0),
        hasWin: totalPayout > 0
    };
}

function createRandomSlotSpin({ paytable = null } = {}) {
    const stops = SLOT_REELS.map(strip => getRandomInt(strip.length));
    const board = createBoardFromStops(stops);
    const summary = evaluateSlotSpin(board, { paytable });
    return { stops, board, summary };
}

function pickPrizeTier(prizeRates = {}) {
    const small = Math.max(0, Number(prizeRates.small || 0));
    const medium = Math.max(0, Number(prizeRates.medium || 0));
    const big = Math.max(0, Number(prizeRates.big || 0));
    const roll = Math.random() * 100;
    if (roll < big) return 'big';
    if (roll < big + medium) return 'medium';
    if (roll < big + medium + small) return 'small';
    return 'miss';
}

function getPayoutTier(spinSummary) {
    const multiplier = Number(spinSummary?.wayMultiplierTotal || 0) + Number(spinSummary?.scatterMultiplier || 0);
    if (multiplier >= 10) return 'big';
    if (multiplier >= 3) return 'medium';
    if (multiplier > 0) return 'small';
    return 'miss';
}

function createSlotSpin({ prizeRates = null, paytable = null } = {}) {
    if (!prizeRates) return createRandomSlotSpin({ paytable });

    const targetTier = pickPrizeTier(prizeRates);
    let fallback = null;
    const maxAttempts = targetTier === 'big' ? 240 : 120;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const spin = createRandomSlotSpin({ paytable });
        fallback = fallback || spin;
        if (getPayoutTier(spin.summary) === targetTier) return spin;
    }

    return fallback || createRandomSlotSpin({ paytable });
}

function roundChip(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

export {
    REEL_COLUMNS,
    REEL_ROWS,
    SLOT_BET_STEP,
    SLOT_RANDOM_SYMBOL_IDS,
    SLOT_REELS,
    SLOT_SYMBOLS,
    SLOT_SYMBOL_IDS,
    SLOT_SCATTER_PAYS,
    calculateSlotPayout,
    calculateSlotPayoutFromTotalBet,
    createBoardFromStops,
    createEmptyBoard,
    createSlotSpin,
    evaluateSlotSpin,
    getPayoutTier,
    getSymbolPayouts,
    roundChip
};
