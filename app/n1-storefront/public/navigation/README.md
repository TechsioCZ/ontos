# N1 navigation artwork

These 50 original illustrations come from historical N1
`herbatika-shop/apps/n1/src/assets/header/`, selected by its
`src/data/header/index.ts` for all eight root submenus. The Pánské set matches the image slots
in N1 Storefront Figma `418:2371`, `418:2376`, `418:2381`, `418:2386`, `418:2391`
(panel `418:2368`, full state `59:1743`). Files are copied without alterations.

`navigation-artwork.ts` associates only audited imported legacy category IDs
with these static brand illustrations. Category names, hierarchy, visibility
and navigation destinations come from the native catalog. No illustration
creates a category or substitutes product/stock data. Unmapped categories
remain real text links; no replacement photo is inferred.

Original dimensions vary from 19×100 to 200×100. NextImage's supported `fill`
adapter and the Image atom's `objectFit="contain"` keep every original inside
a relative 96×96 layout slot without distortion or overflow. Source files
are never cropped, enlarged or otherwise modified on disk.

The historical header supplies 43 direct mappings (including category3, whose
old handle was `obleceni`, now `panske-obleceni`). Seven more audited IDs use
the exact corresponding historical artwork despite differences in old handle
normalization: 405 Boty/Tretry, 724 Zapletená kola, 398 Tašky/Batohy, 863
Nářadí/Údržba, 868 Přeprava/Uskladnění, 871 Výživa/Nápoje and 461 Skateboarding.
These are explicit static mappings, not runtime name/slug guessing. Thirteen
original demo categories have no corresponding illustration and remain text
links in the unchanged native hierarchy.
