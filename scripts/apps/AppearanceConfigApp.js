/**
 * AppearanceConfigApp — 扑克牌样式设置
 *
 * V14 兼容优先：这里走 ApplicationV2，别再开旧表单壳子。
 */

import { ParlorAppearance } from '../core/AppearanceConfig.js';
import { CardRenderer } from '../ui/CardRenderer.js';

const MODULE_ID = 'parlor';
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);
const CUSTOM_UPLOAD_ID = 'custom-uploaded';
const DEFAULT_CUSTOM_FACE_TARGET = Object.freeze({ rank: 'A', suit: 'spades' });

function getImageFilePickerClass() {
    const globalPicker = globalThis.FilePicker;
    const foundryPicker = globalThis.foundry?.applications?.apps?.FilePicker;
    return globalPicker?.implementation || globalPicker || foundryPicker?.implementation || foundryPicker || null;
}

export class AppearanceConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: 'parlor-appearance-config',
        tag: 'section',
        classes: ['parlor-appearance-config'],
        window: {
            title: 'PARLOR.Appearance.WindowTitle',
            icon: 'fas fa-palette',
            resizable: true
        },
        position: {
            width: 1160,
            height: 'auto'
        }
    };

    static PARTS = {
        main: { template: `modules/${MODULE_ID}/templates/appearance-config.hbs` }
    };

    constructor(options = {}) {
        super(options);
        this._draft = ParlorAppearance.getAppearanceConfig();
        this._customFaceTarget = { ...DEFAULT_CUSTOM_FACE_TARGET };
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const choices = ParlorAppearance.getAppearanceChoices();
        const customFaceKey = ParlorAppearance.getCustomCardKey(this._customFaceTarget);
        const customFaceTargetChoices = ParlorAppearance.getCustomCardTargetChoices();
        const customFaceConfiguredCards = ParlorAppearance.getConfiguredCustomCardFaces(this._draft);

        return {
            ...context,
            config: this._draft,
            volumePercent: Math.round(Number(this._draft.soundVolume || 0) * 100),
            textFontLabel: ParlorAppearance.getTextFontOption(this._draft)?.label || '',
            choices,
            builtInFaceChoices: choices.cardFaces.filter(choice => choice.id !== CUSTOM_UPLOAD_ID),
            customFacesActive: this._draft.cardFaceId === CUSTOM_UPLOAD_ID,
            customBackActive: this._draft.cardBackId === CUSTOM_UPLOAD_ID,
            customFaceTarget: this._customFaceTarget,
            customFaceTargetKey: customFaceKey,
            customFaceTargetPath: this._draft.customCardFacePaths?.[customFaceKey] || '',
            customFaceTargetChoices,
            customFaceConfiguredCards,
            customFaceCount: customFaceConfiguredCards.length
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const html = this.element;
        if (!html) return;

        this._bindFields(html);
        this._renderPreview(html);
    }

    _bindFields(root) {
        root.querySelectorAll('[data-appearance-field]').forEach(field => {
            const update = () => this._handleAppearanceFieldChange(root, field);
            field.addEventListener('change', update);
            field.addEventListener('input', update);
        });

        root.querySelectorAll('[data-custom-face-target-field]').forEach(field => {
            field.addEventListener('change', () => {
                const key = field.dataset.customFaceTargetField;
                if (!key) return;
                this._customFaceTarget[key] = field.value;
                this._syncCustomFaceControls(root);
                this._renderPreview(root);
            });
        });

        root.querySelector('[data-custom-card-face-path]')?.addEventListener('input', (event) => {
            this._setCustomCardFacePath(event.currentTarget.value);
            this._renderPreview(root);
        });

        root.querySelector('[data-custom-card-face-path]')?.addEventListener('change', () => {
            this.render(true);
        });

        root.querySelector('[data-custom-card-back-path]')?.addEventListener('input', (event) => {
            this._setCustomCardBackPath(event.currentTarget.value);
            this._renderPreview(root);
        });

        root.querySelector('[data-custom-card-back-path]')?.addEventListener('change', () => {
            this.render(true);
        });

        root.querySelectorAll('[data-select-custom-card-face]').forEach(button => {
            button.addEventListener('click', () => {
                this._customFaceTarget = {
                    rank: button.dataset.rank || DEFAULT_CUSTOM_FACE_TARGET.rank,
                    suit: button.dataset.suit || DEFAULT_CUSTOM_FACE_TARGET.suit
                };
                this._syncCustomFaceControls(root);
                this._renderPreview(root);
            });
        });

        root.querySelector('[data-action="pick-custom-card-face"]')?.addEventListener('click', () => {
            this._openImagePicker({
                current: this._getCustomCardFacePath(),
                onPick: (path) => {
                    this._draft.cardFaceId = CUSTOM_UPLOAD_ID;
                    this._setCustomCardFacePath(path);
                    this.render(true);
                }
            });
        });

        root.querySelector('[data-action="clear-custom-card-face"]')?.addEventListener('click', () => {
            this._setCustomCardFacePath('');
            this.render(true);
        });

        root.querySelector('[data-action="pick-custom-card-back"]')?.addEventListener('click', () => {
            this._openImagePicker({
                current: this._draft.customCardBackPath || '',
                onPick: (path) => {
                    this._draft.cardBackId = CUSTOM_UPLOAD_ID;
                    this._setCustomCardBackPath(path);
                    this.render(true);
                }
            });
        });

        root.querySelector('[data-action="clear-custom-card-back"]')?.addEventListener('click', () => {
            this._setCustomCardBackPath('');
            this.render(true);
        });

        root.querySelector('[data-table-backdrop-path]')?.addEventListener('input', (event) => {
            this._setTableBackdropPath(event.currentTarget.value);
        });

        root.querySelector('[data-table-backdrop-path]')?.addEventListener('change', () => {
            this.render(true);
        });

        root.querySelector('[data-action="pick-table-backdrop"]')?.addEventListener('click', () => {
            this._openImagePicker({
                current: this._draft.tableBackdropPath || '',
                type: 'imagevideo',
                sanitize: (path) => ParlorAppearance.sanitizeMediaPath(path),
                onPick: (path) => {
                    this._setTableBackdropPath(path);
                    this.render(true);
                }
            });
        });

        root.querySelector('[data-action="clear-table-backdrop"]')?.addEventListener('click', () => {
            this._setTableBackdropPath('');
            this.render(true);
        });

        root.querySelector('[data-action="reset-defaults"]')?.addEventListener('click', () => {
            this._draft = ParlorAppearance.resetAppearanceConfig();
            this._customFaceTarget = { ...DEFAULT_CUSTOM_FACE_TARGET };
            this.render(true);
        });

        root.querySelector('[data-action="save-appearance"]')?.addEventListener('click', async () => {
            await ParlorAppearance.setAppearanceConfig(this._draft);
            ui.notifications.info(t('PARLOR.Appearance.Saved'));
            this.close();
        });

        root.querySelectorAll('[data-preview-sound]').forEach(button => {
            button.addEventListener('click', () => {
                ParlorAppearance.playCardSound(button.dataset.previewSound, this._draft);
            });
        });
    }

    _handleAppearanceFieldChange(root, field) {
        const key = field.dataset.appearanceField;
        if (!key) return;

        if (field.type === 'checkbox') {
            this._draft[key] = !!field.checked;
        } else if (field.type === 'range') {
            this._draft[key] = Math.max(0, Math.min(1, Number(field.value) / 100));
        } else {
            this._draft[key] = field.value;
        }

        if (key === 'cardFaceId' || key === 'cardBackId') {
            this.render(true);
            return;
        }

        this._syncVolumeLabel(root);
        this._renderPreview(root);
    }

    _syncVolumeLabel(root) {
        root.querySelector('[data-volume-label]')?.replaceChildren(
            document.createTextNode(`${Math.round(Number(this._draft.soundVolume || 0) * 100)}%`)
        );
    }

    _getCustomCardFacePath() {
        const key = ParlorAppearance.getCustomCardKey(this._customFaceTarget);
        return this._draft.customCardFacePaths?.[key] || '';
    }

    _setCustomCardFacePath(rawPath) {
        const key = ParlorAppearance.getCustomCardKey(this._customFaceTarget);
        const safePath = ParlorAppearance.sanitizeImagePath(rawPath);
        const nextPaths = { ...(this._draft.customCardFacePaths || {}) };
        if (safePath) {
            nextPaths[key] = safePath;
        } else {
            delete nextPaths[key];
        }
        this._draft.customCardFacePaths = nextPaths;
        return safePath;
    }

    _setCustomCardBackPath(rawPath) {
        this._draft.customCardBackPath = ParlorAppearance.sanitizeImagePath(rawPath);
        return this._draft.customCardBackPath;
    }

    _setTableBackdropPath(rawPath) {
        this._draft.tableBackdropPath = ParlorAppearance.sanitizeMediaPath(rawPath);
        return this._draft.tableBackdropPath;
    }

    _syncCustomFaceControls(root) {
        root.querySelector('[data-custom-face-target-field="rank"]')?.replaceChildren(
            ...ParlorAppearance.getCustomCardTargetChoices().ranks.map(choice => {
                const option = document.createElement('option');
                option.value = choice.id;
                option.textContent = choice.label;
                option.selected = choice.id === this._customFaceTarget.rank;
                return option;
            })
        );
        root.querySelector('[data-custom-face-target-field="suit"]')?.replaceChildren(
            ...ParlorAppearance.getCustomCardTargetChoices().suits.map(choice => {
                const option = document.createElement('option');
                option.value = choice.id;
                option.textContent = choice.label;
                option.selected = choice.id === this._customFaceTarget.suit;
                return option;
            })
        );
        const input = root.querySelector('[data-custom-card-face-path]');
        if (input) input.value = this._getCustomCardFacePath();
    }

    _openImagePicker({ current = '', onPick, type = 'image', sanitize = null }) {
        const Picker = getImageFilePickerClass();
        if (!Picker) {
            ui.notifications.warn(t('PARLOR.Appearance.Upload.FilePickerUnavailable'));
            return;
        }

        // FilePicker 是 V13/V14 的 ApplicationV2；这里不自己上传文件，只交给 Foundry 原生窗口处理权限和来源。
        new Picker({
            type,
            current,
            callback: (path) => {
                const safePath = sanitize ? sanitize(path) : ParlorAppearance.sanitizeImagePath(path);
                if (!safePath) {
                    ui.notifications.warn(t('PARLOR.Appearance.Upload.InvalidImagePath'));
                    return;
                }
                onPick(safePath);
            }
        }).render(true);
    }

    _renderPreview(root) {
        const preview = root.querySelector('[data-appearance-preview]');
        if (!preview) return;

        ParlorAppearance.applyAppearanceToElement(root, this._draft);
        ParlorAppearance.applyAppearanceToElement(preview, this._draft);

        const [frontCard, accentCard] = this._getPreviewCards();
        this._mountCard(preview.querySelector('[data-preview-card-front]'), frontCard, false);
        this._mountCard(preview.querySelector('[data-preview-card-back]'), accentCard, true);

        const faceLabel = ParlorAppearance.getCardFaceOption(this._draft)?.label || '';
        const backLabel = ParlorAppearance.getCardBackOption(this._draft)?.label || '';
        const textFontLabel = ParlorAppearance.getTextFontOption(this._draft)?.label || '';

        preview.querySelector('[data-preview-face-label]')?.replaceChildren(document.createTextNode(faceLabel));
        preview.querySelector('[data-preview-back-label]')?.replaceChildren(document.createTextNode(backLabel));
        preview.querySelector('[data-preview-font-label]')?.replaceChildren(document.createTextNode(textFontLabel));
    }

    _getPreviewCards() {
        if (this._draft.cardFaceId === CUSTOM_UPLOAD_ID) {
            return [
                { rank: this._customFaceTarget.rank, suit: this._customFaceTarget.suit },
                { rank: 'Q', suit: 'hearts' }
            ];
        }
        return ParlorAppearance.getPreviewCards();
    }

    _mountCard(host, card, faceDown = false, size = 'large') {
        if (!host) return;
        host.innerHTML = '';
        const el = CardRenderer.createCard(card, {
            faceDown,
            size,
            appearance: this._draft
        });
        host.appendChild(el);
    }
}
