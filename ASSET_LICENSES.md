# Asset Licenses and Attribution

This document covers third-party art, texture, and card assets included in this module.
It is provided for attribution and distribution clarity.
It does not replace the original license terms supplied by the asset authors or marketplaces.

## ambientCG Materials

The texture assets under `assets/materials` were downloaded from [ambientCG](https://ambientcg.com/).
ambientCG assets are published under the Creative Commons CC0 1.0 Universal License.
Attribution is not required under CC0, but the following credit lines are included for clarity:

- Created using Fabric037 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Fabric040 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Metal041A from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Metal048A from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Metal048C from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Metal057C from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Wood013 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.
- Created using Wood070 from ambientCG.com, licensed under the Creative Commons CC0 1.0 Universal License.

These materials are stored in:

- `assets/materials/felt`
- `assets/materials/metal`
- `assets/materials/wood`

Archived source downloads are retained in:

- `assets/materials/archives`

## Playing Card Assets

The playing card assets under `assets/cards` were purchased from:

- [Royal Graphics Resources on itch.io](https://royalgraphicsresources.itch.io/playing-cards)

These card assets are used in this project under the license granted with the original purchase.
This includes the packaged card faces, card backs, vector files, and bundled sound files found in `assets/cards`.

Asset package reference:

- `Playing Cards`

## Fonts

The fonts under `assets/fonts` are licensed under the SIL Open Font License 1.1 (OFL),
which permits bundling and redistribution as part of a larger work (the fonts may not be
sold on their own). Each family ships its original `OFL.txt` alongside it:

- Cinzel Decorative — `assets/fonts/Cinzel_Decorative/OFL.txt`
- Cormorant SC — `assets/fonts/Cormorant_SC/OFL.txt`
- Forum — `assets/fonts/Forum/OFL.txt`
- Marcellus — `assets/fonts/Marcellus/OFL.txt`

## Slot Machine Symbols (removed third-party art)

The slot machine originally used a purchased fruit-symbol pack (Ynumazen, itch.io). Because
that pack's redistribution terms were unclear and Foundry ships assets as plain, extractable
files, the symbols were re-authored as programmatic SVG in
`scripts/games/slotmachine/SlotSymbols.js`, and the third-party pack (`assets/fruitAssets`)
was removed. No third-party slot art ships with this module.

## Beetle Derby Sound Effects

The sound effects under `assets/beetlerace/sfx` were produced for this module by
`tools/beetle-sfx/` (recipes in `recipes.js`, rendered offline). Each sound is either
synthesized from scratch (noise and oscillators) or built from these CC0 1.0 instrument samples
(horn, concertina, glockenspiel, clarinet, harp, bass, whistle, bodhrán, rim):

- VCSL — Versilian Community Sample Library, CC0 1.0 — https://github.com/sgossner/VCSL
- VSCO 2: Community Edition, CC0 1.0 — https://github.com/sgossner/VSCO-2-CE
- FreePats Button Accordion HN, CC0 1.0 — https://freepats.zenvoid.org/

The prepared sample set and its full per-file credits live in the Taverns & Music module
(`assets/samples/CREDITS.md`). No third-party sound files ship with the Beetle Derby.

## Distribution Note

If this module is redistributed, the original source credits above should remain with the project.
If the original seller later provides an updated or more specific license file, that original file should be added alongside this document and treated as the authoritative source for that asset pack.
