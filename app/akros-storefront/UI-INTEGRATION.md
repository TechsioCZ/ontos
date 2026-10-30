# AKROS UI integration

> Latest visual follow-up: [point-by-point parity with feat/akros](VISUAL-PARITY-2026-10-27.md).
> It compares the original Google Docs screenshots, records restored UI and
> separates visual checks from the remaining native integration limitations.

> Current follow-up: [UI review, 2026-10-27](UI-REVIEW-2026-10-27.md).
> It records visual repairs, current GitHub/Google Docs coverage, a failing
> decimal-filter unit test and a post-restart customer-access failure. The older
> successful native QA below must not be read as proof these current gates pass.

Base: `demo/sales-crm` at `ad7895521`. UI reference: `feat/akros` at `f1b74b02a`.
Work stays local on `demo/sales-crm-updated`; no push or deployment is authorized.
The intended PR base is **`demo/sales-crm`**. This is a selective port, not a merge
of prototype data/auth implementations.

The integration branch was fast-forwarded from `fd6788a4f` to `ad7895521` after
five new upstream commits appeared. Their checkout recovery, task assignment and
native customer-fixture fixes were kept unchanged; no tracked UI edits overlapped.
The current-base storefront suite passes **498 tests across 69 files**, and its
production build, including TypeScript, completed successfully.

## Boundary

Preserve OntOS catalog projections, prices and quantity tiers, availability rules,
customer authentication, profile and consent writes, real order history, checkout
validation, exact uncertain-request retry and captured-cart completion. Preserve
the pnpm workspace, its UI-kit version and release configuration. Do not copy
prototype account/order/catalog fixtures or replace real calls with local storage.
Browser-local presentation preferences must not claim a backend operation occurred.

## Implementation slices

- [x] Shared tokens, controls, account/content presentation and responsive layout.
- [x] Product cards, category copy and variants: compact purchases, complete list,
      live dimension filters, readable SKUs, concrete-item prices and variant details.
- [x] Product actions and preferences: reuse the approved UI with native data;
      retain real inquiry submission and expose only capabilities the owner supports.
- [x] Account and cart presentation: real profile/consent/order data, current-price
      reorder when supported. Weight stays unavailable without an exact native
      sale-unit weight contract; no cart-weight total is claimed.
- [x] Smart Address transport and checkout controls, retaining order/auth semantics.
- [x] Component/unit/build checks, responsive browser checks and final scope review.
- [x] Live native storefront verification: signup, profile, two orders, owner re-reads,
      reorder, inquiries and logout. See [QA-REPORT.md](QA-REPORT.md) for exact coverage
      and remaining build/contract gates; this is not an unconditional merge approval.

## Known contract limits to respect

The current profile contract edits display name, phone and contact email; it has
no account address or password mutation. Inquiry supports product questions but no
automatic stock-alert registration. Product variants currently lack a normalized
weight-per-sale-unit field. These gaps must not be filled with fabricated data or
simulated successful persistence as part of a UI integration.

## Verification

Use the workspace-pinned tools via `mise exec -- pnpm --filter akros-storefront`.
Keep existing native-route, tier, stock, order and retry regressions. Browser test
fixtures belong only in tests. Record available runtime access and any remaining
live verification limits separately from component or isolated browser evidence.

### Implementation choices

- Real catalog data remains in the existing bounded OntOS projections. Variant
  detail loads its full record on demand; the page does not send the full variant
  array twice. Price, stock, package constraints and cumulative quantity tiers
  still pass through `CartProvider.addItem` and the existing owner quote.
- Favorites are variant references stored in the browser, explicitly described
  as such. Their display data comes from an uncached public catalog read. Shared
  links retain selected variant IDs. Questions go to the real inquiry form with
  a validated variant description; print uses the browser's print workflow.
- Reorder first reads the authenticated customer's exact historical order and
  prepares current offers. It skips deleted/unavailable variants, applies current
  package/stock constraints, then uses the existing cart validation for each add.
  It does not place an order or reuse historical prices.
- Profile/contact and consent forms retain their existing owner writes and
  acknowledgement/version checks. No prototype addresses, credentials, order
  history, or fake stock-alert persistence were imported.
- Smart Address uses the same-origin `/api/address-suggestions` proxy, a fixed
  upstream, no forwarded customer headers, and bounded timeouts. Missing weights
  remain unknown because the native variant contract supplies no sale-unit weight.

### Evidence (2026-10-26)

- Production `build` passed, including Next's TypeScript phase. `typecheck` and
  `lint` were also run separately; lint retains existing upstream warnings.
- **476 tests passed across 69 files.** Full regression results and browser evidence are under ignored
  `test-results/ui-integration/`. New tests cover authenticated reorder, exact
  variants, changed prices, partial availability, package rules, and standalone
  product sharing/inquiries. Reorder also stops if the active cart changes while
  preparing items or if an owner quote is refused. The Combobox key-warning regression passes.
- Isolated Chromium checks: eight screens at 13 widths (320, 360, 390, 640, 760,
  761, 768, 1024, 1100, 1101, 1280, 1440, 1920): **104 layouts**, no page/table
  overflow, no invisible or overlapping table text/controls. Includes the
  47-variant product and the largest fixture group, cards, profile, orders,
  addresses, favorites and cart. Screenshots were inspected.
- Additional browser flows passed: searchable variant chooser and variant detail
  at 390/768/1920, selecting an address fills city/postcode, profile submits only
  native contact/version fields, and reorder calls the existing cart validator.
  These use test-only fixtures and intercepted requests, not a live backend.
- The production address endpoint was exercised directly: the Tábor query
  returned 11 suggestions. Bakalovo queries returned no suggestions or a provider
  failure; the UI retains manual entry and retry. Provider coverage is not changed
  by this integration.
- An earlier full `check` stopped at formatting drift in untouched files. The
  latest run stops in the repository lint-rule tests: a Windows ESM path failure
  in the native sorting test and repository-policy diagnostics. Four diagnostics
  in the transferred frontend were fixed; its 476 tests, TypeScript check and lint
  pass again, and the six files changed during local setup pass repository policy.
  A subsequent whole-repository policy run reports only three unchanged findings
  in property-portfolio and finance-billing. These and the Windows sorting-test
  failure remain blocking; no rule was disabled. Next also retains the base
  branch's `staleTimes.static: 0` configuration warning.

### Local native runtime and remaining gates (2026-10-26)

The local storefront URL is `http://localhost:3070`; Shell's URL is
`http://localhost:3020`, and the native development composition uses port 3041.
After the user closed Chrome, the APIs could run stably under the unchanged
resource watchdog and the native QA pass was completed. Earlier stop events
below are historical diagnostics. Current runtime PIDs are in the ignored
`test-results/local-runtime/qa-runtime-pids.json`.
The isolated Docker project is `ontos-akros-local`, retaining volume
`ontos_akros_local_postgres_data`. PostgreSQL, TLS-verified SpiceDB and the two
local Mailpit captures (8025/8026) are healthy. No database reset or volume removal
was used to recover startup. Runtime credentials remain in ignored local
configuration; no `.env` file was inspected by the agent.

Shell, Party Registry, Privacy, Work Tasks and Merchandise completed their full
native Node builds (each exit 0). They run with `modern serve`; only Commerce runs
with the standard `modern dev`. This avoids six simultaneous development watchers.
The local launchers cap production Node heaps at 384 MiB and Commerce at 512 MiB.
Native worker delivery is running with a 384 MiB heap. No compiler diagnostic,
authorization rule, declaration check or lint enforcement was disabled.

The first native Commerce build exposed missing workspace declarations (TS6305)
and cascading errors. Preparing all its project references through the repository
TypeScript wrapper passed (exit 0), without owner source changes. The subsequent
Commerce production declaration build and separate project typecheck did not
complete: a resource watchdog stopped them. They are not passing checks.
Measured logs show the declaration compiler using about 5 GiB physical RAM; at
the watchdog stop, 1017 MiB physical RAM and about 14.9 GiB commit headroom remained.
This was a deliberate physical-reserve stop, not a reported Windows out-of-memory
failure. The earlier estimate of 6 GiB free being sufficient was not established.
The watchdog now records physical/commit headroom and compiler memory separately;
a short-lived shell can otherwise disappear from a process ancestry snapshot.
It retains a 1 GiB physical reserve and an increased 8 GiB commit reserve.
Automatic approval review rejected lowering the physical reserve to 256 MiB;
that setting was reverted and was never installed into a running watchdog.

At 16:28 UTC the runtime watchdog stopped the APIs at 400 MiB free physical RAM.
A further startup attempt at 17:58 UTC started with about 2.8 GiB free physical
RAM but was stopped at the unchanged 8 GiB commit reserve (1397 MiB physical,
8097 MiB commit headroom remaining). No checkout submission was attempted during
this retry. Order creation, persistence and customer history are still unverified;
cart quote success and seeded orders must not be counted as order-write evidence.

Docker had independently failed to create its WSL VM with
`Wsl/Service/CreateInstance/CreateVm/HCS/ERROR_NO_SYSTEM_RESOURCES`.
After verifying all WSL distributions were stopped, a normal WSL shutdown and
Docker Desktop stop/start restored the engine. User applications and database
volumes were not closed or removed.

The native composition publisher promoted five owners, revision
`c65e597b62b3ec4c3716f14e7f0cf04286fe0f176ae5f59cecb8f19a3df71824`.
All six native public contracts returned HTTP 200. Native demo permissions
installed 12 accounts and 3175 relationships over 156 Actions, configured the demo
companies through the audited Core Action, and issued/verified the managed
storefront keys. The earlier HTTP 503 did not recur with the complete launcher
environment and signing identity. Native AKROS bootstrap created 1289 groups,
19025 variants, 2125 categories and six native demo orders. Its Windows CLI has a
file-URL pathname defect; the ignored local launcher calls the existing exported
`seedAkros` bootstrap with the already loaded environment, preserving its merge
semantics and leaving owner source unchanged.

Native Commerce portal service/workload bootstrap also passed. A synthetic local
customer registered through the actual storefront form (`ENROLLMENT_STARTED`),
received its real verification email in the local test Mailpit, and signed in
(`SESSION_CREATED`). Registration reached `COMPLETE`; native Outbox delivery was
then necessary to establish `ADMITTED`. The actual customer page opened only after
that admission. A contact-phone update through the UI returned HTTP 200 and was
confirmed by an owner re-read after reloading the page. No direct database
verification flag, fabricated session or frontend account mock was used.

The local storefront launcher now binds to `localhost`, matching its auth origin.
The previous `127.0.0.1` bind combined with a `localhost` browser URL made the
existing same-origin guard reject POSTs with HTTP 403. The guard itself is unchanged.
The live `native-smoke.mjs` probe passed at 1920, 1024 and 390 px: all 47 variants,
real owner-confirmed pricing/stock, a 200-unit cart addition and cart layout;
no page errors or horizontal table/cart overflow. Native rejection of a second
200-unit package above the 360-unit stock was also observed. The older catalog
browser test assumes the prototype's 20-unit minimum and is not a valid expected
quantity for the current owner's whole-package policy. Screenshots and probe logs
are ignored under `test-results/local-runtime/`; these probes do not intercept or
mock HTTP responses.

Remaining review gates:

- Commerce production declaration build and project typecheck still need a complete
  result; successful development startup is not substitute build evidence.
- The full workspace gate still has the separately recorded baseline Windows
  lint-rule test and unchanged repository-policy failures.
- Native marketing purpose/notice configuration is not prepared locally; the
  account correctly reports consent state unavailable instead of fabricating it.
- The generated full worker host logs descriptor errors for Finance, Inventory
  and Price Group Catalog, which are absent from this five-owner composition.
  Core/Commerce admission delivery worked; do not describe the whole host as clean.
- Native order placement, owner re-reads, history/detail/status, reorder, profile,
  inquiry persistence and logout were subsequently verified. There are 263 live
  layout measurements, including 56 authenticated layouts and 88 variant-table
  checks. Earlier 104 fixture layouts are not counted as native evidence.
- On mobile, review the final checkout-step label wrapping; a 390 px cart screenshot
  shows an orphan final letter in the summary label. No unrelated CSS fix was bundled.

Windows module-contract generator repairs remain scoped to LF/CRLF header
acceptance and invoking the JavaScript esbuild CLI through Node on Windows only.
All 13 generator tests passed, including an invalid-marker control. Native owner
manifests, registrations, business logic and the protected cart/checkout providers
still have zero semantic diff against the target branch. Nothing is staged,
committed, pushed or deployed for this integration.

### Final native QA

[QA-REPORT.md](QA-REPORT.md) records two actual storefront orders
`OBJ-2026-0007` / `OBJ-2026-0008`, their native re-reads and current-stock reorder,
two support tasks confirmed by the owning Work Tasks read, and 263 live layout
checks. The final storefront production build and 14 targeted regressions passed
after restoring the print sheet and fixing narrow order-card text wrapping.
Backend, cart/checkout provider and checkout-layout semantics remain unchanged.
Remaining findings include upstream Smart Suggest relevance, missing native
capabilities/configuration and the existing full-workspace/Commerce build gates.

For reproducible isolated UI review, from `app/`:

```sh
mise exec -- pnpm --filter akros-storefront exec node tests/browser/ui-integration-preview.mjs
# Separate terminal:
mise exec -- pnpm --filter akros-storefront exec node tests/browser/ui-integration.mjs
```

The preview runs at `http://127.0.0.1:3097/?view=variants`; views also include
`large`, `cards`, `profile`, `orders`, `address`, `favorites`, and `cart`.
Its generated application lives only in ignored test output, and is never used
by the real storefront build or deployment. Transport fixtures are installed by
the automated browser script; starting the preview alone provides visual screens,
not a working substitute for the backend. The live native probe evidence and its
remaining limitations are recorded above. Existing browser scripts must use the
current owner's quantity/stock rules rather than prototype fixture expectations.

### Workspace exception

The user approved LF normalization of existing pnpm patches and the same static
React-children correction in the existing UI-kit 0.57.0 patch. Only its patch hash
changes in the lockfile (20 references); dependency versions and workspace release
configuration are unchanged. The original `feat/akros` branch remains untouched.
