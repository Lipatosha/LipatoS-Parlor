import {
    OUTCOME_INFLUENCE_GAME_IDS,
    OutcomeInfluence
} from '../core/OutcomeInfluence.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
const hasOwn = (source, key) => Object.prototype.hasOwnProperty.call(source, key);

function formatNumber(value) {
    const rounded = Math.round(Number(value || 0) * 100) / 100;
    return String(rounded);
}

export class ActorOutcomeInfluenceConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'parlor-actor-outcome-config',
        tag: 'section',
        classes: ['parlor-appearance-config', 'parlor-actor-outcome-config'],
        window: {
            icon: 'fas fa-dice',
            resizable: true
        },
        position: {
            width: 820,
            height: 720
        }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/actor-outcome-influence-config.hbs` }
    };

    constructor(actor, options = {}) {
        if (!actor) throw new Error('An Actor is required to edit Parlor outcome overrides.');

        super({
            ...options,
            id: options.id || `parlor-actor-outcome-config-${actor.id}`,
            window: {
                ...(options.window || {}),
                title: t('PARLOR.OutcomeInfluence.Actor.WindowTitle', { name: actor.name })
            }
        });
        this.actor = actor;
        this._draft = OutcomeInfluence.getActorManualOverrides(actor);
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const config = OutcomeInfluence.getConfig();

        return {
            ...context,
            actor: this.actor,
            enabled: config.enabled,
            rows: this._buildRows(config)
        };
    }

    _buildRows(config) {
        const baccarat = OutcomeInfluence.getBaccaratRow(config);
        const rows = [
            ...OutcomeInfluence.getConfigRows(config),
            {
                id: 'baccarat',
                label: game.i18n.localize('PARLOR.Games.Baccarat.Name'),
                modeLabel: baccarat.modeLabel,
                attributePath: baccarat.attributePath
            }
        ];

        return rows.map(row => {
            const isManual = hasOwn(this._draft, row.id);
            const automaticValue = OutcomeInfluence.readActorAttributeValue(this.actor, row.attributePath);
            const manualValue = isManual ? this._draft[row.id] : null;
            const activeValue = isManual ? manualValue : (automaticValue ?? 0);

            return {
                ...row,
                isManual,
                manualValue,
                inputValue: isManual ? manualValue : (automaticValue ?? ''),
                automaticValue,
                automaticDataValue: automaticValue ?? '',
                hasAutomaticValue: automaticValue != null,
                hasAttributePath: !!row.attributePath,
                preview: this._formatPreview(row.id, activeValue, config)
            };
        });
    }

    _onRender(context, options) {
        super._onRender(context, options);
        if (this.element) this._bindFields(this.element);
    }

    _bindFields(root) {
        root.querySelectorAll('[data-actor-outcome-game]').forEach(row => {
            const gameId = row.dataset.actorOutcomeGame;
            const mode = row.querySelector('[data-actor-outcome-mode]');
            const input = row.querySelector('[data-actor-outcome-value]');
            if (!gameId || !mode || !input) return;

            mode.addEventListener('change', () => {
                const isManual = mode.value === 'manual';
                input.disabled = !isManual;
                row.classList.toggle('is-manual', isManual);

                if (isManual) {
                    if (input.value.trim() === '') input.value = '0';
                    this._draft[gameId] = input.value;
                    input.focus();
                    input.select();
                } else {
                    delete this._draft[gameId];
                }

                this._syncPreview(row, gameId, input, isManual);
            });

            input.addEventListener('input', () => {
                if (mode.value !== 'manual') return;
                this._draft[gameId] = input.value;
                this._syncPreview(row, gameId, input, true);
            });
        });

        root.querySelector('[data-action="close-actor-outcomes"]')?.addEventListener('click', () => {
            this.close();
        });

        root.querySelector('[data-action="save-actor-outcomes"]')?.addEventListener('click', () => {
            this._saveOverrides();
        });
    }

    _syncPreview(row, gameId, input, isManual) {
        const preview = row.querySelector('[data-actor-outcome-preview]');
        if (!preview) return;

        const rawValue = isManual ? input.value : row.dataset.automaticValue;
        if (isManual && (String(rawValue).trim() === '' || !Number.isFinite(Number(rawValue)))) {
            preview.textContent = t('PARLOR.OutcomeInfluence.Actor.InvalidPreview');
            return;
        }

        const value = String(rawValue).trim() === '' ? 0 : Number(rawValue);
        preview.textContent = this._formatPreview(gameId, value, OutcomeInfluence.getConfig());
    }

    _formatPreview(gameId, value, config) {
        if (gameId === 'baccarat') {
            const swing = OutcomeInfluence.getBaccaratSwingFromValue(Number(value), config);
            return t('PARLOR.OutcomeInfluence.Actor.BaccaratPreview', {
                loss: formatNumber(swing.lossReductionPercent),
                win: formatNumber(swing.winBoostPercent)
            });
        }

        const rate = OutcomeInfluence.getEffectiveWinRateFromValue(gameId, Number(value), config);
        return t('PARLOR.OutcomeInfluence.Actor.WinRatePreview', {
            value: formatNumber(rate)
        });
    }

    _validatedDraft() {
        const safe = {};
        for (const gameId of OUTCOME_INFLUENCE_GAME_IDS) {
            if (!hasOwn(this._draft, gameId)) continue;

            const rawValue = this._draft[gameId];
            const value = typeof rawValue === 'number'
                ? rawValue
                : Number(String(rawValue).trim());
            if (String(rawValue).trim() === '' || !Number.isFinite(value)) {
                throw new Error(t('PARLOR.OutcomeInfluence.Actor.InvalidValue', {
                    game: OutcomeInfluence.getGameLabel(gameId)
                }));
            }
            safe[gameId] = value;
        }
        return safe;
    }

    async _saveOverrides() {
        try {
            const safe = this._validatedDraft();
            await OutcomeInfluence.setActorManualOverrides(this.actor, safe);
            this._draft = safe;
            ui.notifications.info(t('PARLOR.OutcomeInfluence.Actor.Saved', { name: this.actor.name }));
            await this.close();
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save Actor outcome overrides`, {
                actorId: this.actor?.id,
                error
            });
            ui.notifications.error(t('PARLOR.OutcomeInfluence.Actor.SaveFailed', {
                message: error?.message || String(error)
            }));
            return false;
        }
    }
}
