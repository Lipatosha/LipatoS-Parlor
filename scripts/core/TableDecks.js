/**
 * TableDecks — 赌桌预设(桌台工坊 W2)
 *
 * DM 在酒馆大厅/编辑模式里创建的"赌桌":桌名 + 桌角样式与颜色 + 毛毡显隐/颜色 + 桌面木纹 + 摆件列表。
 * 存 world setting(所有客户端自动同步),只被主题呈现器消费——classic 原生路径不读,零影响。
 * 摆件坐标一律 0-1 归一化(相对 scene),别存像素。
 */

const MODULE_ID = 'parlor';
const SETTING_KEY = 'tableDecks';

const DEFAULT_DATA = Object.freeze({ decks: [], activeDeckId: '' });

// 单张赌桌的骨架:save 时以此为底规范化,坏字段静默丢弃。
// surface.wood 是主题侧解释的木纹预设 id(空=主题默认);旧版滤镜三参已废,
// merge 用 insertKeys:false,老数据里的 filter* 字段保存时自然被剥掉。
// backdrop 是每桌背景(图/视频路径 + 模糊/亮度/透明),src 空=用全局外观背景兜底。
const DECK_DEFAULTS = Object.freeze({
    id: '',
    name: '',
    corner: { style: 'metal', color: '#a87f22' },
    felt: { color: '#5c1c21', visible: true },
    surface: { wood: '' },
    backdrop: { src: '', blur: 4, bright: 0.5, opacity: 1 },
    props: []
});

function sanitizeProp(raw = {}) {
    if (!raw || typeof raw.type !== 'string' || !raw.type) return null;
    const num = (v, def, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return def;
        return Math.max(min, Math.min(max, n));
    };
    const plain = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    };
    return {
        type: raw.type,
        x: num(raw.x, 0.5, 0, 1),
        y: num(raw.y, 0.5, 0, 1),
        rot: num(raw.rot, 0, -180, 180),
        scale: num(raw.scale, 1, 0.4, 2.5),
        colors: plain(raw.colors),
        styles: plain(raw.styles)
    };
}

export class TableDecks {
    static registerSettings() {
        game.settings.register(MODULE_ID, SETTING_KEY, {
            scope: 'world',
            config: false,
            type: Object,
            default: foundry.utils.deepClone(DEFAULT_DATA),
            // world setting 改动会同步每个客户端;呈现器在 refresh 时比对签名自取,这里只发个通告
            onChange: () => Hooks.callAll('parlorTableDeckChanged')
        });
    }

    static _read() {
        if (!game?.settings?.settings?.has(`${MODULE_ID}.${SETTING_KEY}`)) {
            return foundry.utils.deepClone(DEFAULT_DATA);
        }
        const stored = game.settings.get(MODULE_ID, SETTING_KEY);
        return {
            decks: Array.isArray(stored?.decks) ? stored.decks : [],
            activeDeckId: typeof stored?.activeDeckId === 'string' ? stored.activeDeckId : ''
        };
    }

    static async _write(data) {
        if (!game.user.isGM) {
            ui.notifications?.warn(game.i18n.localize('PARLOR.TableDecks.GMOnly'));
            return false;
        }
        await game.settings.set(MODULE_ID, SETTING_KEY, data);
        return true;
    }

    static sanitizeDeck(raw = {}) {
        const base = foundry.utils.deepClone(DECK_DEFAULTS);
        const deck = foundry.utils.mergeObject(base, raw || {}, { inplace: false, insertKeys: false });
        const num = (v, def, min, max) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
        };
        deck.id = String(raw?.id || deck.id || '');
        deck.name = String(raw?.name || '').slice(0, 60);
        deck.felt.visible = raw?.felt?.visible !== false;
        deck.surface.wood = String(raw?.surface?.wood || '').slice(0, 30);
        deck.backdrop.src = String(raw?.backdrop?.src || '').slice(0, 400);
        deck.backdrop.blur = num(raw?.backdrop?.blur, 4, 0, 40);
        deck.backdrop.bright = num(raw?.backdrop?.bright, 0.5, 0.1, 1);
        deck.backdrop.opacity = num(raw?.backdrop?.opacity, 1, 0.1, 1);
        deck.props = (Array.isArray(raw?.props) ? raw.props : []).map(sanitizeProp).filter(Boolean).slice(0, 40);
        return deck;
    }

    static list() {
        return this._read().decks.map(d => this.sanitizeDeck(d));
    }

    static get(id) {
        const found = this._read().decks.find(d => d?.id === id);
        return found ? this.sanitizeDeck(found) : null;
    }

    static getActive() {
        const data = this._read();
        if (!data.activeDeckId) return null;
        const found = data.decks.find(d => d?.id === data.activeDeckId);
        return found ? this.sanitizeDeck(found) : null;
    }

    static async save(deck) {
        const clean = this.sanitizeDeck(deck);
        if (!clean.id) clean.id = `deck-${foundry.utils.randomID(8)}`;
        if (!clean.name) clean.name = game.i18n.localize('PARLOR.TableDecks.Unnamed');
        const data = this._read();
        const index = data.decks.findIndex(d => d?.id === clean.id);
        if (index >= 0) data.decks[index] = clean;
        else data.decks.push(clean);
        // 第一张桌自动激活,省得存了却看不见效果
        if (!data.activeDeckId) data.activeDeckId = clean.id;
        const ok = await this._write(data);
        return ok ? clean : null;
    }

    static async remove(id) {
        const data = this._read();
        data.decks = data.decks.filter(d => d?.id !== id);
        if (data.activeDeckId === id) data.activeDeckId = '';
        return this._write(data);
    }

    static async setActive(id) {
        const data = this._read();
        if (id && !data.decks.some(d => d?.id === id)) return false;
        data.activeDeckId = id || '';
        return this._write(data);
    }
}
