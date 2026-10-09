/**
 * BotManager — 机器人席位管理器
 * 同时驱动无人入桌时补上的测试机器人，以及从 Actor 加入的 NPC。
 * 机器人只发送请求（加牌/压手），主持人还得手动确认发牌。
 */

const MODULE_ID = 'parlor';
const BOT_NAMES = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'];

import {
    evaluateThreeCardPokerHand,
    shouldPlayThreeCardPokerHand
} from '../games/threecardpoker/ThreeCardPokerRules.js';
import {
    evaluateBestTexasHoldemHand
} from '../games/texasholdem/TexasHoldemRules.js';
import {
    SUITS as CRAZY_EIGHTS_SUITS,
    getLegalActions as getCrazyEightsLegalActions,
    cardPoints as crazyEightsCardPoints,
    isWild as isCrazyEightsWild,
    chooseBestSuit as chooseCrazyEightsSuit
} from '../games/crazyeights/CrazyEightsRules.js';
import { clampBetAmount } from './BetLimits.js';
import {
    getActorIdFromParticipantId,
    getParticipant
} from './ParticipantRoster.js';

export class BotManager {
    static createBotIds(count = 5) {
        return Array.from({ length: count }, (_, i) => `bot_${i}`);
    }

    static getBotName(botId) {
        const actorId = getActorIdFromParticipantId(botId);
        const actor = actorId ? game.actors?.get(actorId) : null;
        if (actor?.name) return actor.name;

        const idx = Number.parseInt(botId.replace('bot_', ''), 10);
        const label = game?.i18n?.localize('PARLOR.Common.BOT');
        const safeLabel = label && label !== 'PARLOR.Common.BOT' ? label : 'Test Bot';
        const suffix = BOT_NAMES[idx] || `${Number.isFinite(idx) ? idx : '?'}`;
        return `🤖 ${safeLabel} ${suffix}`;
    }

    static isBot(userId) {
        return String(userId || '').startsWith('bot_') || String(userId || '').startsWith('bot:');
    }

    static getBotMode(source, participantId) {
        const mode = getParticipant(source, participantId)?.botMode;
        return ['win', 'lose', 'random'].includes(mode) ? mode : 'random';
    }

    static _rollAmount(min, span = 30) {
        return min + Math.floor(Math.random() * span);
    }

    static _rollLimitedBet(state, min, span = 30) {
        return clampBetAmount(this._rollAmount(min, span), state?.betLimits);
    }

    static _pickWeighted(entries = []) {
        const safeEntries = entries.filter(entry => entry?.value && Number(entry.weight) > 0);
        if (!safeEntries.length) return null;

        const totalWeight = safeEntries.reduce((sum, entry) => sum + Number(entry.weight || 0), 0);
        let cursor = Math.random() * totalWeight;
        for (const entry of safeEntries) {
            cursor -= Number(entry.weight || 0);
            if (cursor <= 0) return entry.value;
        }

        return safeEntries[safeEntries.length - 1]?.value || null;
    }

    static _baccaratSideForMode(mode) {
        if (mode === 'win') {
            return this._pickWeighted([
                { value: 'banker', weight: 5 },
                { value: 'player', weight: 4 },
                { value: 'tie', weight: 1 }
            ]) || 'banker';
        }

        if (mode === 'lose') {
            return this._pickWeighted([
                { value: 'tie', weight: 4 },
                { value: 'player', weight: 2 },
                { value: 'banker', weight: 2 }
            ]) || 'tie';
        }

        return this._pickWeighted([
            { value: 'player', weight: 2 },
            { value: 'banker', weight: 2 },
            { value: 'tie', weight: 1 }
        ]) || 'player';
    }

    static _dragonTigerSideForMode(mode) {
        if (mode === 'win') {
            return this._pickWeighted([
                { value: 'dragon', weight: 5 },
                { value: 'tiger', weight: 5 },
                { value: 'tie', weight: 1 }
            ]) || 'dragon';
        }

        if (mode === 'lose') {
            return this._pickWeighted([
                { value: 'tie', weight: 4 },
                { value: 'dragon', weight: 2 },
                { value: 'tiger', weight: 2 }
            ]) || 'tie';
        }

        return this._pickWeighted([
            { value: 'dragon', weight: 2 },
            { value: 'tiger', weight: 2 },
            { value: 'tie', weight: 1 }
        ]) || 'dragon';
    }

    static _pairPlusChance(mode) {
        if (mode === 'win') return 0.24;
        if (mode === 'lose') return 0.72;
        return 0.42;
    }

    static _chooseThreeCardDecision(handRank, mode) {
        const shouldPlay = shouldPlayThreeCardPokerHand(handRank);

        if (mode === 'win') {
            return shouldPlay ? 'play' : 'fold';
        }

        if (mode === 'lose') {
            if (shouldPlay) return Math.random() < 0.82 ? 'fold' : 'play';
            return Math.random() < 0.76 ? 'play' : 'fold';
        }

        if (shouldPlay) return Math.random() < 0.85 ? 'play' : 'fold';
        return Math.random() < 0.22 ? 'play' : 'fold';
    }

    static _blackjackTarget(mode, bustThreshold) {
        if (mode === 'win') return Math.min(18, bustThreshold);
        if (mode === 'lose') return Math.min(15, bustThreshold);
        return Math.min(17, bustThreshold);
    }

    /**
     * 给当前回合的机器人席位跑动作。
     * 这里只处理轮到的那个，不会一口气全跑完。
     * `confirmDeal` 还是留给主持人自己点。
     */
    static async executeBotActions(gameInstance) {
        const state = gameInstance.getState();
        const phase = state.phase;
        const gameType = gameInstance.gameType;

        try {
            switch (gameType) {
                case 'blackjack':
                    await this._botBlackjack(gameInstance, state, phase);
                    break;
                case 'baccarat':
                    await this._botBaccarat(gameInstance, state, phase);
                    break;
                case 'casinowar':
                    await this._botCasinoWar(gameInstance, state, phase);
                    break;
                case 'dragontiger':
                    await this._botDragonTiger(gameInstance, state, phase);
                    break;
                case 'roulette':
                    await this._botRouletteAll(gameInstance, state, phase);
                    break;
                case 'threecardpoker':
                    await this._botThreeCardPoker(gameInstance, state, phase);
                    break;
                case 'slotmachine':
                    await this._botSlotMachine(gameInstance, state, phase);
                    break;
                case 'liarsdice':
                    await this._botLiarsDice(gameInstance, state, phase);
                    break;
                case 'bone21':
                    await this._botBone21(gameInstance, state, phase);
                    break;
                case 'texasholdem':
                    await this._botTexasHoldem(gameInstance, state, phase);
                    break;
                case 'crazyeights':
                    await this._botCrazyEights(gameInstance, state, phase);
                    break;
                case 'beetlerace':
                    await this._botBeetleRace(gameInstance, state, phase);
                    break;
            }
        } catch (e) {
            console.warn(`${MODULE_ID} | Bot action failed:`, e);
        }
    }

    // ── 甲虫赛跑 ──────────────────────────────

    // 看客押虫：win 档盯着战力高的，lose 档专挑冷门，random 档在战力和赔率之间折中
    static _chooseBeetleLane(lanes = [], mode = 'random') {
        const entries = lanes.map((lane, index) => {
            const power = Math.max(1, Number(lane.power) || 5);
            const odds = Math.max(1, Number(lane.multiplier) || 2);
            let weight;
            if (mode === 'win') weight = power ** 2;
            else if (mode === 'lose') weight = (11 - power) ** 2;
            else weight = power * Math.sqrt(odds);
            return { value: String(index), weight };
        });
        const picked = this._pickWeighted(entries);
        return picked == null ? 0 : Number(picked);
    }

    static async _botBeetleRace(game, state, phase) {
        if (phase !== 'BETTING' || !state.race?.lanes?.length) return;
        const botIds = [...game.playerIds].filter(id => this.isBot(id));
        for (const botId of botIds) {
            if (state.bets?.some(bet => bet.userId === botId)) continue;
            // 押得慢一点，赛道右端的筹码一个个落下来才有看头
            await new Promise(r => setTimeout(r, 500 + Math.random() * 900));
            if (game.phase !== 'BETTING') return;
            const lane = this._chooseBeetleLane(state.race.lanes, this.getBotMode(state, botId));
            const amount = this._rollLimitedBet(state, Math.max(10, state.race.minBet || 1), 40);
            game.handlePlayerAction(botId, 'placeBet', { lane, amount });
        }
    }

    // ── Blackjack ──────────────────────────────

    static async _botBlackjack(game, state, phase) {
        if (phase === 'BETTING') {
            // 所有 bot 下注（逐个，带延迟）
            const botIds = [...game.playerIds].filter(id => this.isBot(id));
            for (const botId of botIds) {
                const hasBet = state.bets?.some(b => b.userId === botId);
                if (hasBet) continue;
                await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
                const amount = this._rollLimitedBet(state, 10, 40);
                game.handlePlayerAction(botId, 'placeBet', { amount });
            }
            return;
        }

        if (phase === 'PLAYER_TURNS') {
            const currentId = state.currentPlayerId;
            if (!currentId || !this.isBot(currentId)) return;

            const hand = state.playerHands?.[currentId];
            if (!hand) return;

            // V14 兼容优先：新流程里 bot 也会经历待收牌，不能只认旧状态
            if (hand.status === 'awaiting_deal' || hand.status === 'dealing') return;
            if (!['playing', 'awaiting_collect'].includes(hand.status)) return;

            await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

            const total = this._getBlackjackTotal(hand, state.rules);
            const bustThreshold = Number(state.rules?.bustThreshold || 21);
            const mode = this.getBotMode(state, currentId);
            const targetTotal = this._blackjackTarget(mode, bustThreshold);
            const hasTableCards = (hand.tableCards?.length || 0) > 0;

            // V14 兼容优先：桌上有牌时，bot 先决定继续要还是确认收牌
            if (hasTableCards) {
                if (total < targetTotal && hand.status === 'awaiting_collect') {
                    game.handlePlayerAction(currentId, 'requestHit', {});
                    return;
                }

                game.handlePlayerAction(currentId, 'confirmCollect', {});
                return;
            }

            if (total < targetTotal) {
                // 请求加牌，DM 仍然需要手动点“发牌”
                game.handlePlayerAction(currentId, 'requestHit', {});
            } else {
                // 压手不需要 DM 再确认
                game.handlePlayerAction(currentId, 'requestStand', {});
            }
            return;
        }
    }

    static _getBlackjackTotal(hand, rules = {}) {
        const cards = [...(hand?.handCards || []), ...(hand?.tableCards || [])];
        const bustThreshold = Number(rules?.bustThreshold || 21);
        let total = 0;
        let aces = 0;

        for (const c of cards) {
            let v = parseInt(c.rank);
            if (['J', 'Q', 'K'].includes(c.rank)) v = 10;
            if (c.rank === 'A') {
                v = 11;
                aces++;
            }
            total += v;
        }

        while (total > bustThreshold && aces > 0) {
            total -= 10;
            aces--;
        }

        return total;
    }

    static async _botRouletteAll(game, state, phase) {
        if (phase !== 'BETTING') return;
        const botIds = [...game.playerIds].filter(id => this.isBot(id));
        for (const botId of botIds) {
            await new Promise(r => setTimeout(r, 200));
            const bets = ['red', 'black', 'even', 'odd', 'low', 'high'];
            const betType = bets[Math.floor(Math.random() * bets.length)];
            const amount = this._rollAmount(5, 25);
            game.handlePlayerAction(botId, 'placeBet', { data: { betType, number: null, amount } });
        }
    }

    // ── Dragon Tiger ───────────────────────────

    static async _botDragonTiger(game, state, phase) {
        if (phase !== 'BETTING') return;

        const botIds = [...game.playerIds].filter(id => this.isBot(id));

        for (const botId of botIds) {
            const hasBet = state.bets?.some(b => b.userId === botId);
            if (hasBet) continue;

            await new Promise(r => setTimeout(r, 180 + Math.random() * 280));
            const side = this._dragonTigerSideForMode(this.getBotMode(state, botId));
            const amount = this._rollLimitedBet(state, 10, 35);
            game.handlePlayerAction(botId, 'placeBet', { side, amount });
        }
    }

    // ── Baccarat ──────────────────────────────

    static async _botBaccarat(game, state, phase) {
        if (phase !== 'BETTING') return;

        const botIds = [...game.playerIds].filter(id => this.isBot(id));

        for (const botId of botIds) {
            const hasBet = state.bets?.some(b => b.userId === botId);
            if (hasBet) continue;

            await new Promise(r => setTimeout(r, 180 + Math.random() * 280));
            const side = this._baccaratSideForMode(this.getBotMode(state, botId));
            const amount = this._rollLimitedBet(state, 10, 40);
            game.handlePlayerAction(botId, 'placeBet', { side, amount });
        }
    }

    // ── Casino War ───────────────────────────

    static async _botCasinoWar(game, state, phase) {
        if (phase !== 'BETTING') return;

        const botIds = [...game.playerIds].filter(id => this.isBot(id));
        for (const botId of botIds) {
            const hasBet = state.bets?.some(b => b.userId === botId);
            if (hasBet) continue;

            await new Promise(r => setTimeout(r, 180 + Math.random() * 280));
            const amount = this._rollLimitedBet(state, 10, 35);
            game.handlePlayerAction(botId, 'placeBet', { amount });
        }
    }

    // ── Three Card Poker ─────────────────────

    static async _botThreeCardPoker(game, state, phase) {
        if (phase === 'BETTING') {
            const botIds = [...game.playerIds].filter(id => this.isBot(id));
            for (const botId of botIds) {
                const hasBet = state.bets?.some(b => b.userId === botId);
                if (hasBet) continue;

                await new Promise(r => setTimeout(r, 180 + Math.random() * 260));
                const mode = this.getBotMode(state, botId);
                const anteAmount = this._rollLimitedBet(state, 10, 30);
                const addPairPlus = Math.random() < this._pairPlusChance(mode);
                const pairPlusAmount = addPairPlus ? anteAmount : 0;
                game.handlePlayerAction(botId, 'placeBet', { anteAmount, pairPlusAmount });
            }
            return;
        }

        if (phase !== 'DECISION') return;

        const botIds = [...game.playerIds].filter(id => this.isBot(id));
        for (const botId of botIds) {
            const seatState = state.playerStates?.[botId];
            if (!seatState || seatState.decision !== 'pending') continue;

            await new Promise(r => setTimeout(r, 220 + Math.random() * 280));
            const handRank = seatState.handRank || evaluateThreeCardPokerHand(seatState.hand || []);
            const decision = this._chooseThreeCardDecision(handRank, this.getBotMode(state, botId));
            game.handlePlayerAction(botId, 'makeDecision', { decision });
        }
    }

    // ── Slot Machine ─────────────────────────

    static async _botSlotMachine(game, state, phase) {
        if (phase !== 'BETTING') return;

        const botIds = [...game.playerIds].filter(id => this.isBot(id));
        for (const botId of botIds) {
            const hasBet = state.bets?.some(b => b.userId === botId);
            if (hasBet) continue;

            await new Promise(r => setTimeout(r, 180 + Math.random() * 240));
            const lineBet = 1 + Math.floor(Math.random() * 5);
            game.handlePlayerAction(botId, 'placeBet', { lineBet });
        }
    }

    // ── Liar's Dice ──────────────────────────

    static _countLiarsDiceMatches(dice = [], face, onesCalled) {
        const exactCount = dice.filter(value => value === face).length;
        if (face === 1) return exactCount;
        if (onesCalled) return exactCount;
        return exactCount + dice.filter(value => value === 1).length;
    }

    static _chooseLiarsDiceClaim(game, state, participantId) {
        const hand = game.getPrivateDice(participantId) || [];
        const currentClaim = state.lastClaim || null;
        const faces = [1, 2, 3, 4, 5, 6];
        const supportByFace = new Map(
            faces.map(face => [face, this._countLiarsDiceMatches(hand, face, !!state.onesCalled)])
        );

        const pickBestFace = (allowedFaces) => {
            return allowedFaces
                .slice()
                .sort((left, right) => {
                    const diff = (supportByFace.get(right) || 0) - (supportByFace.get(left) || 0);
                    if (diff !== 0) return diff;
                    return right - left;
                })[0] || allowedFaces[0] || 1;
        };

        if (!currentClaim) {
            const openingFace = pickBestFace(faces);
            const openingSupport = Math.max(1, supportByFace.get(openingFace) || 1);
            return {
                quantity: openingSupport,
                face: openingFace
            };
        }

        const higherFaces = faces.filter(face => face > Number(currentClaim.face || 0));
        const higherFace = pickBestFace(higherFaces);
        const higherFaceSupport = supportByFace.get(higherFace) || 0;
        if (higherFaces.length && higherFaceSupport >= Math.max(1, Number(currentClaim.quantity || 0) - 1)) {
            return {
                quantity: Number(currentClaim.quantity || 1),
                face: higherFace
            };
        }

        return {
            quantity: Number(currentClaim.quantity || 1) + 1,
            face: pickBestFace(faces)
        };
    }

    static _shouldLiarsDiceBotOpen(game, state, participantId) {
        const currentClaim = state.lastClaim;
        if (!currentClaim) return false;

        const hand = game.getPrivateDice(participantId) || [];
        const handSupport = this._countLiarsDiceMatches(hand, currentClaim.face, !!state.onesCalled);
        const tableDice = (state.playerIds || [])
            .reduce((sum, id) => sum + Math.max(0, Number(state.diceCounts?.[id] || 0)), 0);
        const unknownDice = Math.max(0, tableDice - hand.length);
        const expectedPerDie = state.onesCalled || Number(currentClaim.face || 0) === 1 ? (1 / 6) : (2 / 6);
        const expectedSupport = handSupport + (unknownDice * expectedPerDie);
        const requiredCount = Number(currentClaim.quantity || 0);
        const mode = this.getBotMode(state, participantId);

        let openThreshold = 0.9;
        if (mode === 'win') openThreshold = 0.55;
        if (mode === 'lose') openThreshold = 1.55;

        return (requiredCount - expectedSupport) > openThreshold;
    }

    static async _botLiarsDice(game, state, phase) {
        if (phase !== 'PLAYER_TURNS' || state.revealed) return;

        const currentId = state.currentPlayerId;
        if (!currentId || !this.isBot(currentId)) return;
        if (Number(state.diceCounts?.[currentId] || 0) < 1) return;

        await new Promise(resolve => setTimeout(resolve, 700 + Math.random() * 700));

        if (this._shouldLiarsDiceBotOpen(game, state, currentId)) {
            game.handlePlayerAction(currentId, 'open', {});
            return;
        }

        const claim = this._chooseLiarsDiceClaim(game, state, currentId);
        game.handlePlayerAction(currentId, 'makeClaim', claim);
    }

    // ── 骨骰二十一 ───────────────────────────

    static _bone21StandTarget(mode) {
        if (mode === 'win') return 18;
        if (mode === 'lose') return 20;
        return 17;
    }

    static async _botBone21(game, state, phase) {
        if (phase === 'BETTING') {
            const botIds = [...game.playerIds].filter(id => this.isBot(id));
            const amount = Math.max(1, Math.floor(Number(state.roundAnte || 10)) || 10);
            for (const botId of botIds) {
                const hasBet = state.bets?.some(bet => bet.userId === botId);
                if (hasBet) continue;

                await new Promise(resolve => setTimeout(resolve, 180 + Math.random() * 260));
                game.handlePlayerAction(botId, 'placeBet', { amount });
            }
            return;
        }

        if (phase !== 'PLAYER_TURNS') return;

        const currentId = state.currentPlayerId;
        if (!currentId || !this.isBot(currentId)) return;

        const seat = state.playerStates?.[currentId];
        if (!seat || seat.status !== 'playing') return;

        // 拉慢一颗一颗的节奏——上一颗的 DSN 大概需要 ~2s 才落地，
        // 之前 520-1040ms 太短，骰子还没停 bot 又抛下一颗，画面叠在一起
        await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 400));
        const target = this._bone21StandTarget(this.getBotMode(state, currentId));
        // bot 走 GM 端，能拿真实总分（含私骰）；老逻辑用 seat.total 是公开加骰部分，会让 bot 永远不 stand
        const realTotal = typeof game._getRealTotal === 'function'
            ? game._getRealTotal(currentId)
            : Number(seat.total || 0);
        if (realTotal >= target) {
            game.handlePlayerAction(currentId, 'stand', {});
            return;
        }

        game.handlePlayerAction(currentId, 'roll', {});
    }

    // ── 疯狂八 ───────────────────────────────

    /**
     * 纯决策，方便单测。ctx 跟 getLegalActions 的一致，opponents 按出牌方向从下家开始排。
     * win：先甩高分牌、8 留到没牌可出、下家快赢了优先扔罚抽/跳过、罚抽必叠
     * lose：随机出合法牌，8 早早扔掉，偶尔有牌也抽
     * random：两者对半掺
     */
    static _chooseCrazyEightsMove(hand, ctx, mode = 'random', opponents = [], rng = Math.random) {
        const rules = ctx?.rules || {};
        const legal = getCrazyEightsLegalActions(hand, ctx);

        if (legal.mustChooseSuit) {
            const suit = mode === 'lose'
                ? CRAZY_EIGHTS_SUITS[Math.floor(rng() * CRAZY_EIGHTS_SUITS.length)]
                : chooseCrazyEightsSuit(hand, rules);
            return { action: 'chooseSuit', data: { suit } };
        }

        if (Number(ctx?.pendingDraw || 0) > 0) {
            const stackChance = mode === 'win' ? 1 : mode === 'lose' ? 0.3 : 0.6;
            if (legal.playable.length && rng() < stackChance) {
                return { action: 'playCard', data: { ...legal.playable[0] } };
            }
            return { action: 'draw', data: {} };
        }

        if (!legal.playable.length) {
            if (legal.canDraw) return { action: 'draw', data: {} };
            if (legal.canPass) return { action: 'pass', data: {} };
            return { action: 'draw', data: {} };
        }

        const wilds = legal.playable.filter(card => isCrazyEightsWild(card, rules));
        const plain = legal.playable.filter(card => !isCrazyEightsWild(card, rules));
        const randomOf = cards => cards[Math.floor(rng() * cards.length)];

        if (mode === 'lose') {
            if (legal.canDraw && rng() < 0.2) return { action: 'draw', data: {} };
            if (wilds.length && rng() < 0.65) return { action: 'playCard', data: { ...wilds[0] } };
            return { action: 'playCard', data: { ...randomOf(legal.playable) } };
        }

        const nextCount = Number(opponents?.[0]?.count ?? Infinity);
        const suitCounts = {};
        for (const card of hand) {
            if (isCrazyEightsWild(card, rules)) continue;
            suitCounts[card.suit] = (suitCounts[card.suit] || 0) + 1;
        }
        const isActionCard = card => [rules.skipRank, rules.reverseRank, rules.drawTwoRank].includes(card.rank);
        const bestPlain = () => {
            let best = null;
            let bestScore = -Infinity;
            for (const card of plain) {
                let score = crazyEightsCardPoints(card, rules);
                // 下家只剩一两张就把跳过/罚抽砸过去，别让他出完
                if (isActionCard(card) && nextCount <= 2) score += 25;
                // 留着自己手里多的那门花色，后面好接
                score += (suitCounts[card.suit] || 0) * 0.5;
                if (score > bestScore) {
                    bestScore = score;
                    best = card;
                }
            }
            return best;
        };

        if (mode === 'win') {
            const pick = plain.length ? bestPlain() : wilds[0];
            return { action: 'playCard', data: { ...pick } };
        }

        // random：一半按 win 的算法，一半随手出；8 大多数时候还是攥着
        if (plain.length && (!wilds.length || rng() < 0.7)) {
            const pick = rng() < 0.5 ? bestPlain() : randomOf(plain);
            return { action: 'playCard', data: { ...pick } };
        }
        return { action: 'playCard', data: { ...randomOf(legal.playable) } };
    }

    // 单测里可以把这个换成同步返回，省得真等。调度器本身还有 320ms 的续接延迟，这里别再等太久，
    // 不然机器人局一圈要十来秒，看着像卡
    static _crazyEightsThink() {
        return new Promise(resolve => setTimeout(resolve, 380 + Math.random() * 320));
    }

    static async _botCrazyEights(game, state, phase) {
        if (phase !== 'PLAYER_TURNS') return;

        const currentId = state.currentPlayerId;
        if (!currentId || !this.isBot(currentId)) return;

        await this._crazyEightsThink();
        // 等的这段时间桌面可能已经变了（GM 强制推进之类），别对着旧局面出牌
        if (game.phase !== 'PLAYER_TURNS' || game.currentPlayerId !== currentId) return;

        const live = game.getState();
        const hand = typeof game.getAuthoritativeHand === 'function' ? game.getAuthoritativeHand(currentId) : [];
        const ctx = {
            topCard: live.discardTop,
            currentSuit: live.currentSuit,
            rules: live.rules,
            pendingDraw: live.turn?.pendingDraw || 0,
            mustChooseSuit: !!live.turn?.mustChooseSuit,
            drawnThisTurn: !!live.turn?.drawnThisTurn,
            drawCountThisTurn: live.turn?.drawCountThisTurn || 0,
            stockCount: live.stockCount,
            discardCount: live.discardCount
        };

        const order = Array.isArray(live.turnOrder) ? live.turnOrder : [];
        const index = order.indexOf(currentId);
        const direction = Number(live.direction) < 0 ? -1 : 1;
        const opponents = [];
        for (let step = 1; step < order.length && index >= 0; step++) {
            const id = order[(((index + direction * step) % order.length) + order.length) % order.length];
            opponents.push({ id, count: Number(live.handCounts?.[id] || 0) });
        }

        const move = this._chooseCrazyEightsMove(hand, ctx, this.getBotMode(live, currentId), opponents);
        let result = game.handlePlayerAction(currentId, move.action, move.data || {});
        if (result?.ok) return;

        // 决策和引擎判定对不上（不该发生）：退到抽牌，再退到过，别让桌子卡在机器人手里
        result = game.handlePlayerAction(currentId, 'draw', {});
        if (!result?.ok) game.handlePlayerAction(currentId, 'pass', {});
    }

    // ── 德州扑克 ─────────────────────────────

    static _texasRankValue(card) {
        if (!card?.rank) return 0;
        if (card.rank === 'A') return 14;
        if (card.rank === 'K') return 13;
        if (card.rank === 'Q') return 12;
        if (card.rank === 'J') return 11;
        return Number(card.rank) || 0;
    }

    static _texasPreflopScore(cards = []) {
        const hole = cards.slice(0, 2);
        if (hole.length < 2) return 0.18;

        const values = hole.map(card => this._texasRankValue(card)).sort((left, right) => right - left);
        const [high, low] = values;
        const suited = hole[0]?.suit && hole[0].suit === hole[1]?.suit;
        const gap = Math.abs(high - low);
        const pair = high === low;

        if (pair) return Math.min(0.98, 0.52 + (high / 14) * 0.42);

        let score = 0.12 + (high / 14) * 0.34 + (low / 14) * 0.18;
        if (suited) score += 0.07;
        if (gap === 1) score += 0.06;
        if (gap === 2) score += 0.03;
        if (high >= 13 && low >= 10) score += 0.08;
        if (low <= 5 && gap > 4) score -= 0.08;
        return Math.max(0.08, Math.min(0.92, score));
    }

    static _texasHandScore(game, state, participantId) {
        const hole = game.getAuthoritativeHoleCards?.(participantId)
            || game.getVisibleHoleCards?.(participantId)
            || [];
        const community = Array.isArray(state.communityCards) ? state.communityCards : [];

        if (hole.length + community.length < 5) {
            return this._texasPreflopScore(hole);
        }

        const handRank = evaluateBestTexasHoldemHand([...hole, ...community]);
        const categoryValue = Number(handRank?.categoryValue || 0);
        const topKicker = Number(handRank?.compare?.[0] || 0);
        return Math.max(0.12, Math.min(0.99, 0.18 + (categoryValue / 8) * 0.72 + (topKicker / 14) * 0.1));
    }

    static _adjustTexasScoreForMode(score, mode) {
        if (mode === 'win') return Math.min(0.99, score + 0.1);
        if (mode === 'lose') return Math.max(0.02, score - 0.18);
        return score;
    }

    static _texasRaiseTarget(state, seat, stack, score) {
        const currentBet = Number(state.currentBet || 0);
        const minRaise = Math.max(Number(state.minRaise || 0), Number(state.bigBlind || 1), 1);
        const maxTarget = Number(seat.streetCommitted || 0) + stack;
        let target = currentBet + minRaise;

        if (score > 0.82) target += minRaise;
        if (score > 0.93) target += minRaise * 2;

        return Math.min(maxTarget, target);
    }

    static _tryTexasAction(game, participantId, action, data = {}) {
        const result = game.handlePlayerAction(participantId, action, data);
        return !!result?.ok;
    }

    static async _botTexasHoldem(game, state, phase) {
        if (phase !== 'PLAYER_TURNS') return;

        const currentId = state.currentPlayerId;
        if (!currentId || !this.isBot(currentId)) return;

        const seat = state.playerStates?.[currentId];
        if (!seat || seat.status !== 'active') return;

        await new Promise(resolve => setTimeout(resolve, 650 + Math.random() * 550));

        const mode = this.getBotMode(state, currentId);
        const rawScore = this._texasHandScore(game, state, currentId);
        const score = this._adjustTexasScoreForMode(rawScore, mode);
        const stack = Math.max(0, Number(state.tableStacks?.[currentId] ?? seat.stack ?? 0));
        const currentBet = Number(state.currentBet || 0);
        const streetCommitted = Number(seat.streetCommitted || 0);
        const toCall = Math.max(0, currentBet - streetCommitted);
        const maxTarget = streetCommitted + stack;
        const minRaiseTo = currentBet + Math.max(Number(state.minRaise || 0), Number(state.bigBlind || 1), 1);
        const canRaise = stack > toCall && maxTarget >= minRaiseTo;
        const pressure = toCall <= 0
            ? 0
            : Math.min(1, toCall / Math.max(stack + toCall, Number(state.bigBlind || 1) * 4));

        if (toCall <= 0) {
            if (canRaise && score > 0.72 && Math.random() < (score - 0.58)) {
                const target = this._texasRaiseTarget(state, seat, stack, score);
                if (target > currentBet && this._tryTexasAction(game, currentId, 'raiseTo', { amount: target })) return;
            }
            this._tryTexasAction(game, currentId, 'check');
            return;
        }

        if (toCall >= stack) {
            if (score > 0.62 + pressure * 0.18 || (mode === 'lose' && Math.random() < 0.18)) {
                this._tryTexasAction(game, currentId, 'allIn');
                return;
            }
            this._tryTexasAction(game, currentId, 'fold');
            return;
        }

        const foldThreshold = 0.26 + pressure * 0.36;
        if (score < foldThreshold && Math.random() < 0.82) {
            this._tryTexasAction(game, currentId, 'fold');
            return;
        }

        if (canRaise && score > 0.76 && Math.random() < (score - 0.64)) {
            const target = this._texasRaiseTarget(state, seat, stack, score);
            if (target >= maxTarget) {
                if (this._tryTexasAction(game, currentId, 'allIn')) return;
            } else if (this._tryTexasAction(game, currentId, 'raiseTo', { amount: target })) {
                return;
            }
        }

        if (!this._tryTexasAction(game, currentId, 'call')) {
            this._tryTexasAction(game, currentId, 'fold');
        }
    }
}
