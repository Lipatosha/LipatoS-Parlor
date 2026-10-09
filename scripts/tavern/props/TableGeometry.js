/**
 * 赌桌几何约定统一放在这里。摆件坐标始终相对完整的 2200×1080 场景，
 * 木框和毛毡只是这套坐标里的两块材质区域，编辑器不能再把毛毡误当成活动边界。
 */

import { getPropType, propBaseWidth } from './PropLibrary.js';

const SCENE_WIDTH = 2200;
const SCENE_HEIGHT = 1080;

export const TABLE_BOUNDS = Object.freeze({
    x0: 114 / SCENE_WIDTH,
    x1: 2086 / SCENE_WIDTH,
    y0: 78 / SCENE_HEIGHT,
    y1: 1002 / SCENE_HEIGHT
});

export const FELT_BOUNDS = Object.freeze({
    x0: 242 / SCENE_WIDTH,
    x1: 1958 / SCENE_WIDTH,
    y0: 172 / SCENE_HEIGHT,
    y1: 908 / SCENE_HEIGHT
});

// 允许摆件边缘稍微探出桌面，中心和大部分本体仍得留在木板上。
const OVERHANG = 0.25;

export function isPropOnFelt(x, y, feltVisible = true) {
    if (!feltVisible) return false;
    const px = Number(x);
    const py = Number(y);
    return Number.isFinite(px) && Number.isFinite(py)
        && px >= FELT_BOUNDS.x0 && px <= FELT_BOUNDS.x1
        && py >= FELT_BOUNDS.y0 && py <= FELT_BOUNDS.y1;
}

export function clampPropToTable(x, y, prop) {
    const type = getPropType(prop?.type);
    let halfWidth = 0;
    let halfHeight = 0;

    if (type) {
        const [, , viewWidth, viewHeight] = type.view.split(' ').map(Number);
        const width = (propBaseWidth(prop.type, prop) / SCENE_WIDTH) * (Number(prop.scale) || 1);
        halfWidth = (width / 2) * (1 - OVERHANG);
        halfHeight = halfWidth * (viewHeight / viewWidth) * (SCENE_WIDTH / SCENE_HEIGHT);
    }

    const usableSpan = (low, high, half) => (high - low <= half * 2)
        ? [(low + high) / 2, (low + high) / 2]
        : [low + half, high - half];
    const [minX, maxX] = usableSpan(TABLE_BOUNDS.x0, TABLE_BOUNDS.x1, halfWidth);
    const [minY, maxY] = usableSpan(TABLE_BOUNDS.y0, TABLE_BOUNDS.y1, halfHeight);
    const px = Number.isFinite(Number(x)) ? Number(x) : 0.5;
    const py = Number.isFinite(Number(y)) ? Number(y) : 0.5;

    return [
        Math.max(minX, Math.min(maxX, px)),
        Math.max(minY, Math.min(maxY, py))
    ];
}
