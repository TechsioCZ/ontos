# Core Reference contract

## Purpose and ownership

Core Reference is the shared contract by which Text Mentions and Relations point to Business Entities owned by registered microverticals. Core owns the reference envelope, provider registry, and federated discovery boundary. Each target microvertical owns its entities, discoverability responses, active resolution, and authorization to open.

## Eligible targets and identity

- Any Business Entity exposed by any registered microvertical in any tenant is eligible for a Mention or Relation. Eligibility is not limited to people, Tasks, the current microvertical, or the current tenant.
- A committed reference retains a globally opaque Core Reference token, owning microvertical key, target tenant, entity type, stable entity identity, reference kind (`mention` or `relation`), and last successfully resolved display label.
- The opaque token or a Core-recognized deep link is required for insertion outside discovery. A caller-supplied raw entity ID alone is not sufficient to enumerate or forge a cross-tenant reference.
- Reference identity is stable across target rename or movement within the owning microvertical. A label is presentation, not identity.

## Selection and discovery

- Core provides federated picker search across registered reference providers.
- Each target microvertical decides which of its entities are discoverable to the acting user and returns only those entities from picker search. Discoverability is not permission to open.
- A user may paste a known Core deep link or opaque reference token even when the target was not discoverable in picker search. Core validates the token/provider envelope before committing the reference.
- Invalid, malformed, or unknown tokens are rejected as active references. Plain pasted text may remain ordinary Text content but is not silently converted into a reference.
- Selection never grants, changes, or implies access to the target.

## Active resolution and opening

- A registered target provider resolves a valid token to the current stable identity, current display label, and an open request. Active resolution may cross microvertical and tenant boundaries.
- A resolvable target renders as an active clickable reference even when the viewer lacks permission to open it.
- Immediately before opening, the owning microvertical authorizes the current viewer against the current target state. Authorization is never cached as a property of the Text value.
- If authorization succeeds, the target opens through the owning microvertical. If authorization fails, navigation is prevented and an access-denied result is shown; the stored reference remains unchanged and clickable for later attempts.
- Picker discoverability, active resolution, and authorization-to-open are distinct operations and must not be treated as equivalent decisions.

## Lifecycle and fallback

- A rename changes the actively resolved label without changing the stored reference identity. The last successfully resolved label is refreshed.
- A deleted target, unknown token, unregistered provider, or currently unavailable provider is unresolvable. Retain the reference identity and last label, but render that label as searchable, non-clickable plain text.
- Temporary unavailability may later resolve again, restoring active clickable rendering. Permanent deletion remains fallback text unless the owning microvertical later makes that same stable target resolvable again.
- Mere permission denial or permission loss does not cause plain-text fallback.
- Copying or duplicating Text content retains the same reference target identity and last label where the enclosing Text operation permits value copying; the reference itself never clones the target entity.

## Acceptance guarantees

- A discoverable entity can be selected without granting open permission.
- A valid pasted opaque token can create a cross-tenant reference even when picker search did not expose the target.
- A raw guessed ID cannot be used to enumerate or forge a reference.
- A resolvable unauthorized target is clickable, but every open attempt is denied by the owning microvertical before navigation.
- Deleting or making the target provider unavailable produces searchable, non-clickable last-label text; restoring resolution makes the reference clickable again.

## Sources

- `../sources/product-owner/ontos-text-property.md` §§F4–F5/J.5.
- `../sources/handoffs/ontos-text-property-handoff.md`.
- [PR-015](../product/product-resolutions.md#pr-015--unresolved-core-references-degrade-to-searchable-plain-text).
- [PR-020](../product/product-resolutions.md#pr-020--core-references-span-microverticals-and-authorize-when-opened).
