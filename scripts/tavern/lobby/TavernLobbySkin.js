/**
 * TavernLobbySkin — 原生大厅的酒馆皮肤 + 「今夜赌桌」面板
 *
 * 大厅不再被呈现器接管:原生 ApplicationV2 窗口原样保留(布局/功能/弹窗层级全不动),
 * 这里只在 renderGameLobby 时做两件事——挂换色类、往内容区尾部注入赌桌预设面板。
 * DialogV2 弹窗因此天然浮在大厅之上,不存在被 z3000 盖住的问题。
 */

import { DeckStudio } from '../presenters/DeckStudio.js';

export class TavernLobbySkin {
    static init() {
        Hooks.on('renderGameLobby', (app) => this.apply(app));
        Hooks.on('parlorTableDeckChanged', () => this.refreshPanel());
    }

    static get parlorApi() { return game.modules.get('parlor')?.api || null; }
    static get decks() { return this.parlorApi?.tableDecks || null; }

    static _isTavernActive() {
        return this.parlorApi?.ParlorAppearance?.getActiveThemeId?.() === 'tavern';
    }

    static _t(key, data) {
        return data ? game.i18n.format(key, data) : game.i18n.localize(key);
    }

    static _esc(text) {
        return String(text ?? '').replace(/[&<>"']/gu, (ch) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
        ));
    }

    // 每次 render 全量重做:摘旧面板、按当前主题挂/摘换色类、需要时插新面板
    static apply(app) {
        const el = app?.element;
        if (!el) return;
        const active = this._isTavernActive();
        el.classList.toggle('parlor-lobby--tavern', active);
        el.querySelector('.tavern-decks')?.remove();
        if (!active || !this.decks) return;

        const content = el.querySelector('.parlor-lobby-content');
        if (!content) return;

        // 玩家侧只有激活桌可看;一张预设都没有就不占地方
        if (!game.user?.isGM && !this.decks.getActive()) return;

        const panel = document.createElement('section');
        panel.className = 'tavern-decks';
        panel.innerHTML = this._panelHtml();
        content.appendChild(panel);
        this._bind(panel);
    }

    // 预设 CRUD 落盘后(所有客户端的)开着的大厅就地重绘面板
    static refreshPanel() {
        const panel = document.querySelector('.parlor-lobby--tavern .tavern-decks');
        if (!panel) return;
        panel.innerHTML = this._panelHtml();
    }

    static _panelHtml() {
        const isGM = !!game.user?.isGM;
        const data = { decks: this.decks?.list() || [], activeId: this.decks?.getActive()?.id || '' };
        const shown = isGM ? data.decks : data.decks.filter(d => d.id === data.activeId);

        const rows = shown.map(d => {
            const name = this._esc(d.name) || this._t('PARLORTAVERN.Lobby.Unnamed');
            const isActive = d.id === data.activeId;
            return `
            <div class="tavern-deck-row${isActive ? ' active' : ''}" data-deck="${d.id}" ${isGM ? 'role="button" tabindex="0"' : ''}>
                <span class="tavern-deck-dot" aria-hidden="true"></span>
                <span class="tavern-deck-name">${name}</span>
                ${isActive ? `<span class="tavern-deck-tag">${this._t('PARLORTAVERN.Lobby.Active')}</span>` : ''}
                ${isGM ? `
                <span class="tavern-deck-actions">
                    <button type="button" data-look="${d.id}" title="${this._t('PARLORTAVERN.Lobby.EditLook')}"><i class="fas fa-palette"></i></button>
                    <button type="button" data-rename="${d.id}" title="${this._t('PARLORTAVERN.Lobby.Rename')}"><i class="fas fa-pen"></i></button>
                    <button type="button" data-remove="${d.id}" title="${this._t('PARLORTAVERN.Lobby.Delete')}"><i class="fas fa-times"></i></button>
                </span>` : ''}
            </div>`;
        }).join('');

        return `
            <div class="tavern-decks-head">
                <i class="fas fa-chess-board" aria-hidden="true"></i>
                <span>${this._t('PARLORTAVERN.Lobby.TonightDecks')}</span>
            </div>
            ${rows || `<div class="tavern-deck-empty">${this._t('PARLORTAVERN.Lobby.NoDecks')}</div>`}
            ${isGM ? `
            <button type="button" class="tavern-deck-new" data-new-deck>
                <i class="fas fa-plus"></i><span>${this._t('PARLORTAVERN.Lobby.NewDeck')}</span>
            </button>
            <div class="tavern-deck-hint">${this._t('PARLORTAVERN.Lobby.EditHint')}</div>` : ''}
        `;
    }

    // 委托挂在 panel 上:refreshPanel 只换 innerHTML,监听不用重挂
    static _bind(panel) {
        panel.addEventListener('click', async (ev) => {
            if (!game.user?.isGM || !this.decks) return;
            const look = ev.target.closest('[data-look]');
            if (look) { ev.stopPropagation(); DeckStudio.open(look.dataset.look); return; }
            const rename = ev.target.closest('[data-rename]');
            if (rename) { ev.stopPropagation(); await this._renameDeck(rename.dataset.rename); return; }
            const remove = ev.target.closest('[data-remove]');
            if (remove) { ev.stopPropagation(); await this._removeDeck(remove.dataset.remove); return; }
            if (ev.target.closest('[data-new-deck]')) { await this._createDeck(); return; }
            const row = ev.target.closest('[data-deck]');
            if (row) await this.decks.setActive(row.dataset.deck);
        });
    }

    // 新建:命名 → 落盘 → 直接进工坊摆桌(改外观的入口就在手边,不用再找)
    static async _createDeck() {
        const name = await this._promptName('');
        if (name === null) return;
        const saved = await this.decks.save({ name });
        if (saved) DeckStudio.open(saved.id);
    }

    static async _renameDeck(id) {
        const deck = this.decks.get(id);
        if (!deck) return;
        const name = await this._promptName(deck.name || '');
        if (name === null) return;
        await this.decks.save({ ...deck, name });
    }

    static async _removeDeck(id) {
        const deck = this.decks.get(id);
        if (!deck) return;
        const name = deck.name || this._t('PARLORTAVERN.Lobby.Unnamed');
        let ok = false;
        try {
            ok = await foundry.applications.api.DialogV2.confirm({
                window: { title: this._t('PARLORTAVERN.Lobby.Delete') },
                content: `<p>${this._t('PARLORTAVERN.Lobby.DeleteConfirm', { name: this._esc(name) })}</p>`
            });
        } catch { ok = false; }
        if (ok) await this.decks.remove(id);
    }

    static async _promptName(initial) {
        try {
            const result = await foundry.applications.api.DialogV2.prompt({
                window: { title: this._t('PARLORTAVERN.Lobby.NamePrompt') },
                content: `<input type="text" name="deckName" value="${this._esc(initial)}" autofocus style="width:100%">`,
                ok: {
                    label: this._t('PARLORTAVERN.Lobby.NameOk'),
                    callback: (_ev, button) => button.form.elements.deckName.value.trim()
                }
            });
            return typeof result === 'string' ? result : null;
        } catch {
            return null; // 取消/ESC
        }
    }
}
