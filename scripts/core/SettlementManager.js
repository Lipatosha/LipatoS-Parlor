import { ChipManager } from './ChipManager.js';
import { planGoldChipExchange } from './GoldChipExchange.js';
import {
    createUserParticipant,
    getActorIdFromParticipantId,
    getParticipantLabel,
    getPlayerCharacterParticipants,
    isBotParticipantId,
    isNpcParticipantId,
    migrateChipOwnerId
} from './ParticipantRoster.js';

const DND5E_GOLD_PATH = 'system.currency.gp';
const SETTLEMENT_MODES = Object.freeze({
    CHIPS: 'chips',
    DND5E_GOLD: 'dnd5e-gold',
    DND5E_SILVER: 'dnd5e-silver',
    DND5E_COPPER: 'dnd5e-copper'
});

const CURRENCY_CODES = Object.freeze({
    [SETTLEMENT_MODES.DND5E_GOLD]: 'gp',
    [SETTLEMENT_MODES.DND5E_SILVER]: 'sp',
    [SETTLEMENT_MODES.DND5E_COPPER]: 'cp'
});
const CURRENCY_KEYS = Object.freeze({ gp: 'Gold', sp: 'Silver', cp: 'Copper' });

export class SettlementManager {
    static MODES = SETTLEMENT_MODES;
    static _activeMode = SETTLEMENT_MODES.CHIPS;

    static canUseDnd5eGold() {
        return game.system?.id === 'dnd5e';
    }

    static normalizeMode(mode) {
        if (Object.hasOwn(CURRENCY_CODES, mode) && this.canUseDnd5eGold()) return mode;
        return SETTLEMENT_MODES.CHIPS;
    }

    static setActiveMode(mode) {
        this._activeMode = this.normalizeMode(mode);
        return this._activeMode;
    }

    static getMode(context = null) {
        return this.normalizeMode(context?.settlementMode || this._activeMode);
    }

    /** Compatibility alias: historically isGoldMode also controls actor selection. */
    static isGoldMode(context = null) {
        return this.getMode(context) !== SETTLEMENT_MODES.CHIPS;
    }

    static getCurrencyCode(context = null) {
        return CURRENCY_CODES[this.getMode(context)] || null;
    }

    static getCurrencyLabel(context = null) {
        const code = this.getCurrencyCode(context);
        const key = code ? 'PARLOR.Currency.' + CURRENCY_KEYS[code] : 'PARLOR.Currency.Chips';
        const translated = game.i18n?.localize?.(key);
        return translated && translated !== key ? translated : ({
            gp: 'Золото', sp: 'Серебро', cp: 'Медь'
        }[code] || 'Фишки');
    }

    static formatAmount(amount, context = null) {
        const value = Number(amount) || 0;
        return `${value.toLocaleString(game.i18n?.lang || 'ru-RU')} ${this.getCurrencyLabel(context)}`;
    }

    static getBalance(participantId, context = null) {
        if (!this.isGoldMode(context)) return ChipManager.getBalance(participantId);
        if (this._isUnlimitedParticipant(participantId)) return Number.POSITIVE_INFINITY;

        const actor = this._getActor(participantId);
        if (!actor) return 0;
        return this._readActorCurrency(actor, this.getCurrencyCode(context));
    }

    static getDisplayBalance(participantId, context = null) {
        if (!this.isGoldMode(context)) return ChipManager.getDisplayBalance(participantId);
        if (this._isUnlimitedParticipant(participantId)) return '∞';

        const actor = this._getActor(participantId);
        if (!actor) return '0';
        return this._readActorCurrency(actor, this.getCurrencyCode(context));
    }

    static canAfford(participantId, amount, context = null) {
        if (!this.isGoldMode(context)) return ChipManager.canAfford(participantId, amount);
        if (this._isUnlimitedParticipant(participantId)) return true;

        const actor = this._getActor(participantId);
        if (!actor) return false;
        return this._readActorCurrency(actor, this.getCurrencyCode(context)) >= Number(amount || 0);
    }

    static async grant(participantId, amount, context = null) {
        const safeAmount = Number(amount);
        if (!Number.isFinite(safeAmount) || safeAmount < 0) return false;
        return this.applyDeltas([{ userId: participantId, delta: safeAmount }], context);
    }

    static async deduct(participantId, amount, context = null) {
        const safeAmount = Number(amount);
        if (!Number.isFinite(safeAmount) || safeAmount < 0) return false;
        return this.applyDeltas([{ userId: participantId, delta: -safeAmount }], context);
    }

    static async applyDeltas(entries, context = null) {
        if (!this.isGoldMode(context)) return ChipManager.applyDeltas(entries);
        if (!game.user.isGM) return false;
        if (!Array.isArray(entries) || !entries.length) return true;

        const currencyCode = this.getCurrencyCode(context);
        const currencyPath = `system.currency.${currencyCode}`;
        const changes = new Map();
        for (const entry of entries) {
            const participantId = migrateChipOwnerId(entry?.userId ?? entry?.id);
            const delta = Math.round(Number(entry?.delta || 0) * 100) / 100;
            if (!participantId || !Number.isFinite(delta) || delta === 0) continue;
            if (this._isUnlimitedParticipant(participantId)) continue;

            const actor = this._getActor(participantId);
            // A missing recipient must not be treated as a successful payout.
            if (!actor) return false;
            changes.set(actor.id, {
                actor,
                delta: Math.round(((changes.get(actor.id)?.delta || 0) + delta) * 100) / 100
            });
        }

        for (const { actor, delta } of changes.values()) {
            if (!delta) continue;
            const current = this._readActorCurrency(actor, currencyCode);
            const next = Math.max(0, Math.round((current + delta) * 100) / 100);
            if (next === current) continue;
            await actor.update({ [currencyPath]: next });
        }

        return true;
    }

    static getDndGoldExchangeRows({ includeGM = true, includeInactive = false, user = null } = {}) {
        const participants = user
            ? [createUserParticipant(user)].filter(Boolean)
            : getPlayerCharacterParticipants({ includeGM, includeInactive });

        return participants.map(participant => {
            const actor = participant.actorId ? game.actors?.get(participant.actorId) || null : null;
            return {
                id: participant.id,
                actorId: participant.actorId || null,
                userId: participant.userId || null,
                name: getParticipantLabel(participant),
                gold: actor ? this._readActorGold(actor) : 0,
                chips: ChipManager.getBalance(participant.id),
                canExchange: !!actor
            };
        });
    }

    static async applyDndGoldExchange({ grants = [], goldToChip = [], chipToGold = [], rows = null } = {}) {
        if (!game.user.isGM) return { ok: false, reason: 'not-gm' };
        if (!this.canUseDnd5eGold()) return { ok: false, reason: 'not-dnd5e' };

        const currentRows = Array.isArray(rows)
            ? rows
            : this.getDndGoldExchangeRows({ includeGM: true, includeInactive: true });
        const plan = planGoldChipExchange({ rows: currentRows, grants, goldToChip, chipToGold });
        const failedActors = [];

        for (const update of plan.actorUpdates) {
            const actor = game.actors?.get(update.actorId);
            if (!actor) {
                failedActors.push({ participantId: update.participantId, actorId: update.actorId });
                continue;
            }

            try {
                await actor.update({ [DND5E_GOLD_PATH]: update.nextGold });
            } catch (err) {
                console.warn('parlor | Failed to update D&D gold during exchange', err);
                failedActors.push({ participantId: update.participantId, actorId: update.actorId });
            }
        }

        const failedParticipantIds = new Set(failedActors.map(row => row.participantId));
        const successfulParticipantIds = new Set(plan.actorUpdates
            .filter(update => !failedParticipantIds.has(update.participantId))
            .map(update => update.participantId));
        const chipDeltas = plan.chipDeltas.filter(delta => successfulParticipantIds.has(delta.userId));
        const chipsOk = chipDeltas.length ? await ChipManager.applyDeltas(chipDeltas) : true;

        return {
            ok: chipsOk && !failedActors.length,
            ...plan,
            chipDeltas,
            failedActors
        };
    }

    static async applySelfServiceDndGoldExchange({ userId, direction, amount } = {}) {
        if (!game.user.isGM) return { ok: false, reason: 'not-gm' };
        const user = userId ? game.users?.get(userId) : null;
        const participant = user ? createUserParticipant(user) : null;
        if (!participant?.actorId) return { ok: false, reason: 'missing-actor' };

        const entry = { participantId: participant.id, amount };
        return this.applyDndGoldExchange({
            goldToChip: direction === 'gold-to-chip' ? [entry] : [],
            chipToGold: direction === 'chip-to-gold' ? [entry] : []
        });
    }
    static _isUnlimitedParticipant(participantId) {
        const id = String(migrateChipOwnerId(participantId) || '');
        return isBotParticipantId(id) || isNpcParticipantId(id);
    }

    static _getActor(participantId) {
        const ownerId = migrateChipOwnerId(participantId);
        const actorId = getActorIdFromParticipantId(ownerId);
        return actorId ? game.actors?.get(actorId) || null : null;
    }

    static _readActorCurrency(actor, currencyCode = 'gp') {
        const key = ['gp', 'sp', 'cp'].includes(currencyCode) ? currencyCode : 'gp';
        const value = foundry.utils.getProperty(actor, `system.currency.${key}`);
        const amount = Number(value ?? 0);
        return Number.isFinite(amount) ? amount : 0;
    }

    static _readActorGold(actor) {
        return this._readActorCurrency(actor, 'gp');
    }
}
