import {
    SLOT_SCATTER_PAYS,
    SLOT_SYMBOLS,
    SLOT_SYMBOL_IDS
} from '../games/slotmachine/SlotMachineRules.js';

const MODULE_ID = 'parlor';

const DEFAULT_SLOT_MACHINE_CONFIG = Object.freeze({
    prizeRates: Object.freeze({
        small: 24,
        medium: 8,
        big: 1.5
    }),
    symbolPays: Object.freeze(
        SLOT_SYMBOL_IDS.reduce((memo, symbolId) => {
            const pays = symbolId === 'scatter' ? SLOT_SCATTER_PAYS : SLOT_SYMBOLS[symbolId]?.pays || {};
            memo[symbolId] = Object.freeze({
                3: Number(pays[3] || 0),
                4: Number(pays[4] || 0),
                5: Number(pays[5] || 0)
            });
            return memo;
        }, {})
    )
});

class SlotMachineConfig {
    static SETTING_KEY = 'slotMachineConfig';

    static getDefaultConfig() {
        return foundry.utils.deepClone(DEFAULT_SLOT_MACHINE_CONFIG);
    }

    static getConfig() {
        if (!game?.settings?.settings?.has(`${MODULE_ID}.${this.SETTING_KEY}`)) {
            return this.getDefaultConfig();
        }
        return this.sanitizeConfig(game.settings.get(MODULE_ID, this.SETTING_KEY) || {});
    }

    static async setConfig(config) {
        const safe = this.sanitizeConfig(config);
        await game.settings.set(MODULE_ID, this.SETTING_KEY, safe);
        return safe;
    }

    static resetConfig() {
        return this.getDefaultConfig();
    }

    static sanitizeConfig(config = {}) {
        const defaults = this.getDefaultConfig();
        const sourceRates = config.prizeRates || {};
        const sourcePays = config.symbolPays || {};
        const safe = {
            prizeRates: {
                small: this._clampPercent(sourceRates.small, defaults.prizeRates.small),
                medium: this._clampPercent(sourceRates.medium, defaults.prizeRates.medium),
                big: this._clampPercent(sourceRates.big, defaults.prizeRates.big)
            },
            symbolPays: {}
        };

        for (const symbolId of SLOT_SYMBOL_IDS) {
            const defaultPays = defaults.symbolPays[symbolId] || {};
            const sourceSymbolPays = sourcePays[symbolId] || {};
            safe.symbolPays[symbolId] = {
                3: this._sanitizeMultiplier(sourceSymbolPays[3], defaultPays[3]),
                4: this._sanitizeMultiplier(sourceSymbolPays[4], defaultPays[4]),
                5: this._sanitizeMultiplier(sourceSymbolPays[5], defaultPays[5])
            };
        }

        this._normalizePrizeRates(safe.prizeRates);
        return safe;
    }

    static getPaytable(config = this.getConfig()) {
        return this.sanitizeConfig(config).symbolPays;
    }

    static getPrizeRates(config = this.getConfig()) {
        return this.sanitizeConfig(config).prizeRates;
    }

    static getSymbolRows(config = this.getConfig()) {
        const safe = this.sanitizeConfig(config);
        return SLOT_SYMBOL_IDS.map(symbolId => ({
            id: symbolId,
            label: game.i18n.localize(SLOT_SYMBOLS[symbolId]?.labelKey || 'PARLOR.Common.Unknown'),
            shortLabel: SLOT_SYMBOLS[symbolId]?.shortLabel || symbolId,
            isScatter: symbolId === 'scatter',
            pays: safe.symbolPays[symbolId],
            p3: safe.symbolPays[symbolId]?.[3] ?? 0,
            p4: safe.symbolPays[symbolId]?.[4] ?? 0,
            p5: safe.symbolPays[symbolId]?.[5] ?? 0
        }));
    }

    static _clampPercent(value, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
    }

    static _sanitizeMultiplier(value, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return Number(fallback || 0);
        return Math.max(0, Math.min(999, Math.round(number * 100) / 100));
    }

    static _normalizePrizeRates(rates) {
        const total = Number(rates.small || 0) + Number(rates.medium || 0) + Number(rates.big || 0);
        if (total <= 100) return rates;

        const scale = 100 / total;
        rates.small = Math.round(rates.small * scale * 10) / 10;
        rates.medium = Math.round(rates.medium * scale * 10) / 10;
        rates.big = Math.round((100 - rates.small - rates.medium) * 10) / 10;
        return rates;
    }
}

export {
    DEFAULT_SLOT_MACHINE_CONFIG,
    SlotMachineConfig
};
