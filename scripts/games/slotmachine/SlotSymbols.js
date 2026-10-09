/**
 * 老虎机符号 —— 程序化 SVG
 *
 * 原来符号走第三方水果精灵表（Ynumazen 素材包）。那套素材的再分发授权一直悬着，
 * 而 FVTT 是明文分发、素材可被原样提取，索性把符号全改成程序化 SVG，从源头甩掉这层不确定性。
 *
 * 形状按 symbol id 画；主色/高光/描边直接吃 SLOT_SYMBOLS 里各自的 palette（main/accent/ink），
 * 这样改赔付表配色时符号会跟着变，不用两头对。叶、梗这类自然物用固定的绿/棕，不跟着主色乱变。
 */

// 叶梗是自然色，不吃 palette——否则蓝色 wild 长出蓝叶子就怪了
const LEAF = '#6cae52';
const LEAF_DK = '#4d8a39';
const STEM = '#7a5230';

// 每个生成器拿到 {main, accent, ink}，返回一段画在 100×100 视口里的 SVG 内容
const BUILDERS = Object.freeze({
    // 铃铛：福林机的老符号
    bell: (p) => `
        <path d="M50,25 C37,25 31,36 30,50 C29,60 25,67 21,71 L79,71 C75,67 71,60 70,50 C69,36 63,25 50,25 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <rect x="20" y="70" width="60" height="6" rx="3" fill="${p.ink}"/>
        <circle cx="50" cy="20" r="4.4" fill="none" stroke="${p.ink}" stroke-width="2.6"/>
        <circle cx="50" cy="80" r="5" fill="${p.ink}"/>
        <path d="M40,34 Q34,42 34,53" fill="none" stroke="${p.accent}" stroke-width="3.4" stroke-linecap="round"/>`,

    // 西瓜切片：绿皮 + 红瓤 + 籽
    watermelon: (p) => `
        <path d="M18,42 A40,37 0 0 0 82,42 Z" fill="${p.accent}" stroke="${p.ink}" stroke-width="2.4" stroke-linejoin="round"/>
        <path d="M24,44 A34,31 0 0 0 76,44 Z" fill="${p.main}"/>
        <path d="M18,42 H82" stroke="${p.ink}" stroke-width="2.4" stroke-linecap="round"/>
        <g fill="${p.ink}">
            <ellipse cx="40" cy="53" rx="1.7" ry="2.8"/><ellipse cx="55" cy="51" rx="1.7" ry="2.8"/>
            <ellipse cx="48" cy="62" rx="1.7" ry="2.8"/><ellipse cx="62" cy="60" rx="1.7" ry="2.8"/>
            <ellipse cx="34" cy="60" rx="1.7" ry="2.8"/>
        </g>
        <path d="M28,47 A28,24 0 0 0 40,58" fill="none" stroke="${p.accent}" stroke-width="2.6" stroke-linecap="round" opacity=".6"/>`,

    // 幸运七
    seven: (p) => `
        <path d="M31,30 L71,30 L71,39 L52,76 L39,76 L58,39 L31,39 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.8" stroke-linejoin="round"/>
        <path d="M35,34 L64,34" stroke="${p.accent}" stroke-width="3" stroke-linecap="round"/>`,

    // Wild：多切面宝石
    wild: (p) => `
        <path d="M50,22 L76,44 L50,80 L24,44 Z" fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M50,22 L76,44 L50,44 Z" fill="${p.accent}"/>
        <path d="M24,44 L50,44 L50,80 Z" fill="${p.ink}" opacity=".28"/>
        <path d="M24,44 H76 M50,22 V80 M37,33 L44,44 M63,33 L56,44" stroke="${p.ink}" stroke-width="1.8" fill="none" stroke-linejoin="round" opacity=".7"/>
        <path d="M33,40 L44,29" stroke="${p.accent}" stroke-width="2.6" stroke-linecap="round"/>`,

    // 橙子
    orange: (p) => `
        <circle cx="50" cy="55" r="24" fill="${p.main}" stroke="${p.ink}" stroke-width="2.6"/>
        <path d="M50,34 Q60,27 68,31 Q60,37 50,34 Z" fill="${LEAF}" stroke="${LEAF_DK}" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M50,31 L50,36" stroke="${STEM}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M37,45 A18,18 0 0 1 52,39" fill="none" stroke="${p.accent}" stroke-width="4" stroke-linecap="round"/>`,

    // 柠檬
    lemon: (p) => `
        <ellipse cx="50" cy="54" rx="27" ry="19" fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" transform="rotate(-14 50 54)"/>
        <circle cx="24" cy="60" r="3" fill="${p.ink}"/><circle cx="76" cy="48" r="3" fill="${p.ink}"/>
        <path d="M40,45 A20,15 0 0 1 56,41" fill="none" stroke="${p.accent}" stroke-width="3.6" stroke-linecap="round" transform="rotate(-14 50 54)"/>`,

    // 幸运星 / Scatter
    scatter: (p) => `
        <path d="M50,24 L58,44 L79,45 L62,58 L68,79 L50,66 L32,79 L38,58 L21,45 L42,44 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M50,33 L55,45" stroke="${p.accent}" stroke-width="3" stroke-linecap="round"/>
        <circle cx="50" cy="53" r="3.4" fill="${p.accent}"/>`,

    // 香蕉
    banana: (p) => `
        <path d="M25,58 C22,40 38,28 64,27 C57,35 54,47 49,54 C41,62 32,62 25,58 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M64,27 L69,24 M25,58 L23,63" stroke="${p.ink}" stroke-width="3" stroke-linecap="round"/>
        <path d="M32,52 C38,42 48,36 60,32" fill="none" stroke="${p.accent}" stroke-width="2.6" stroke-linecap="round" opacity=".7"/>`,

    // 李子
    plum: (p) => `
        <ellipse cx="50" cy="56" rx="23" ry="25" fill="${p.main}" stroke="${p.ink}" stroke-width="2.6"/>
        <path d="M50,33 Q43,56 50,80" fill="none" stroke="${p.ink}" stroke-width="1.8" opacity=".5"/>
        <path d="M52,33 L57,25" stroke="${STEM}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M56,27 Q65,22 70,27 Q63,32 56,27 Z" fill="${LEAF}" stroke="${LEAF_DK}" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M38,46 A18,20 0 0 1 44,38" fill="none" stroke="${p.accent}" stroke-width="3.4" stroke-linecap="round"/>`,

    // 苹果
    apple: (p) => `
        <path d="M50,38 C43,31 30,32 28,47 C26,60 35,74 50,77 C65,74 74,60 72,47 C70,32 57,31 50,38 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M50,36 L52,26" stroke="${STEM}" stroke-width="3" stroke-linecap="round"/>
        <path d="M52,30 Q63,23 68,30 Q60,35 52,30 Z" fill="${LEAF}" stroke="${LEAF_DK}" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M37,48 A16,18 0 0 1 44,40" fill="none" stroke="${p.accent}" stroke-width="4" stroke-linecap="round"/>`,

    // 梨
    pear: (p) => `
        <path d="M50,30 C45,30 43,39 45,47 C38,53 33,64 41,72 C49,80 57,77 60,69 C64,60 58,52 55,47 C57,39 55,30 50,30 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M50,30 L52,23" stroke="${STEM}" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M52,26 Q61,21 66,26 Q59,31 52,26 Z" fill="${LEAF}" stroke="${LEAF_DK}" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M42,60 A13,14 0 0 1 47,50" fill="none" stroke="${p.accent}" stroke-width="3.4" stroke-linecap="round"/>`,

    // 草莓
    strawberry: (p) => `
        <path d="M28,49 C28,41 40,39 50,43 C60,39 72,41 72,49 C72,63 58,77 50,81 C42,77 28,63 28,49 Z"
            fill="${p.main}" stroke="${p.ink}" stroke-width="2.6" stroke-linejoin="round"/>
        <path d="M50,43 L50,30 M50,40 L40,32 M50,40 L60,32 M50,42 L34,40 M50,42 L66,40"
            stroke="${LEAF_DK}" stroke-width="2" stroke-linecap="round" fill="none"/>
        <path d="M50,42 C44,34 36,35 34,40 C40,40 46,42 50,46 C54,42 60,40 66,40 C64,35 56,34 50,42 Z" fill="${LEAF}"/>
        <g fill="${p.accent}">
            <circle cx="42" cy="54" r="1.5"/><circle cx="54" cy="52" r="1.5"/><circle cx="48" cy="62" r="1.5"/>
            <circle cx="60" cy="60" r="1.5"/><circle cx="38" cy="63" r="1.5"/><circle cx="52" cy="70" r="1.5"/>
        </g>`
});

const FALLBACK_PALETTE = Object.freeze({ main: '#f4b44a', accent: '#fff2b8', ink: '#3a2408' });

/**
 * 生成某个符号的内联 SVG。palette 缺项时兜底，缺形状时返回空串（调用方会退化成空格子）。
 */
export function renderSlotSymbolSvg(symbolId, palette = null) {
    const build = BUILDERS[symbolId];
    if (!build) return '';
    const p = {
        main: palette?.main || FALLBACK_PALETTE.main,
        accent: palette?.accent || FALLBACK_PALETTE.accent,
        ink: palette?.ink || FALLBACK_PALETTE.ink
    };
    return `<svg class="parlor-slot-symbol-glyph" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${build(p)}</svg>`;
}

export function hasSlotSymbolSvg(symbolId) {
    return Boolean(BUILDERS[symbolId]);
}
