import { OutcomeInfluence } from '../core/OutcomeInfluence.js';
import { OutcomeAttributeDetector } from '../core/OutcomeAttributeDetector.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export class OutcomeInfluenceConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'parlor-outcome-config',
        tag: 'section',
        classes: ['parlor-appearance-config', 'parlor-outcome-config'],
        window: {
            title: 'PARLOR.OutcomeInfluence.WindowTitle',
            icon: 'fas fa-sliders-h',
            resizable: true
        },
        position: {
            width: 1120,
            height: 760
        }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/outcome-influence-config.hbs` }
    };

    constructor(options = {}) {
        super(options);
        this._draft = OutcomeInfluence.getConfig();
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const config = OutcomeInfluence.sanitizeConfig(this._draft);
        this._draft = config;

        return {
            ...context,
            config,
            rows: OutcomeInfluence.getConfigRows(config),
            baccarat: OutcomeInfluence.getBaccaratRow(config)
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        if (!html) return;
        this._bindFields(html);
    }

    _bindFields(root) {
        root.querySelectorAll('[data-outcome-field]').forEach(field => {
            field.addEventListener('change', () => {
                const path = field.dataset.outcomeField;
                if (!path) return;

                let value = field.value;
                if (field.type === 'checkbox') {
                    value = !!field.checked;
                } else if (field.type === 'number') {
                    value = field.value === '' ? '' : Number(field.value);
                }

                foundry.utils.setProperty(this._draft, path, value);

                if (path === 'minWinRate' || path === 'maxWinRate') {
                    this._draft = OutcomeInfluence.sanitizeConfig(this._draft);
                    this._syncWinRateBounds(root);
                }
            });
        });

        root.querySelector('[data-action="reset-defaults"]')?.addEventListener('click', () => {
            this._draft = OutcomeInfluence.resetConfig();
            this.render(true);
        });

        root.querySelectorAll('[data-action="detect-attribute"]').forEach(button => {
            button.addEventListener('click', async () => {
                const target = button.dataset.outcomePathTarget;
                if (!target) return;

                const path = await OutcomeAttributeDetector.startDetection();
                if (!path) return;

                foundry.utils.setProperty(this._draft, target, path);
                ui.notifications.info(t('PARLOR.OutcomeInfluence.Detection.Applied', { path }));
                const field = Array.from(root.querySelectorAll('[data-outcome-field]'))
                    .find(entry => entry.dataset.outcomeField === target);
                if (field) field.value = path;
            });
        });

        root.querySelector('[data-action="save-outcome"]')?.addEventListener('click', async () => {
            await OutcomeInfluence.setConfig(this._draft);
            ui.notifications.info(t('PARLOR.OutcomeInfluence.Saved'));
            this.close();
        });
    }

    _syncWinRateBounds(root) {
        for (const path of ['minWinRate', 'maxWinRate']) {
            const field = root.querySelector(`[data-outcome-field="${path}"]`);
            if (field) field.value = String(this._draft[path]);
        }

        root.querySelectorAll('[data-outcome-field$=".baseWinRate"]').forEach(field => {
            field.min = String(this._draft.minWinRate);
            field.max = String(this._draft.maxWinRate);
            field.value = String(foundry.utils.getProperty(this._draft, field.dataset.outcomeField));
        });
    }
}
