/**
 * WoodPresets — 桌面画风与旧木纹兼容
 *
 * Parlor 核心目前只保存 deck.surface.wood，所以主题把画风与 B 版木材压在一个短 id 里。
 * 旧桌留下的六种木纹仍按 B 半写实读取；上一版写入的 semi-real / handdraw 也继续兼容。
 */

const ASSET = 'modules/parlor/assets/tavern';

export const WOOD_MATERIAL_PRESETS = Object.freeze([
    { id: 'tavern',   nameKey: 'PARLORTAVERN.Workshop.MaterialTavern',   img: 'wood.jpg',         tile: 420, filter: '' },
    { id: 'walnut',   nameKey: 'PARLORTAVERN.Workshop.MaterialWalnut',   img: 'wood-walnut.jpg',  tile: 640, filter: '' },
    { id: 'butcher',  nameKey: 'PARLORTAVERN.Workshop.MaterialButcher',  img: 'wood-butcher.jpg', tile: 540, filter: '' },
    { id: 'mahogany', nameKey: 'PARLORTAVERN.Workshop.MaterialMahogany', img: 'wood.jpg', tile: 420, filter: 'hue-rotate(-14deg) saturate(1.4) brightness(.78)' },
    { id: 'ebony',    nameKey: 'PARLORTAVERN.Workshop.MaterialEbony',    img: 'wood.jpg', tile: 420, filter: 'saturate(.4) brightness(.5) contrast(1.12)' },
    { id: 'drift',    nameKey: 'PARLORTAVERN.Workshop.MaterialDrift',    img: 'wood.jpg', tile: 420, filter: 'saturate(.32) brightness(1.04)' }
]);

export const TABLE_STYLE_PRESETS = Object.freeze([
    {
        id: 'semi-real',
        code: 'B',
        nameKey: 'PARLORTAVERN.Workshop.StyleSemiReal',
        hintKey: 'PARLORTAVERN.Workshop.StyleSemiRealHint'
    },
    {
        id: 'handdraw',
        code: 'C',
        nameKey: 'PARLORTAVERN.Workshop.StyleHanddraw',
        hintKey: 'PARLORTAVERN.Workshop.StyleHanddrawHint'
    }
]);

export function resolveTableSurface(id) {
    const raw = String(id || '').trim();
    const separator = raw.indexOf(':');
    const storedStyle = separator >= 0 ? raw.slice(0, separator) : raw;
    const storedMaterial = separator >= 0 ? raw.slice(separator + 1) : raw;
    const style = storedStyle === 'handdraw' ? TABLE_STYLE_PRESETS[1] : TABLE_STYLE_PRESETS[0];
    const material = WOOD_MATERIAL_PRESETS.find(item => item.id === storedMaterial)
        || WOOD_MATERIAL_PRESETS[0];
    return { style, material };
}

export function tableSurfaceId(styleId, materialId) {
    const style = styleId === 'handdraw' ? 'handdraw' : 'semi-real';
    const material = WOOD_MATERIAL_PRESETS.some(item => item.id === materialId)
        ? materialId
        : WOOD_MATERIAL_PRESETS[0].id;
    return `${style}:${material}`;
}

export function getTableStylePreset(id) {
    return resolveTableSurface(id).style;
}

export function getWoodPreset(id) {
    return resolveTableSurface(id).material;
}

export function woodAssetPath(preset) {
    return `${ASSET}/${preset.img}`;
}
