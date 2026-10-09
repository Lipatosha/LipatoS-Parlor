/**
 * 游戏注册表
 * 这里只保留当前还维护的游戏，别让旧目录继续挂在入口上。
 */

import { isVisibleInLobby } from './GameVisibility.js';


// 玩法长说明先收在这里，后面真改规则时只改一处就够了。
const GAME_GUIDE_TEXT = {
    roulette: {
        zh: {
            summary: '这是一桌经典轮盘赌。所有人先把筹码压在想赌的位置上，DM 统一开转，最后按落点一次性结算全部下注。',
            flow: [
                '下注阶段先选好你要操作的角色，再在轮盘桌上压号码、颜色、单双、大小或区段。',
                '同一轮里可以拆成多笔下注，所以可以同时押保守盘和高赔率盘。',
                'DM 开转后，轮盘和小球会一起转动，最终停在一个确定号码上。',
                '系统会把命中的下注统一派奖，没命中的下注则在这轮结算掉。'
            ],
            win: [
                '押得越具体，命中率通常越低，但赔率也越高，例如单号。',
                '押颜色、单双、大小或十二宫这种范围盘更稳，回报也会相对平一些。',
                '如果一轮里命中不止一个下注位，系统会把这些命中一起算进最终派彩。'
            ],
            notes: [
                '轮盘赌的操作重点都在下注阶段，真正开转和推进流程仍由 DM 负责。',
                '下注是挂在你当前选中的参赛角色上，不是直接挂在用户账号上。',
                '这桌更适合多人围观和一起押注，节奏会比纸牌类游戏慢一点。'
            ]
        },
        en: {
            summary: 'This is a classic roulette table. Everyone places bets first, the DM starts the spin, and every wager is settled together from the final number.',
            flow: [
                'During betting, choose the participant you want to use and place chips on numbers, colors, odd/even, high/low, or larger board regions.',
                'A single round can contain several separate bets, so you can mix safer wagers with high-payout shots.',
                'Once the DM starts the spin, the wheel and ball animate until they stop on one final number.',
                'The table pays every winning wager from that result and clears the losing ones for the round.'
            ],
            win: [
                'The more specific the bet, the lower the hit rate usually is, but the higher the payout tends to be.',
                'Broad bets like color, odd/even, high/low, or dozens hit more often but pay less.',
                'A single spin can score more than one of your bets, and all matching hits are added into the final payout.'
            ],
            notes: [
                'Roulette is mostly about the betting phase; the DM still controls the actual spin and phase flow.',
                'Bets are tracked on the participant you selected, not directly on the user account.',
                'This table works best as a shared spectator game where several players bet at once.'
            ]
        }
    },
    blackjack: {
        zh: {
            summary: '经典 21 点。目标是不爆牌，尽量靠近 21，然后和庄家比大小。',
            flow: [
                '先下注，再由 DM 统一发牌。',
                '轮到你时决定要牌还是停牌。',
                '所有玩家结束后，庄家补牌并统一结算。'
            ],
            win: [
                '超过 21 直接爆牌。',
                '没爆牌就比点数，越接近 21 越大；自然黑杰克单独算。'
            ],
            notes: [
                '当前 DM 固定当庄家。',
                '操作和自己的手牌都在下方区域。'
            ]
        },
        en: {
            summary: 'Classic blackjack. Get as close to 21 as you can without busting, then compare against the dealer.',
            flow: [
                'Bet first, then the DM deals the opening hand.',
                'On your turn, choose hit or stand.',
                'After all players finish, the dealer draws and the round settles.'
            ],
            win: [
                'Going over 21 is an immediate bust.',
                'If nobody busts, the hand closer to 21 wins. Natural blackjack resolves separately.'
            ],
            notes: [
                'The current DM is always the dealer.',
                'Your controls and private hand live in the bottom area.'
            ]
        }
    },
    dragontiger: {
        zh: {
            summary: '龙虎斗是一桌节奏很快的比大小游戏。桌上只开“龙”和“虎”两边各一张牌，所有玩家先押边，开牌后立刻见结果。',
            flow: [
                '下注阶段每个席位选择押龙、押虎或押和，并锁定本轮金额。',
                '所有人下完后，由 DM 统一开牌，龙边和虎边各翻出一张牌。',
                '两张牌只比大小，不需要补牌，也没有额外操作回合。',
                '开牌后系统按胜边和下注方向一次性结算所有席位。'
            ],
            win: [
                '你押中的那一边牌点更大，就算这轮命中。',
                '如果两边同点，则只按和局结果来结算，其他下注按桌面规则退回或失利。',
                '因为每轮只翻两张牌，所以它比百家乐和 21 点更直接、更快。'
            ],
            notes: [
                '这桌没有玩家自己的手牌区，重点在下注和看中间开牌结果。',
                '当前流程仍由 DM 负责推进开牌和下一轮。',
                '适合当成一桌短回合、连着押很多把的快节奏玩法。'
            ]
        },
        en: {
            summary: 'Dragon Tiger is a very fast head-to-head card game. The table reveals one card for Dragon and one for Tiger after everyone places a side bet.',
            flow: [
                'During betting, each seat chooses Dragon, Tiger, or Tie and locks in the round amount.',
                'Once everyone is done, the DM reveals one card on each side.',
                'The two cards only compare rank; there are no draw steps or extra player turns.',
                'After reveal, the system settles every seat from the winning side and the chosen bet.'
            ],
            win: [
                'If the side you backed shows the higher card, that wager hits.',
                'If both sides tie, only tie bets resolve as winners and the other wagers follow the current table rules.',
                'Because each round is only two cards, it is much quicker and more direct than baccarat or blackjack.'
            ],
            notes: [
                'This table has no private player hand area; the focus is on betting and the shared reveal.',
                'The DM still advances the reveal and the next round.',
                'It works well as a fast table where people want to fire through many short rounds.'
            ]
        }
    },
    baccarat: {
        zh: {
            summary: '百家乐不是各打一手，而是一起押闲、庄或和。',
            flow: [
                '先下注，选押闲、庄或和。',
                '开牌后由系统按百家乐规则自动补牌。',
                '最后只看庄闲两边谁大，再统一结算。'
            ],
            win: [
                '百家乐只看个位数，比如 15 算 5 点。',
                '你押中的结果和最终结果一致就赢；押和只有真和局才中。'
            ],
            notes: [
                '玩家主要做的是下注，不是自己打牌。',
                '桌上只有庄、闲两手公开牌。'
            ]
        },
        en: {
            summary: 'Baccarat is a shared betting game. Everyone bets on Player, Banker, or Tie.',
            flow: [
                'Bet on Player, Banker, or Tie first.',
                'After reveal, the table follows baccarat draw rules automatically.',
                'When the public hands finish, the table settles all bets together.'
            ],
            win: [
                'Baccarat only uses the last digit of the total, so 15 becomes 5.',
                'Your bet wins if it matches the final result; Tie only wins on a real tie.'
            ],
            notes: [
                'Players are betting on the public result, not controlling private hands.',
                'The table only shows the shared Banker and Player hands.'
            ]
        }
    },
    casinowar: {
        zh: {
            summary: '赌场战争是所有玩家一起对庄家比单张的大牌游戏。每人先押一笔主注，翻牌后比点数；如果遇到平点，就会进入战争牌。',
            flow: [
                '下注阶段先锁定主注，所有参赛席位都是各自对庄家进行结算。',
                '开牌后，每个玩家和庄家各翻一张牌，先比较这一张的大小。',
                '如果玩家牌大于庄家，主注直接命中；如果更小则直接失利。',
                '若双方平点，就按桌面流程进入战争牌，再决定最终输赢。'
            ],
            win: [
                '最直接的结果就是玩家大赢、庄家大输。',
                '平点时不会马上结算，而是靠后续战争牌继续分胜负。',
                '它的刺激点在于规则简单，但平点后会突然把赌注风险拉高。'
            ],
            notes: [
                '这桌的玩家依旧只管自己那一手，不需要操作公共手牌。',
                '战争牌阶段的结果会直接体现在最终结算面板里。',
                '如果你想要比龙虎斗多一点悬念、又不想像 21 点那样逐步操作，这桌会很合适。'
            ]
        },
        en: {
            summary: 'Casino War is a shared table where every player compares a single card against the dealer. Each seat starts with one main bet, and ties go to war.',
            flow: [
                'During betting, every seat locks the main wager and later resolves against the dealer separately.',
                'After reveal, each player and the dealer flip one card and compare that first card.',
                'If the player card is higher, the main wager wins immediately; if lower, it loses immediately.',
                'When the cards tie, the table goes into war and uses the follow-up reveal to decide the final result.'
            ],
            win: [
                'The simplest outcome is just player high versus dealer high.',
                'A tie does not resolve at once and instead pushes the round into the war step.',
                'The excitement comes from how simple the base rule is and how suddenly a tie can raise the stakes.'
            ],
            notes: [
                'Each player still only cares about their own seat and does not operate any shared public hand.',
                'War outcomes are shown directly in the final settlement panel.',
                'If you want more suspense than Dragon Tiger but less turn-by-turn play than blackjack, this table fits well.'
            ]
        }
    },
    threecardpoker: {
        zh: {
            summary: '三张扑克是先下注，再看三张牌决定要不要继续的一种玩法。',
            flow: [
                '先下 Ante；想加注也可以补 Pair Plus。',
                '发牌后先看自己的三张牌。',
                '然后决定继续跟 Play，还是直接 Fold。',
                '最后亮庄牌，按规则统一结算。'
            ],
            win: [
                'Pair Plus 只看你自己的牌型。',
                '主注部分要先看庄家是否合格，再看谁的三张牌更大。'
            ],
            notes: [
                '这桌重点就是看牌后要不要继续追。',
                '结算后会公开大家的牌。'
            ]
        },
        en: {
            summary: 'Three Card Poker is about betting first, looking at three cards, and deciding whether to continue.',
            flow: [
                'Place Ante first, and add Pair Plus if you want.',
                'After the deal, check your three private cards.',
                'Choose Play or Fold.',
                'Then the dealer hand is revealed and the table settles.'
            ],
            win: [
                'Pair Plus only cares about your own hand type.',
                'The main bet checks dealer qualification first, then compares the two hands.'
            ],
            notes: [
                'The main tension is deciding whether the hand is worth continuing.',
                'At settlement, all hands are revealed.'
            ]
        }
    },
    texasholdem: {
        zh: {
            summary: '经典德州扑克现金桌。开桌时买入成桌内筹码，之后每一手按大小盲、公共牌和多轮下注推进。',
            flow: [
                'DM 开桌时设小盲、大盲和买入金额；买入只扣一次，后续连续开手不会重复扣。',
                '每手自动轮转按钮位和盲注，每位玩家拿到两张只有自己能看的底牌。',
                '翻牌前、翻牌、转牌、河牌都会按顺序行动，可以过牌、跟注、加注、弃牌或全下。',
                '一手结束后，底池会先回到桌内 stack；DM 结束整桌时，剩余 stack 才退回筹码或角色 GP。'
            ],
            win: [
                '如果其他人都弃牌，最后未弃牌者直接拿下底池，不公开底牌。',
                '如果打到摊牌，系统会从两张底牌和五张公共牌里自动选最佳五张牌比较。',
                '多人全下时会按投入金额拆主池和边池，能赢哪个池只看你实际参与了哪个池。'
            ],
            notes: [
                '这桌适合 2 到 6 人短局，不做锦标赛盲注升级或中途 rebuy。',
                '底牌不会进公开状态；其他玩家和旁观者只能看到牌背，摊牌时才公开仍在局内的手牌。'
            ]
        },
        en: {
            summary: 'Classic Texas Hold\'em cash table. Buy in once at setup, then play hands with blinds, community cards, and betting streets.',
            flow: [
                'The DM sets the small blind, big blind, and buy-in at setup. The buy-in is paid once and reused across hands as table stack.',
                'Each hand rotates the button and blinds automatically, then each seat receives two private hole cards.',
                'Preflop, flop, turn, and river all use ordered actions: check, call, raise, fold, or all-in.',
                'Hand winnings stay on the table stack. When the DM finishes the table, remaining stacks return to chips or character GP.'
            ],
            win: [
                'If everyone else folds, the last live seat takes the pot without showing hole cards.',
                'At showdown, the table automatically picks the best five-card hand from hole cards and community cards.',
                'When players go all-in for different amounts, main and side pots decide which seats can win each pot.'
            ],
            notes: [
                'This table is tuned for short 2-6 player cash games, not tournaments, blind ladders, or mid-table rebuy.',
                'Hole cards never enter the public state; other players and spectators only see card backs until a real showdown.'
            ]
        }
    },
    liarsdice: {
        zh: {
            summary: '经典说谎骰——每人摇杯藏 5 颗，轮流喊"几个几"，谁先憋不住就开盅。',
            flow: [
                '每轮开始，每人摇好杯，自己看自己手里的骰子。',
                '起手的人先喊出一口"几个几"，比如"3 个 4"——可以真，也可以诈。',
                '下一位只能往大了叫（点数加，或者数量加），或者直接开盅。',
                '1 默认当万能骰算；这轮里只要有人叫过 1，之后 1 就不当万能了。',
                '开盅一刻，所有杯子掀开——按当前那口判真假。'
            ],
            win: [
                '叫的成立 → 开盅那个人输；不成立 → 上一口那个人输。输家少一颗骰子。',
                '谁的骰子掉光就出局，最后还有骰子的人赢这一整局。'
            ],
            notes: [
                '中央会一直提示当前叫点，以及 1 还能不能当万能。',
                '骰子全程私密，只有你自己看得到自己手里的——开盅那一刻才一起翻。'
            ]
        },
        en: {
            summary: 'Classic Liar\'s Dice — everyone hides five under a cup, take turns calling "N of a kind", whoever folds first calls open.',
            flow: [
                'Each round starts with everyone rolling under their cup — only you see your own.',
                'The opener calls "N of a face", e.g. "three 4s" — could be real, could be a bluff.',
                'Each next player must raise (more dice, or a higher face) or call open.',
                'Ones count as wild by default; once anyone claims 1s this round, 1s stop being wild.',
                'On open, every cup lifts and the last call is checked against the whole table.'
            ],
            win: [
                'Claim held → the one who opened loses; claim failed → the last claimant loses. Loser drops one die.',
                'Out of dice means out. Last seat with dice takes the match.'
            ],
            notes: [
                'The center always shows the current call and whether 1s are still wild.',
                'Your dice stay hidden until open — no one sees what you rolled.'
            ]
        }
    },
    bone21: {
        zh: {
            summary: '一桌没有庄家的骰局——DM 定底注，每人扣进奖池，谁最接近 21 不爆，谁拿奖池。',
            flow: [
                'DM 在开桌时定一个金额，桌上每人都按这个数扣。',
                '开局每人摇 3 颗，只有自己看得到点数。',
                '轮到你时，可以再加一颗，也可以就此停手。',
                '加完总分一旦过 21，这一轮你就出局了。'
            ],
            win: [
                '所有人停手或爆了之后，没爆的里点数最大的拿走奖池。',
                '并列就平分；全员爆了，奖池原样退回。'
            ],
            notes: [
                '起手 3 颗一直是私的，等开盅才一起翻给大家看。',
                'NPC 不在筹码体系里，开桌时不会因为它"没钱"而被卡住。'
            ]
        },
        en: {
            summary: 'A no-dealer dice round. The DM sets the ante, everyone pays in, closest to 21 without busting takes the pot.',
            flow: [
                'DM picks one ante at table setup — every seat pays it into the pot.',
                'Each player rolls 3 dice that only they can see.',
                'On your turn, take one more die or stop where you are.',
                'Go past 21 and you bust out of the round.'
            ],
            win: [
                'When everyone stops or busts, the highest non-bust total wins.',
                'Ties split the pot; if everyone busts, antes go back.'
            ],
            notes: [
                'The opening 3 stay private until the round opens.',
                'NPCs don\'t use chips, so they never block the ante check.'
            ]
        }
    },
    crazyeights: {
        zh: {
            summary: '疯狂八（Crazy Eights）是一种以率先出完手牌为目标的纸牌游戏。玩家按花色或点数接续出牌，其中 8 是可以指定花色的万能牌。',
            paragraphs: [
                'Parlor 的疯狂八支持 2 至 8 人。2 至 5 人使用一副扑克牌，6 至 8 人使用两副。开局时，每位玩家支付相同的底注，合为底注池。两人游戏每人发 7 张牌，三人及以上每人发 5 张，其余牌作为抽牌堆，并翻开一张作为弃牌堆的起始牌。',
                '玩家按当前方向轮流行动，每回合可打出一张与当前花色或弃牌堆顶牌点数相同的牌。8 不受花色和点数限制；打出后，由出牌者指定下一位玩家须跟随的花色。下一位玩家可以打出该花色的牌，或再出一张 8。指定花色属于此次出牌的一部分，完成后回合结束。',
                '默认抽牌规则下，玩家每回合可抽一张牌，即使手中已有可出的牌。抽牌后，可以打出手中任意一张符合规则的牌，也可以结束回合；若无牌可出，回合自动结束。另有「抽到能出为止」规则：每回合最多抽三张，抽牌后只要手中有可出的牌，就必须出牌；达到上限仍无牌可出时，回合自动结束。',
                '功能牌规则赋予 2、J 和 Q 额外作用。2 使下一位玩家罚抽两张；罚抽尚未处理时，该玩家只能打出另一张 2，将罚抽数量增加两张并传给下一位，或接受累计罚抽并结束回合。J 跳过下一位玩家，Q 反转行动方向；两人游戏中的 Q 则跳过对方。采用经典规则时，只有 8 具有特殊作用，其余牌均按普通牌使用。',
                '率先出完手牌的玩家获胜，并获得底注池。若最后一张牌是 8，游戏立即结束，无须再指定花色。游戏不要求玩家在只剩一张手牌时作出口头声明。',
                '若启用剩牌罚金，其他玩家还须按剩余手牌的点数向赢家支付罚金。8 计 50 点，J、Q、K 各计 10 点，A 计 1 点，其余牌按牌面数字计分。剩牌总点数乘以每点罚金，即为应付金额，实际扣款以可用筹码余额为限。',
                '抽牌堆耗尽时，弃牌堆保留最上方一张，其余牌重新洗入抽牌堆。若已无牌可抽，且连续一整圈无人出牌，则以剩余手牌总点数最低者为胜者；同分者平分底注池，此时不收取剩牌罚金。'
            ]
        },
        en: {
            summary: 'Crazy Eights is a card game in which players compete to be the first to empty their hand. Cards are played by matching suit or rank, with eights serving as wild cards that allow the player to name a suit.',
            paragraphs: [
                'Parlor supports two to eight players. One deck is used for two to five players, and two decks for six to eight. Each player contributes the same ante to a shared pot. Seven cards are dealt to each player in a two-player game, or five with three or more players. The remaining cards form the stock, and one card is turned face up to begin the discard pile.',
                'Play proceeds in the current direction. A player may play one card matching either the current suit or the rank of the top discard. An eight may be played regardless of suit or rank, after which its player names the suit to be followed. The next player must play that suit or another eight. Naming the suit completes the play and ends the turn.',
                'Under the default draw rule, a player may draw one card per turn, even when holding a playable card. After drawing, the player may play any legal card from their hand or end the turn. A turn ends automatically if no card can be played. The alternative Draw until playable rule allows up to three draws per turn. After a draw, a player holding a legal card must play; reaching the limit without a legal card ends the turn automatically.',
                'The action-card rules give twos, jacks and queens additional effects. A two imposes a two-card draw penalty on the next player. While a penalty is pending, that player must either play another two, adding two cards to the penalty and passing it on, or draw the accumulated penalty and end their turn. A jack skips the next player. A queen reverses direction, or skips the opponent in a two-player game. Under classic rules, only eights have a special effect.',
                'The first player to empty their hand wins the ante pot. A final eight ends the game immediately, without a suit being named. Players are not required to announce when they have one card remaining.',
                'If leftover penalties are enabled, the other players also pay the winner according to the cards left in their hands. Eights count as 50 points; jacks, queens and kings as 10; aces as 1; and other cards at face value. The hand total is multiplied by the penalty per point, with the amount deducted limited to the available chip balance.',
                'When the stock is exhausted, all but the top discard are shuffled to form a new stock. If no cards remain available to draw and a full circuit passes without a card being played, the player with the lowest hand total wins. Tied players share the ante pot, and no leftover penalties are charged.'
            ]
        }
    },
    beetlerace: {
        zh: {
            summary: '甲虫赛跑是一种押注比赛结果的博彩游戏。DM 事先配好赛事卡，开桌后甲虫依次入场亮相，玩家挑选甲虫下注，再一起观看比赛，押中冠军的人按倍率拿回彩金。',
            paragraphs: [
                '每张赛事卡规定上场的甲虫（三至八只）、赛程时长、下注时长、赔付倍率和单笔下注的上下限。每只甲虫有自己的名字、外观、战力和介绍；战力越高，跑得越快，但比赛中的变数足以让冷门翻盘。赛事卡还决定玩家能否看到战力：公开数字、只显示星级，或完全隐藏。',
                '第一场开始前，甲虫依次登场亮相。随后进入下注阶段：每位参赛者可以押一只或几只甲虫，每只各押一笔，封盘前可以随时修改或撤回。所有注额合计不能超过自己的余额。下注倒计时结束，或 DM 提前封盘，比赛即开始。',
                '比赛中，甲虫会随机出状况：冲刺、打滑、翻肚皮、停下吃东西等。这些插曲会暂时改变名次，但甲虫之后会逐渐追回或让出差距，胜负主要取决于战力。只有第一名计入派彩：押中冠军的注额按该甲虫的倍率赔付（含本金），其余注额全部输掉。',
                'DM 可以在比赛中作弊：让某只甲虫施展事先配置好的招式，或暗中调整它的速度。招式有的明目张胆（起飞、闪现、法术），有的与自然出现的状况无异，玩家无从分辨。'
            ]
        },
        en: {
            summary: 'Beetle Derby is a betting game on the outcome of a race. The DM prepares race cards in advance; at the table, the beetles are introduced one by one, players back the beetles they fancy, and everyone watches the race together. Bets on the winner pay out at the listed multiplier.',
            paragraphs: [
                'Each race card sets the runners (three to eight beetles), the race length, the betting time, the payout multipliers and the minimum and maximum stake. Every beetle has its own name, appearance, power rating and description. Higher power means a faster beetle, but races are unpredictable enough for an outsider to win. The race card also decides whether players can see power ratings: as numbers, as stars, or not at all.',
                'Before the first race, the beetles parade out one at a time. Betting follows: each participant may back one or several beetles, with one stake per beetle, and may change or withdraw bets until betting closes. The total of a participant\'s bets may not exceed their balance. The race begins when the betting timer runs out or the DM closes betting early.',
                'During the race, beetles run into trouble at random: sudden sprints, spin-outs, flipping onto their backs, stopping for a snack. These incidents shuffle the order for a while, but beetles gradually make up or give back the difference, so power decides most races. Only the winner pays: stakes on the winning beetle are paid at its multiplier, including the stake, and all other stakes are lost.',
                'The DM may cheat during the race, making a beetle perform a prepared move or quietly adjusting its speed. Some moves are blatant (flight, teleportation, spells); others look exactly like the natural incidents, and players cannot tell the difference.'
            ]
        }
    },
    slotmachine: {
        zh: {
            summary: '每次一位玩家，单人操作，多人围观。3x5 经典布局。',
            flow: [
                '开局后只保留 1 位操作者，其他人默认观战。',
                '转轮从左到右停下后，系统会立刻检查整张 3x5 盘面。'
            ],
            win: [
                '同一图案从左往右连续连到 3、4、5 列就算命中；同列里能接上的位置越多，中出的组数也越多。',
                'Wild 可以代替普通图案补连，Scatter 不看连线，盘面出现 3 个以上就单独算奖。'
            ],
            notes: [
                '同一转里命中的普通奖和 Scatter 会一起合并结算。'
            ]
        },
        en: {
            summary: 'One active player at a time. Solo play, table-side spectators, classic 3x5 layout.',
            flow: [
                'Only one operator stays active when the table starts, and everyone else watches.',
                'After the reels stop from left to right, the machine checks the full 3x5 board immediately.'
            ],
            win: [
                'A symbol wins when it connects from the left across 3, 4, or 5 reels; more matching positions on a reel create more ways.',
                'Wild substitutes for regular symbols. Scatter pays anywhere on the board with 3 or more, and all hits are added together.'
            ],
            notes: [
                'Line wins and Scatter wins are merged into the same spin result.'
            ]
        }
    }
};

const BACCARAT_DRAW_GUIDE = {
    zh: {
        title: '补牌规则仅供参考，系统会自动判定是否需要补牌，作为DM，您不需要记住这些复杂的规则',
        items: [
            '如果庄或闲首两张就达到 8 点或 9 点，属于天牌，这一轮双方都不补牌。',
            '闲家首两张 0 到 5 点时补一张，6 到 7 点停牌。',
            '如果闲家没有补牌，庄家 0 到 5 点补牌，6 到 7 点停牌。',
            '如果闲家补了第三张，庄家 0 到 2 点一定补牌，7 点一定停牌。',
            '庄家 3 点时，闲家第三张不是 8 就补；庄家 4 点时，闲家第三张为 2 到 7 补。',
            '庄家 5 点时，闲家第三张为 4 到 7 补；庄家 6 点时，闲家第三张为 6 或 7 才补。'
        ]
    },
    en: {
        title: 'These draw rules are only here for reference. The system decides draws automatically, so the DM does not need to memorize them.',
        items: [
            'If either side opens on 8 or 9, that is a natural and neither side draws a third card.',
            'Player draws on 0 through 5 and stands on 6 or 7.',
            'If Player stands, Banker draws on 0 through 5 and stands on 6 or 7.',
            'If Player takes a third card, Banker always draws on 0 through 2 and always stands on 7.',
            'Banker on 3 draws unless Player drew an 8, and Banker on 4 draws when Player drew 2 through 7.',
            'Banker on 5 draws when Player drew 4 through 7, and Banker on 6 only draws when Player drew 6 or 7.'
        ]
    }
};

function getGuideLocale() {
    const lang = String(game.i18n.lang || 'en').toLowerCase();
    return lang.startsWith('zh') || lang.startsWith('cn') ? 'zh' : 'en';
}

const GAME_REGISTRY = {
    roulette: {
        id: 'roulette',
        name: 'PARLOR.Games.Roulette.Name',
        desc: 'PARLOR.Games.Roulette.Desc',
        icon: 'fas fa-circle-notch',
        color: '#2e7d32',
        dealerMode: 'gm',
        load: () => import('../games/roulette/RouletteGame.js').then(m => m.RouletteGame),
        loadUI: () => import('../games/roulette/RouletteUI.js').then(m => m.RouletteUI)
    },
    dragontiger: {
        id: 'dragontiger',
        name: 'PARLOR.Games.DragonTiger.Name',
        desc: 'PARLOR.Games.DragonTiger.Desc',
        icon: 'fas fa-dragon',
        color: '#7b3f15',
        dealerMode: 'gm',
        load: () => import('../games/dragontiger/DragonTigerGame.js').then(m => m.DragonTigerGame),
        loadUI: () => import('../games/dragontiger/DragonTigerTable.js').then(m => m.DragonTigerTable)
    },
    baccarat: {
        id: 'baccarat',
        name: 'PARLOR.Games.Baccarat.Name',
        desc: 'PARLOR.Games.Baccarat.Desc',
        icon: 'fas fa-crown',
        color: '#114c3b',
        dealerMode: 'gm',
        load: () => import('../games/baccarat/BaccaratGame.js').then(m => m.BaccaratGame),
        loadUI: () => import('../games/baccarat/BaccaratTable.js').then(m => m.BaccaratTable)
    },
    casinowar: {
        id: 'casinowar',
        name: 'PARLOR.Games.CasinoWar.Name',
        desc: 'PARLOR.Games.CasinoWar.Desc',
        icon: 'fas fa-shield-alt',
        color: '#5b3417',
        dealerMode: 'gm',
        load: () => import('../games/casinowar/CasinoWarGame.js').then(m => m.CasinoWarGame),
        loadUI: () => import('../games/casinowar/CasinoWarTable.js').then(m => m.CasinoWarTable)
    },
    threecardpoker: {
        id: 'threecardpoker',
        name: 'PARLOR.Games.ThreeCardPoker.Name',
        desc: 'PARLOR.Games.ThreeCardPoker.Desc',
        icon: 'fas fa-layer-group',
        color: '#5c2d1f',
        dealerMode: 'gm',
        load: () => import('../games/threecardpoker/ThreeCardPokerGame.js').then(m => m.ThreeCardPokerGame),
        loadUI: () => import('../games/threecardpoker/ThreeCardPokerTable.js').then(m => m.ThreeCardPokerTable)
    },
    texasholdem: {
        id: 'texasholdem',
        name: 'PARLOR.Games.TexasHoldem.Name',
        desc: 'PARLOR.Games.TexasHoldem.Desc',
        icon: 'fas fa-spade',
        color: '#0f6b4a',
        dealerMode: 'gm',
        load: () => import('../games/texasholdem/TexasHoldemGame.js').then(m => m.TexasHoldemGame),
        loadUI: () => import('../games/texasholdem/TexasHoldemTable.js').then(m => m.TexasHoldemTable)
    },
    liarsdice: {
        id: 'liarsdice',
        name: 'PARLOR.Games.LiarsDice.Name',
        desc: 'PARLOR.Games.LiarsDice.Desc',
        icon: 'fas fa-dice-five',
        color: '#2f5d46',
        dealerMode: 'gm',
        load: () => import('../games/liarsdice/LiarsDiceGame.js').then(m => m.LiarsDiceGame),
        loadUI: () => import('../games/liarsdice/LiarsDiceTable.js').then(m => m.LiarsDiceTable)
    },
    bone21: {
        id: 'bone21',
        name: 'PARLOR.Games.Bone21.Name',
        desc: 'PARLOR.Games.Bone21.Desc',
        icon: 'fas fa-dice-d20',
        color: '#6c4d25',
        dealerMode: 'gm',
        load: () => import('../games/bone21/Bone21Game.js').then(m => m.Bone21Game),
        loadUI: () => import('../games/bone21/Bone21Table.js').then(m => m.Bone21Table)
    },
    crazyeights: {
        id: 'crazyeights',
        name: 'PARLOR.Games.CrazyEights.Name',
        desc: 'PARLOR.Games.CrazyEights.Desc',
        icon: 'fas fa-dice-d8',
        color: '#3a4f7a',
        dealerMode: 'gm',
        // 大厅元数据：大厅谓词先看这里，没有再走原来按 id 写死的分支。老游戏暂时没迁，别指望它们有这块
        lobby: {
            minParticipants: 2,
            maxParticipants: 8,
            allowGM: true,
            // GM 席位不进账:金币/筹码都不查不扣,没绑角色也能坐(DM 想下多少下多少)
            gmExempt: true,
            allowNpc: true,
            autoFillBots: true,
            participantsNoteKey: 'PARLOR.Lobby.Setup.CrazyEightsParticipantsNote'
        },
        load: () => import('../games/crazyeights/CrazyEightsGame.js').then(m => m.CrazyEightsGame),
        loadUI: () => import('../games/crazyeights/CrazyEightsTable.js').then(m => m.CrazyEightsTable)
    },
    beetlerace: {
        id: 'beetlerace',
        name: 'PARLOR.Games.BeetleRace.Name',
        desc: 'PARLOR.Games.BeetleRace.Desc',
        icon: 'fas fa-bug',
        color: '#5a6e2a',
        dealerMode: 'gm',
        lobby: {
            minParticipants: 1,
            maxParticipants: 12,
            allowGM: true,
            // 跟疯狂八一样，DM 坐下来押着玩不进账
            gmExempt: true,
            allowNpc: true,
            // 主角是甲虫：没人押注也照跑，DM 自测不补机器人（见 GameLobby._composeSetupParticipants）
            autoFillBots: false,
            participantsNoteKey: 'PARLOR.Lobby.Setup.BeetleRaceParticipantsNote'
        },
        load: () => import('../games/beetlerace/BeetleRaceGame.js').then(m => m.BeetleRaceGame),
        loadUI: () => import('../games/beetlerace/BeetleRaceTable.js').then(m => m.BeetleRaceTable)
    },
    slotmachine: {
        id: 'slotmachine',
        name: 'PARLOR.Games.SlotMachine.Name',
        desc: 'PARLOR.Games.SlotMachine.Desc',
        icon: 'fas fa-coins',
        color: '#8b1e2d',
        dealerMode: 'gm',
        load: () => import('../games/slotmachine/SlotMachineGame.js').then(m => m.SlotMachineGame),
        loadUI: () => import('../games/slotmachine/SlotMachineTable.js').then(m => m.SlotMachineTable)
    },
    blackjack: {
        id: 'blackjack',
        name: 'PARLOR.Games.Blackjack.Name',
        desc: 'PARLOR.Games.Blackjack.Desc',
        icon: 'fas fa-cards',
        color: '#1a1a1a',
        dealerMode: 'gm',
        load: () => import('../games/blackjack/BlackjackGame.js').then(m => m.BlackjackGame),
        loadUI: () => import('../games/blackjack/BlackjackTable.js').then(m => m.BlackjackTable)
    }
};

export function getGameList() {
    return Object.values(GAME_REGISTRY)
        .filter(g => isVisibleInLobby(g.id))
        .map(g => ({
            id: g.id,
            name: game.i18n.localize(g.name),
            desc: game.i18n.localize(g.desc),
            icon: g.icon,
            color: g.color,
            dealerMode: g.dealerMode || 'gm'
        }));
}

export function getGameConfig(gameType) {
    const entry = GAME_REGISTRY[gameType];
    if (!entry) return null;
    return {
        ...entry,
        nameText: game.i18n.localize(entry.name),
        descText: game.i18n.localize(entry.desc),
        dealerMode: entry.dealerMode || 'gm'
    };
}

export function getGameGuide(gameType) {
    const guideSet = GAME_GUIDE_TEXT[gameType];
    if (!guideSet) return null;

    const locale = getGuideLocale();
    const guide = guideSet[locale] ?? guideSet.en ?? guideSet.zh;
    if (!guide) return null;

    const flowText = Array.isArray(guide.flow) && guide.flow.length
        ? guide.flow.join(' ')
        : '';
    const winText = Array.isArray(guide.win) && guide.win.length
        ? guide.win.join(' ')
        : '';
    const notesText = Array.isArray(guide.notes) && guide.notes.length
        ? guide.notes.join(' ')
        : '';
    const defaultParagraphs = gameType === 'liarsdice'
        ? [flowText].filter(Boolean)
        : [flowText, winText].filter(Boolean);
    const paragraphs = Array.isArray(guide.paragraphs)
        ? guide.paragraphs.filter(Boolean)
        : defaultParagraphs;
    const baccaratAccordion = gameType === 'baccarat'
        ? (BACCARAT_DRAW_GUIDE[locale] ?? BACCARAT_DRAW_GUIDE.en)
        : null;
    const note = gameType === 'liarsdice' ? [winText, notesText].filter(Boolean).join(' ') : '';

    return {
        summary: guide.summary || '',
        paragraphs,
        note,
        accordion: baccaratAccordion
    };
}

export async function createGameInstance(gameType, config) {
    const entry = GAME_REGISTRY[gameType];
    if (!entry) throw new Error(`Unknown game type: ${gameType}`);
    const GameClass = await entry.load();
    if (typeof GameClass !== 'function') {
        throw new Error(`GameClass for '${gameType}' is not a constructor. Check exports.`);
    }
    return new GameClass(config);
}

export async function createGameUI(gameType, gameInstance) {
    const entry = GAME_REGISTRY[gameType];
    if (!entry) throw new Error(`Unknown game type: ${gameType}`);
    const UIClass = await entry.loadUI();
    if (typeof UIClass !== 'function') {
        throw new Error(`UIClass for '${gameType}' is not a constructor. Check exports.`);
    }
    return new UIClass({ gameInstance });
}

export { GAME_REGISTRY };
