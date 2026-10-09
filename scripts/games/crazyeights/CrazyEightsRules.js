/**
 * 疯狂八规则模块 —— 纯函数，不碰 Foundry 全局。
 *
 * 游戏引擎、机器人、牌运干预、测试全从这里拿规则，别在别处再抄一份"能不能出"。
 * 牌堆用普通数组：栈顶 = 数组末尾。故意不用 CardDeck——它 deal() 在牌空时会静默重建整副，
 * 甩牌游戏牌堆抽空是常态，那会凭空复制手里已有的牌。
 *
 * 几条单开关的细则（改规则先改这里的注释再改代码）：
 * - drawRule 'one'：抽一张后可以出手里任意能出的牌（playAfterDraw 'any'），不限于刚抽的那张
 * - drawRule 'untilPlayable'：手里一旦有能出的牌就必须出，不能继续抽；最多抽 3 张
 * - 2 人局 Q 反转等价于跳过，方向不变
 * - 罚抽（2）不吃牌运，只有主动抽牌吃
 */

import { SUITS, RANKS, SUIT_SYMBOLS, SUIT_COLORS } from '../shared/CardDeck.js';

export { SUITS, RANKS, SUIT_SYMBOLS, SUIT_COLORS };

export const CRAZY_EIGHTS_DRAW_RULES = Object.freeze(['one', 'untilPlayable']);
export const CRAZY_EIGHTS_ACTION_PRESETS = Object.freeze(['tavern', 'classic']);
export const CRAZY_EIGHTS_MIN_PLAYERS = 2;
export const CRAZY_EIGHTS_MAX_PLAYERS = 8;
export const DEFAULT_CRAZY_EIGHTS_OPTIONS = Object.freeze({
    ante: 10,
    penaltyPerPoint: 0,
    drawRule: 'one',
    actionCards: 'tavern'
});

const WILD_RANK = '8';
const MAX_DRAW_UNTIL_PLAYABLE = 3;
const TWO_DECK_PLAYER_COUNT = 6;

function randomUnit(rng = Math.random) {
    const value = Number(rng?.());
    if (!Number.isFinite(value)) return Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
}

function roundChipAmount(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

export function sanitizeCrazyEightsOptions(raw = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const ante = Math.floor(Number(source.ante));
    const penaltyPerPoint = Math.floor(Number(source.penaltyPerPoint));
    const drawRule = CRAZY_EIGHTS_DRAW_RULES.includes(source.drawRule)
        ? source.drawRule
        : DEFAULT_CRAZY_EIGHTS_OPTIONS.drawRule;
    const actionCards = CRAZY_EIGHTS_ACTION_PRESETS.includes(source.actionCards)
        ? source.actionCards
        : DEFAULT_CRAZY_EIGHTS_OPTIONS.actionCards;
    const tavern = actionCards === 'tavern';

    return {
        ante: Number.isFinite(ante) && ante >= 1 ? ante : DEFAULT_CRAZY_EIGHTS_OPTIONS.ante,
        penaltyPerPoint: Number.isFinite(penaltyPerPoint) && penaltyPerPoint > 0 ? penaltyPerPoint : 0,
        drawRule,
        actionCards,
        // 引擎只认这组标志位，预设名只在这里翻译一次
        rules: {
            wildRank: WILD_RANK,
            skipRank: tavern ? 'J' : null,
            reverseRank: tavern ? 'Q' : null,
            drawTwoRank: tavern ? '2' : null,
            drawRule,
            maxDrawPerTurn: drawRule === 'untilPlayable' ? MAX_DRAW_UNTIL_PLAYABLE : 1,
            playAfterDraw: 'any'
        }
    };
}

export function getDeckCount(playerCount) {
    return Number(playerCount || 0) >= TWO_DECK_PLAYER_COUNT ? 2 : 1;
}

export function getHandSize(playerCount) {
    return Number(playerCount || 0) <= 2 ? 7 : 5;
}

export function shuffleCards(cards, rng = Math.random) {
    const copy = Array.isArray(cards) ? [...cards] : [];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(randomUnit(rng) * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

export function buildStock(deckCount = 1, rng = Math.random) {
    const cards = [];
    const decks = Math.max(1, Math.floor(Number(deckCount) || 1));
    for (let d = 0; d < decks; d++) {
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                cards.push({ suit, rank, symbol: SUIT_SYMBOLS[suit], color: SUIT_COLORS[suit] });
            }
        }
    }
    return shuffleCards(cards, rng);
}

export function cardKey(card) {
    return card ? `${card.rank}-${card.suit}` : '';
}

export function sameCard(a, b) {
    return !!a && !!b && a.rank === b.rank && a.suit === b.suit;
}

export function normalizeCard(raw) {
    const suit = String(raw?.suit || '');
    const rank = String(raw?.rank || '');
    if (!SUITS.includes(suit) || !RANKS.includes(rank)) return null;
    return { suit, rank, symbol: SUIT_SYMBOLS[suit], color: SUIT_COLORS[suit] };
}

export function describeCard(card) {
    if (!card) return '';
    return `${SUIT_SYMBOLS[card.suit] || ''}${card.rank || ''}`;
}

// 花色序再点数序，手牌永远按这个排，客户端才能"新牌飞到它该在的位置"
export function sortHand(cards) {
    return [...(Array.isArray(cards) ? cards : [])]
        .filter(Boolean)
        .sort((a, b) => {
            const suitDiff = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
            if (suitDiff) return suitDiff;
            return RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
        });
}

export function isWild(card, rules = {}) {
    return !!card && card.rank === (rules.wildRank || WILD_RANK);
}

export function cardPoints(card, rules = {}) {
    if (!card) return 0;
    if (isWild(card, rules)) return 50;
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    if (card.rank === 'A') return 1;
    const pip = parseInt(card.rank, 10);
    return Number.isFinite(pip) ? pip : 0;
}

export function handPoints(cards, rules = {}) {
    return (Array.isArray(cards) ? cards : []).reduce((sum, card) => sum + cardPoints(card, rules), 0);
}

export function canPlayCard(card, { topCard = null, currentSuit = '', rules = {}, pendingDraw = 0 } = {}) {
    if (!card) return false;
    // 头上压着罚抽时只能用 2 往下传
    if (Number(pendingDraw) > 0) {
        return !!rules.drawTwoRank && card.rank === rules.drawTwoRank;
    }
    if (isWild(card, rules)) return true;
    if (!topCard) return true;
    const suit = currentSuit || topCard.suit;
    return card.suit === suit || card.rank === topCard.rank;
}

export function getPlayableCards(hand, ctx = {}) {
    return (Array.isArray(hand) ? hand : []).filter(card => canPlayCard(card, ctx));
}

/**
 * 某席位此刻能做什么。引擎校验、经典桌/呈现器亮按钮、机器人决策都用它。
 * 结果只在各自客户端用自己看得见的手牌算，绝不进公共 state（会泄露"没牌可出"）。
 */
export function getLegalActions(hand, ctx = {}) {
    const rules = ctx.rules || {};
    const pendingDraw = Math.max(0, Number(ctx.pendingDraw || 0));
    const drawCount = Math.max(0, Number(ctx.drawCountThisTurn || 0));
    const drawnThisTurn = !!ctx.drawnThisTurn || drawCount > 0;
    const cardsAvailable = Number(ctx.stockCount || 0) > 0 || Number(ctx.discardCount || 0) > 1;

    if (ctx.mustChooseSuit) {
        return { mustChooseSuit: true, playable: [], canDraw: false, canPass: false, cardsAvailable };
    }

    const playable = getPlayableCards(hand, { topCard: ctx.topCard, currentSuit: ctx.currentSuit, rules, pendingDraw });

    if (pendingDraw > 0) {
        // 接罚抽走 draw 动作；牌不够也照样能"接"，抽到多少算多少
        return { mustChooseSuit: false, playable, canDraw: true, canPass: false, cardsAvailable };
    }

    if (rules.drawRule === 'untilPlayable') {
        const maxDraw = Math.max(1, Number(rules.maxDrawPerTurn || MAX_DRAW_UNTIL_PLAYABLE));
        if (drawCount > 0 && playable.length) {
            return { mustChooseSuit: false, playable, canDraw: false, canPass: false, cardsAvailable };
        }
        return {
            mustChooseSuit: false,
            playable,
            canDraw: drawCount < maxDraw && cardsAvailable,
            canPass: !playable.length && (drawCount >= maxDraw || !cardsAvailable),
            cardsAvailable
        };
    }

    return {
        mustChooseSuit: false,
        playable,
        canDraw: !drawnThisTurn && cardsAvailable,
        canPass: drawnThisTurn || !cardsAvailable,
        cardsAvailable
    };
}

export function resolvePlayEffect(card, { rules = {}, playerCount = 2 } = {}) {
    if (!card) return { wild: false, addDraw: 0, skipNext: false, reverse: false };
    const twoPlayer = Number(playerCount) <= 2;
    const isReverse = !!rules.reverseRank && card.rank === rules.reverseRank;
    return {
        wild: isWild(card, rules),
        addDraw: !!rules.drawTwoRank && card.rank === rules.drawTwoRank ? 2 : 0,
        // 两个人反转等于跳过对方，直接当跳过处理，方向别翻
        skipNext: (!!rules.skipRank && card.rank === rules.skipRank) || (isReverse && twoPlayer),
        reverse: isReverse && !twoPlayer
    };
}

export function getNextIndex(length, currentIndex, direction = 1, steps = 1) {
    const len = Math.max(1, Number(length) || 1);
    const dir = Number(direction) < 0 ? -1 : 1;
    const from = Number.isInteger(currentIndex) && currentIndex >= 0 ? currentIndex : 0;
    return (((from + dir * steps) % len) + len) % len;
}

// 弃牌堆留顶牌，其余洗回牌堆；只剩顶牌就什么都不做
export function reshuffleDiscardIntoStock({ stock = [], discard = [] } = {}, rng = Math.random) {
    if (!Array.isArray(discard) || discard.length <= 1) {
        return { stock: [...stock], discard: [...discard], reshuffled: false };
    }
    const top = discard[discard.length - 1];
    const rest = discard.slice(0, -1);
    return { stock: [...stock, ...shuffleCards(rest, rng)], discard: [top], reshuffled: true };
}

export function takeFromStock({ stock = [], discard = [] } = {}, count = 1, rng = Math.random) {
    let nextStock = [...stock];
    let nextDiscard = [...discard];
    let reshuffled = false;
    const cards = [];
    const wanted = Math.max(0, Math.floor(Number(count) || 0));

    for (let i = 0; i < wanted; i++) {
        if (!nextStock.length) {
            const result = reshuffleDiscardIntoStock({ stock: nextStock, discard: nextDiscard }, rng);
            nextStock = result.stock;
            nextDiscard = result.discard;
            reshuffled = reshuffled || result.reshuffled;
        }
        if (!nextStock.length) break;
        cards.push(nextStock.pop());
    }

    return { cards, stock: nextStock, discard: nextDiscard, reshuffled };
}

export function isDeadRound({ stockCount = 0, discardCount = 0, passStreak = 0, playerCount = 0 } = {}) {
    return Number(stockCount) === 0
        && Number(discardCount) <= 1
        && Number(playerCount) > 0
        && Number(passStreak) >= Number(playerCount);
}

export function rankLowestHands(handsById = {}, rules = {}) {
    const pointsById = {};
    let lowest = Infinity;
    for (const [id, cards] of Object.entries(handsById)) {
        const points = handPoints(cards, rules);
        pointsById[id] = points;
        if (points < lowest) lowest = points;
    }
    const winnerIds = Object.keys(pointsById).filter(id => pointsById[id] === lowest);
    return { winnerIds, pointsById };
}

// 手里哪门花色最多就叫哪门；并列按 SUITS 顺序取前者，机器人和默认建议共用
export function chooseBestSuit(hand, rules = {}) {
    const counts = Object.fromEntries(SUITS.map(suit => [suit, 0]));
    for (const card of Array.isArray(hand) ? hand : []) {
        if (!card || isWild(card, rules)) continue;
        counts[card.suit] = (counts[card.suit] || 0) + 1;
    }
    let best = SUITS[0];
    for (const suit of SUITS) {
        if (counts[suit] > counts[best]) best = suit;
    }
    return best;
}

/**
 * 一局的账。kind 'win' 才算尾牌罚金；'split' / 'dead' 只分池。
 * 罚金封顶在"余额减底注"——底注这轮已经要扣，不能让人罚到负数；无限席位（NPC/机器人）不封顶。
 */
export function computeSettlement({
    kind = 'win',
    winnerIds = [],
    playerIds = [],
    handsById = {},
    ante = 0,
    penaltyPerPoint = 0,
    rules = {},
    getBalance = () => Infinity,
    isUnlimited = () => false
} = {}) {
    const safeAnte = Math.max(0, Number(ante) || 0);
    const unitPenalty = Math.max(0, Number(penaltyPerPoint) || 0);
    const winners = winnerIds.filter(id => playerIds.includes(id));
    const pot = roundChipAmount(safeAnte * playerIds.length);
    const payoutPerWinner = winners.length ? roundChipAmount(pot / winners.length) : 0;

    const rows = playerIds.map(id => {
        const cards = Array.isArray(handsById[id]) ? handsById[id] : [];
        return {
            id,
            cardsLeft: cards.length,
            points: handPoints(cards, rules),
            ante: safeAnte,
            penalty: 0,
            payout: winners.includes(id) ? payoutPerWinner : 0,
            net: 0
        };
    });

    if (kind === 'win' && unitPenalty > 0 && winners.length === 1) {
        const winnerRow = rows.find(row => row.id === winners[0]);
        let collected = 0;
        for (const row of rows) {
            if (row.id === winners[0]) continue;
            const raw = roundChipAmount(row.points * unitPenalty);
            if (!raw) continue;
            const cap = isUnlimited(row.id)
                ? raw
                : Math.max(0, roundChipAmount(Number(getBalance(row.id)) - safeAnte));
            row.penalty = Math.min(raw, Number.isFinite(cap) ? cap : raw);
            collected = roundChipAmount(collected + row.penalty);
        }
        if (winnerRow) winnerRow.payout = roundChipAmount(winnerRow.payout + collected);
    }

    for (const row of rows) {
        row.net = roundChipAmount(row.payout - row.ante - row.penalty);
    }

    const deltas = rows
        .filter(row => row.net !== 0)
        .map(row => ({ userId: row.id, delta: row.net }));

    return { pot, payoutPerWinner, rows, deltas };
}
