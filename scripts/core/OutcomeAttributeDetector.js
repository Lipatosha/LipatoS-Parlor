const MODULE_ID = 'parlor';

const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export class OutcomeAttributeDetector {
    static async startDetection() {
        const { DialogV2 } = foundry.applications.api;

        const confirmed = await DialogV2.confirm({
            window: { title: t('PARLOR.OutcomeInfluence.Detection.Name') },
            content: `
                <p>${t('PARLOR.OutcomeInfluence.Detection.Prompt')}</p>
                <p class="hint">${t('PARLOR.OutcomeInfluence.Detection.PromptHint')}</p>
            `,
            yes: {
                icon: 'fas fa-dice-d20',
                label: t('PARLOR.OutcomeInfluence.Detection.Listening')
            },
            no: {
                icon: 'fas fa-times',
                label: t('PARLOR.Common.Cancel')
            }
        });

        if (!confirmed) return null;

        ui.notifications.info(t('PARLOR.OutcomeInfluence.Detection.Listening'));

        return new Promise(resolve => {
            const hookId = Hooks.on('createChatMessage', (message) => {
                if (message.author?.id !== game.user.id) return;
                const rolls = message.rolls;
                if (!rolls?.length) return;

                Hooks.off('createChatMessage', hookId);
                this._processRoll(message, rolls[0]).then(resolve);
            });

            window.setTimeout(() => {
                Hooks.off('createChatMessage', hookId);
                ui.notifications.warn(t('PARLOR.OutcomeInfluence.Detection.NoRoll'));
                resolve(null);
            }, 60000);
        });
    }

    static async _processRoll(message, roll) {
        const actor = this._resolveActor(message);
        if (!actor) {
            ui.notifications.warn(t('PARLOR.OutcomeInfluence.Detection.NoActor'));
            return null;
        }

        const modifier = this._extractModifier(roll);
        const flagPath = this._detectFromFlags(message, actor);
        if (flagPath) {
            const rollData = actor.getRollData?.() || {};
            const value = foundry.utils.getProperty(rollData, flagPath);
            return this._chooseSingleResult({
                path: flagPath,
                value: typeof value === 'number' ? value : modifier
            }, modifier);
        }

        const rollData = actor.getRollData?.() || {};
        let matches = this._findMatchingPaths(rollData, modifier);

        if (!matches.length && actor.system) {
            matches = this._findMatchingPaths({ system: actor.system }, modifier, '', 6);
        }

        const deduped = this._deduplicateByNamespace(matches);
        if (!deduped.length) return this._showNoMatch(modifier);
        if (deduped.length === 1) return this._chooseSingleResult(deduped[0], modifier);
        return this._chooseMultipleResults(deduped.slice(0, 6), modifier);
    }

    static _detectFromFlags(message, actor) {
        const systemId = game.system.id;
        const flags = message.flags || {};

        if (systemId === 'dnd5e') {
            const dnd5e = flags.dnd5e;
            if (dnd5e?.roll?.skillId) return `skills.${dnd5e.roll.skillId}.total`;
            if (dnd5e?.skill) return `skills.${dnd5e.skill}.total`;
        }

        if (systemId === 'pf2e') {
            const pf2e = flags.pf2e;
            if (pf2e?.context?.type === 'skill-check' && pf2e?.context?.slug) {
                return `system.skills.${pf2e.context.slug}.totalModifier`;
            }
        }

        if (systemId === 'swade') {
            const swade = flags.swade;
            if (swade?.skillId) return `skills.${swade.skillId}.die.sides`;
        }

        for (const value of Object.values(flags)) {
            if (!value || typeof value !== 'object') continue;
            const skillId = value.skillId || value.skill || value.skillKey;
            if (typeof skillId !== 'string' || skillId.length > 10) continue;

            const rollData = actor.getRollData?.() || {};
            const totalPath = `skills.${skillId}.total`;
            if (foundry.utils.getProperty(rollData, totalPath) != null) return totalPath;

            const modPath = `skills.${skillId}.mod`;
            if (foundry.utils.getProperty(rollData, modPath) != null) return modPath;
        }

        return null;
    }

    static _extractModifier(roll) {
        let diceTotal = 0;
        for (const term of roll?.terms || []) {
            if (!term?.results) continue;
            for (const result of term.results) {
                diceTotal += Number(result?.result || 0);
            }
        }
        return Number(roll?.total || 0) - diceTotal;
    }

    static _findMatchingPaths(obj, target, prefix = '', maxDepth = 5) {
        const results = [];
        if (maxDepth <= 0 || !obj || typeof obj !== 'object') return results;

        for (const [key, value] of Object.entries(obj)) {
            if (key.startsWith('_')) continue;

            const path = prefix ? `${prefix}.${key}` : key;
            if (typeof value === 'number' && value === target) {
                results.push({ path, value });
                continue;
            }

            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                results.push(...this._findMatchingPaths(value, target, path, maxDepth - 1));
            }
        }

        return results;
    }

    static _deduplicateByNamespace(matches) {
        const groups = new Map();
        const priority = { total: 4, mod: 3, totalModifier: 3, value: 2, bonus: 1 };
        const skip = ['proficient', 'proficiency', 'passive', 'dc', 'attack', 'save', 'mode', 'roll', 'label', 'type', 'ability'];

        for (const match of matches) {
            const segments = match.path.split('.');
            if (segments.length > 5) continue;

            const lastSegment = segments[segments.length - 1];
            if (skip.includes(lastSegment)) continue;

            const namespace = segments.slice(0, Math.min(2, segments.length)).join('.');
            const current = groups.get(namespace);
            const score = priority[lastSegment] || 0;
            const currentScore = priority[current?.path?.split('.').pop()] || 0;

            if (!current || score > currentScore) {
                groups.set(namespace, match);
            }
        }

        let results = [...groups.values()];
        const skillResults = results.filter(entry => entry.path.startsWith('skills.'));
        if (skillResults.length) results = skillResults;
        return results;
    }

    static _resolveActor(message) {
        const speaker = message?.speaker;
        let actor = null;

        if (speaker?.actor) actor = game.actors?.get(speaker.actor) || null;
        if (!actor && speaker?.token) {
            const token = canvas.tokens?.get(speaker.token);
            actor = token?.actor || null;
        }
        if (!actor) actor = canvas.tokens?.controlled?.[0]?.actor || null;

        return actor;
    }

    static async _chooseSingleResult(match, modifier) {
        const { DialogV2 } = foundry.applications.api;
        const safePath = foundry.utils.escapeHTML(String(match?.path || ''));

        const confirmed = await DialogV2.confirm({
            window: { title: t('PARLOR.OutcomeInfluence.Detection.Name') },
            content: `
                <p>${t('PARLOR.OutcomeInfluence.Detection.Found', {
                    path: `<code>${safePath}</code>`,
                    value: modifier
                })}</p>
            `,
            yes: {
                icon: 'fas fa-check',
                label: t('PARLOR.Common.Apply')
            },
            no: {
                icon: 'fas fa-times',
                label: t('PARLOR.Common.Cancel')
            }
        });

        return confirmed ? match.path : null;
    }

    static async _chooseMultipleResults(matches, modifier) {
        const { DialogV2 } = foundry.applications.api;
        const optionsHtml = matches.map((entry, index) => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:6px 0;">
                <input type="radio" name="outcomePath" value="${foundry.utils.escapeHTML(entry.path)}" ${index === 0 ? 'checked' : ''}>
                <code>${foundry.utils.escapeHTML(entry.path)}</code>
                <span style="color:var(--color-text-dark-secondary);">(= ${entry.value})</span>
            </label>
        `).join('');

        return foundry.applications.api.DialogV2.wait({
            window: { title: t('PARLOR.OutcomeInfluence.Detection.Name') },
            content: `
                <p>${t('PARLOR.OutcomeInfluence.Detection.FoundMultiple', { value: modifier })}</p>
                ${optionsHtml}
            `,
            buttons: [
                {
                    action: 'apply',
                    icon: 'fas fa-check',
                    label: t('PARLOR.Common.Apply'),
                    callback: (_event, _button, dialog) => dialog.element.querySelector('input[name="outcomePath"]:checked')?.value || null
                },
                {
                    action: 'cancel',
                    icon: 'fas fa-times',
                    label: t('PARLOR.Common.Cancel'),
                    callback: () => null
                }
            ]
        });
    }

    static async _showNoMatch(modifier) {
        const { DialogV2 } = foundry.applications.api;

        return DialogV2.wait({
            window: { title: t('PARLOR.OutcomeInfluence.Detection.Name') },
            content: `
                <p>${t('PARLOR.OutcomeInfluence.Detection.NoMatch', { value: modifier })}</p>
                <p class="hint">${t('PARLOR.OutcomeInfluence.Detection.ManualHint')}</p>
                <div class="form-group">
                    <label>${t('PARLOR.OutcomeInfluence.Fields.AttributePath')}</label>
                    <input type="text" name="manualPath" placeholder="skills.slt.total">
                </div>
            `,
            buttons: [
                {
                    action: 'apply',
                    icon: 'fas fa-check',
                    label: t('PARLOR.Common.Apply'),
                    callback: (_event, _button, dialog) => dialog.element.querySelector('input[name="manualPath"]')?.value?.trim() || null
                },
                {
                    action: 'cancel',
                    icon: 'fas fa-times',
                    label: t('PARLOR.Common.Cancel'),
                    callback: () => null
                }
            ]
        });
    }
}
