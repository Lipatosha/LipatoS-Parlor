/** Shared 2D dice renderer.
 * All six uploaded PNG faces are preserved in a losslessly-compressed 128px/face
 * horizontal sprite. The sprite is also used by tavern presenters.
 * Never inject untrusted HTML: numeric face and class tokens are sanitized.
 */
export const D6_SPRITE_PATH = 'modules/parlor/assets/dice/d6-white-faces.webp';

export function normalizeD6(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(6, Math.floor(n))) : 1;
}

export function d6FaceAttributes(value) {
    const v = normalizeD6(value);
    return {
        face: v,
        index: v - 1,
        label: `Кость: ${v}`
    };
}

export function renderD6Face(value, { className = '', small = false } = {}) {
    const die = d6FaceAttributes(value);
    const classes = String(className).split(/\s+/u).filter(token => /^[a-z0-9_-]+$/iu.test(token));
    if (small && !classes.includes('is-small')) classes.push('is-small');
    return `<span class="parlor-d6-face ${classes.join(' ')}" data-value="${die.face}" data-v="${die.face}" style="--parlor-d6-index:${die.index}" role="img" aria-label="${die.label}"></span>`;
}

export function applyD6Face(element, value) {
    if (!element) return element;
    const die = d6FaceAttributes(value);
    element.classList.add('parlor-d6-face');
    element.dataset.value = String(die.face);
    element.dataset.v = String(die.face);
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', die.label);
    element.style.setProperty('--parlor-d6-index', String(die.index));
    return element;
}
