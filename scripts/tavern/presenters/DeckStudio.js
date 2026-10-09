/**
 * DeckStudio — 赌桌工坊(大厅直达的外观编辑)
 *
 * 不开局也能改外观:起一张无游戏逻辑的空预览桌(TavernTableShell + 空数据 stub),
 * 直接进 TavernDeckEditor 编辑指定预设。保存/取消都回大厅,不碰"今夜赌桌"激活位。
 */

import { TavernTableShell } from './TavernTableShell.js';
import { TavernDeckEditor } from './TavernDeckEditor.js';

// 预览壳:基类默认钩子就是一张空桌(无阶段条/无桌面渲染),正合适
class StudioShell extends TavernTableShell {}

export class DeckStudio {
    static _root = null;
    static _shell = null;

    static get api() {
        return game.modules.get('parlor')?.api?.tableDecks || null;
    }

    static open(deckId) {
        this.close(); // 单例:重复打开先收掉旧的
        if (!this.api) return;

        const root = document.createElement('div');
        root.id = 'parlor-deck-studio';
        // pds-studio:工坊场景藏掉空 HUD 木台和链吊匾,只留招牌+桌台+摆件
        root.className = 'parlor-presenter-root pds-studio';
        document.body.appendChild(root);
        this._root = root;

        // 空数据 stub:壳只画桌台和氛围,预设实时读存档(保存后 revert 才有正确基准)
        const stubApi = {
            getState: () => ({}),
            getSeats: () => [],
            getStatus: () => ({}),
            getHud: () => null,
            getTableDeck: () => this.api?.get(deckId) || null,
            getTableBackdrop: () => null,
            renderCard: () => '',
            formatChips: (v) => String(v ?? ''),
            playSound: () => {},
            t: (key, data) => game.i18n.format(key, data || {}),
            requestClose: () => this.close()
        };

        const shell = new StudioShell();
        this._shell = shell;
        shell.mount(root, stubApi);

        // 塞给 shell._deckEditor:壳自带的 ⚒ 按钮就会复用这个实例,不会开出第二个编辑器
        const editor = new TavernDeckEditor(shell, {
            setActiveOnSave: false,
            onClose: () => this.close()
        });
        shell._deckEditor = editor;
        editor.open();
    }

    static close() {
        if (!this._root) return;
        const shell = this._shell;
        this._shell = null;
        const root = this._root;
        this._root = null; // 先摘引用再销毁:destroy→editor.close→onClose 会再进来一次,直接空转返回
        shell?.destroy();
        root.remove();
    }
}
