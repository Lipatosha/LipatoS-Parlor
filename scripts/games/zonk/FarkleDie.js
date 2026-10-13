import { normalizeD6 } from '../../core/DiceFaces.js';

/**
 * Farkle has its OWN dice markup. Do not add .parlor-d6-face or .parlor-ld-die
 * here: those classes receive a conflicting background-image and legacy dice
 * skin from two other Parlor CSS modules. That was the real cause of the
 * invisible white faces while button outlines stayed visible.
 *
 * Every face is basic HTML spans and CSS circles, with inline paint fallback.
 * No SVG, image decoding, externally loaded sprites, or shared dice skins.
 */
const FARKLE_PIPS = Object.freeze({
    1: [[50, 50]],
    2: [[24, 24], [76, 76]],
    3: [[24, 24], [50, 50], [76, 76]],
    4: [[24, 24], [76, 24], [24, 76], [76, 76]],
    5: [[24, 24], [76, 24], [50, 50], [24, 76], [76, 76]],
    6: [[24, 22], [76, 22], [24, 50], [76, 50], [24, 78], [76, 78]]
});

export const renderFarkleDie = (value, small = false) => {
    const face = normalizeD6(value);
    const dots = FARKLE_PIPS[face].map(([x, y]) =>
        `<span class="parlor-farkle-pip" aria-hidden="true" style="position:absolute;z-index:2;left:${x}%;top:${y}%;width:22%;height:22%;transform:translate(-50%,-50%);border-radius:50%;background:#2b2b2b"></span>`
    ).join('');
    return `<span class="parlor-farkle-face${small ? ' is-small' : ''}" role="img"
        data-face="${face}" aria-label="Кость: ${face}"
        style="position:relative;display:inline-block;overflow:hidden;box-sizing:border-box;isolation:isolate;background:#d2d2d2;border-radius:9%;opacity:1;visibility:visible">
        <span class="parlor-farkle-face-white" aria-hidden="true"
            style="position:absolute;z-index:1;inset:0;background:#ffffff;border-radius:28%;"></span>
        ${dots}
    </span>`;
};
