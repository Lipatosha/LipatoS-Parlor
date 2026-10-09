import { SlotMachineConfig } from '../core/SlotMachineConfig.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export class SlotMachineConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'parlor-slot-config',
        tag: 'section',
        classes: ['parlor-appearance-config', 'parlor-slot-config'],
        window: {
            title: 'PARLOR.SlotConfig.WindowTitle',
            icon: 'fas fa-slot-machine',
            resizable: true
        },
        position: {
            width: 1080,
            height: 'auto'
        }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/slotmachine-config.hbs` }
    };

    constructor(options = {}) {
        super(options);
        this._draft = SlotMachineConfig.getConfig();
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const config = SlotMachineConfig.sanitizeConfig(this._draft);
        this._draft = config;
        const rates = config.prizeRates;
        const totalRate = Math.round((rates.small + rates.medium + rates.big) * 10) / 10;

        return {
            ...context,
            config,
            symbolRows: SlotMachineConfig.getSymbolRows(config),
            totalRate,
            missRate: Math.max(0, Math.round((100 - totalRate) * 10) / 10)
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        if (!html) return;
        this._bindFields(html);
    }

    _bindFields(root) {
        root.querySelectorAll('[data-slot-config-field]').forEach(field => {
            field.addEventListener('change', () => {
                const path = field.dataset.slotConfigField;
                if (!path) return;
                const value = field.value === '' ? 0 : Number(field.value);
                foundry.utils.setProperty(this._draft, path, value);
                this._draft = SlotMachineConfig.sanitizeConfig(this._draft);
                this.render(true);
            });
        });

        root.querySelector('[data-action="reset-slot-config"]')?.addEventListener('click', () => {
            this._draft = SlotMachineConfig.resetConfig();
            this.render(true);
        });

        root.querySelector('[data-action="save-slot-config"]')?.addEventListener('click', async () => {
            await SlotMachineConfig.setConfig(this._draft);
            ui.notifications.info(t('PARLOR.SlotConfig.Saved'));
            this.close();
        });
    }
}
