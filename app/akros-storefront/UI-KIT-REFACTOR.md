# UI-kit refactor

The UI-kit refactor has six tasks. Each task may contain several commits. Preserve the
current appearance and behavior while moving supported appearance into UI-kit props and
tokens. Page composition and verified library limitations may retain local CSS/utilities.

| Task | Scope                                                                       | Status   |
| ---- | --------------------------------------------------------------------------- | -------- |
| 1    | Catalog categories/listings, variant filters and purchase tables            | Complete |
| 2    | Shared search/suggestions, navigation and footer                            | Complete |
| 3    | Cart and checkout appearance overrides                                      | Complete |
| 4    | Account, login, registration and shared form styling                        | Complete |
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

## Task 2 inventory

| Surface                              | Implementation                                                         | Result / retained exception                                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header utility links                 | `LinkButton`, `size="sm"`, `theme="borderless"`, `variant="secondary"` | Font weight/size, padding, radius and current/hover colors use scoped Button tokens. Underline and a leading utility referencing the existing text line-height remain because Button has no line-height/text-decoration token.         |
| Mobile information/account links     | The same `LinkButton` API, with `block`                                | Replaced native link appearance rules with scoped tokens. Keep left alignment and the grid of links as composition. The links retain their routes and current-page semantics and use kit focus feedback.                               |
| Search control                       | `SearchForm` and `SearchSuggestions`/`Combobox`                        | The joined control's full corner shape uses `--radius-combobox-md`, replacing the descendant radius utility. Keep the hidden redundant trigger: Combobox exposes no visibility prop.                                                   |
| Search popup and result content      | Existing grouped `SearchSuggestions`                                   | The popup has no max-height prop/token beyond measured available height. Keep the app's viewport cap and mobile positioner width; custom image/category/SKU/price content is result-slot composition.                                  |
| Catalog navigation                   | `VerticalNavigation`                                                   | Already uses kit size/spacing/typography tokens. Depth-specific open/current row tints stay local: Row and Link share the item background token, so changing it on Row would also recolor its child controls and alter state layering. |
| Footer containers                    | `Footer`, `layout="col"`                                               | Grid columns use the existing `--footer-cols` token at desktop/tablet/mobile widths instead of native grid/display overrides.                                                                                                          |
| Footer bottom, text and social links | `Footer.Bottom`, `Footer.Text`, `Footer.Link`                          | Removed duplicate flex alignment, paragraph margin and cursor overrides. Keep the original asset dimensions, row wrapping and section composition. Footer has no title/link line-height token, so those scoped declarations remain.    |

## Task 2 verification

- Before/after computed styles match in 22 shared UI states at twelve viewport widths,
  including open search suggestions and open/current/hovered mobile links. Navigation/footer
  geometry matches; popup geometry is checked after its discrete scale transition settles.
- `npm run test:shared-ui`: header/menu/search/footer token consumption, logo bounds,
  footer grid token isolation, Escape/focus restoration, selected category/product navigation,
  all-results links, mobile navigation close and internal footer links.
- `npm run test:catalog`, `npm run test:responsive`, `npm run test:theme`,
  `npm run test:account`, `npm run test:typography` and `npm run check`.

All checks passed: the shared UI test at twelve widths, the catalog interaction checks,
150 unit/component tests, the production build and the responsive/theme/account/typography
regression suites.

## Task 3 inventory

| Surface                                   | Implementation                                            | Result / retained exception                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named carts                               | `RadioGroup`, `Button`, `Dialog`, `FormInput`             | Name size uses `--text-radio-group-item-sm`; the add-cart button uses `block`. Removed the ignored group-gap override and inactive compact-name utility/token. Preserve the measured 25px names and the kit's 8px group gap at all checked widths. RadioGroup has no item-text weight/line-height token, so those utilities stay. |
| Delivery/payment methods                  | `RadioGroup`, `size="sm"`                                 | Columns use `--radio-group-item-grid`; the vertical stack uses its spacing token. Keep the kit's measured 6.08px desktop column gap and use `--spacing-radio-group-item-sm` for the existing 8px mobile gap below 640px. Per-edge separators, carrier logos, prices and disabled-row opacity remain composition.                  |
| Checkout steps                            | `Steps`, `size="md"`, `variant="subtle"`                  | Removed duplicate gap utilities: existing List/Trigger spacing tokens already supply 0px/8px. Mobile titles use `--text-steps-title-md` below 640px instead of a text-size utility. Keep placement, wrapping and numbered-indicator line height.                                                                                  |
| Cart quantities                           | `NumericInput`, `size="sm"`                               | Moved the compact font token assignment into the cart token file at the same 448px container boundary. Set it on the NumericInput root because the quantity width uses its inherited font's `ch` unit. Keep separate input border/radius and trigger surface utilities: the kit hardcodes the conflicting slot styles.            |
| Cart services                             | `FormCheckbox` and native `progress`                      | Removed the duplicate checkbox border-width utility; the control already consumes that token. The kit has no Progress component; preserve native progress semantics and its browser-specific rendering. Rich service-label content remains composition.                                                                           |
| Summary, address, review and confirmation | Existing form controls, `DataTable`, `LinkButton`, `Icon` | Existing scoped component tokens already own the supported control appearance. Keep panel/content composition, app price/address typography and table responsive placement. No generic kit surface or complete row-card API replaces these semantics.                                                                             |
| Mini-cart                                 | Existing `Popover`, `LinkButton`, `Badge`                 | Previously tokenized; retain the documented popup shadow and viewport-height API exceptions.                                                                                                                                                                                                                                      |

This task removes 19 utility occurrences from component markup and one inactive app token.
It preserves cart calculations, minimum/package quantities, carrier/payment rules, address
validation, persistence and order completion.

## Task 3 verification

- Before/after geometry and computed styles match across all four checkout routes at twelve
  widths from 320 to 1920px: 48 layouts and 10,110 rendered elements. Address captures include
  the expanded billing form; shipping/payment captures include checked and disabled options.
- Extended `npm run test:theme` probes the actual RadioGroup stack/grid/text, Steps spacing
  and mobile title size, and compact NumericInput text tokens, including 639/640px edges.
- Full click-through at 1920, 1024 and 390px: named payment availability after delivery changes,
  required-payment validation, billing edit, order confirmation and cart clearing.
- Responsive, catalog, shared UI, account and actual-font browser suites passed. The production
  build passed on retry after the first Windows build worker exited during static generation.
  The subsequent full `npm run check` passed formatting, lint, type checking, all 150 tests
  and the production build.

Observed library limitation for task 6: after selecting store-card payment and changing from
personal pickup to DPD, the draft clears the payment and the visible radio becomes unchecked,
but its disabled hidden native input retains `checked`. The installed Zag radio machine's
`syncInputElements` excludes disabled inputs. This is existing library behavior; method handlers
are unchanged by this refactor. The checkout blocks progression until a valid payment is chosen.
Record it for the final UI-kit/accessibility audit rather than changing purchase behavior here.

## Task 4 inventory

| Surface                                            | Implementation                                                                | Result / retained exception                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile section headings                           | `Accordion`, `variant="borderless"`, `size="sm"`                              | Trigger gap uses the Button `--spacing-button-md` token consumed internally by Accordion.Header. Keep the heading line-height utility, custom disclosure rotation and mobile touch target: Accordion exposes no corresponding tokens/props.                                                                                      |
| Profile checkboxes                                 | `FormCheckbox`, `size="sm"`                                                   | Removed descendant border-width utilities. Controls already consume `--border-width-checkbox`; a scoped `--border-width-validation` mapping preserves the existing 2px error border rather than the kit's 3px validation default. Keep the newsletter's custom circle indicator because FormCheckbox has no indicator-icon prop. |
| Profile and account heading actions                | `Button`, `LinkButton`, `size="sm"`                                           | Profile buttons use `block`; heading actions use `--height-form-control-sm: auto` with their existing minimum-height/wrapping composition. Keep explicit line height because Button has no component line-height token.                                                                                                          |
| Login/registration links                           | `LinkButton`, `theme="borderless"`, `variant="secondary"`, `size="current"`   | Weight and color use Button tokens; hover/active backgrounds stay transparent. Keep inline text composition and native underline offset. `AuthPageLink` provides the client boundary required by LinkButton's handlers inside the two server-rendered auth pages. The recovery anchor retains native hash navigation.            |
| Login/registration panels                          | Native semantic content around existing `FormInput`, `FormCheckbox`, `Button` | Removed the duplicate paragraph/heading margin reset. Mapped 19 literal spacing/radius/weight values to existing kit variables. Keep the exact 26/14/13px content typography, panel geometry/shadow and divider composition: kit 0.56.1 has no general heading, card/surface or divider component.                               |
| Phone/country controls                             | Existing `PhoneInput`, `Select`                                               | Already tokenized. Keep the phone input border and full trigger radius utilities: PhoneInput hardcodes a borderless input and a joined trigger corner. Keep the hidden redundant select glyph and custom account glyph; Select exposes no replacement-indicator prop.                                                            |
| Account navigation, orders and other account pages | Existing `LinkButton`, `DataTable`, `Table`, `ProductCard`                    | Current navigation/field/table tokens remain appropriate. Per-edge current-tab border, disabled opacity, app content panels, table/card placement, local status text and responsive wrapping remain composition or verified API gaps.                                                                                            |

This task removes six utility occurrences and three native CSS declarations, replaces three
native/Next auth links with the shared component, and reuses existing tokens for 19 literal
values. Authentication remains a local prototype; no credentials are persisted or sent to a
backend, and existing profile validation/persistence behavior is unchanged.

## Task 4 verification

- Before/after comparison: nine routes, eleven UI states at thirteen widths (143 layouts,
  12,765 rendered elements), including profile email errors and collapsed sections. Geometry
  and effective visual styles match. Comparison normalizes equivalent transparent colors and
  ignores flex gap/alignment properties on links that use inline/block text layout.
- Visually reviewed login, registration and profile screenshots at desktop/mobile widths.
- `npm run test:auth`: 26 layout/token checks at thirteen widths, required/email/consent
  validation, keyboard links, recovery focus, demo login/registration and credential isolation
  at 1920, 1024 and 390px.
- Extended `npm run test:theme`: account heading gap/action height and checkbox border tokens
  in both normal and invalid states.
- `npm run check` passed formatting, lint, type checking, all 150 tests and the production build.
  Auth, theme, account, responsive, catalog, shared UI and actual-font browser suites all passed.
