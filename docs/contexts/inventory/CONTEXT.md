# Inventory

Inventory defines canonical stock meaning, stock demand, Inventory-recognized stock obligations, and their authority boundaries. Detailed behavior and acceptance live in GitHub issues; durable trade-offs live in accepted ADRs.

## Stock model

**Stock Item** — Durable Inventory Resource representing exactly one immutable exact Catalog Selection meaning with one explicit stock Unit. A materially different exact Selection meaning uses a different Stock Item; relation correction never redefines an existing Item.
_Avoid_: Product, SKU, one Stock Item shared by materially different exact Catalog Selections, or redefining a Stock Item through relation correction.

**Stock Location** — Durable Inventory Resource identifying one explicit operational stock scope in which stock facts are interpreted.
_Avoid_: Storefront, postal address, pickup point, hostname, or legacy `store` label as identity.

**Stock Position** — Durable Inventory Resource with its own stable identity, representing one constrained quantity scope for one Stock Item in one exact Stock Location. `(Customer Configuration, Stock Item, Stock Location)` is the Launch Current-uniqueness constraint, not the Position identity.
_Avoid_: composite Item + Location used as Resource identity, Product-level stock bucket, or duplicate Current Positions for one Item + Location constraint.

**ON_HAND** — Authoritative physical Quantity for one exact Stock Position according to its declared System of Record. It is not customer-facing Availability.

**RESERVED** — Derived Quantity from Current successful provisional Inventory Reservation Allocations on one exact Stock Position. It is not independently writable, a committed obligation, or failed/indeterminate create-effect debt.

**Stock Evidence UNKNOWN** — Stock Evidence state where the expected owner and scope are known but a Current numeric value cannot be established.

**Stock Evidence MISSING** — Stock Evidence state where no usable evidence exists for an expected fact and scope.

**Stock Evidence STALE** — Stock Evidence state where prior evidence exists but no longer qualifies as Current under its owner contract.

**Stock Evidence INDETERMINATE** — Stock Evidence state where relevant evidence exists but Current truth cannot be safely resolved.
_Avoid_: treating `MISSING` or `INDETERMINATE` as one global Inventory status independent of the owning outcome type.

**Stock Receipt** — Authoritative physical increase of one exact Stock Position for an explicit business reason.

**Stock Issue** — Authoritative physical decrease of one exact Stock Position for an explicit business reason.

**Stock Correction** — High-risk Inventory Action establishing corrected absolute ON_HAND for one exact Stock Position under the selected Inventory Backend's applicable authority contract.
_Avoid_: generic inventory update, local override of the selected System of Record, or backend switching.

## Stock demand and relations

**Catalog-to-Stock Binding** — Inventory-owned Current one-to-one relation between one exact Catalog Selection meaning and one compatible Stock Item carrying that same intrinsic meaning. Relation correction changes the relation, never either Stock Item's intrinsic meaning.
_Avoid_: inference from Product, SKU, Package contents, Set components, source identifiers, availability, or redefining a Stock Item to repair a wrong relation.

**Stock Requirement** — Exact Inventory demand for one Commerce-owned `Purchase Demand Occurrence`, preserving that stable occurrence identity, its exact Catalog Selection provenance, one Stock Item, and unchanged requested Quantity + Unit. Distinct occurrences remain distinct Requirements even when their values and Stock Item are equal.

**Stock Allocation** — Assignment of all or part of one Stock Requirement Quantity to one Stock Position for the same Stock Item and Unit. One Requirement may use 1..N Allocations whose quantities cover that unchanged Requirement.
_Avoid_: substitution, remapping, or Unit conversion.

**External Stock Correlation** — Inventory specialization of the shared OntOS `Connector Registry` correlation concept, mapping one issuer/backend-origin + namespace/scope + identifier-kind + external-value key to one Stock Item or Stock Location for the relevant Effective Period. Inventory owns the stock-specific target and lifecycle semantics; this is not a second generic external-ID mapping framework.
_Avoid_: similarity-based SKU/name/address matching, an external identifier treated as Inventory identity, or resolving delayed evidence through a replacement backend merely because that backend is Current.

**Stock Sharing Eligibility** — Inventory-owned positive Current relation between one exact Stock Position and required Selling Legal Entity + Channel, optionally restricted by Commerce Market and/or Storefront. It is distinct from Principal Permission, Assortment, Availability, and Reservation guarantee.
_Avoid_: a durable Sales Context Resource, customer-specific stock selectors, or an ALLOW/DENY specificity resolver.

## Reservations and obligations

**Inventory Backend** — Exactly one configured stock/reservation backend selected for the whole Customer Configuration in Launch: either a customer-provided External Business System or the OntOS-provided WMS.
_Avoid_: per-Location backend selection, simultaneous authoritative backends, automatic fallback, or Integration Route as authority.

**Reservation Authority** — The selected Inventory Backend in its role as the owner capable of enforcing the exact Inventory Reservation and issuing authoritative Reservation evidence.
_Avoid_: Availability, Order Commitment Gate, Integration Route, provider adapter, or an unselected backend as issuer.

**Inventory Reservation** — Durable Inventory Resource for one exact Order Commitment Attempt representing its complete provisional stock obligation across required Stock Requirements and Stock Allocations. Its identity is the Inventory-recognized obligation identity for that runtime Attempt.

**Reservation Confirmation** — The single Attempt-bound proof identity issued by the Reservation Authority that one exact Inventory Reservation is guaranteed within its declared validity interval. In Launch, that Confirmation identity is not renewed or replaced after pre-Protection expiry or definitive revocation.

**Reservation Release** — Explicit owner-governed transition ending the whole provisional Inventory Reservation after release safety is proven.
_Avoid_: Confirmation expiry, `AT_RISK`, or `REVOKED` treated as Release.

**Unresolved Reservation Effect Constraint** — Inventory evidence meaning that a failed or indeterminate Reservation create effect is known or possible to keep stock constrained although no successful Inventory Reservation exists. It retains exact owner-proven scope/Quantity when known, otherwise typed effect uncertainty and original Attempt/effect provenance.
_Avoid_: folding this debt into `RESERVED`, treating no successful Reservation as reusable stock, or fabricating an exact deduction from uncertainty.

**Provisional Shortage Priority** — Stable authoritative-issuance rank used among competing unprotected provisional Reservation Confirmations after a material shortage in one constrained scope. Proof health and priority rank are distinct meanings; leaving the priority pool is not Reservation Release.
_Avoid_: physical picking order, best-fit, Selling Legal Entity/Purchasing Subject priority, Current-health sorting, or technical arrival order.

**Commitment Protection** — The single Attempt-bound owner guarantee fencing the exact Inventory Reservation through Order commitment. It is established by the Reservation Authority while the Reservation Confirmation is valid and remains distinct from that Confirmation.

**COMMITTED_OBLIGATION** — Post-commit lifecycle meaning of the same underlying stock-obligation identity previously represented by the successful Inventory Reservation, now bound to the Accepted Order.
_Avoid_: a second parallel obligation created by commit.

**AT_RISK** — Guarantee-health meaning where an Inventory obligation still exists but its promised guarantee cannot currently be owner-verifiably honored.
_Avoid_: release, cancellation, or proof of non-commit.

**REVOKED** — Pre-Protection Reservation Confirmation state where the Reservation Authority explicitly terminates that exact Confirmation guarantee. Revocation is not Reservation Release.

**EXPIRED** — Reservation Confirmation state reached when its declared validity interval ends. Expiry is not Reservation Release and does not erase established Commitment Protection.

**UNVERIFIABLE** — Proof-health state where Current owner evidence is insufficient to establish the guarantee state.
_Avoid_: implicit revocation or release.

**Imported Committed Obligation** — Migration-origin Inventory obligation bound directly to an already-proven imported Order with explicit source lineage, starting in committed meaning without fabricating a historical OntOS Order Commitment Attempt.

## External stock evidence

**Inventory Source Assertion** — Provenance-backed stock claim retaining actual issuer/backend origin, exact correlated scope, fact meaning, Quantity + Unit, business time, and owner-defined ordering evidence. Transport arrival is not business Currentness or authority.

**Source Coverage Evidence** — Owner-verifiable evidence establishing whether an absolute ON_HAND assertion includes, excludes, or predates a separately known authoritative Stock Receipt or Stock Issue.
_Avoid_: message arrival order as coverage evidence or guessed/double-applied arithmetic.
