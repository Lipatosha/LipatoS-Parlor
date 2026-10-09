/**
 * Parlor Themes — Fantasy Tavern
 *
 * Presenter API v1 consumer. Contract: parlor/docs/presenter-api-v1.md (English, authoritative).
 * 注册骨架:surfaces 暂空,呈现器(桌面/大厅)随视觉移植逐面点亮——
 * 未接管的面由本体原生 UI 兜底,这是契约行为,不是故障。
 */

import { TexasTablePresenter } from './presenters/TexasTablePresenter.js';
import { BlackjackTablePresenter } from './presenters/BlackjackTablePresenter.js';
import { LiarsDiceTablePresenter } from './presenters/LiarsDiceTablePresenter.js';
import { BaccaratTablePresenter } from './presenters/BaccaratTablePresenter.js';
import { DragonTigerTablePresenter } from './presenters/DragonTigerTablePresenter.js';
import { CasinoWarTablePresenter } from './presenters/CasinoWarTablePresenter.js';
import { ThreeCardPokerTablePresenter } from './presenters/ThreeCardPokerTablePresenter.js';
import { Bone21TablePresenter } from './presenters/Bone21TablePresenter.js';
import { CrazyEightsTablePresenter } from './presenters/CrazyEightsTablePresenter.js';
import { BeetleRaceTablePresenter } from './presenters/BeetleRaceTablePresenter.js';
import { TavernLobbySkin } from './lobby/TavernLobbySkin.js';

const MODULE_ID = 'parlor';

export function registerBuiltInTavernTheme() {
    const api = game.modules.get('parlor')?.api;
    if (typeof api?.registerThemePresenter !== 'function') {
        // 本体缺席或版本过老:只告警不炸,主题静默失活
        console.warn(`${MODULE_ID} | Parlor core with Presenter API not found; tavern theme inactive`);
        return;
    }

    const registered = api.registerThemePresenter({
        id: 'tavern',
        labelKey: 'PARLORTAVERN.Name',
        presenterApiVersion: 1,
        surfaces: {
            'table:texasholdem': TexasTablePresenter,
            'table:blackjack': BlackjackTablePresenter,
            'table:liarsdice': LiarsDiceTablePresenter,
            // 下面四桌的呈现器已就绪;本体挂载点由数据面批次接入,接入前 resolve 不会被调用、原生兜底
            'table:baccarat': BaccaratTablePresenter,
            'table:dragontiger': DragonTigerTablePresenter,
            'table:casinowar': CasinoWarTablePresenter,
            'table:threecardpoker': ThreeCardPokerTablePresenter,
            'table:bone21': Bone21TablePresenter,
            'table:crazyeights': CrazyEightsTablePresenter,
            'table:beetlerace': BeetleRaceTablePresenter
            // 大厅刻意不接管:原生窗口布局/弹窗层级保持原样,酒馆风由 TavernLobbySkin 换色实现
        }
    });

    if (registered) {
        console.log(`${MODULE_ID} | tavern theme registered (10 tables)`);
    }

    // 原生大厅换酒馆色 + 注入「今夜赌桌」面板(含外观编辑入口)
    TavernLobbySkin.init();
}
