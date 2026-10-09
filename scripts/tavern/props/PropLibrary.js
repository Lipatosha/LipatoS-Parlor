/**
 * PropLibrary — 酒馆摆件库(物件画法全量升级,Reslin 2026-07-17 过审)
 *
 * 每件 = { id, nameKey, view, size, spin, parts(换色部件), styles(结构变体), variants(预设), svg(colors, styles) }。
 * 纯函数库:呈现器上桌渲染 / 编辑器面板 / 大厅缩略图三处共用,不进 DOM 逻辑。
 *
 * ⚠ 真源就是本文件。改摆件直接改这里,然后跑 `node tools/build-props-demo.mjs`
 *   生成审阅 demo(parlor/docs/skin-demos/prop-upgrade-demo.html)交 Reslin 过目——
 *   demo 是库原文内嵌生成的,别再手抄两份(旧流程"先改 demo 再搬库"已废)。
 *
 * ── size:实际尺寸,别跟 view 混 ──────────────────────────────
 * view 是画布,size 是这件东西在桌面坐标系(scene 宽 2200 / 绒垫宽 1716 ≈ 213cm,
 * 即 1cm ≈ 8.06 单位)里真实占多宽。以前没这个字段,直接拿 viewBox 宽当尺寸用,
 * 结果一桶酒和一只杯子一样大、一颗骰子和一枚金币一样大。加尺寸就照着实物量,
 * 别照着"画面上好不好看"定——好不好看是 scale 的事,DM 自己滚轮调。
 *
 * ── spin:能不能转 ────────────────────────────────────────
 * 光影是烤死在路径里的(统一顶光 = 上方偏左),元素一转,高光和背光跟着转,
 * 这件就变成"从右下打光"。所以圆对称、转了也看不出朝向的件一律 spin:false,
 * 编辑器不给旋转控件,顶光永远成立。只有朝向有意义的件(匕首/烟斗/牌堆/钥匙串
 * 这些长条和带把手的)才 spin:true——它们转的时候高光跟着转是这套画法的既定代价。
 *
 * ── 画法约束(别破)──────────────────────────────────────
 * 光影一律黑白半透明层叠在部件色上;统一顶光=上方偏左。
 * **落桌投影不要画进 svg**——接触阴影由呈现层的独立图层出(不跟着 --rot 转,
 * 而且会按摆件在桌上的位置朝桌心反方向偏,对上桌台那盏顶灯)。svg 里只留
 * 物件内部的自遮挡(叠在一起的币、牌、骰子之间那种),别再补整体落地影。
 *
 * defs/id 原则上仍然不用(多实例同页 id 会互相打架),唯一例外是每次渲染
 * 自带唯一序号的颗粒滤镜,见 grainFilter()。
 */

export const PROP_PALETTES = {
    metal:  ['#c9d3dd', '#8d959f', '#e8c96a', '#a87f22', '#7a5a3a', '#3a3f46', '#b3763a', '#4a5a6a'],
    wood:   ['#8a5c30', '#5c3a16', '#3c2410', '#6b4a22', '#9a6b3a', '#2e1a08', '#7a3a1e', '#4a2c14'],
    cloth:  ['#8f3b26', '#5c1c21', '#1c4a30', '#2c3a5c', '#6b4a17', '#3a2c4a', '#7a5217', '#42221a'],
    paper:  ['#f0e3bd', '#d9c793', '#c2ae7c', '#e8d5a8', '#b89a6a', '#f4ead0', '#cbb083', '#a8905e'],
    liquid: ['#c9812a', '#8f2b1e', '#6b1a3a', '#3a6b4a', '#b3541e', '#7a5c1a', '#4a2c6b', '#2a4a6b'],
    flame:  ['#f09a5e', '#e8a83c', '#c9812a', '#e86a3c', '#f0c05e', '#d9542a', '#f0e08a', '#b34714'],
    bone:   ['#f7efd8', '#e8d5b0', '#d9cba4', '#c9b890', '#f0e8d0', '#b8a880', '#e0d0a8', '#a89870'],
    ink:    ['#3c2a14', '#5c4526', '#2a1a0a', '#4a3a2a', '#6b2418', '#1a2a3a', '#3a1a2a', '#2c3624'],
    glass:  ['#2c3624', '#7a4a1a', '#1a2a3a', '#3a1a2a', '#2a4a3a', '#4a2c14', '#26343e', '#413022']
  };

// 锤打纹发生器:一圈错位亮暗点对,锡器/铜器的手工感(酒盏、烛台托盘共用)
function hammer(cx, cy, r, n, seed) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + seed;
    const wob = 1 + 0.14 * Math.sin(i * 2.7 + seed * 5);
    const x = cx + Math.cos(a) * r * wob, y = cy + Math.sin(a) * r * wob;
    out += `<circle cx="${(x - .7).toFixed(1)}" cy="${(y - .7).toFixed(1)}" r="2.1" fill="rgba(255,255,255,.11)"/>`
         + `<circle cx="${(x + .7).toFixed(1)}" cy="${(y + .7).toFixed(1)}" r="2.1" fill="rgba(0,0,0,.13)"/>`;
  }
  return out;
}

// 摆件颗粒:桌面是照片木纹+绒布噪点,摆件是纯平色矢量,两者细节密度差一个数量级,
// 干净的那个就显得像贴上去的。这层把颗粒补回来，再统一补一圈左上受光和右下收暗。
//
// 两个关键别改:
// 1. color-interpolation-filters="sRGB"——默认的 linearRGB 会把暗色底的三个通道
//    抬同样多,红的就变灰了(桌台绒垫踩过这个坑)。
// 2. 颗粒压在 .43–.57 之间再走 overlay。overlay 在暗底上等价于 2×底色×颗粒,
//    三通道同倍缩放 = 只动明度不动色相。范围放宽就开始洗色。
//
// id 必须每次渲染唯一:同一页会同时出现十几个摆件(桌上 + 编辑器抽屉 + 大厅缩略图),
// 固定 id 会互相抢引用。
let grainSeq = 0;
function grainFilter(id) {
  // 滤镜区留 12% 边:默认区正好等于 bbox,描边会被切掉一圈(蜡烛那几圈光晕首当其冲)
  return `<defs><filter id="${id}" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">`
       + `<feTurbulence type="fractalNoise" baseFrequency=".4" numOctaves="2" seed="7" result="n"/>`
       + `<feColorMatrix type="saturate" values="0" in="n" result="g"/>`
       + `<feComponentTransfer in="g" result="grain">`
       + `<feFuncR type="linear" slope=".12" intercept=".44"/>`
       + `<feFuncG type="linear" slope=".12" intercept=".44"/>`
       + `<feFuncB type="linear" slope=".12" intercept=".44"/>`
       + `<feFuncA type="table" tableValues="1 1"/>`
       + `</feComponentTransfer>`
       + `<feBlend in="SourceGraphic" in2="grain" mode="overlay" result="b"/>`
       + `<feComposite in="b" in2="SourceAlpha" operator="in" result="textured"/>`
       + `<feOffset in="SourceAlpha" dx=".8" dy="1" result="alphaDown"/>`
       + `<feComposite in="SourceAlpha" in2="alphaDown" operator="out" result="lightEdge"/>`
       + `<feFlood flood-color="#fff1cf" flood-opacity=".16" result="lightTone"/>`
       + `<feComposite in="lightTone" in2="lightEdge" operator="in" result="rimLight"/>`
       + `<feOffset in="SourceAlpha" dx="-.8" dy="-1" result="alphaUp"/>`
       + `<feComposite in="SourceAlpha" in2="alphaUp" operator="out" result="shadeEdge"/>`
       + `<feFlood flood-color="#160a03" flood-opacity=".25" result="shadeTone"/>`
       + `<feComposite in="shadeTone" in2="shadeEdge" operator="in" result="rimShade"/>`
       + `<feBlend in="textured" in2="rimShade" mode="multiply" result="shaded"/>`
       + `<feBlend in="shaded" in2="rimLight" mode="screen" result="lit"/>`
       + `<feComposite in="lit" in2="SourceAlpha" operator="in"/>`
       + `</filter></defs>`;
}

// 桌面坐标系里 1 厘米有多少单位(scene 宽 2200,绒垫 1716 单位 ≈ 213cm)。
// 定 size 的时候拿实物尺寸乘它,别拍脑袋。
export const UNITS_PER_CM = 8.06;

// 摆件尺寸制式版本。存档里没这个标记的摆件 = 老数据,继续按 viewBox 宽当尺寸渲染,
// 一个像素都不动;新摆件才吃 size。标记塞在 styles 里是因为本体 sanitizeProp
// 白名单只放行 type/x/y/rot/scale/colors/styles,别的字段存不住(parlor/scripts/core/TableDecks.js)。
export const PROP_SIZE_KEY = '__sz';
export const PROP_SIZE_VERSION = 'v2';

export function isRealScale(prop) {
    return prop?.styles?.[PROP_SIZE_KEY] === PROP_SIZE_VERSION;
}

// 摆件在桌面坐标系里占多宽(未乘 scale)。老存档走 viewBox,新摆件走 size。
export function propBaseWidth(typeId, prop) {
    const type = getPropType(typeId);
    if (!type) return 120;
    return isRealScale(prop) ? type.size : Number(type.view.split(' ')[2]);
}

// 单瓶保留完整玻璃层次；双瓶在首屏更小，quiet 分支只留瓶肩、细颈和封口三层。
// 整体接触影仍由呈现层统一处理，这里只保留玻璃自身的折光。
function standingBottle({ cx, cy, r, glass, liquid, cork, seal, label, wax = false, quiet = false }) {
    if (quiet) {
        const neck = r * .22;
        const top = r * .12;
        return `
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="${glass}" fill-opacity=".88"
                  stroke="${liquid}" stroke-opacity=".28" stroke-width="2"/>
          <path d="M${cx - r * .72} ${cy - r * .38} A${r * .88} ${r * .88} 0 0 1 ${cx - r * .12} ${cy - r * .9}"
                fill="none" stroke="rgba(255,255,255,.24)" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="${cx}" cy="${cy}" r="${neck}" fill="none" stroke="rgba(225,235,230,.24)" stroke-width="1.2"/>
          <circle cx="${cx}" cy="${cy}" r="${top}" fill="${wax ? seal : cork}" stroke="rgba(0,0,0,.34)" stroke-width="1"/>`;
    }
    const shoulder = r * .7;
    const neck = r * .42;
    const top = r * .24;
    return `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${glass}"/>
      <circle cx="${cx}" cy="${cy}" r="${r - 4}" fill="${liquid}" opacity=".72"/>
      <path d="M${cx - r * .82} ${cy - r * .36} A${r} ${r} 0 0 1 ${cx - r * .12} ${cy - r * .95}"
            fill="none" stroke="rgba(255,255,255,.42)" stroke-width="${r * .13}" stroke-linecap="round"/>
      <path d="M${cx + r * .78} ${cy + r * .28} A${r} ${r} 0 0 1 ${cx + r * .2} ${cy + r * .92}"
            fill="none" stroke="rgba(0,0,0,.23)" stroke-width="${r * .14}" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${shoulder}" fill="${glass}" opacity=".86"/>
      <circle cx="${cx}" cy="${cy}" r="${shoulder}" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="${r * .57}" fill="none" stroke="${label}" stroke-width="${r * .1}" opacity=".82"/>
      <circle cx="${cx}" cy="${cy}" r="${neck}" fill="${glass}"/>
      <circle cx="${cx}" cy="${cy}" r="${neck}" fill="rgba(0,0,0,.25)"/>
      <path d="M${cx - neck * .7} ${cy - neck * .38} A${neck} ${neck} 0 0 1 ${cx - neck * .08} ${cy - neck * .93}"
            fill="none" stroke="rgba(255,255,255,.34)" stroke-width="${Math.max(2, r * .07)}" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="${neck}" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1.5"/>
      ${wax ? `<circle cx="${cx}" cy="${cy}" r="${top}" fill="${seal}"/>
        <path d="M${cx + top * .45} ${cy + top * .65} q${top * .4} ${top * .55} ${top * .1} ${top * .9} q${-top * .35} ${top * .15} ${-top * .5} ${-top * .45} Z" fill="${seal}"/>
        <path d="M${cx - top * .68} ${cy - top * .35} A${top} ${top} 0 0 1 ${cx - top * .08} ${cy - top * .92}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="${top}" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.4"/>` : `
        <circle cx="${cx}" cy="${cy}" r="${top}" fill="${cork}"/>
        <path d="M${cx - top * .6} ${cy + top * .15} l${top * .7} ${-top * .38} M${cx - top * .08} ${cy - top * .62} l${top * .24} ${top * .65}" stroke="rgba(0,0,0,.3)" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M${cx - top * .68} ${cy - top * .35} A${top} ${top} 0 0 1 ${cx - top * .08} ${cy - top * .92}" fill="none" stroke="rgba(255,255,255,.33)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="${top}" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="1.4"/>`}`;
}

const PROP_DEFINITIONS = [

    /* ═══ 酒馆核心摆件(全部严格俯视)═══ */
    {
      id: 'bottle-top', view: '0 0 112 112', size: 93, spin: false,
      parts: [
        { key: 'glass', def: '#2c3624', pal: 'glass' },
        { key: 'liquid', def: '#6b1a3a', pal: 'liquid' },
        { key: 'cork', def: '#8a5c30', pal: 'wood' },
        { key: 'seal', def: '#8f2b1e', pal: 'liquid' },
        { key: 'label', def: '#d9c793', pal: 'paper' }
      ],
      styles: [
        { key: 'girth', options: [{ id: 'std' }, { id: 'stout' }] },
        { key: 'top', options: [{ id: 'cork' }, { id: 'wax' }] }
      ],
      variants: [
        { p: { glass: '#2c3624', liquid: '#6b1a3a', cork: '#8a5c30', seal: '#8f2b1e', label: '#d9c793' }, s: { girth: 'std', top: 'wax' } },
        { p: { glass: '#7a4a1a', liquid: '#c9812a', cork: '#5c3a16', seal: '#6b2418', label: '#f0e3bd' }, s: { girth: 'std', top: 'cork' } },
        { p: { glass: '#26343e', liquid: '#2a4a6b', cork: '#6b4a22', seal: '#6b1a3a', label: '#c2ae7c' }, s: { girth: 'stout', top: 'wax' } }
      ],
      // 保留旧 id 和真实尺寸；这是直立瓶的严格俯视，旋转不会改变视觉方向。
      svg: (c, s) => standingBottle({
          cx: 56,
          cy: 56,
          r: s.girth === 'stout' ? 47 : 42,
          glass: c.glass,
          liquid: c.liquid,
          cork: c.cork,
          seal: c.seal,
          label: c.label,
          wax: s.top === 'wax',
          quiet: true
      }) + `
        <path d="M64 62 Q77 66 89 75" fill="none" stroke="rgba(35,20,8,.62)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M90 73 L108 77 L105 93 L87 87 Z" fill="rgba(0,0,0,.24)" transform="translate(1 1.5)"/>
        <path d="M89 71 L107 75 L104 91 L86 85 Z" fill="${c.label}"/>
        <path d="M89 71 L107 75 L104 91 L86 85 Z" fill="none" stroke="rgba(45,28,12,.48)" stroke-width="1.3"/>
        <circle cx="91.5" cy="75.5" r="1.8" fill="none" stroke="rgba(45,28,12,.55)" stroke-width="1.1"/>
        <path d="M92 80 L102 82 M91 83 L99 85" stroke="rgba(60,42,20,.42)" stroke-width="1.1" stroke-linecap="round"/>`
    },
    {
      id: 'bottle-pair', view: '0 0 190 126', size: 240, spin: true,
      parts: [
        { key: 'glassA', def: '#2c3624', pal: 'glass' },
        { key: 'glassB', def: '#7a4a1a', pal: 'glass' },
        { key: 'liquidA', def: '#6b1a3a', pal: 'liquid' },
        { key: 'liquidB', def: '#c9812a', pal: 'liquid' },
        { key: 'cork', def: '#8a5c30', pal: 'wood' },
        { key: 'seal', def: '#8f2b1e', pal: 'liquid' },
        { key: 'tray', def: '#6b4a22', pal: 'wood' },
        { key: 'trim', def: '#a87f22', pal: 'metal' }
      ],
      styles: [
        { key: 'tray', options: [{ id: 'wood' }, { id: 'brass' }] },
        { key: 'tops', options: [{ id: 'mixed' }, { id: 'wax' }, { id: 'cork' }] }
      ],
      variants: [
        { p: { glassA: '#26342a', glassB: '#49331f', liquidA: '#6b1a3a', liquidB: '#c9812a', cork: '#8a5c30', seal: '#8f2b1e', tray: '#6b4a22', trim: '#7a5a3a' }, s: { tray: 'wood', tops: 'mixed' } },
        { p: { glassA: '#182630', glassB: '#321b29', liquidA: '#8f2b1e', liquidB: '#6b1a3a', cork: '#6b4a22', seal: '#6b1a3a', tray: '#4a2c14', trim: '#e8c96a' }, s: { tray: 'brass', tops: 'wax' } },
        { p: { glassA: '#382a20', glassB: '#1d2b32', liquidA: '#b3541e', liquidB: '#2a4a6b', cork: '#5c3a16', seal: '#42221a', tray: '#8a5c30', trim: '#3a3f46' }, s: { tray: 'wood', tops: 'cork' } }
      ],
      svg: (c, s) => {
        const waxA = s.tops !== 'cork';
        const waxB = s.tops === 'wax';
        return `
          <ellipse cx="95" cy="63" rx="89" ry="55" fill="${c.tray}"/>
          <path d="M12 58 A85 50 0 0 1 178 54" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="6" stroke-linecap="round"/>
          <path d="M13 72 A84 49 0 0 0 177 76" fill="none" stroke="rgba(0,0,0,.20)" stroke-width="7" stroke-linecap="round"/>
          <ellipse cx="95" cy="63" rx="89" ry="55" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2"/>
          <ellipse cx="95" cy="63" rx="79" ry="46" fill="none" stroke="${c.trim}" stroke-width="${s.tray === 'brass' ? 3.4 : 1.8}" opacity="${s.tray === 'brass' ? .82 : .48}"/>
          <path d="M25 48 Q73 35 165 48 M20 68 Q91 56 172 68 M32 87 Q95 99 158 87"
                fill="none" stroke="rgba(0,0,0,.13)" stroke-width="1.5"/>
          <path d="M31 45 Q75 34 121 40 M31 72 Q82 63 151 72" fill="none" stroke="rgba(255,225,175,.08)" stroke-width="1.2"/>
          ${s.tray === 'brass' ? `<g fill="${c.trim}" opacity=".7">
            <circle cx="20" cy="63" r="2.1"/><circle cx="170" cy="63" r="2.1"/><circle cx="95" cy="17" r="2.1"/><circle cx="95" cy="109" r="2.1"/>
          </g>` : ''}
          <ellipse cx="69" cy="54" rx="34" ry="33" fill="rgba(10,5,2,.24)"/>
          <ellipse cx="129" cy="81" rx="30" ry="29" fill="rgba(10,5,2,.22)"/>
          ${standingBottle({ cx: 66, cy: 50, r: 32, glass: c.glassA, liquid: c.liquidA, cork: c.cork, seal: c.seal, wax: waxA, quiet: true })}
          ${standingBottle({ cx: 126, cy: 77, r: 28, glass: c.glassB, liquid: c.liquidB, cork: c.cork, seal: c.seal, wax: waxB, quiet: true })}`;
      }
    },
    {
      id: 'wine-cup', view: '0 0 108 108', size: 92, spin: false,
      parts: [
        { key: 'glass', def: '#aab4be', pal: 'glass' },
        { key: 'wine', def: '#6b1a3a', pal: 'liquid' },
        { key: 'rim', def: '#c9d3dd', pal: 'metal' }
      ],
      styles: [
        { key: 'fill', options: [{ id: 'full' }, { id: 'half' }, { id: 'empty' }] },
        { key: 'shape', options: [{ id: 'wine' }, { id: 'goblet' }] }
      ],
      variants: [
        { p: { glass: '#aab4be', wine: '#6b1a3a', rim: '#d7e1e8' }, s: { fill: 'full', shape: 'wine' } },
        { p: { glass: '#8d959f', wine: '#c9812a', rim: '#c9d3dd' }, s: { fill: 'half', shape: 'goblet' } },
        { p: { glass: '#6a7482', wine: '#8f2b1e', rim: '#e8e2d0' }, s: { fill: 'empty', shape: 'wine' } }
      ],
      svg: (c, s) => {
        const bowl = s.shape === 'goblet' ? 43 : 40;
        const liquid = s.fill === 'full'
          ? `<path d="M29 47 A30 29 0 1 0 82 41 Q75 56 58 64 Q40 69 29 47 Z" fill="${c.wine}" opacity=".88"/>
             <path d="M36 43 Q48 32 64 34 Q72 35 77 40 Q62 39 50 47 Q41 53 34 57" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="3" stroke-linecap="round"/>`
          : s.fill === 'half'
            ? `<path d="M34 59 A27 24 0 0 0 82 48 Q77 66 62 72 Q45 76 34 59 Z" fill="${c.wine}" opacity=".84"/>
               <path d="M42 58 Q54 51 72 51" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="2.5" stroke-linecap="round"/>`
            : `<path d="M36 67 Q53 73 72 65" fill="none" stroke="${c.wine}" stroke-width="1.5" opacity=".42" stroke-linecap="round"/>`;
        return `
        <circle cx="54" cy="54" r="${bowl}" fill="rgba(220,235,240,.07)"/>
        <circle cx="54" cy="54" r="${bowl}" fill="none" stroke="${c.rim}" stroke-width="1.8" opacity=".62"/>
        <circle cx="54" cy="54" r="${bowl - 4}" fill="none" stroke="${c.glass}" stroke-width="1" opacity=".36"/>
        ${liquid}
        <path d="M25 43 A35 35 0 0 1 45 22" fill="none" stroke="rgba(255,255,255,.68)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M50 19 A35 35 0 0 1 61 20" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M83 63 A34 34 0 0 1 69 82" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2.2" stroke-linecap="round"/>`;
      }
    },
    {
      id: 'bread-basket', view: '0 0 154 112', size: 258, spin: true,
      parts: [
        { key: 'weave', def: '#8a5c30', pal: 'wood' },
        { key: 'bread', def: '#b3763a', pal: 'wood' },
        { key: 'liner', def: '#8f3b26', pal: 'cloth' }
      ],
      styles: [
        { key: 'bread', options: [{ id: 'rolls' }, { id: 'loaf' }] },
        { key: 'liner', options: [{ id: 'cloth' }, { id: 'bare' }] }
      ],
      variants: [
        { p: { weave: '#8a5c30', bread: '#b3763a', liner: '#8f3b26' }, s: { bread: 'rolls', liner: 'cloth' } },
        { p: { weave: '#5c3a16', bread: '#7a3a1e', liner: '#42221a' }, s: { bread: 'loaf', liner: 'bare' } },
        { p: { weave: '#9a6b3a', bread: '#c9812a', liner: '#1c4a30' }, s: { bread: 'rolls', liner: 'cloth' } }
      ],
      svg: (c, s) => `
        <ellipse cx="77" cy="56" rx="69" ry="47" fill="${c.weave}"/>
        <path d="M12 51 A69 47 0 0 1 142 51 L134 51 A61 39 0 0 0 20 51 Z" fill="rgba(255,255,255,.14)"/>
        <path d="M13 64 A68 46 0 0 0 141 64 L133 64 A60 38 0 0 1 21 64 Z" fill="rgba(0,0,0,.20)"/>
        <g fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2">
          <ellipse cx="77" cy="56" rx="61" ry="39"/><ellipse cx="77" cy="56" rx="55" ry="34"/>
          <path d="M21 41 Q77 63 133 41 M18 56 Q77 78 136 56 M23 72 Q77 91 131 72"/>
        </g>
        <g fill="none" stroke="rgba(255,230,185,.13)" stroke-width="1.4">
          <path d="M25 36 Q77 56 129 36 M20 51 Q77 72 134 51 M26 68 Q77 85 128 68"/>
        </g>
        ${s.liner === 'cloth' ? `<path d="M27 39 Q43 24 58 37 Q77 22 94 37 Q113 25 128 43 L121 80 Q99 91 77 83 Q52 92 31 77 Z" fill="${c.liner}" opacity=".88"/>
        <path d="M31 43 Q50 56 68 40 M86 40 Q105 55 124 44" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2.2"/>` : ''}
        ${s.bread === 'loaf' ? `<g transform="rotate(-7 77 57)">
          <path d="M35 54 Q38 34 57 31 H101 Q119 34 121 54 Q118 75 100 78 H57 Q38 75 35 54 Z" fill="${c.bread}"/>
          <path d="M41 47 Q51 34 68 35 H101" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="5" stroke-linecap="round"/>
          <path d="M52 38 Q58 51 52 68 M72 34 Q78 50 72 73 M93 34 Q99 49 94 72" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="4" stroke-linecap="round"/>
          <path d="M53 39 Q58 49 53 65 M73 35 Q78 48 73 69 M94 35 Q99 47 95 69" fill="none" stroke="rgba(255,240,205,.24)" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M35 54 Q38 34 57 31 H101 Q119 34 121 54 Q118 75 100 78 H57 Q38 75 35 54 Z" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.7"/>
        </g>` : `${[[52,49,20],[84,43,19],[105,66,18],[66,70,18]].map(([x,y,r], i) => `<g>
          <circle cx="${x}" cy="${y}" r="${r}" fill="${c.bread}"/>
          <path d="M${x-r*.7} ${y-r*.35} A${r*.8} ${r*.8} 0 0 1 ${x-r*.05} ${y-r*.86}" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="3.6" stroke-linecap="round"/>
          <path d="M${x-r*.42} ${y-2} Q${x} ${y+5} ${x+r*.42} ${y-2}" fill="none" stroke="rgba(0,0,0,.33)" stroke-width="2.3" stroke-linecap="round"/>
          <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="1.4"/>
        </g>`).join('')}`}
        <ellipse cx="77" cy="56" rx="69" ry="47" fill="none" stroke="rgba(0,0,0,.40)" stroke-width="2.2"/>
        <ellipse cx="77" cy="56" rx="65" ry="43" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1.4"/>`
    },
    {
      id: 'roast-board', view: '0 0 184 110', size: 322, spin: true,
      parts: [
        { key: 'board', def: '#6b4a22', pal: 'wood' },
        { key: 'roast', def: '#8f3b26', pal: 'liquid' },
        { key: 'crust', def: '#3c2410', pal: 'wood' },
        { key: 'herb', def: '#2c3624', pal: 'cloth' }
      ],
      styles: [
        { key: 'cut', options: [{ id: 'whole' }, { id: 'sliced' }] },
        { key: 'garnish', options: [{ id: 'herbs' }, { id: 'roots' }] }
      ],
      variants: [
        { p: { board: '#6b4a22', roast: '#8f3b26', crust: '#3c2410', herb: '#2c3624' }, s: { cut: 'whole', garnish: 'herbs' } },
        { p: { board: '#8a5c30', roast: '#6b2418', crust: '#4a2c14', herb: '#6b4a17' }, s: { cut: 'sliced', garnish: 'roots' } },
        { p: { board: '#4a2c14', roast: '#7a3a1e', crust: '#2e1a08', herb: '#1c4a30' }, s: { cut: 'whole', garnish: 'roots' } }
      ],
      svg: (c, s) => `
        <path d="M14 19 Q14 11 22 11 H145 Q153 11 153 19 V35 H174 Q180 35 180 41 V69 Q180 75 174 75 H153 V91 Q153 99 145 99 H22 Q14 99 14 91 Z" fill="${c.board}"/>
        <path d="M16 25 Q16 14 27 14 H144" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="5" stroke-linecap="round"/>
        <path d="M17 86 Q62 94 145 92" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="5" stroke-linecap="round"/>
        <path d="M28 28 Q84 20 141 29 M23 48 Q82 41 145 48 M24 76 Q86 84 143 75" fill="none" stroke="rgba(0,0,0,.15)" stroke-width="1.6"/>
        <circle cx="166" cy="55" r="7" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="2"/>
        <path d="M14 19 Q14 11 22 11 H145 Q153 11 153 19 V35 H174 Q180 35 180 41 V69 Q180 75 174 75 H153 V91 Q153 99 145 99 H22 Q14 99 14 91 Z" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="2"/>
        ${s.cut === 'sliced' ? `${[42,59,76,93,110].map((x,i) => `<g transform="rotate(${i*2-4} ${x} 56)">
          <ellipse cx="${x}" cy="56" rx="13" ry="27" fill="${c.crust}"/>
          <ellipse cx="${x-1}" cy="54" rx="10" ry="23" fill="${c.roast}"/>
          <path d="M${x-8} 42 Q${x-2} 34 ${x+5} 38" fill="none" stroke="rgba(255,255,255,.20)" stroke-width="3" stroke-linecap="round"/>
          <path d="M${x-4} 52 Q${x} 47 ${x+5} 52 Q${x} 58 ${x-4} 52 Z" fill="rgba(240,210,180,.35)"/>
        </g>`).join('')}` : `<path d="M34 55 Q37 28 63 24 Q91 16 119 31 Q137 43 129 68 Q122 91 91 88 Q56 94 39 75 Q32 67 34 55 Z" fill="${c.crust}"/>
        <path d="M40 54 Q44 32 66 29 Q91 22 114 34 Q129 44 123 65 Q116 84 89 81 Q59 87 45 71 Q39 64 40 54 Z" fill="${c.roast}"/>
        <path d="M48 44 Q67 28 90 29 Q105 30 115 39" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="5" stroke-linecap="round"/>
        <path d="M112 72 Q97 82 79 78" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="4" stroke-linecap="round"/>
        <g fill="rgba(240,210,180,.34)"><circle cx="63" cy="58" r="4"/><circle cx="91" cy="49" r="3.2"/><circle cx="103" cy="66" r="3.6"/></g>
        <path d="M34 55 Q37 28 63 24 Q91 16 119 31 Q137 43 129 68 Q122 91 91 88 Q56 94 39 75 Q32 67 34 55 Z" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.7"/>`}
        ${s.garnish === 'herbs' ? `<g fill="none" stroke="${c.herb}" stroke-width="3" stroke-linecap="round">
          <path d="M126 27 Q140 39 145 55 M130 35 l10 -7 M134 41 l12 -3 M138 48 l11 4"/>
        </g>` : `<g fill="${c.herb}" stroke="rgba(0,0,0,.22)" stroke-width="1">
          <circle cx="132" cy="30" r="7"/><circle cx="143" cy="42" r="6"/><circle cx="135" cy="81" r="8"/><circle cx="122" cy="86" r="5"/>
        </g>`}`
    },
    {
      id: 'sealed-letter', view: '0 0 142 92', size: 164, spin: true,
      parts: [
        { key: 'paper', def: '#d9c793', pal: 'paper' },
        { key: 'seal', def: '#8f2b1e', pal: 'liquid' },
        { key: 'ink', def: '#3c2a14', pal: 'ink' }
      ],
      styles: [
        { key: 'fold', options: [{ id: 'envelope' }, { id: 'scroll' }] },
        { key: 'crest', options: [{ id: 'star' }, { id: 'crown' }, { id: 'plain' }] }
      ],
      variants: [
        { p: { paper: '#d9c793', seal: '#8f2b1e', ink: '#3c2a14' }, s: { fold: 'envelope', crest: 'star' } },
        { p: { paper: '#f0e3bd', seal: '#6b1a3a', ink: '#2a1a0a' }, s: { fold: 'envelope', crest: 'crown' } },
        { p: { paper: '#c2ae7c', seal: '#7a3a1e', ink: '#5c4526' }, s: { fold: 'scroll', crest: 'plain' } }
      ],
      svg: (c, s) => s.fold === 'scroll' ? `
        <path d="M19 18 Q12 24 20 31 L17 73 Q24 84 34 75 H118 Q130 78 130 65 L126 19 Q119 10 109 18 Z" fill="${c.paper}"/>
        <path d="M21 23 Q37 30 51 19 M108 19 Q121 27 126 20" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3"/>
        <path d="M28 35 H111 M27 44 H98 M27 53 H106 M27 62 H87" stroke="${c.ink}" stroke-width="2" opacity=".55" stroke-linecap="round"/>
        <path d="M19 18 Q12 24 20 31 L17 73 Q24 84 34 75 H118 Q130 78 130 65 L126 19 Q119 10 109 18 Z" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.8"/>
        <circle cx="103" cy="61" r="13" fill="${c.seal}"/>
        <path d="M94 56 A12 12 0 0 1 101 49" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="103" cy="61" r="13" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.5"/>
        ${s.crest === 'plain' ? '' : `<text x="103" y="65" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="rgba(0,0,0,.42)">${s.crest === 'crown' ? '♛' : '✦'}</text>`}` : `
        <rect x="13" y="13" width="116" height="66" rx="5" fill="${c.paper}"/>
        <path d="M15 17 L71 55 L127 17" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="2"/>
        <path d="M15 76 L57 42 M127 76 L85 42" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="1.6"/>
        <path d="M18 17 H124" stroke="rgba(255,255,255,.45)" stroke-width="3" stroke-linecap="round"/>
        <rect x="13" y="13" width="116" height="66" rx="5" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.8"/>
        <circle cx="71" cy="51" r="15" fill="${c.seal}"/>
        <path d="M60 45 A14 14 0 0 1 69 37" fill="none" stroke="rgba(255,255,255,.31)" stroke-width="3" stroke-linecap="round"/>
        <path d="M80 59 q7 7 2 13 q-5 2 -7 -5 q-1 -5 -5 -7 Z" fill="${c.seal}"/>
        <circle cx="71" cy="51" r="15" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.7"/>
        ${s.crest === 'plain' ? '' : `<text x="71" y="55.5" text-anchor="middle" font-family="Georgia,serif" font-size="13" fill="rgba(0,0,0,.44)">${s.crest === 'crown' ? '♛' : '✦'}</text>`}`
    },
    {
      id: 'ink-quill', view: '0 0 190 104', size: 205, spin: true,
      parts: [
        { key: 'feather', def: '#d9cba4', pal: 'bone' },
        { key: 'shaft', def: '#c2ae7c', pal: 'paper' },
        { key: 'ink', def: '#1a2a3a', pal: 'ink' },
        { key: 'glass', def: '#26343e', pal: 'glass' },
        { key: 'nib', def: '#a87f22', pal: 'metal' }
      ],
      styles: [
        { key: 'feather', options: [{ id: 'broad' }, { id: 'slim' }] },
        { key: 'pot', options: [{ id: 'square' }, { id: 'faceted' }] }
      ],
      variants: [
        { p: { feather: '#d9cba4', shaft: '#c2ae7c', ink: '#1a2a3a', glass: '#26343e', nib: '#a87f22' }, s: { feather: 'broad', pot: 'square' } },
        { p: { feather: '#3a3f46', shaft: '#7a5a3a', ink: '#2a1a0a', glass: '#2c3624', nib: '#8d959f' }, s: { feather: 'slim', pot: 'faceted' } },
        { p: { feather: '#f0e8d0', shaft: '#d9c793', ink: '#3a1a2a', glass: '#4a2c14', nib: '#e8c96a' }, s: { feather: 'broad', pot: 'faceted' } }
      ],
      svg: (c, s) => {
        const upper = s.feather === 'broad' ? 43 : 48;
        const lower = s.feather === 'broad' ? 78 : 73;
        return `
        ${s.pot === 'faceted' ? `<path d="M12 62 L19 53 H45 L52 62 L49 91 L42 97 H20 L13 91 Z" fill="${c.glass}"/>`
          : `<rect x="13" y="55" width="38" height="42" rx="7" fill="${c.glass}"/>`}
        <path d="M17 65 Q19 58 26 57 H42" fill="none" stroke="rgba(255,255,255,.36)" stroke-width="3.5" stroke-linecap="round"/>
        <path d="M16 88 Q31 93 48 87" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="4" stroke-linecap="round"/>
        ${s.pot === 'faceted' ? `<path d="M12 62 L19 53 H45 L52 62 L49 91 L42 97 H20 L13 91 Z" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="1.8"/>`
          : `<rect x="13" y="55" width="38" height="42" rx="7" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="1.8"/>`}
        <rect x="20" y="50" width="25" height="12" rx="3" fill="${c.glass}"/>
        <rect x="23" y="53" width="19" height="7" rx="2" fill="rgba(0,0,0,.42)"/>
        <rect x="25" y="54" width="15" height="5" rx="1.5" fill="${c.ink}"/>
        <path d="M24 53 H39" stroke="rgba(255,255,255,.30)" stroke-width="1.5" stroke-linecap="round"/>
        <g transform="rotate(-20 52 65)">
          <path d="M69 65 Q84 ${upper} 116 ${upper - 5} Q147 ${upper - 7} 177 53
                   Q151 ${lower - 6} 119 ${lower} Q88 ${lower + 1} 69 65 Z" fill="${c.feather}"/>
          <path d="M76 62 Q91 49 108 47 M91 61 Q107 45 125 43 M108 59 Q124 44 142 44 M126 57 Q140 47 155 47"
                fill="none" stroke="rgba(255,255,255,.24)" stroke-width="2" stroke-linecap="round"/>
          <path d="M77 68 Q93 76 109 72 M94 66 Q109 76 126 69 M112 63 Q127 71 143 64 M132 60 Q145 65 158 58"
                fill="none" stroke="rgba(0,0,0,.25)" stroke-width="2" stroke-linecap="round"/>
          <path d="M111 ${upper + 5} l-10 10 M133 ${upper + 1} l-9 10 M116 ${lower - 5} l-10 -8"
                fill="none" stroke="rgba(0,0,0,.30)" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M69 65 Q84 ${upper} 116 ${upper - 5} Q147 ${upper - 7} 177 53
                   Q151 ${lower - 6} 119 ${lower} Q88 ${lower + 1} 69 65 Z" fill="none" stroke="rgba(0,0,0,.31)" stroke-width="1.5"/>
          <path d="M51 65 Q105 63 177 53" fill="none" stroke="${c.shaft}" stroke-width="3.4" stroke-linecap="round"/>
          <path d="M40 65 L49 58 L61 62 L59 69 L49 73 Z" fill="${c.nib}"/>
          <path d="M42 65 L57 65" stroke="rgba(255,255,255,.42)" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M40 65 L49 58 L61 62 L59 69 L49 73 Z" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.3"/>
          <path d="M41 65 L50 65 L54 62 M50 65 L54 69" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.1" stroke-linecap="round"/>
        </g>`;
      }
    },
    {
      id: 'herb-bundle', view: '0 0 164 96', size: 188, spin: true,
      parts: [
        { key: 'leaf', def: '#2c3624', pal: 'cloth' },
        { key: 'stem', def: '#6b4a17', pal: 'wood' },
        { key: 'twine', def: '#c2ae7c', pal: 'paper' }
      ],
      styles: [
        { key: 'kind', options: [{ id: 'sage' }, { id: 'rosemary' }, { id: 'mixed' }] }
      ],
      variants: [
        { p: { leaf: '#3a6b4a', stem: '#6b4a17', twine: '#c2ae7c' }, s: { kind: 'sage' } },
        { p: { leaf: '#1c4a30', stem: '#5c4526', twine: '#a8905e' }, s: { kind: 'rosemary' } },
        { p: { leaf: '#2c3624', stem: '#6b4a17', twine: '#d9c793' }, s: { kind: 'mixed' } }
      ],
      svg: (c, s) => {
        const branches = s.kind === 'rosemary' ? [-16,-9,-2,5,12] : [-20,-10,0,10,20];
        const leaves = branches.map((a, i) => `<g transform="rotate(${a} 132 48)">
          <path d="M24 48 Q80 ${42 + i} 137 48" fill="none" stroke="${c.stem}" stroke-width="4" stroke-linecap="round"/>
          ${s.kind === 'rosemary' ? [45,59,73,87,101,115].map((x,j) => `<path d="M${x} 47 q${j%2?7:-7} -9 13 -2 q-5 8 -13 2 Z" fill="${c.leaf}"/>`).join('') : [42,62,82,102,120].map((x,j) => `<path d="M${x} 47 Q${x-2} ${j%2?30:35} ${x+15} ${j%2?32:37} Q${x+13} 47 ${x} 47 Z" fill="${c.leaf}"/>
            <path d="M${x+2} 47 Q${x+5} ${j%2?63:60} ${x+19} ${j%2?59:57} Q${x+13} 47 ${x+2} 47 Z" fill="${c.leaf}"/>`).join('')}
        </g>`).join('');
        return `${leaves}
        <path d="M118 35 Q129 48 118 61" fill="none" stroke="${c.twine}" stroke-width="8" stroke-linecap="round"/>
        <path d="M118 35 Q129 48 118 61" fill="none" stroke="rgba(0,0,0,.26)" stroke-width="8" stroke-dasharray="2 5"/>
        <path d="M121 58 q9 10 17 14 M121 58 q2 12 -4 20" fill="none" stroke="${c.twine}" stroke-width="3" stroke-linecap="round"/>
        <path d="M25 43 Q67 35 112 41" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2.4" stroke-linecap="round"/>`;
      }
    },
    {
      id: 'salt-cellar', view: '0 0 122 100', size: 82, spin: true,
      parts: [
        { key: 'bowl', def: '#8d959f', pal: 'metal' },
        { key: 'salt', def: '#f7efd8', pal: 'bone' },
        { key: 'trim', def: '#a87f22', pal: 'metal' },
        { key: 'spoon', def: '#c9d3dd', pal: 'metal' }
      ],
      styles: [
        { key: 'fill', options: [{ id: 'salt' }, { id: 'pepper' }, { id: 'mixed' }] },
        { key: 'bowl', options: [{ id: 'metal' }, { id: 'ceramic' }] }
      ],
      variants: [
        { p: { bowl: '#8d959f', salt: '#f7efd8', trim: '#a87f22', spoon: '#c9d3dd' }, s: { fill: 'salt', bowl: 'metal' } },
        { p: { bowl: '#3a3f46', salt: '#2a1a0a', trim: '#7a5a3a', spoon: '#8d959f' }, s: { fill: 'pepper', bowl: 'ceramic' } },
        { p: { bowl: '#a8703a', salt: '#d9cba4', trim: '#e8c96a', spoon: '#a87f22' }, s: { fill: 'mixed', bowl: 'metal' } }
      ],
      svg: (c, s) => {
        const grains = [[38,39,3],[49,34,2.6],[61,40,3.2],[33,51,2.4],[46,48,3.4],[58,52,2.5],[68,49,2.8],[39,61,2.5],[52,63,3.1],[64,61,2.3]];
        return `
        <circle cx="50" cy="50" r="43" fill="${c.bowl}"/>
        <path d="M10 45 A42 42 0 0 1 90 45 L84 45 A36 36 0 0 0 16 45 Z" fill="rgba(255,255,255,.16)"/>
        <path d="M11 58 A41 41 0 0 0 89 58 L83 58 A35 35 0 0 1 17 58 Z" fill="rgba(0,0,0,.20)"/>
        <circle cx="50" cy="50" r="43" fill="none" stroke="rgba(0,0,0,.40)" stroke-width="2"/>
        <circle cx="50" cy="50" r="37" fill="none" stroke="${c.trim}" stroke-width="4"/>
        ${s.bowl === 'ceramic' ? `<circle cx="50" cy="50" r="33" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2" stroke-dasharray="6 5"/>` : ''}
        <circle cx="50" cy="50" r="29" fill="rgba(0,0,0,.38)"/>
        <circle cx="50" cy="50" r="25" fill="${s.fill === 'pepper' ? '#2a1a0a' : '#e8dcc2'}"/>
        ${grains.map(([x,y,r], i) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${s.fill === 'pepper' ? c.salt : i % 3 === 0 && s.fill === 'mixed' ? c.trim : c.salt}"/>
          <circle cx="${x-r*.32}" cy="${y-r*.32}" r="${r*.24}" fill="rgba(255,255,255,.42)"/>`).join('')}
        <path d="M31 37 A24 24 0 0 1 45 27" fill="none" stroke="rgba(255,255,255,.27)" stroke-width="3" stroke-linecap="round"/>
        <circle cx="50" cy="50" r="29" fill="none" stroke="rgba(0,0,0,.30)" stroke-width="1.5"/>
        <g transform="rotate(16 79 62)">
          <ellipse cx="76" cy="60" rx="10" ry="7" fill="${c.spoon}"/>
          <path d="M83 62 Q98 67 116 66" fill="none" stroke="${c.spoon}" stroke-width="6" stroke-linecap="round"/>
          <path d="M70 57 Q76 53 82 58" fill="none" stroke="rgba(255,255,255,.38)" stroke-width="2" stroke-linecap="round"/>
          <path d="M85 60 Q100 64 114 63" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.5" stroke-linecap="round"/>
          <ellipse cx="76" cy="60" rx="10" ry="7" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.4"/>
        </g>`;
      }
    },
    {
      id: 'candelabra', view: '0 0 150 96', size: 403, spin: true,
      parts: [
        { key: 'frame', def: '#9a6b22', pal: 'metal' },
        { key: 'wax', def: '#e6d5ac', pal: 'bone' },
        { key: 'flame', def: '#e8a83c', pal: 'flame' }
      ],
      styles: [
        { key: 'arms', options: [{ id: 'two' }, { id: 'three' }] }
      ],
      variants: [
        { p: { frame: '#9a6b22', wax: '#e6d5ac', flame: '#e8a83c' }, s: { arms: 'three' } },
        { p: { frame: '#3a3f46', wax: '#f0e8d0', flame: '#f09a5e' }, s: { arms: 'two' } },
        { p: { frame: '#42221a', wax: '#2c3a5c', flame: '#4a2c6b' }, s: { arms: 'three' } }
      ],
      svg: (c, s) => {
        const cups = s.arms === 'two' ? [[45, 48], [105, 48]] : [[30, 50], [75, 40], [120, 50]];
        const cup = (x, y) => `
          <g class="pglow">
            <circle cx="${x}" cy="${y}" r="26" fill="${c.flame}" opacity=".12"/>
            <circle cx="${x}" cy="${y}" r="20" fill="${c.flame}" opacity=".08"/>
          </g>
          <ellipse cx="${x + 1.5}" cy="${y + 2.5}" rx="16.5" ry="15.5" fill="rgba(6,3,1,.30)"/>
          <circle cx="${x}" cy="${y}" r="15" fill="${c.frame}"/>
          <path d="M ${x - 15} ${y - 1.5} A 15 15 0 0 1 ${x + 15} ${y - 1.5} L ${x + 11.5} ${y - 1.5} A 11.5 11.5 0 0 0 ${x - 11.5} ${y - 1.5} Z" fill="rgba(255,255,255,.13)"/>
          <path d="M ${x - 11.5} ${y - 6.5} A 12 12 0 0 1 ${x - 3} ${y - 11.5}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2.6" stroke-linecap="round"/>
          <circle cx="${x}" cy="${y}" r="15" fill="none" stroke="rgba(0,0,0,.36)" stroke-width="1.6"/>
          <circle cx="${x}" cy="${y}" r="13" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1"/>
          <circle cx="${x}" cy="${y}" r="10.5" fill="rgba(0,0,0,.26)"/>
          <circle cx="${x}" cy="${y}" r="8.5" fill="${c.wax}"/>
          <path d="M ${x - 7} ${y - 3} A 7.5 7.5 0 0 1 ${x - 2} ${y - 7}" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.6" stroke-linecap="round"/>
          <circle cx="${x}" cy="${y}" r="5.6" fill="rgba(0,0,0,.14)"/>
          <circle cx="${x}" cy="${y}" r="4.6" fill="${c.wax}"/>
          <path d="M ${x + 7.5} ${y + 3} q 3.5 2.5 3 6.5 q -.4 2.6 -2.6 2 q -2 -.6 -1.6 -3 q .4 -3 -.6 -4.5 Z" fill="${c.wax}" opacity=".95"/>
          <circle cx="${x}" cy="${y}" r="8.5" fill="none" stroke="rgba(0,0,0,.26)" stroke-width="1.1"/>
          <g class="flameCore">
            <circle cx="${x}" cy="${y}" r="6" fill="none" stroke="${c.flame}" stroke-width="1.4" opacity=".35"/>
            <circle cx="${x}" cy="${y}" r="4.6" fill="${c.flame}"/>
            <circle cx="${x}" cy="${y}" r="3" fill="rgba(255,255,255,.35)"/>
            <circle cx="${x}" cy="${y}" r="1.8" fill="#fff8e4"/>
          </g>`;
        const bar = s.arms === 'two'
          ? `M45 48 Q75 62 105 48`
          : `M30 50 Q52 58 75 52 Q98 46 120 50`;
        const hubY = s.arms === 'two' ? 55 : 52;
        return `
        <path d="${bar}" fill="none" stroke="${c.frame}" stroke-width="7" stroke-linecap="round"/>
        <path d="${bar}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2.2" stroke-linecap="round" transform="translate(0 -1.4)"/>
        <path d="${bar}" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="2" stroke-linecap="round" transform="translate(0 2.2)"/>
        <path d="${bar}" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="7" stroke-linecap="round" stroke-dasharray="1.6 7.5" opacity=".5"/>
        <circle cx="75" cy="${hubY}" r="6.5" fill="${c.frame}"/>
        <circle cx="73.2" cy="${hubY - 1.8}" r="2.2" fill="rgba(255,255,255,.30)"/>
        <circle cx="75" cy="${hubY}" r="6.5" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.3"/>
        <circle cx="75" cy="${hubY}" r="3.2" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="1"/>
        ${cups.map(([x, y]) => cup(x, y)).join('')}`;
      }
    },
    {
      id: 'keg', view: '0 0 116 116', size: 299, spin: false,
      parts: [
        { key: 'wood', def: '#6b4a22', pal: 'wood' },
        { key: 'hoop', def: '#3a3f46', pal: 'metal' },
        { key: 'bung', def: '#2e1a08', pal: 'wood' }
      ],
      styles: [
        { key: 'hoops', options: [{ id: 'double' }, { id: 'triple' }] },
        { key: 'bung', options: [{ id: 'plug' }, { id: 'open' }] }
      ],
      variants: [
        { p: { wood: '#6b4a22', hoop: '#3a3f46', bung: '#2e1a08' }, s: { hoops: 'double', bung: 'plug' } },
        { p: { wood: '#4a2c14', hoop: '#a87f22', bung: '#1c0f04' }, s: { hoops: 'triple', bung: 'plug' } },
        { p: { wood: '#8a5c30', hoop: '#7a5a3a', bung: '#140a03' }, s: { hoops: 'double', bung: 'open' } }
      ],
      // 正俯视桶端面:板条是放射状(不是弦线),箍环带铆钉,端面带年轮
      svg: (c, s) => `
        <circle cx="58" cy="58" r="50" fill="${c.hoop}"/>
        <path d="M8 54 A50 50 0 0 1 108 54 L101.5 54 A43.5 43.5 0 0 0 14.5 54 Z" fill="rgba(255,255,255,.13)"/>
        <path d="M9 63 A49 49 0 0 0 107 63 L100.5 63 A42.5 42.5 0 0 1 15.5 63 Z" fill="rgba(0,0,0,.2)"/>
        <path d="M18 36 A45 45 0 0 1 46 12.5" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="4" stroke-linecap="round"/>
        ${[15, 75, 140, 205, 275, 335].map(a => {
          const r = a * Math.PI / 180;
          return `<circle cx="${(58 + Math.cos(r) * 47).toFixed(1)}" cy="${(58 + Math.sin(r) * 47).toFixed(1)}" r="1.7" fill="rgba(0,0,0,.4)"/><circle cx="${(58 + Math.cos(r) * 47 - .6).toFixed(1)}" cy="${(58 + Math.sin(r) * 47 - .6).toFixed(1)}" r=".8" fill="rgba(255,255,255,.35)"/>`;
        }).join('')}
        <circle cx="58" cy="58" r="50" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2"/>
        <circle cx="58" cy="58" r="44" fill="${c.wood}"/>
        ${[22, 68, 112, 158, 202, 248, 292, 338].map(a => {
          const r = a * Math.PI / 180;
          const x1 = 58 + Math.cos(r) * 13, y1 = 58 + Math.sin(r) * 13;
          const x2 = 58 + Math.cos(r) * 43.5, y2 = 58 + Math.sin(r) * 43.5;
          return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="rgba(0,0,0,.28)" stroke-width="1.8"/><path d="M ${(x1 + 1).toFixed(1)} ${(y1 + 1).toFixed(1)} L ${(x2 + 1).toFixed(1)} ${(y2 + 1).toFixed(1)}" stroke="rgba(255,214,150,.08)" stroke-width="1"/>`;
        }).join('')}
        <circle cx="58" cy="58" r="35" fill="none" stroke="rgba(0,0,0,.14)" stroke-width="1.6"/>
        <circle cx="58" cy="58" r="26" fill="none" stroke="rgba(0,0,0,.11)" stroke-width="1.3"/>
        <circle cx="58" cy="58" r="18.5" fill="none" stroke="rgba(0,0,0,.13)" stroke-width="1.2"/>
        <path d="M30 42 A32 32 0 0 1 46 28" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="5" stroke-linecap="round"/>
        <path d="M84 76 A33 33 0 0 1 70 86" fill="none" stroke="rgba(0,0,0,.14)" stroke-width="4" stroke-linecap="round"/>
        ${s.hoops === 'triple' ? `
        <circle cx="58" cy="58" r="30" fill="none" stroke="${c.hoop}" stroke-width="4.5"/>
        <path d="M38 45 A30 30 0 0 1 52 34" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="58" cy="58" r="30" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="1"/>` : ''}
        <circle cx="58" cy="58" r="44" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.6"/>
        ${s.bung === 'open'
          ? `<circle cx="58" cy="58" r="11" fill="rgba(0,0,0,.6)"/>
             <path d="M50 52 A10 10 0 0 1 56 48.5" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2" stroke-linecap="round"/>
             <circle cx="58" cy="58" r="11" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2"/>
             <circle cx="58" cy="58" r="12.8" fill="none" stroke="rgba(255,214,150,.10)" stroke-width="1"/>
             <ellipse cx="55" cy="55" rx="4.5" ry="3" fill="${c.bung}" opacity=".6"/>`
          : `<circle cx="59" cy="59.5" r="10" fill="rgba(6,3,1,.32)"/>
             <circle cx="58" cy="58" r="10" fill="${c.bung}"/>
             <path d="M50.5 55 A8.5 8.5 0 0 1 55 50.8" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2" stroke-linecap="round"/>
             <circle cx="58" cy="58" r="10" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="1.6"/>
             <path d="M52.5 55 L63.5 61 M52.5 61 L63.5 55" stroke="rgba(0,0,0,.32)" stroke-width="1.5" stroke-linecap="round"/>`}`
    },
    {
      id: 'cardfan', view: '0 0 130 96', size: 186, spin: true,
      parts: [
        { key: 'back', def: '#66201f', pal: 'cloth' },
        { key: 'trim', def: '#c9a227', pal: 'metal' },
        { key: 'face', def: '#f4ead0', pal: 'paper' }
      ],
      styles: [
        { key: 'count', options: [{ id: 'three' }, { id: 'five' }] },
        { key: 'reveal', options: [{ id: 'none' }, { id: 'one' }] }
      ],
      variants: [
        { p: { back: '#66201f', trim: '#c9a227', face: '#f4ead0' }, s: { count: 'five', reveal: 'none' } },
        { p: { back: '#1a2a3a', trim: '#c9d3dd', face: '#f0e8d0' }, s: { count: 'three', reveal: 'one' } },
        { p: { back: '#1c4a30', trim: '#e8c96a', face: '#f4ead0' }, s: { count: 'five', reveal: 'one' } }
      ],
      svg: (c, s) => {
        const n = s.count === 'three' ? 3 : 5;
        const angles = s.count === 'three' ? [-16, 0, 16] : [-28, -14, 0, 14, 28];
        const backCard = (a) => `
          <g transform="rotate(${a} 65 88)">
            <rect x="48.5" y="20.5" width="36" height="52" rx="5" fill="rgba(6,3,1,.30)"/>
            <rect x="47" y="18" width="36" height="52" rx="5" fill="${c.back}"/>
            <rect x="47" y="63.5" width="36" height="6.5" rx="3" fill="rgba(0,0,0,.22)"/>
            <rect x="47" y="18" width="36" height="9" rx="4.5" fill="rgba(255,255,255,.15)"/>
            <rect x="50.5" y="21.5" width="29" height="45" rx="3" fill="none" stroke="${c.trim}" stroke-width="1.3" opacity=".75"/>
            <rect x="52.8" y="23.8" width="24.4" height="40.4" rx="2" fill="none" stroke="${c.trim}" stroke-width=".7" opacity=".45"/>
            <path d="M65 31 L72.5 44 L65 57 L57.5 44 Z" fill="${c.trim}" opacity=".5"/>
            <path d="M65 35.5 L69.8 44 L65 52.5 L60.2 44 Z" fill="${c.back}" style="filter:brightness(1.25)"/>
            <path d="M65 31 L72.5 44 L65 57 L57.5 44 Z" fill="none" stroke="${c.trim}" stroke-width=".8" opacity=".6"/>
            <g fill="${c.trim}" opacity=".4">
              <circle cx="65" cy="26" r="1.2"/><circle cx="65" cy="62" r="1.2"/>
              <circle cx="54.5" cy="44" r="1.2"/><circle cx="75.5" cy="44" r="1.2"/>
            </g>
            <rect x="47" y="18" width="36" height="52" rx="5" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.4"/>
          </g>`;
        const faceCard = `
          <g transform="rotate(${angles[n - 1] + 16} 65 88)">
            <rect x="48.5" y="20.5" width="36" height="52" rx="5" fill="rgba(6,3,1,.30)"/>
            <rect x="47" y="18" width="36" height="52" rx="5" fill="${c.face}"/>
            <rect x="47" y="18" width="36" height="9" rx="4.5" fill="rgba(255,255,255,.5)"/>
            <rect x="47" y="64" width="36" height="6" rx="3" fill="rgba(0,0,0,.10)"/>
            <text x="53.5" y="33" font-family="Georgia,serif" font-size="11" fill="#8f2b1e">A</text>
            <text x="53.5" y="42" font-family="Georgia,serif" font-size="8" fill="#8f2b1e">♥</text>
            <text x="65.4" y="54.2" text-anchor="middle" font-family="Georgia,serif" font-size="17" fill="rgba(255,255,255,.4)">♥</text>
            <text x="66" y="55" text-anchor="middle" font-family="Georgia,serif" font-size="17" fill="#8f2b1e">♥</text>
            <rect x="47" y="18" width="36" height="52" rx="5" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.4"/>
          </g>`;
        return angles.slice(0, n).map(a => backCard(a)).join('') + (s.reveal === 'one' ? faceCard : '');
      }
    },
    {
      id: 'chipstack', view: '0 0 128 92', size: 88, spin: false,
      parts: [
        { key: 'chip', def: '#8f2b1e', pal: 'cloth' },
        { key: 'ring', def: '#f0e8d0', pal: 'bone' },
        { key: 'alt', def: '#1c4a30', pal: 'cloth' }
      ],
      styles: [
        { key: 'stacks', options: [{ id: 'two' }, { id: 'three' }] }
      ],
      variants: [
        { p: { chip: '#8f2b1e', ring: '#f0e8d0', alt: '#1c4a30' }, s: { stacks: 'three' } },
        { p: { chip: '#2c3a5c', ring: '#e8c96a', alt: '#42221a' }, s: { stacks: 'two' } },
        { p: { chip: '#2a1a0a', ring: '#c9d3dd', alt: '#3a2c4a' }, s: { stacks: 'three' } }
      ],
      // 正俯视:一叠 = 顶面圆(周边纹用粗虚线弧段)+ 底下错位露边的暗圆做叠高感
      svg: (c, s) => {
        const stack = (x, y, r, col) => `
          <ellipse cx="${x + 4.5}" cy="${y + 6}" rx="${r + 2}" ry="${r + 1}" fill="rgba(6,3,1,.30)"/>
          <circle cx="${x + 3.5}" cy="${y + 4.5}" r="${r}" fill="rgba(0,0,0,.32)"/>
          <circle cx="${x + 2.2}" cy="${y + 2.8}" r="${r}" fill="${col}" style="filter:brightness(.55)"/>
          <path d="M ${x + 2.2 - r} ${y + 2.8} A ${r} ${r} 0 0 0 ${x + 2.2 + r} ${y + 2.8}" fill="none" stroke="${c.ring}" stroke-width="1.6" stroke-dasharray="2.5 4" opacity=".5"/>
          <circle cx="${x + 1.1}" cy="${y + 1.4}" r="${r}" fill="${col}" style="filter:brightness(.75)"/>
          <path d="M ${x + 1.1 - r} ${y + 1.4} A ${r} ${r} 0 0 0 ${x + 1.1 + r} ${y + 1.4}" fill="none" stroke="${c.ring}" stroke-width="1.6" stroke-dasharray="2.5 4" opacity=".55"/>
          <circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>
          <circle cx="${x}" cy="${y}" r="${r - 3}" fill="none" stroke="${c.ring}" stroke-width="5" stroke-dasharray="${(r - 3) * .55} ${(r - 3) * .5}" stroke-dashoffset="4"/>
          <path d="M ${x - r * .95} ${y - r * .2} A ${r} ${r} 0 0 1 ${x - r * .2} ${y - r * .95}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.4"/>
          <circle cx="${x}" cy="${y}" r="${r * .58}" fill="none" stroke="${c.ring}" stroke-width="1.5" opacity=".8"/>
          <circle cx="${x}" cy="${y}" r="${r * .48}" fill="none" stroke="rgba(0,0,0,.14)" stroke-width="1"/>
          <path d="M ${x - r * .62} ${y - r * .34} A ${r * .72} ${r * .72} 0 0 1 ${x - r * .1} ${y - r * .7}" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="3.2" stroke-linecap="round"/>
          <path d="M ${x + r * .55} ${y + r * .4} A ${r * .68} ${r * .68} 0 0 1 ${x + r * .28} ${y + r * .62}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2" stroke-linecap="round"/>
          <text x="${x - r * .02}" y="${y + r * .16}" text-anchor="middle" font-family="Georgia,serif" font-size="${r * .5}" fill="rgba(255,255,255,.18)">✦</text>
          <text x="${x}" y="${y + r * .18}" text-anchor="middle" font-family="Georgia,serif" font-size="${r * .5}" fill="rgba(0,0,0,.34)">✦</text>`;
        const loose = (x, y, r, col) => `
          <ellipse cx="${x + 2.4}" cy="${y + 3.2}" rx="${r + 1.4}" ry="${r + .8}" fill="rgba(6,3,1,.26)"/>
          <circle cx="${x}" cy="${y}" r="${r}" fill="${col}"/>
          <circle cx="${x}" cy="${y}" r="${r - 2.4}" fill="none" stroke="${c.ring}" stroke-width="3.6" stroke-dasharray="${(r - 2.4) * .5} ${(r - 2.4) * .46}"/>
          <path d="M ${x - r * .6} ${y - r * .3} A ${r * .68} ${r * .68} 0 0 1 ${x - r * .1} ${y - r * .66}" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>`;
        return s.stacks === 'two'
          ? stack(44, 44, 23, c.chip) + stack(90, 56, 20, c.alt) + loose(72, 78, 12, c.chip)
          : stack(38, 40, 22, c.chip) + stack(86, 36, 19, c.alt) + stack(64, 68, 20, c.chip) + loose(98, 72, 11, c.alt);
      }
    },
    {
      id: 'dicecup', view: '0 0 124 104', size: 118, spin: true,
      parts: [
        { key: 'leather', def: '#7a3a1e', pal: 'wood' },
        { key: 'stitch', def: '#c9a864', pal: 'paper' },
        { key: 'die', def: '#f7efd8', pal: 'bone' }
      ],
      styles: [
        { key: 'pose', options: [{ id: 'up' }, { id: 'spill' }] }
      ],
      variants: [
        { p: { leather: '#7a3a1e', stitch: '#c9a864', die: '#f7efd8' }, s: { pose: 'up' } },
        { p: { leather: '#5c3a16', stitch: '#e8c96a', die: '#f0e8d0' }, s: { pose: 'spill' } },
        { p: { leather: '#2a1a0a', stitch: '#8d959f', die: '#a6adb4' }, s: { pose: 'up' } }
      ],
      svg: (c, s) => {
        // 骰子:点窝画成凹坑(暗点+下缘亮线),顶棱受光底棱背光
        const die = (x, y, v, r) => `
          <g transform="rotate(${r} ${x} ${y})">
            <rect x="${x - 9.8}" y="${y - 8.8}" width="22" height="22" rx="5" fill="rgba(6,3,1,.30)"/>
            <rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="${c.die}"/>
            <rect x="${x - 11}" y="${y - 11}" width="22" height="7.5" rx="3.7" fill="rgba(255,255,255,.4)"/>
            <rect x="${x - 11}" y="${y + 4.5}" width="22" height="6.5" rx="3.2" fill="rgba(0,0,0,.13)"/>
            <rect x="${x - 11}" y="${y - 11}" width="22" height="22" rx="5" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.2"/>
            ${(v === 5 ? [[-5, -5], [5, -5], [0, 0], [-5, 5], [5, 5]]
              : v === 3 ? [[-5, -5], [0, 0], [5, 5]]
              : v === 6 ? [[-5, -4], [5, -4], [-5, 0], [5, 0], [-5, 4], [5, 4]]
              : [[-5, -4], [5, -4], [-5, 4], [5, 4]])
              .map(([dx, dy]) => `<circle cx="${x + dx}" cy="${y + dy}" r="2.1" fill="#3c2a14"/><path d="M ${x + dx - 1.7} ${y + dy + 1.2} A 2.1 2.1 0 0 0 ${x + dx + 1.7} ${y + dy + 1.2}" fill="none" stroke="rgba(255,255,255,.4)" stroke-width=".7"/>`).join('')}
          </g>`;
        return s.pose === 'up'
          ? `
        <circle cx="56" cy="52" r="38" fill="${c.leather}"/>
        <path d="M18 48 A38 38 0 0 1 94 48 L88.5 48 A32.5 32.5 0 0 0 23.5 48 Z" fill="rgba(255,255,255,.12)"/>
        <path d="M19 58 A37 37 0 0 0 93 58 L87.5 58 A31.5 31.5 0 0 1 24.5 58 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M26 36 A34 34 0 0 1 46 20" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="4.5" stroke-linecap="round"/>
        <g stroke="rgba(0,0,0,.16)" stroke-width="1.1" fill="none">
          <path d="M28 68 Q42 76 60 77"/><path d="M78 70 Q84 62 86 52"/><path d="M24 44 Q28 36 36 29"/>
        </g>
        <circle cx="56" cy="52" r="38" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="2"/>
        <circle cx="56" cy="52" r="33.5" fill="none" stroke="${c.stitch}" stroke-width="1.8" stroke-dasharray="4.5 5"/>
        <circle cx="56" cy="52" r="30" fill="none" stroke="${c.stitch}" stroke-width="1.4" stroke-dasharray="3.5 5.5" opacity=".7"/>
        <circle cx="56" cy="52" r="26.5" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1.4"/>
        <circle cx="56" cy="52" r="24" fill="rgba(0,0,0,.42)"/>
        <path d="M38 42 A22 22 0 0 1 50 32" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="3" stroke-linecap="round"/>
        <path d="M72 62 A22.5 22.5 0 0 1 62 71" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="56" cy="52" r="24" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.6"/>
        ${die(65, 51, 4, 12)}`
          : `
        <g transform="rotate(-24 42 54)">
          <circle cx="42" cy="54" r="34" fill="${c.leather}"/>
          <path d="M8 50 A34 34 0 0 1 76 50 L71 50 A29 29 0 0 0 13 50 Z" fill="rgba(255,255,255,.12)"/>
          <path d="M15 34 A30 30 0 0 1 33 22" fill="none" stroke="rgba(255,255,255,.26)" stroke-width="4" stroke-linecap="round"/>
          <g stroke="rgba(0,0,0,.15)" stroke-width="1.1" fill="none">
            <path d="M16 66 Q30 74 46 75"/><path d="M64 68 Q70 60 72 50"/>
          </g>
          <circle cx="42" cy="54" r="34" fill="none" stroke="rgba(0,0,0,.38)" stroke-width="2"/>
          <circle cx="42" cy="54" r="29.5" fill="none" stroke="${c.stitch}" stroke-width="1.8" stroke-dasharray="4.5 5"/>
          <circle cx="42" cy="54" r="26.5" fill="none" stroke="${c.stitch}" stroke-width="1.3" stroke-dasharray="3.5 5.5" opacity=".7"/>
          <path d="M42 20 A34 34 0 0 1 76 54 L42 54 Z" fill="rgba(0,0,0,.28)"/>
        </g>
        ${[[92, 42, 5, -12], [104, 66, 3, 18], [82, 74, 6, 6]].map(([x, y, v, r]) => die(x, y, v, r)).join('')}`;
      }
    },
    {
      id: 'keyring', view: '0 0 118 96', size: 95, spin: true,
      parts: [
        { key: 'ring', def: '#7a5a3a', pal: 'metal' },
        { key: 'key', def: '#a87f22', pal: 'metal' }
      ],
      styles: [
        { key: 'count', options: [{ id: 'two' }, { id: 'three' }] },
        { key: 'bow', options: [{ id: 'round' }, { id: 'clover' }] }
      ],
      variants: [
        { p: { ring: '#7a5a3a', key: '#a87f22' }, s: { count: 'three', bow: 'round' } },
        { p: { ring: '#3a3f46', key: '#8d959f' }, s: { count: 'two', bow: 'clover' } },
        { p: { ring: '#8d959f', key: '#e8c96a' }, s: { count: 'two', bow: 'round' } }
      ],
      svg: (c, s) => {
        const key = (a, len) => `
          <g transform="rotate(${a} 46 38)">
            <g transform="translate(1.2 2)" opacity=".28">
              ${s.bow === 'clover'
                ? `<circle cx="46" cy="52" r="6.5" fill="none" stroke="rgba(6,3,1,1)" stroke-width="4"/>`
                : `<circle cx="46" cy="56" r="9" fill="none" stroke="rgba(6,3,1,1)" stroke-width="4.6"/>`}
              <rect x="43.6" y="64" width="5" height="${len}" rx="2.4" fill="rgba(6,3,1,1)"/>
            </g>
            ${s.bow === 'clover'
              ? `<circle cx="46" cy="52" r="6.5" fill="none" stroke="${c.key}" stroke-width="4"/>
                 <path d="M41 48.5 A6.5 6.5 0 0 1 47 45.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5" stroke-linecap="round"/>
                 <circle cx="40" cy="60" r="5" fill="none" stroke="${c.key}" stroke-width="3.4"/>
                 <circle cx="52" cy="60" r="5" fill="none" stroke="${c.key}" stroke-width="3.4"/>
                 <path d="M36.5 57 A5 5 0 0 1 40 55" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="1.2" stroke-linecap="round"/>`
              : `<circle cx="46" cy="56" r="9" fill="none" stroke="${c.key}" stroke-width="4.6"/>
                 <path d="M38.5 52 A9 9 0 0 1 44 47.3" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="1.8" stroke-linecap="round"/>
                 <path d="M53 60.5 A9 9 0 0 1 49 63.8" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.6" stroke-linecap="round"/>`}
            <rect x="43.6" y="64" width="5" height="${len}" rx="2.4" fill="${c.key}"/>
            <rect x="43.6" y="${64 + len - 8}" width="11" height="4.4" rx="2" fill="${c.key}"/>
            <rect x="43.6" y="${64 + len - 8}" width="11" height="1.8" rx=".9" fill="rgba(255,255,255,.22)"/>
            <rect x="43.6" y="${64 + len - 15}" width="8" height="4" rx="2" fill="${c.key}"/>
            <rect x="43.6" y="${64 + len - 15}" width="8" height="1.6" rx=".8" fill="rgba(255,255,255,.2)"/>
            <rect x="43.6" y="64" width="2" height="${len}" rx="1" fill="rgba(255,255,255,.28)"/>
            <rect x="46.8" y="64" width="1.8" height="${len}" rx=".9" fill="rgba(0,0,0,.22)"/>
          </g>`;
        const angles = s.count === 'two' ? [-118, -62] : [-128, -90, -52];
        return `
        <circle cx="47.5" cy="40.5" r="17" fill="none" stroke="rgba(6,3,1,.30)" stroke-width="6"/>
        <circle cx="46" cy="38" r="17" fill="none" stroke="${c.ring}" stroke-width="6"/>
        <path d="M31.5 31 A17 17 0 0 1 41 22.5" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M60 45 A17 17 0 0 1 52 52.5" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="46" cy="38" r="17" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="6" stroke-dasharray="1.4 6.5" opacity=".45"/>
        <circle cx="46" cy="38" r="20.5" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="1.4"/>
        <circle cx="46" cy="38" r="13.8" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="1.2"/>
        ${angles.map((a, i) => key(a, 26 + i * 5)).join('')}`;
      }
    },
    {
      id: 'platter', view: '0 0 146 100', size: 321, spin: true,
      parts: [
        { key: 'board', def: '#8a5c30', pal: 'wood' },
        { key: 'rind', def: '#b3763a', pal: 'wood' },
        { key: 'cheese', def: '#e8c96a', pal: 'bone' },
        { key: 'bread', def: '#b3763a', pal: 'wood' },
        { key: 'garnish', def: '#2c3624', pal: 'cloth' }
      ],
      styles: [
        { key: 'spread', options: [{ id: 'cheese' }, { id: 'full' }, { id: 'feast' }] }
      ],
      variants: [
        { p: { board: '#8a5c30', rind: '#b3763a', cheese: '#e8c96a', bread: '#b3763a', garnish: '#2c3624' }, s: { spread: 'full' } },
        { p: { board: '#6b4a22', rind: '#9a6b3a', cheese: '#f0d888', bread: '#9a6b3a', garnish: '#3a6b4a' }, s: { spread: 'cheese' } },
        { p: { board: '#4a2c14', rind: '#7a3a1e', cheese: '#d9cba4', bread: '#7a3a1e', garnish: '#1c4a30' }, s: { spread: 'feast' } }
      ],
      // 盘缘、奶酪外皮和切面各有完整轮廓；孔洞宁可少而大，缩到桌面尺寸也要一眼读出来。
      svg: (c, s) => `
        <circle cx="74" cy="52" r="47" fill="${c.board}"/>
        <path d="M29 43 A47 47 0 0 1 119 43" fill="none" stroke="rgba(255,255,255,.20)" stroke-width="6" stroke-linecap="round"/>
        <path d="M30 62 A45 45 0 0 0 118 62" fill="none" stroke="rgba(0,0,0,.22)" stroke-width="7" stroke-linecap="round"/>
        <circle cx="74" cy="52" r="47" fill="none" stroke="rgba(0,0,0,.40)" stroke-width="2.2"/>
        <circle cx="74" cy="52" r="41" fill="none" stroke="rgba(255,230,185,.17)" stroke-width="2"/>
        <circle cx="74" cy="52" r="37.5" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="2"/>
        <path d="M38 42 Q74 35 110 42 M37 62 Q74 69 111 62 M48 78 Q74 84 101 77" fill="none" stroke="rgba(0,0,0,.14)" stroke-width="1.4"/>
        <g transform="rotate(-12 82 45)">
          <path d="M59 49 L96 27 A40 40 0 0 1 111 55 L64 59 Z" fill="${c.cheese}"/>
          <path d="M96 27 A40 40 0 0 1 111 55 L103 53 A32 32 0 0 0 92 32 Z" fill="${c.rind}"/>
          <path d="M59 49 L64 59 L111 55 L103 53 Z" fill="rgba(255,255,255,.27)"/>
          <path d="M59 49 L96 27 L92 32 L64 59 Z" fill="rgba(255,255,255,.14)"/>
          <path d="M64 56 L105 52" stroke="rgba(0,0,0,.18)" stroke-width="1.5"/>
          <path d="M59 49 L96 27 A40 40 0 0 1 111 55 L64 59 Z" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.6"/>
          <g fill="rgba(80,48,15,.28)" stroke="rgba(255,255,255,.17)" stroke-width="1">
            <circle cx="78" cy="43" r="4"/><circle cx="94" cy="42" r="3.2"/><circle cx="84" cy="52" r="2.7"/><circle cx="101" cy="49" r="2.2"/>
          </g>
        </g>
        ${s.spread !== 'cheese' ? `<g transform="rotate(8 48 69)">
          <path d="M29 57 Q31 47 43 45 Q58 43 67 54 Q74 68 64 81 Q51 91 37 83 Q26 74 29 57 Z" fill="${c.bread}"/>
          <path d="M33 57 Q39 48 50 48 Q60 49 66 56" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="4" stroke-linecap="round"/>
          <path d="M39 53 Q45 61 39 77 M51 48 Q57 59 52 82 M61 52 Q67 62 62 76" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="2.7" stroke-linecap="round"/>
          <path d="M29 57 Q31 47 43 45 Q58 43 67 54 Q74 68 64 81 Q51 91 37 83 Q26 74 29 57 Z" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.5"/>
        </g>` : ''}
        ${s.spread === 'feast' ? `<g fill="${c.garnish}" stroke="rgba(0,0,0,.25)" stroke-width="1">
          <circle cx="103" cy="71" r="6"/><circle cx="114" cy="65" r="5"/><circle cx="111" cy="79" r="4.5"/>
        </g><path d="M94 82 Q105 73 117 76 M98 86 Q107 79 118 82" fill="none" stroke="${c.garnish}" stroke-width="2.5" stroke-linecap="round"/>` : ''}
        <g fill="${c.cheese}"><circle cx="87" cy="75" r="3.4"/><circle cx="94" cy="80" r="2.5"/><circle cx="101" cy="84" r="1.8"/></g>
        <g fill="rgba(80,48,15,.26)"><circle cx="87" cy="75" r="1.2"/><circle cx="94" cy="80" r=".9"/></g>`
    },
    {
      // 罗盘不给转:N 必须朝上,转了就是画错(而且盘面文字会倒过来)
      id: 'compass', view: '0 0 112 104', size: 70, spin: false,
      parts: [
        { key: 'case', def: '#a87f22', pal: 'metal' },
        { key: 'face', def: '#f0e3bd', pal: 'paper' },
        { key: 'needle', def: '#8f2b1e', pal: 'liquid' }
      ],
      styles: [
        { key: 'lid', options: [{ id: 'open' }, { id: 'shut' }] }
      ],
      variants: [
        { p: { case: '#a87f22', face: '#f0e3bd', needle: '#8f2b1e' }, s: { lid: 'open' } },
        { p: { case: '#7a5a3a', face: '#d9c793', needle: '#6b2418' }, s: { lid: 'shut' } },
        { p: { case: '#8d959f', face: '#f4ead0', needle: '#1a2a3a' }, s: { lid: 'open' } }
      ],
      svg: (c, s) => s.lid === 'shut'
        ? `
        <rect x="11" y="42" width="13" height="20" rx="3" fill="${c.case}"/>
        <path d="M13 46 H23 M13 53 H23 M13 59 H23" stroke="rgba(0,0,0,.34)" stroke-width="1.5"/>
        <path d="M13 44 H21" stroke="rgba(255,255,255,.30)" stroke-width="2" stroke-linecap="round"/>
        <path d="M89 43 H100 Q105 43 105 48 V56 Q105 61 100 61 H89 L91 56 H99 V48 H91 Z" fill="${c.case}"/>
        <path d="M96 45 H101 Q103 45 103 48" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="56" cy="52" r="37" fill="${c.case}"/>
        <path d="M19 48 A37 37 0 0 1 93 48 L87.5 48 A31.5 31.5 0 0 0 24.5 48 Z" fill="rgba(255,255,255,.14)"/>
        <path d="M20 58 A36 36 0 0 0 92 58 L86.5 58 A30.5 30.5 0 0 1 25.5 58 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M26 36 A33 33 0 0 1 45 20" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="4.5" stroke-linecap="round"/>
        <path d="M30 32 A29 29 0 0 1 44 24" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M88 64 A34 34 0 0 1 74 82" fill="none" stroke="rgba(255,240,205,.12)" stroke-width="3.5" stroke-linecap="round"/>
        <circle cx="56" cy="52" r="37" fill="none" stroke="rgba(0,0,0,.36)" stroke-width="2"/>
        <circle cx="56" cy="52" r="34" fill="none" stroke="rgba(0,0,0,.16)" stroke-width="1"/>
        <circle cx="56" cy="52" r="29" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="1.6"/>
        <circle cx="56" cy="50.2" r="29" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="1.2"/>
        <circle cx="56" cy="52" r="24" fill="none" stroke="rgba(0,0,0,.12)" stroke-width="1"/>
        <path d="M50 20 Q56 14 62 20 L60 26 Q56 22 52 26 Z" fill="rgba(6,3,1,.28)" transform="translate(1 1.6)"/>
        <path d="M50 20 Q56 14 62 20 L60 26 Q56 22 52 26 Z" fill="${c.case}"/>
        <path d="M51.5 19.5 Q56 15.8 60.5 19.5 L60 21.4 Q56 18.4 52 21.4 Z" fill="rgba(255,255,255,.3)"/>
        <path d="M57 27 L64 45 L83 52 L64 59 L57 79 L49 59 L30 52 L49 45 Z" fill="rgba(0,0,0,.20)"/>
        <path d="M56 25 L63 44 L82 52 L63 60 L56 80 L48 60 L29 52 L48 44 Z" fill="${c.face}" opacity=".34"/>
        <path d="M56 25 L63 44 L56 52 L48 44 Z" fill="${c.needle}" opacity=".78"/>
        <path d="M56 80 L63 60 L56 52 L48 60 Z" fill="rgba(0,0,0,.28)"/>
        <path d="M56 25 L63 44 L82 52 L63 60 L56 80 L48 60 L29 52 L48 44 Z" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="1.5"/>
        <path d="M36 43 Q46 31 55 29" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="2" stroke-linecap="round"/>`
        : `
        <circle cx="56" cy="52" r="37" fill="${c.case}"/>
        <path d="M20 47 A37 37 0 0 1 92 47 L86.5 47 A31.5 31.5 0 0 0 25.5 47 Z" fill="rgba(255,255,255,.14)"/>
        <path d="M21 58 A36 36 0 0 0 91 58 L85.5 58 A30.5 30.5 0 0 1 26.5 58 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M25 37 A34 34 0 0 1 44 20.5" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="4" stroke-linecap="round"/>
        <circle cx="56" cy="52" r="37" fill="none" stroke="rgba(0,0,0,.36)" stroke-width="2"/>
        <circle cx="56" cy="52" r="33.6" fill="none" stroke="rgba(0,0,0,.15)" stroke-width="1"/>
        <circle cx="56" cy="52" r="31.8" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="1"/>
        <circle cx="56" cy="52" r="29" fill="rgba(0,0,0,.32)"/>
        <circle cx="56" cy="52" r="26" fill="${c.face}"/>
        <g stroke="rgba(60,42,20,.30)" stroke-width=".8" fill="none">
          <circle cx="56" cy="52" r="21"/><circle cx="56" cy="52" r="16.5"/>
        </g>
        <g font-family="Georgia,serif" font-size="8.5" fill="rgba(60,42,20,.78)" text-anchor="middle">
          <text x="56" y="35">N</text><text x="56" y="75">S</text><text x="36" y="56">W</text><text x="76" y="56">E</text>
        </g>
        <g stroke="rgba(60,42,20,.38)" stroke-width="1">
          <path d="M56 28 V33 M56 71 V76 M32 52 H37 M75 52 H80"/>
          <path d="M39 35 L43 39 M73 35 L69 39 M39 69 L43 65 M73 69 L69 65"/>
        </g>
        <path d="M57.5 36 L61 52 L56 58 Z" fill="${c.needle}" style="filter:brightness(1.2)"/>
        <path d="M56 34 L57.5 36 L56 58 L51 52 Z" fill="${c.needle}"/>
        <path d="M56 70 L61 52 L56 58 L51 52 Z" fill="rgba(60,42,20,.5)"/>
        <path d="M54.5 70 L56 70 L56 58 L53.5 55.2 Z" fill="rgba(60,42,20,.72)"/>
        <ellipse cx="57" cy="53.5" rx="3.6" ry="3.4" fill="rgba(0,0,0,.3)"/>
        <circle cx="56" cy="52" r="3.4" fill="${c.case}"/>
        <circle cx="55" cy="51" r="1.2" fill="rgba(255,255,255,.45)"/>
        <circle cx="56" cy="52" r="3.4" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1"/>
        <path d="M30 38 A32 32 0 0 1 52 24 L58 30 A26 26 0 0 0 36 44 Z" fill="rgba(255,255,255,.10)"/>
        <circle cx="56" cy="52" r="26" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="1.4"/>
        <path d="M50 20 Q56 14 62 20 L60 26 Q56 22 52 26 Z" fill="rgba(6,3,1,.28)" transform="translate(1 1.6)"/>
        <path d="M50 20 Q56 14 62 20 L60 26 Q56 22 52 26 Z" fill="${c.case}"/>
        <path d="M51.5 19.5 Q56 15.8 60.5 19.5 L60 21.4 Q56 18.4 52 21.4 Z" fill="rgba(255,255,255,.3)"/>`
    },

    /* ═══ 保留件(v2 过审形制,仅换色)═══ */
    {
      id: 'dagger', view: '0 0 190 52', size: 258, spin: true,
      parts: [
        { key: 'blade', def: '#c9d3dd', pal: 'metal' },
        { key: 'guard', def: '#a87f22', pal: 'metal' },
        { key: 'grip', def: '#5c3a16', pal: 'wood' },
        { key: 'pommel', def: '#c9a227', pal: 'metal' }
      ],
      styles: [],
      variants: [
        { p: { blade: '#c9d3dd', guard: '#8d959f', grip: '#5c3a16', pommel: '#8d959f' }, s: {} },
        { p: { blade: '#e8e2d0', guard: '#e8c96a', grip: '#7a3a1e', pommel: '#e8c96a' }, s: {} },
        { p: { blade: '#aab4be', guard: '#3a3f46', grip: '#2e1a08', pommel: '#3a3f46' }, s: {} }
      ],
      svg: (c) => `
        <path d="M14 26 L96 18 Q112 17 118 24 L118 28 Q112 35 96 34 L14 26 Z" fill="${c.blade}"/>
        <path d="M14 26 L96 18 Q104 17.5 110 20 L110 24 L16 27 Z" fill="rgba(255,255,255,.42)"/>
        <path d="M16 26.5 L110 30 Q104 33 96 33 L14 26 Z" fill="rgba(0,0,0,.24)"/>
        <path d="M16 26 L112 26" stroke="rgba(255,255,255,.55)" stroke-width="1" fill="none"/>
        <path d="M14 26 L96 18 Q104 17.4 110 19.6" fill="none" stroke="rgba(255,255,255,.6)" stroke-width=".9"/>
        <path d="M34 25.4 L96 21.4" stroke="rgba(0,0,0,.22)" stroke-width="1.6" fill="none"/>
        <path d="M34 24.6 L96 20.7" stroke="rgba(255,255,255,.22)" stroke-width=".7" fill="none"/>
        <path d="M14 26 L96 18 Q112 17 118 24 L118 28 Q112 35 96 34 L14 26 Z" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="1"/>
        <rect x="117" y="13.6" width="10" height="28" rx="3" fill="rgba(6,3,1,.28)"/>
        <rect x="116" y="12" width="10" height="28" rx="3" fill="${c.guard}"/>
        <rect x="116" y="12" width="4" height="28" rx="2" fill="rgba(255,255,255,.3)"/>
        <rect x="122.2" y="12" width="3.8" height="28" rx="1.9" fill="rgba(0,0,0,.26)"/>
        <rect x="116" y="12" width="10" height="28" rx="3" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.1"/>
        <circle cx="121" cy="11.5" r="3.4" fill="${c.guard}"/>
        <circle cx="120" cy="10.5" r="1.2" fill="rgba(255,255,255,.4)"/>
        <circle cx="121" cy="40.5" r="3.4" fill="${c.guard}"/>
        <circle cx="121" cy="40.5" r="3.4" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1"/>
        <rect x="126" y="19" width="42" height="14" rx="6" fill="${c.grip}"/>
        <rect x="126" y="19" width="42" height="4.6" rx="2.3" fill="rgba(255,255,255,.18)"/>
        <rect x="126" y="28.6" width="42" height="4.4" rx="2.2" fill="rgba(0,0,0,.22)"/>
        <g stroke="rgba(0,0,0,.38)" stroke-width="1.8" fill="none">
          <path d="M132 19 L140 33"/><path d="M141 19 L149 33"/><path d="M150 19 L158 33"/><path d="M159 19 L166 32"/>
        </g>
        <g stroke="rgba(0,0,0,.28)" stroke-width="1.8" fill="none">
          <path d="M140 19 L132 33"/><path d="M149 19 L141 33"/><path d="M158 19 L150 33"/><path d="M166 20 L159 33"/>
        </g>
        <g fill="rgba(255,255,255,.2)">
          <circle cx="136" cy="26" r="1"/><circle cx="145" cy="26" r="1"/><circle cx="154" cy="26" r="1"/><circle cx="162" cy="26" r="1"/>
        </g>
        <rect x="126" y="19" width="42" height="14" rx="6" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.1"/>
        <circle cx="174" cy="26" r="9" fill="${c.pommel}"/>
        <path d="M166 28 A9 9 0 0 0 182 28 L179.6 28 A6.6 6.6 0 0 1 168.4 28 Z" fill="rgba(0,0,0,.24)"/>
        <circle cx="171" cy="22.6" r="3.2" fill="rgba(255,255,255,.30)"/>
        <circle cx="170.2" cy="21.8" r="1.5" fill="rgba(255,255,255,.6)"/>
        <circle cx="174" cy="26" r="9" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.5"/>`
    },
    {
      id: 'tankard', view: '0 0 120 110', size: 130, spin: true,
      parts: [
        { key: 'body', def: '#8d959f', pal: 'metal' },
        { key: 'brew', def: '#c9812a', pal: 'liquid' },
        { key: 'handle', def: '#7a828c', pal: 'metal' }
      ],
      styles: [],
      variants: [
        { p: { body: '#8d959f', brew: '#c9812a', handle: '#7a828c' }, s: {} },
        { p: { body: '#a8703a', brew: '#8f2b1e', handle: '#8a5c30' }, s: {} },
        { p: { body: '#c9d3dd', brew: '#6b1a3a', handle: '#aab4be' }, s: {} }
      ],
      svg: (c) => `
        <path d="M97.5 44.5 Q117.5 49 117.5 59 Q117.5 69 97.5 74 L93.5 65 Q105.5 63.5 105.5 59 Q105.5 54.5 93.5 53 Z" fill="rgba(0,0,0,.3)"/>
        <path d="M96 42 Q116 47 116 57 Q116 67 96 72 L92 63 Q104 61.5 104 57 Q104 52.5 92 51 Z" fill="${c.handle}"/>
        <path d="M96 42 Q116 47 116 57 L108.5 57 Q108 51.5 93.5 48.5 Z" fill="rgba(255,255,255,.30)"/>
        <path d="M96 72 Q116 67 116 57 L108.5 57 Q108 62.5 93.5 65.5 Z" fill="rgba(0,0,0,.28)"/>
        <path d="M96 42 Q116 47 116 57 Q116 67 96 72" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="1.5"/>
        <circle cx="95" cy="49.5" r="1.7" fill="rgba(255,255,255,.3)"/>
        <circle cx="95" cy="64.5" r="1.7" fill="rgba(0,0,0,.35)"/>
        <circle cx="56" cy="56" r="44" fill="${c.body}"/>
        <path d="M13 52 A44 44 0 0 1 99 52 L91.5 52 A36.5 36.5 0 0 0 20.5 52 Z" fill="rgba(255,255,255,.10)"/>
        <path d="M14 63 A43 43 0 0 0 98 63 L90.5 63 A35.5 35.5 0 0 1 21.5 63 Z" fill="rgba(0,0,0,.17)"/>
        <path d="M19 37 A41 41 0 0 1 50 15.5" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="6.5" stroke-linecap="round"/>
        <path d="M23 33 A38 38 0 0 1 46 19" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.6" stroke-linecap="round"/>
        <path d="M93 71 A41 41 0 0 1 74 91" fill="none" stroke="rgba(255,240,205,.13)" stroke-width="4.5" stroke-linecap="round"/>
        ${hammer(56, 56, 40.5, 9, 0.6)}
        <circle cx="56" cy="56" r="44" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2"/>
        <circle cx="56" cy="56" r="41.4" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="1.3"/>
        <circle cx="56" cy="56" r="38.8" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.2"/>
        ${hammer(56, 56, 35, 8, 2.1)}
        <circle cx="56" cy="56" r="35.5" fill="rgba(0,0,0,.40)"/>
        <path d="M79 73 A29.5 29.5 0 0 1 64 83.5" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="3.6" stroke-linecap="round"/>
        <circle cx="56" cy="56" r="30" fill="${c.brew}"/>
        <path d="M28 64 A29.5 29.5 0 0 0 84 64 L79 64 A24.5 24.5 0 0 1 33 64 Z" fill="rgba(0,0,0,.22)"/>
        <ellipse cx="47" cy="47" rx="14.5" ry="8.5" fill="rgba(255,255,255,.18)" transform="rotate(-24 47 47)"/>
        <ellipse cx="44" cy="44" rx="7" ry="4" fill="rgba(255,255,255,.40)" transform="rotate(-24 44 44)"/>
        <circle cx="56" cy="56" r="27.8" fill="none" stroke="rgba(255,244,214,.28)" stroke-width="2.2" stroke-dasharray="3 8 7 11 4 9"/>
        <circle cx="69" cy="66" r="2.7" fill="rgba(255,244,214,.5)"/>
        <circle cx="63.5" cy="71" r="1.9" fill="rgba(255,244,214,.42)"/>
        <circle cx="72" cy="60.5" r="1.4" fill="rgba(255,244,214,.34)"/>
        <circle cx="56" cy="56" r="30" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="1.8"/>`
    },
    {
      id: 'alemug', view: '0 0 122 112', size: 135, spin: true,
      parts: [
        { key: 'wood', def: '#6b4318', pal: 'wood' },
        { key: 'ale', def: '#b3541e', pal: 'liquid' },
        { key: 'foam', def: '#f0e8d0', pal: 'bone' }
      ],
      styles: [],
      variants: [
        { p: { wood: '#6b4318', ale: '#b3541e', foam: '#f0e8d0' }, s: {} },
        { p: { wood: '#3c2410', ale: '#42221a', foam: '#e0d0a8' }, s: {} },
        { p: { wood: '#8a5c30', ale: '#c9812a', foam: '#f4ead0' }, s: {} }
      ],
      svg: (c) => `
        <path d="M101.5 44.5 Q119.5 49.5 119.5 60.5 Q119.5 71.5 101.5 76.5 L98.5 68.5 Q109.5 65.5 109.5 60.5 Q109.5 55.5 98.5 52.5 Z" fill="rgba(0,0,0,.3)"/>
        <path d="M100 42 Q118 47 118 58 Q118 69 100 74 L97 66 Q108 63 108 58 Q108 53 97 50 Z" fill="${c.wood}"/>
        <path d="M100 42 Q118 47 118 58 L110.5 58 Q110 52 97.5 48.5 Z" fill="rgba(255,255,255,.24)"/>
        <path d="M100 74 Q118 69 118 58 L110.5 58 Q110 64 97.5 67.5 Z" fill="rgba(0,0,0,.26)"/>
        <path d="M100 42 Q118 47 118 58 Q118 69 100 74" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.4"/>
        <circle cx="58" cy="58" r="46" fill="${c.wood}"/>
        <path d="M13 54 A46 46 0 0 1 103 54 L96.5 54 A39.5 39.5 0 0 0 19.5 54 Z" fill="rgba(255,255,255,.10)"/>
        <path d="M14 64 A45 45 0 0 0 102 64 L95.5 64 A38.5 38.5 0 0 1 20.5 64 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M20 38 A43 43 0 0 1 50 13.5" fill="none" stroke="rgba(255,255,255,.26)" stroke-width="5" stroke-linecap="round"/>
        ${[10, 55, 100, 145, 190, 235, 280, 325].map(a => {
          const r = a * Math.PI / 180;
          const x1 = 58 + Math.cos(r) * 37.5, y1 = 58 + Math.sin(r) * 37.5;
          const x2 = 58 + Math.cos(r) * 45.5, y2 = 58 + Math.sin(r) * 45.5;
          return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="rgba(0,0,0,.26)" stroke-width="1.7"/>`;
        }).join('')}
        <circle cx="58" cy="58" r="46" fill="none" stroke="rgba(0,0,0,.42)" stroke-width="2.5"/>
        <circle cx="58" cy="58" r="42.6" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.2"/>
        <circle cx="58" cy="58" r="36" fill="rgba(0,0,0,.34)"/>
        <path d="M80 76 A30 30 0 0 1 66 85" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="3.2" stroke-linecap="round"/>
        <circle cx="58" cy="58" r="32" fill="${c.ale}"/>
        <path d="M30 66 A31.5 31.5 0 0 0 88 66 L83 66 A26.5 26.5 0 0 1 35 66 Z" fill="rgba(0,0,0,.20)"/>
        <ellipse cx="49" cy="50" rx="15" ry="9" fill="rgba(255,255,255,.15)" transform="rotate(-22 49 50)"/>
        <ellipse cx="46" cy="47" rx="7" ry="4" fill="rgba(255,255,255,.32)" transform="rotate(-22 46 47)"/>
        <circle cx="58" cy="58" r="32" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.6"/>
        <path d="M37.5 45.5 Q45 31 61 33 Q77 35 81 47.5 Q85 57.5 75 59.5 Q80 67.5 69 70.5 Q59 73.5 55 65.5 Q43 69.5 39 59.5 Q35 51.5 37.5 45.5 Z" fill="rgba(6,3,1,.24)" transform="translate(1.5 2)"/>
        <path d="M36 44 Q44 30 60 32 Q76 34 80 46 Q84 56 74 58 Q79 66 68 69 Q58 72 54 64 Q42 68 38 58 Q34 50 36 44 Z" fill="${c.foam}"/>
        <path d="M40 45 Q47 35 60 36 Q71 38 75 46 Q70 42 60 41 Q49 40 40 45 Z" fill="rgba(255,255,255,.55)"/>
        <path d="M42 58 Q52 64 64 62 Q72 60.5 76 55 Q74 62 66 65.5 Q54 69 44 63 Z" fill="rgba(0,0,0,.10)"/>
        <g fill="rgba(0,0,0,.12)">
          <circle cx="48" cy="46" r="2"/><circle cx="60" cy="42" r="1.6"/><circle cx="68" cy="52" r="2.2"/><circle cx="52" cy="56" r="1.7"/><circle cx="61" cy="60" r="1.4"/>
        </g>
        <g fill="rgba(255,255,255,.4)">
          <circle cx="47" cy="45" r=".8"/><circle cx="59" cy="41" r=".7"/><circle cx="67" cy="51" r=".9"/>
        </g>
        <path d="M36 44 Q44 30 60 32 Q76 34 80 46 Q84 56 74 58 Q79 66 68 69 Q58 72 54 64 Q42 68 38 58 Q34 50 36 44 Z" fill="none" stroke="rgba(0,0,0,.16)" stroke-width="1.1"/>
        <circle cx="76" cy="70" r="2.6" fill="${c.foam}"/>
        <circle cx="75.3" cy="69.3" r=".9" fill="rgba(255,255,255,.5)"/>`
    },
    {
      // 真骰子 1.8cm,画到 5.5cm 是可读性折中——两颗骰子小到 15px 就分不清点数了。
      // 这是全库唯一一件故意画大的,别照它定别的件的尺寸。
      id: 'dice', view: '0 0 110 70', size: 62, spin: true,
      parts: [
        { key: 'body', def: '#f7efd8', pal: 'bone' },
        { key: 'pip', def: '#3c2a14', pal: 'ink' }
      ],
      styles: [],
      variants: [
        { p: { body: '#f7efd8', pip: '#3c2a14' }, s: {} },
        { p: { body: '#42221a', pip: '#e8d5b0' }, s: {} },
        { p: { body: '#1c4a30', pip: '#f0e8d0' }, s: {} }
      ],
      svg: (c) => `
        <g transform="rotate(-8 32 36)">
          <rect x="14.5" y="19" width="40" height="40" rx="8" fill="rgba(6,3,1,.30)"/>
          <rect x="12" y="16" width="40" height="40" rx="8" fill="${c.body}"/>
          <rect x="12" y="16" width="40" height="13" rx="6.5" fill="rgba(255,255,255,.4)"/>
          <rect x="12" y="45" width="40" height="11" rx="5.5" fill="rgba(0,0,0,.15)"/>
          <path d="M12 24 Q12 16 20 16" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6" stroke-linecap="round"/>
          <rect x="12" y="16" width="40" height="40" rx="8" fill="none" stroke="rgba(0,0,0,.27)" stroke-width="1.5"/>
          ${[[24, 28], [40, 28], [32, 36], [24, 44], [40, 44]].map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" fill="${c.pip}"/><path d="M ${px - 3.1} ${py + 2.2} A 4 4 0 0 0 ${px + 3.1} ${py + 2.2}" fill="none" stroke="rgba(255,255,255,.38)" stroke-width=".9"/><path d="M ${px - 2.6} ${py - 2.6} A 4 4 0 0 1 ${px + 2.2} ${py - 3}" fill="none" stroke="rgba(0,0,0,.3)" stroke-width=".8"/>`).join('')}
        </g>
        <g transform="rotate(12 76 38)">
          <rect x="58.5" y="21" width="40" height="40" rx="8" fill="rgba(6,3,1,.30)"/>
          <rect x="56" y="18" width="40" height="40" rx="8" fill="${c.body}"/>
          <rect x="56" y="18" width="40" height="13" rx="6.5" fill="rgba(255,255,255,.4)"/>
          <rect x="56" y="47" width="40" height="11" rx="5.5" fill="rgba(0,0,0,.15)"/>
          <path d="M56 26 Q56 18 64 18" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6" stroke-linecap="round"/>
          <rect x="56" y="18" width="40" height="40" rx="8" fill="none" stroke="rgba(0,0,0,.27)" stroke-width="1.5"/>
          ${[[68, 30], [84, 46]].map(([px, py]) => `<circle cx="${px}" cy="${py}" r="4" fill="${c.pip}"/><path d="M ${px - 3.1} ${py + 2.2} A 4 4 0 0 0 ${px + 3.1} ${py + 2.2}" fill="none" stroke="rgba(255,255,255,.38)" stroke-width=".9"/><path d="M ${px - 2.6} ${py - 2.6} A 4 4 0 0 1 ${px + 2.2} ${py - 3}" fill="none" stroke="rgba(0,0,0,.3)" stroke-width=".8"/>`).join('')}
        </g>`
    },
    {
      id: 'coins', view: '0 0 116 92', size: 94, spin: false,
      parts: [
        { key: 'coin', def: '#e2bd58', pal: 'metal' },
        { key: 'edge', def: '#8a5f1d', pal: 'metal' }
      ],
      styles: [],
      variants: [
        { p: { coin: '#e2bd58', edge: '#8a5f1d' }, s: {} },
        { p: { coin: '#c9d3dd', edge: '#6a7482' }, s: {} },
        { p: { coin: '#b3763a', edge: '#6b3a1a' }, s: {} }
      ],
      // 正俯视:圆币散叠,重叠处压住下币;每枚带厚度侧缘+内环刻线+浮雕徽记+弦月高光
      svg: (c) => `
        ${[[30, 60, 0], [58, 68, 1], [84, 58, 0], [44, 40, 1], [72, 38, 0], [58, 52, 1]].map(([x, y, g], i) => `
          <g transform="rotate(${(i * 37) % 60 - 30} ${x} ${y})">
            <circle cx="${x + 2.2}" cy="${y + 3}" r="14.3" fill="rgba(6,3,1,.28)"/>
            <path d="M ${x - 14} ${y} A 14 14 0 0 0 ${x + 14} ${y} L ${x + 14} ${y + 1.8} A 14 14 0 0 1 ${x - 14} ${y + 1.8} Z" fill="${c.edge}"/>
            <circle cx="${x}" cy="${y}" r="14" fill="${c.coin}"/>
            <circle cx="${x}" cy="${y}" r="14" fill="none" stroke="${c.edge}" stroke-width="1.8"/>
            <circle cx="${x}" cy="${y}" r="10" fill="none" stroke="${c.edge}" stroke-width="1.1" opacity=".8"/>
            <g stroke="${c.edge}" stroke-width="1" opacity=".55">
              ${[0, 45, 90, 135].map(a => `<path d="M ${x + Math.cos(a * Math.PI / 180) * 10.5} ${y + Math.sin(a * Math.PI / 180) * 10.5} L ${x + Math.cos(a * Math.PI / 180) * 13.5} ${y + Math.sin(a * Math.PI / 180) * 13.5}"/>`).join('')}
            </g>
            <path d="M ${x - 8.5} ${y - 4.5} A 9.6 9.6 0 0 1 ${x - 1.5} ${y - 9.5}" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2.6" stroke-linecap="round"/>
            <path d="M ${x + 8} ${y + 5} A 9.4 9.4 0 0 1 ${x + 3} ${y + 8.8}" fill="none" stroke="rgba(0,0,0,.16)" stroke-width="1.8" stroke-linecap="round"/>
            <text x="${x - .7}" y="${y + 2.7}" text-anchor="middle" font-family="Georgia,serif" font-size="9.5" fill="rgba(255,255,255,.4)">${g ? 'G' : '✦'}</text>
            <text x="${x}" y="${y + 3.4}" text-anchor="middle" font-family="Georgia,serif" font-size="9.5" fill="${c.edge}">${g ? 'G' : '✦'}</text>
          </g>`).join('')}`
    },
    {
      id: 'pouch', view: '0 0 108 106', size: 120, spin: false,
      parts: [
        { key: 'cloth', def: '#5c3a16', pal: 'cloth' },
        { key: 'rope', def: '#c9a864', pal: 'paper' },
        { key: 'coin', def: '#e2bd58', pal: 'metal' }
      ],
      styles: [],
      variants: [
        { p: { cloth: '#5c3a16', rope: '#c9a864', coin: '#e2bd58' }, s: {} },
        { p: { cloth: '#42221a', rope: '#e8c96a', coin: '#e2bd58' }, s: {} },
        { p: { cloth: '#2c3a5c', rope: '#b8a880', coin: '#c9d3dd' }, s: {} }
      ],
      // 布袋故意塌向右下，束口也偏在一侧；这样缩小时先读到软袋轮廓，不会变成圆形筹码。
      svg: (c) => `
        <path d="M17 48 Q14 28 31 20 Q45 8 61 19 Q78 16 91 31 Q103 44 96 61
                 Q100 78 83 88 Q69 100 52 91 Q34 99 21 84 Q8 72 17 48 Z" fill="${c.cloth}"/>
        <path d="M20 43 Q24 27 38 21 Q49 15 60 21" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="5" stroke-linecap="round"/>
        <path d="M93 58 Q96 75 80 85 Q68 94 55 89" fill="none" stroke="rgba(0,0,0,.23)" stroke-width="6" stroke-linecap="round"/>
        <path d="M17 48 Q14 28 31 20 Q45 8 61 19 Q78 16 91 31 Q103 44 96 61
                 Q100 78 83 88 Q69 100 52 91 Q34 99 21 84 Q8 72 17 48 Z" fill="none" stroke="rgba(0,0,0,.34)" stroke-width="2"/>
        <g fill="none" stroke-linecap="round">
          <path d="M59 43 Q40 37 28 29 M59 45 Q75 34 86 31 M61 49 Q80 52 94 62 M57 50 Q43 67 38 85 M62 51 Q67 72 61 90"
                stroke="rgba(0,0,0,.23)" stroke-width="2.2"/>
          <path d="M56 41 Q40 35 31 29 M63 47 Q78 40 87 36 M58 53 Q47 69 44 82"
                stroke="rgba(255,255,255,.08)" stroke-width="1.3"/>
        </g>
        <path d="M48 42 Q51 31 63 32 Q76 33 79 43 Q77 54 65 57 Q52 56 48 42 Z" fill="rgba(0,0,0,.34)"/>
        <path d="M49 41 Q61 34 77 41 Q74 51 64 53 Q54 52 49 41 Z" fill="none" stroke="${c.rope}" stroke-width="4" stroke-linecap="round"/>
        <path d="M50 39 Q62 32 78 40" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M77 42 q8 4 10 12 q-4 6 -10 1 q-5 -5 0 -13 Z" fill="${c.rope}"/>
        <path d="M84 53 Q96 58 103 68 M83 55 Q91 68 88 79" fill="none" stroke="${c.rope}" stroke-width="3" stroke-linecap="round"/>
        <path d="M84 53 Q96 58 103 68" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="3" stroke-dasharray="2 4"/>
        <circle cx="91" cy="86" r="8" fill="${c.coin}"/>
        <circle cx="91" cy="86" r="8" fill="none" stroke="rgba(0,0,0,.32)" stroke-width="1.4"/>
        <path d="M85 83 A7.5 7.5 0 0 1 91 78.5" fill="none" stroke="rgba(255,255,255,.48)" stroke-width="2" stroke-linecap="round"/>
        <path d="M87 86 H95 M91 82 V90" stroke="rgba(0,0,0,.24)" stroke-width="1.2" stroke-linecap="round"/>`
    },
    {
      id: 'pipe', view: '0 0 148 64', size: 128, spin: true,
      parts: [
        { key: 'bowl', def: '#5a3414', pal: 'wood' },
        { key: 'stem', def: '#3c2410', pal: 'wood' },
        { key: 'ember', def: '#f09a5e', pal: 'flame' }
      ],
      styles: [],
      variants: [
        { p: { bowl: '#5a3414', stem: '#3c2410', ember: '#f09a5e' }, s: {} },
        { p: { bowl: '#2e1a08', stem: '#1c0f04', ember: '#e86a3c' }, s: {} },
        { p: { bowl: '#d9cba4', stem: '#8a5c30', ember: '#f0c05e' }, s: {} }
      ],
      svg: (c) => `
        <circle cx="116" cy="30" r="12" fill="${c.ember}" opacity=".06"/>
        <path d="M8 30 Q52 52 96 34" fill="none" stroke="rgba(6,3,1,.38)" stroke-width="15" stroke-linecap="round"/>
        <path d="M8 30 Q52 52 96 34" fill="none" stroke="${c.stem}" stroke-width="11" stroke-linecap="round"/>
        <path d="M8 27.8 Q52 48.5 96 30.8" fill="none" stroke="rgba(255,225,180,.32)" stroke-width="3.2" stroke-linecap="round"/>
        <path d="M9 33 Q52 54 95 36.5" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M20 33.5 Q52 48 84 36.5" fill="none" stroke="rgba(0,0,0,.16)" stroke-width=".9" stroke-dasharray="7 5"/>
        <path d="M8 30 l-1.5 -2.5 M8 30 l-2 1.5" stroke="rgba(0,0,0,.3)" stroke-width="1.4" stroke-linecap="round" fill="none"/>
        <circle cx="116" cy="30" r="20" fill="${c.bowl}"/>
        <path d="M96 27 A20 20 0 0 1 136 27 L132.4 27 A16.4 16.4 0 0 0 99.6 27 Z" fill="rgba(255,255,255,.12)"/>
        <path d="M97 34 A19 19 0 0 0 135 34 L131.5 34 A15.5 15.5 0 0 1 100.5 34 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M101 20 A18 18 0 0 1 110 13.5" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="3" stroke-linecap="round"/>
        <circle cx="116" cy="30" r="20" fill="none" stroke="rgba(0,0,0,.36)" stroke-width="2"/>
        <circle cx="116" cy="30" r="17.6" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="1"/>
        <circle cx="116" cy="30" r="12" fill="rgba(0,0,0,.58)"/>
        <path d="M107 26 A12 12 0 0 1 112 20.5" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="2" stroke-linecap="round"/>
        <g fill="rgba(30,15,5,.85)">
          <circle cx="110" cy="34" r="1.6"/><circle cx="121" cy="35.5" r="1.4"/><circle cx="123" cy="25" r="1.3"/>
        </g>
        <circle cx="116" cy="30" r="4.5" fill="${c.ember}" opacity=".88"/>
        <circle cx="114.8" cy="28.8" r="2.2" fill="rgba(255,255,255,.28)"/>
        <circle cx="116" cy="30" r="1.4" fill="#fff3dd" opacity=".75"/>
        <path d="M120 16 Q116 10 121 5" fill="none" stroke="rgba(240,232,220,.22)" stroke-width="2" stroke-linecap="round"/>
        <path d="M125 13 Q129 8 126 2.5" fill="none" stroke="rgba(240,232,220,.14)" stroke-width="1.5" stroke-linecap="round"/>`
    },
    {
      id: 'candle', view: '0 0 96 96', size: 142, spin: false,
      parts: [
        { key: 'tray', def: '#9a6b22', pal: 'metal' },
        { key: 'wax', def: '#e6d5ac', pal: 'bone' },
        { key: 'flame', def: '#e8a83c', pal: 'flame' }
      ],
      styles: [],
      variants: [
        { p: { tray: '#9a6b22', wax: '#e6d5ac', flame: '#e8a83c' }, s: {} },
        { p: { tray: '#3a3f46', wax: '#f0e8d0', flame: '#f09a5e' }, s: {} },
        { p: { tray: '#42221a', wax: '#2c3a5c', flame: '#4a2c6b' }, s: {} }
      ],
      svg: (c) => `
        <g class="pglow">
          <circle cx="48" cy="50" r="45" fill="${c.flame}" opacity=".12"/>
          <circle cx="48" cy="50" r="37" fill="${c.flame}" opacity=".09"/>
          <circle cx="48" cy="50" r="29" fill="${c.flame}" opacity=".07"/>
        </g>
        <circle cx="75.5" cy="74" r="6" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="3.6"/>
        <circle cx="74" cy="72.5" r="6" fill="none" stroke="${c.tray}" stroke-width="3.4"/>
        <path d="M69.5 69 A6 6 0 0 1 77 67.5" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.4" stroke-linecap="round"/>
        <circle cx="48" cy="50" r="30" fill="${c.tray}"/>
        <path d="M19 47 A30 30 0 0 1 77 47 L71.5 47 A24.5 24.5 0 0 0 24.5 47 Z" fill="rgba(255,255,255,.12)"/>
        <path d="M19.5 55 A29 29 0 0 0 76.5 55 L71 55 A23.5 23.5 0 0 1 25 55 Z" fill="rgba(0,0,0,.18)"/>
        <path d="M27 38.5 A24.5 24.5 0 0 1 42 27" fill="none" stroke="rgba(255,255,255,.33)" stroke-width="4.4" stroke-linecap="round"/>
        <path d="M73 60 A26 26 0 0 1 62 72" fill="none" stroke="rgba(255,240,205,.11)" stroke-width="3.2" stroke-linecap="round"/>
        ${hammer(48, 50, 26.5, 8, 1.3)}
        <circle cx="48" cy="50" r="30" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="2"/>
        <circle cx="48" cy="50" r="27.6" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>
        <circle cx="48" cy="50" r="25.2" fill="none" stroke="rgba(0,0,0,.24)" stroke-width="1.1"/>
        <circle cx="34.5" cy="65" r="2.7" fill="${c.wax}"/>
        <circle cx="33.8" cy="64.3" r="1" fill="rgba(255,255,255,.35)"/>
        <circle cx="61" cy="29.5" r="2.1" fill="${c.wax}" opacity=".92"/>
        <path d="M63 43 q7.5 3.5 9.5 10.5 q1 4.5 -2.8 5 q-3.4 .4 -4 -3.4 q-.9 -6.5 -5 -9.2 Z" fill="${c.wax}"/>
        <circle cx="69.5" cy="55.5" r="1.2" fill="rgba(255,255,255,.35)"/>
        <path d="M34 59.5 q-6 4.5 -5 10 q.7 3.6 4 2.8 q3 -.8 2.6 -4.2 q-.5 -4.6 1.6 -7.2 Z" fill="${c.wax}"/>
        <path d="M56 66.5 q3.5 4.5 2 8 q-1.2 2.6 -3.6 1.6 q-2.2 -1 -1.4 -3.8 q.9 -3.2 .6 -5.4 Z" fill="${c.wax}" opacity=".95"/>
        <circle cx="48" cy="50" r="18.5" fill="${c.wax}"/>
        <path d="M35 42 A15.5 15.5 0 0 1 45 34.8" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M60.5 57 A15.5 15.5 0 0 1 53 63.5" fill="none" stroke="rgba(0,0,0,.14)" stroke-width="2.8" stroke-linecap="round"/>
        <circle cx="48" cy="50" r="12.5" fill="rgba(0,0,0,.16)"/>
        <circle cx="48" cy="50" r="10.5" fill="${c.wax}"/>
        <circle cx="45.5" cy="47.5" r="6" fill="rgba(255,255,255,.17)"/>
        <path d="M39.5 46 A10 10 0 0 1 46 40.5" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="48" cy="50" r="18.5" fill="none" stroke="rgba(0,0,0,.28)" stroke-width="1.4"/>
        <g class="flameCore">
          <circle cx="48" cy="50" r="11" fill="none" stroke="${c.flame}" stroke-width="2" opacity=".35"/>
          <circle cx="48" cy="50" r="9" fill="${c.flame}"/>
          <circle cx="48" cy="50" r="6.2" fill="rgba(255,255,255,.35)"/>
          <circle cx="48" cy="50" r="3.4" fill="#fff8e6"/>
        </g>`
      // flameCore 类接壳里现成的火光闪动动画(tavern.css);demo 真源=prop-upgrade-demo.html
    }
  ];


function propTextKey(propId, path) {
    return `PARLORTAVERN.Props.${propId}.${path}`;
}

function addPropTextKeys(prop) {
    return {
        ...prop,
        nameKey: propTextKey(prop.id, 'Name'),
        parts: prop.parts.map(part => ({
            ...part,
            labelKey: propTextKey(prop.id, `Parts.${part.key}`)
        })),
        styles: prop.styles.map(style => ({
            ...style,
            labelKey: propTextKey(prop.id, `Styles.${style.key}.Label`),
            options: style.options.map(option => ({
                ...option,
                labelKey: propTextKey(prop.id, `Styles.${style.key}.Options.${option.id}`)
            }))
        })),
        variants: prop.variants.map((variant, index) => ({
            ...variant,
            nameKey: propTextKey(prop.id, `Variants.Variant${index + 1}`)
        }))
    };
}

export const PROP_TYPES = PROP_DEFINITIONS.map(addPropTextKeys);

export function getPropType(id) {
    return PROP_TYPES.find(p => p.id === id) || null;
}

// 合并默认值后出 SVG 字符串;未知 type 返回空串(坏数据不炸桌)。
// styles 只按 type 声明的 key 取值,所以存档里的 __sz 标记永远进不了 svg 函数。
export function renderPropSvg(typeId, colors = {}, styles = {}) {
    const prop = getPropType(typeId);
    if (!prop) return '';
    const c = {};
    for (const part of prop.parts) c[part.key] = colors[part.key] || part.def;
    const s = {};
    for (const st of prop.styles) s[st.key] = styles[st.key] || st.options[0].id;
    const body = prop.svg(c, s);
    // 带火的件跳过颗粒:火焰和光晕是 CSS 动画,包在滤镜里会让 feTurbulence 每帧重算一遍
    // (一桌几支蜡烛就是每秒几百次噪点重算)。它们本来就被光晕糊着,少一层颗粒看不出来。
    if (/class="(flameCore|pglow)"/u.test(body)) {
        return `<svg viewBox="${prop.view}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    }
    const grainId = `pttp-grain-${++grainSeq}`;
    return `<svg viewBox="${prop.view}" xmlns="http://www.w3.org/2000/svg">`
         + `${grainFilter(grainId)}<g filter="url(#${grainId})">${body}</g></svg>`;
}
