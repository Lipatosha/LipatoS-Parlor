/** 两套皮肤共用的拉幕节奏；进度来自阶段时钟，刷新或迟到也能落在正确画面。 */
export function curtainMotion(progress) {
    const q = Math.max(0, Math.min(1, Number(progress) || 0));
    const t = Math.max(0, Math.min(1, (q - 0.2) / 0.74));
    const open = t * t * (3 - 2 * t);
    const fade = Math.max(0, Math.min(1, (q - 0.14) / 0.24));
    return {
        open,
        shift: 104 * open,
        gather: 1 - 0.08 * open,
        sway: Math.sin(open * Math.PI) * 0.7,
        titleOpacity: 1 - fade * fade * (3 - 2 * fade)
    };
}

/** 经典桌的大幕；布料单独收褶，赛事名不会随整幅帷幕压扁。 */
export class BeetleRaceCurtain {
    constructor(host, title = '') {
        this.root = document.createElement('div');
        this.root.className = 'parlor-br-opening';
        this.root.setAttribute('aria-hidden', 'true');
        this.root.innerHTML = `
            <div class="parlor-br-curtain l"><div class="parlor-br-curtain-fabric"></div></div>
            <div class="parlor-br-curtain r"><div class="parlor-br-curtain-fabric"></div></div>
            <div class="parlor-br-curtain-title"></div>`;
        this.root.querySelector('.parlor-br-curtain-title').textContent = title;
        this.panels = [...this.root.querySelectorAll('.parlor-br-curtain')];
        this.fabrics = [...this.root.querySelectorAll('.parlor-br-curtain-fabric')];
        this.title = this.root.querySelector('.parlor-br-curtain-title');
        this._progress = -1;
        host.appendChild(this.root);
    }

    setOpening(progress) {
        const q = Math.max(0, Math.min(1, progress));
        if (Math.abs(q - this._progress) < 0.0005) return;
        this._progress = q;
        const pose = curtainMotion(q);
        this.panels.forEach((panel, i) => {
            const direction = i === 0 ? -1 : 1;
            panel.style.transform = `translateX(${direction * pose.shift}%) skewY(${direction * pose.sway}deg)`;
            this.fabrics[i].style.transform = `scaleX(${pose.gather})`;
        });
        this.title.style.opacity = String(pose.titleOpacity);
        this.root.hidden = pose.open >= 1;
    }

    destroy() {
        this.root.remove();
    }
}
