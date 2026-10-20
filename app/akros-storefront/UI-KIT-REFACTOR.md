# UI-kit refactor

The remaining refactor has six tasks. Each task may contain several commits. Preserve the
current appearance and behavior while moving supported appearance into UI-kit props and
tokens. Page composition and verified library limitations may retain local CSS/utilities.

| Task | Scope                                                                       | Status   |
| ---- | --------------------------------------------------------------------------- | -------- |
| 1    | Catalog categories/listings, variant filters and purchase tables            | Complete |
| 2    | Shared search/suggestions, navigation and footer                            | Pending  |
| 3    | Cart and checkout appearance overrides                                      | Pending  |
| 4    | Account, login, registration and shared form styling                        | Pending  |
| 5    | FAQ, blog, news, contacts and delivery information                          | Pending  |
| 6    | Final token consolidation, exception audit and responsive regression checks | Pending  |

## Task 1 inventory

| Surface                    | Implementation                                | Result / retained exception                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product listings           | `ProductCard`, `Badge`, `LinkButton`          | Removed the native card background override and redundant image height/direct-child image selector; the existing component tokens own appearance. Grid columns, image fitting and stock-row wrapping remain composition.                               |
| Category tiles             | `NextLink` and Next `Image`                   | Intentional app composition: UI kit 0.56.1 has no category-card component. Preserve tile images, dimensions and headings; do not substitute a product card with unrelated purchase slots.                                                              |
| Category/search pagination | `Pagination`, `size="sm"`, `variant="filled"` | Already uses UI-kit props/tokens. Retain wrapping/alignment composition and URL-based pagination, including the search query.                                                                                                                          |
| Variant table              | `DataTable`, `size="sm"`, `variant="line"`    | Moved component token declarations from globals to `_akros-data-table.css`. Header text size uses `--text-table-sm`; cells use existing Table padding tokens.                                                                                          |
| Compact variant modes      | Named `akros-variants` container              | Moved five inline token assignments into the component token file. The 1000px CSS container boundary matches `--container-akros-variant-table`. Preserve the existing three-group intermediate list and mobile cards.                                  |
| Variant quantities         | `NumericInput`, `size="sm"`                   | Input padding uses Input/NumericInput tokens; removed redundant input height and trigger alignment declarations. Center alignment, trigger height and the quantity grid remain slot composition. NumericInput has no text-alignment/line-height token. |
| Purchase buttons           | `Button`, `block`, `size="sm"`                | Width uses `block`; compact padding/height use scoped Button tokens. Minimum touch size, wrapping and the nested unit/package caption remain local composition; Button has no line-height or nested caption API.                                       |
| Filter submit              | `Button`, `size="sm"`                         | Weight uses `--font-weight-button` instead of an inline utility.                                                                                                                                                                                       |
| Range filters              | `Slider` and `NumericInput`                   | Existing values already use kit tokens. Slider renders its Label with `size="current"` and has no label slot/size/line-height API; the scoped label utilities remain necessary.                                                                        |
| Material filters           | `FormCheckbox`, `size="sm"`                   | Size, colors and radius already use kit tokens. The custom checked glyph remains a slot utility because FormCheckbox has no indicator-icon prop.                                                                                                       |

Table row/cell corner radii, per-edge separators, cell surfaces and the mobile placement rules
remain app CSS/utilities: the current Table tokens do not cover that complete row/card shape.
Raw product text, stock labels, prices and unit captions are app content inside the shared table.
This task does not change filter algorithms, catalog data, ordering rules or layout widths.

## Task 1 verification

- Before/after computed styles and geometry: seven routes at eleven widths (77 layouts),
  including four variant products, visual category tiles, a product category and search results.
- `npm run test:catalog`: token consumption, minimum/package purchases, variant pagination,
  material empty/recovery states, keyboard slider changes and category/search pagination at
  1920, 1024 and 390px.
- `npm run test:responsive`: homepage, four variant tables across 22 widths, cart and checkout.
- `npm run test:theme`, `npm run test:account`, `npm run test:typography` and `npm run check`.

All checks passed: 150 unit/component tests and the production build; 77 before/after layouts
matched; the catalog interaction/token checks passed at all three widths. The responsive suite
also passed all 88 variant-table checks at 22 widths, and account, checkout and typography
regression checks passed.
