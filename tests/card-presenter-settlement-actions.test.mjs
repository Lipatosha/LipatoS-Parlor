import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildBaccaratHud,
    buildBaccaratStatus
} from '../scripts/games/baccarat/BaccaratPresenterData.js';
import {
    buildCasinoWarHud,
    buildCasinoWarStatus
} from '../scripts/games/casinowar/CasinoWarPresenterData.js';
import {
    buildDragonTigerHud,
    buildDragonTigerStatus
} from '../scripts/games/dragontiger/DragonTigerPresenterData.js';
import {
    buildThreeCardPokerHud,
    buildThreeCardPokerStatus
} from '../scripts/games/threecardpoker/ThreeCardPokerPresenterData.js';

const games = [
    {
        name: 'Baccarat',
        buildHud: buildBaccaratHud,
        buildStatus: buildBaccaratStatus,
        phases: {
            BETTING: 'Betting',
            READY: 'Ready',
            DEALING: 'Dealing',
            SHOWDOWN: 'Showdown',
            DRAW_RULES: 'DrawRules',
            DRAWING: 'Drawing',
            FINAL_SHOWDOWN: 'FinalShowdown',
            SETTLE: 'Settle',
            RESOLVING: 'Resolving'
        }
    },
    {
        name: 'DragonTiger',
        buildHud: buildDragonTigerHud,
        buildStatus: buildDragonTigerStatus,
        phases: {
            BETTING: 'Betting',
            READY: 'Ready',
            DEALING: 'Dealing',
            SHOWDOWN: 'Showdown',
            SETTLE: 'Settle',
            RESOLVING: 'Resolving'
        }
    },
    {
        name: 'CasinoWar',
        buildHud: buildCasinoWarHud,
        buildStatus: buildCasinoWarStatus,
        phases: {
            BETTING: 'Betting',
            READY: 'Ready',
            DEALING: 'Dealing',
            SHOWDOWN: 'Showdown',
            WAR: 'War',
            SETTLE: 'Settle',
            RESOLVING: 'Resolving'
        }
    },
    {
        name: 'ThreeCardPoker',
        buildHud: buildThreeCardPokerHud,
        buildStatus: buildThreeCardPokerStatus,
        phases: {
            BETTING: 'Betting',
            READY: 'Ready',
            DEALING: 'Dealing',
            DECISION: 'Decision',
            REVEAL_READY: 'RevealReady',
            SHOWDOWN: 'Showdown',
            SETTLE: 'Settle',
            RESOLVING: 'Resolving'
        }
    }
];

function makeState(phase) {
    return {
        phase,
        round: 1,
        playerIds: [],
        bets: [],
        payouts: {},
        playerStates: {},
        warParticipants: []
    };
}

function makeHelpers(requests = []) {
    return {
        t: key => key,
        isGM: () => true,
        getControlledParticipantIds: () => [],
        requestAction: (action, data) => {
            requests.push({ action, data });
            return Promise.resolve({ ok: true });
        }
    };
}

describe('card game presenter settlement actions', () => {
    for (const game of games) {
        it(`${game.name} exposes the settle action during SETTLE`, async () => {
            const requests = [];
            const hud = game.buildHud(makeState('SETTLE'), makeHelpers(requests));

            assert.ok(hud);
            assert.equal(hud.actions.length, 1);
            await hud.actions[0].onClick(null, {});
            assert.equal(requests[0]?.action, 'settle');
        });
    }
});

describe('card game presenter phase localization', () => {
    for (const game of games) {
        it(`${game.name} uses the existing Center.Phase localization keys`, () => {
            const helpers = makeHelpers();

            for (const [phase, label] of Object.entries(game.phases)) {
                const status = game.buildStatus(makeState(phase), helpers);
                assert.equal(status.phase, `PARLOR.${game.name}.Center.Phase.${label}`);
            }
        });
    }
});

describe('Three Card Poker presenter runtime localization', () => {
    const labels = {
        'PARLOR.ThreeCardPoker.Center.Phase.Showdown': '摊牌',
        'PARLOR.ThreeCardPoker.Center.ShowdownTitleQualified': '庄家 {hand}，开始比牌',
        'PARLOR.ThreeCardPoker.Center.ShowdownTitleNotQualified': '庄家 {hand}，未达合格门槛',
        'PARLOR.ThreeCardPoker.Badge.DealerNotQualified': '庄家不合格',
        'PARLOR.ThreeCardPoker.Hand.Pair': '对子',
        'PARLOR.ThreeCardPoker.Hand.StraightFlush': '同花顺',
        'PARLOR.ThreeCardPoker.Hud.AnteLabel': '底注',
        'PARLOR.Common.RoundCounter': '第 {round} 局',
        'PARLOR.Common.CurrentParticipant': '当前角色',
        'PARLOR.Games.ThreeCardPoker.Name': '三张扑克'
    };
    const localize = (key, data = null) => Object.entries(data || {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        labels[key] || key
    );

    it('formats the dealer rank object instead of leaking [object Object]', () => {
        const status = buildThreeCardPokerStatus({
            ...makeState('SHOWDOWN'),
            dealerRank: { category: 'straight-flush' },
            dealerQualified: true
        }, { t: localize });

        assert.equal(status.title, '庄家 同花顺，开始比牌');
        assert.doesNotMatch(status.title, /\[object Object\]|PARLOR\./u);
    });

    it('localizes the selected player hand rank in the HUD identity', () => {
        const state = {
            ...makeState('DECISION'),
            playerIds: ['actor:a'],
            playerStates: {
                'actor:a': {
                    anteAmount: 10,
                    pairPlusAmount: 0,
                    decision: 'play',
                    hand: [{ rank: 'A' }, { rank: 'A' }, { rank: '5' }],
                    handRank: { category: 'pair' }
                }
            }
        };
        const hud = buildThreeCardPokerHud(state, {
            t: localize,
            isGM: () => false,
            getControlledParticipantIds: () => ['actor:a'],
            resolveSelectedParticipantId: () => 'actor:a',
            getParticipantName: () => 'Alice',
            getDisplayParticipant: () => ({ avatarHtml: '' }),
            getBalance: () => 100,
            formatChips: value => `${value} GP`
        });

        assert.match(hud.identity.sub, /对子/u);
        assert.doesNotMatch(hud.identity.sub, /PARLOR\.|\[object Object\]/u);
    });
});

function makeBaccaratDrawHelpers(requests = []) {
    const labels = {
        'PARLOR.Baccarat.Side.Player': '闲',
        'PARLOR.Baccarat.Side.Banker': '庄',
        'PARLOR.Baccarat.DrawTitle.Natural': '天牌',
        'PARLOR.Baccarat.DrawTitle.NoThirdCard': '无需第三张',
        'PARLOR.Baccarat.DrawTitle.RuleBased': '按规则补牌',
        'PARLOR.Baccarat.DrawAction.ExecuteDraw': '执行补牌',
        'PARLOR.Baccarat.DrawAction.ConfirmNoDraw': '直接进入结果',
        'PARLOR.Baccarat.DrawAction.GoToResult': '查看结果',
        'PARLOR.Baccarat.Reason.PlayerDraw05': '闲 4 点，按规则补牌。',
        'PARLOR.Baccarat.Reason.BankerConditional5': '庄 5 点：闲第三张为 4-7 时补牌。',
        'PARLOR.Baccarat.Reason.PlayerNaturalStand': '闲 8 点天牌，停牌。',
        'PARLOR.Baccarat.Reason.NaturalNoDraw': '出现天牌，本轮不补牌。',
        'PARLOR.Baccarat.Reason.PlayerStand67': '闲 7 点，按规则停牌。',
        'PARLOR.Baccarat.Reason.BankerStand7': '庄 7 点停牌。'
    };
    return {
        ...makeHelpers(requests),
        t: key => labels[key] || key
    };
}

describe('Baccarat presenter draw rules', () => {
    const cases = [
        {
            name: 'rule-based draw',
            summary: {
                natural: false,
                playerShouldDraw: true,
                bankerPlan: 'conditional',
                playerReason: { key: 'PARLOR.Baccarat.Reason.PlayerDraw05', data: { total: 4 } },
                bankerReason: { key: 'PARLOR.Baccarat.Reason.BankerConditional5' }
            },
            label: '执行补牌'
        },
        {
            name: 'natural hand',
            summary: {
                natural: true,
                playerShouldDraw: false,
                bankerPlan: 'stand',
                playerReason: { key: 'PARLOR.Baccarat.Reason.PlayerNaturalStand', data: { total: 8 } },
                bankerReason: { key: 'PARLOR.Baccarat.Reason.NaturalNoDraw' }
            },
            label: '查看结果'
        },
        {
            name: 'both sides stand',
            summary: {
                natural: false,
                playerShouldDraw: false,
                bankerPlan: 'stand',
                playerReason: { key: 'PARLOR.Baccarat.Reason.PlayerStand67', data: { total: 7 } },
                bankerReason: { key: 'PARLOR.Baccarat.Reason.BankerStand7' }
            },
            label: '直接进入结果'
        }
    ];

    for (const testCase of cases) {
        it(`uses the localized action for ${testCase.name}`, () => {
            const hud = buildBaccaratHud({
                ...makeState('DRAW_RULES'),
                roundSummary: testCase.summary
            }, makeBaccaratDrawHelpers());

            assert.equal(hud.actions.length, 1);
            assert.equal(hud.actions[0].label, testCase.label);
            assert.doesNotMatch(hud.actions[0].label, /PARLOR\.Baccarat\.Action\.Draw/u);
        });
    }

    it('shows the exact player and banker rules used for this round', () => {
        const hud = buildBaccaratHud({
            ...makeState('DRAW_RULES'),
            roundSummary: cases[0].summary
        }, makeBaccaratDrawHelpers());

        assert.match(hud.centerHtml, /parlor-bac-draw-rules/u);
        assert.match(hud.centerHtml, /按规则补牌/u);
        assert.match(hud.centerHtml, /闲 4 点，按规则补牌。/u);
        assert.match(hud.centerHtml, /庄 5 点：闲第三张为 4-7 时补牌。/u);
    });
});
