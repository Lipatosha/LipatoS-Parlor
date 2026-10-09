import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeObject(original, other, _options = {}) {
    const target = clone(original) || {};
    for (const [key, value] of Object.entries(other || {})) {
        if (isPlainObject(value) && isPlainObject(target[key])) {
            target[key] = mergeObject(target[key], value);
        } else {
            target[key] = clone(value);
        }
    }
    return target;
}

globalThis.foundry = {
    utils: {
        deepClone: clone,
        mergeObject
    }
};

globalThis.game = {
    i18n: {
        localize: (key) => key,
        format: (key) => key
    }
};
globalThis.ROUTE_PREFIX = '';

const { ParlorAppearance } = await import('../scripts/core/AppearanceConfig.js');
const { PRESENTER_API_VERSION, PresenterRegistry } = await import('../scripts/core/PresenterRegistry.js');

describe('ParlorAppearance custom card images', () => {
    it('uses an uploaded image for a matching custom card face', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({
            cardFaceId: 'custom-uploaded',
            customCardFacePaths: {
                'spades:A': 'worlds/campaign/parlor/ace-spades.webp'
            }
        });

        assert.equal(
            ParlorAppearance.getCardFacePath({ rank: 'A', suit: 'spades' }, config),
            'worlds/campaign/parlor/ace-spades.webp'
        );
    });

    it('falls back to the selected built-in face when a custom card face is missing', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({
            cardFaceId: 'custom-uploaded',
            customCardFaceFallbackId: 'fvtt-dark-gold',
            customCardFacePaths: {}
        });

        assert.equal(
            ParlorAppearance.getCardFacePath({ rank: 'Q', suit: 'hearts' }, config),
            'cards/dark-gold/hearts-queen.webp'
        );
    });

    it('uses an uploaded image for the custom card back', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({
            cardBackId: 'custom-uploaded',
            customCardBackPath: 'worlds/campaign/parlor/card-back.png'
        });

        assert.equal(
            ParlorAppearance.getCardBackPath(config),
            'worlds/campaign/parlor/card-back.png'
        );
    });

    it('drops unsafe or non-image custom paths before rendering cards', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({
            cardFaceId: 'custom-uploaded',
            customCardFacePaths: {
                'clubs:K': 'javascript:alert(1)',
                'hearts:Q': 'worlds/campaign/readme.txt'
            },
            cardBackId: 'custom-uploaded',
            customCardBackPath: 'data:text/html,<script>alert(1)</script>'
        });

        assert.deepEqual(config.customCardFacePaths, {});
        assert.equal(config.customCardBackPath, '');
        assert.equal(
            ParlorAppearance.getCardFacePath({ rank: 'K', suit: 'clubs' }, config),
            '/modules/parlor/assets/cards/runtime/New Club White/King.png'
        );
        assert.equal(
            ParlorAppearance.getCardBackPath(config),
            '/modules/parlor/assets/cards/runtime/Card Backs/New Blue.png'
        );
    });
});

describe('ParlorAppearance presenter themes', () => {
    it('defaults to the classic native table theme', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({});

        assert.equal(config.themeId, 'classic');
        assert.equal(ParlorAppearance.getActiveThemeId(config), 'classic');
    });

    it('sanitizes unknown presenter themes back to classic', () => {
        const config = ParlorAppearance.sanitizeAppearanceConfig({
            themeId: 'missing-theme'
        });

        assert.equal(config.themeId, 'classic');
    });

    it('keeps registered presenter themes and exposes them as appearance choices', () => {
        class SmokePresenter {}

        PresenterRegistry.register({
            id: 'appearance-smoke',
            labelKey: 'PARLOR.Debug.PresenterSmoke',
            presenterApiVersion: PRESENTER_API_VERSION,
            surfaces: {
                'table:texasholdem': SmokePresenter
            }
        });

        const config = ParlorAppearance.sanitizeAppearanceConfig({
            themeId: 'appearance-smoke'
        });
        const choices = ParlorAppearance.getAppearanceChoices();

        assert.equal(config.themeId, 'appearance-smoke');
        assert.deepEqual(
            choices.themes.map(choice => [choice.id, choice.label]),
            [
                ['classic', 'PARLOR.Appearance.Options.Theme.Classic'],
                ['appearance-smoke', 'PARLOR.Debug.PresenterSmoke']
            ]
        );
    });
});

describe('ParlorAppearance table backdrop media', () => {
    it('keeps image and video backdrop paths and reports whether the media is video', () => {
        const imageConfig = ParlorAppearance.sanitizeAppearanceConfig({
            tableBackdropPath: 'worlds/campaign/parlor/table-backdrop.webp'
        });
        const videoConfig = ParlorAppearance.sanitizeAppearanceConfig({
            tableBackdropPath: 'worlds/campaign/parlor/table-backdrop.webm'
        });

        assert.equal(imageConfig.tableBackdropPath, 'worlds/campaign/parlor/table-backdrop.webp');
        assert.deepEqual(ParlorAppearance.getTableBackdrop(imageConfig), {
            path: 'worlds/campaign/parlor/table-backdrop.webp',
            isVideo: false
        });
        assert.equal(videoConfig.tableBackdropPath, 'worlds/campaign/parlor/table-backdrop.webm');
        assert.deepEqual(ParlorAppearance.getTableBackdrop(videoConfig), {
            path: 'worlds/campaign/parlor/table-backdrop.webm',
            isVideo: true
        });
    });

    it('drops unsafe or unsupported backdrop media paths', () => {
        assert.equal(ParlorAppearance.sanitizeMediaPath('javascript:alert(1)'), '');
        assert.equal(ParlorAppearance.sanitizeMediaPath('worlds/campaign/readme.txt'), '');
        assert.equal(ParlorAppearance.sanitizeMediaPath('worlds\\campaign\\parlor\\scene.mp4'), 'worlds/campaign/parlor/scene.mp4');
        assert.equal(ParlorAppearance.getTableBackdrop({ tableBackdropPath: '' }), null);
    });
});

describe('ParlorAppearance card sounds', () => {
    it('uses the namespaced AudioHelper without touching the deprecated global', () => {
        const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioHelper');
        const calls = [];
        let legacyAccessed = false;
        Object.defineProperty(globalThis, 'AudioHelper', {
            configurable: true,
            get() {
                legacyAccessed = true;
                throw new Error('legacy AudioHelper accessed');
            }
        });
        globalThis.foundry.audio = {
            AudioHelper: {
                play: (...args) => {
                    calls.push(args);
                    return Promise.resolve();
                }
            }
        };
        ParlorAppearance._lastSoundAt.placed = 0;

        try {
            ParlorAppearance.playCardSound('placed', {
                soundSetId: 'playing-cards',
                soundEnabled: true,
                soundVolume: 0.5
            });

            assert.equal(legacyAccessed, false);
            assert.equal(calls.length, 1);
            assert.equal(calls[0][0].volume, 0.5);
            assert.match(calls[0][0].src, /Card Placed\.wav$/u);
        } finally {
            if (previousDescriptor) {
                Object.defineProperty(globalThis, 'AudioHelper', previousDescriptor);
            } else {
                delete globalThis.AudioHelper;
            }
        }
    });
});
