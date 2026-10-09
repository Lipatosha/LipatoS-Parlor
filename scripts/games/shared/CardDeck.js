/**
 * CardDeck — 52 张标准扑克牌
 */
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_COLORS = { hearts: 'red', diamonds: 'red', clubs: 'black', spades: 'black' };

export class CardDeck {
    constructor(numDecks = 1) {
        this.cards = [];
        this.numDecks = numDecks;
        this.shuffle();
    }

    /** 洗牌 */
    shuffle() {
        this.cards = [];
        for (let d = 0; d < this.numDecks; d++) {
            for (const suit of SUITS) {
                for (const rank of RANKS) {
                    this.cards.push({ suit, rank, symbol: SUIT_SYMBOLS[suit], color: SUIT_COLORS[suit] });
                }
            }
        }
        // Fisher-Yates
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    /** 发一张牌 */
    deal() {
        if (this.cards.length === 0) this.shuffle();
        return this.cards.pop();
    }

    /** 发多张 */
    dealMany(n) {
        const hand = [];
        for (let i = 0; i < n; i++) hand.push(this.deal());
        return hand;
    }

    /** 获取牌的数值（Blackjack 用） */
    static getValue(card) {
        if (['J', 'Q', 'K'].includes(card.rank)) return 10;
        if (card.rank === 'A') return 11; // 调用方需判断是否降为 1
        return parseInt(card.rank);
    }

    /** 获取牌的比较值（War/HigherLower 用：A=14 最大） */
    static getCompareValue(card) {
        const map = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11 };
        return map[card.rank] || parseInt(card.rank);
    }

    /** 获取牌的显示文本 */
    static getDisplay(card) {
        return `${card.rank}${card.symbol}`;
    }

    get remaining() { return this.cards.length; }
}

export { SUITS, RANKS, SUIT_SYMBOLS, SUIT_COLORS };
