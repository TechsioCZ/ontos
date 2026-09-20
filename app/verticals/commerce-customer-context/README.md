# Commerce Customer Context

The Commerce customer MicroVertical: customer profiles, counterparty access, purchasing policy, and
the Commerce Portal (authentication realm and enrollment).

## Optional deployment configuration

Both groups below are opt-in. A deployment that names none of a group's values never opted into it,
and the vertical still serves readiness and every business route: the corresponding routes answer a
retryable `503` instead. Naming only some of a group's values is a misconfiguration, not an opt-out,
and is reported as one.

### Commerce Portal authentication realm — `COMMERCE_PORTAL_AUTH_*`

The Better Auth provider realm behind the portal session, MFA, recovery, step-up and enrollment
routes. Read by `api/portal-auth/provider/config.ts`.

| Variable                               | Required when opted in | Meaning                                                   |
| -------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `COMMERCE_PORTAL_AUTH_URL`             | yes                    | The portal origin. Also the first trusted origin.         |
| `COMMERCE_PORTAL_AUTH_DATABASE_URL`    | yes                    | The provider's own PostgreSQL connection string.          |
| `COMMERCE_PORTAL_AUTH_SECRET`          | yes                    | At least 32 characters. Rotated independently of Staff's. |
| `COMMERCE_PORTAL_AUTH_SECRETS`         | no                     | `version:value` entries, current key first.               |
| `COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS` | no                     | Extra comma-separated origins.                            |
| `COMMERCE_PORTAL_AUTH_TRUSTED_PROXIES` | no                     | Exact peer addresses of the deployment's own proxies.     |
| `COMMERCE_PORTAL_AUTH_NODE_ENV`        | no                     | `production` forces secure cookies.                       |

### Core identity transport — `COMMERCE_CORE_IDENTITY_*`

The provider-neutral Core endpoint enrollment reaches for a Tenant-scoped Principal Auth Binding,
and the server-owned service credential presented to it. Read by
`api/portal-auth/provider/core-identity-client-config.ts`. It is deliberately separate from the
portal realm: the realm is the provider half of enrollment, this is the Core half, and a deployment
rotates them independently.

| Variable                          | Required when opted in | Meaning                                                                                                                                                             |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMMERCE_CORE_IDENTITY_BASE_URL` | yes                    | `http`/`https` base URL of the Core identity API. It carries no credential material: a URL with userinfo, a query or a fragment is rejected.                        |
| `COMMERCE_CORE_IDENTITY_API_KEY`  | yes                    | The trusted, server-owned API key, at least 16 characters. It is `Redacted` from the moment it is read and never reaches a log, a span attribute or a problem body. |

With neither value named, enrollment commit convergence stays the fail-closed capability and refuses
retryably rather than reaching an unconfigured endpoint. The endpoint and the credential are
deployment inputs: the installed transport replaces both on every call, so a caller supplies only
the correlation it is dispatching under and can neither redirect the client nor present a
credential of its own.

Enrollment owner evidence now needs both halves of the realm. The owner preparation authority — the
gate every governed enrollment Action passes — is installed only when a deployment named both the
`COMMERCE_PORTAL_AUTH_*` realm and this Core identity transport, because a Retail transition is
vouched for against the Principal Auth Binding Core retains for the Attempt's provider subject. A
deployment that named only one of them keeps the fail-closed leaf: every claimed owner payload is
refused retryably instead of proceeding without owner evidence, and the readiness and business
routes are unaffected.

## Authentication namespace registration

The vertical registers its own authentication namespace, `ontos.commerce.portal.better-auth.v1`,
for its own action-boundary audience `commerce-customer-context`
(`api/portal-auth/authentication-namespace-registry.ts`). It needs no configuration, but it is a
required deployment input of every governed route here: Core revalidates the namespace a presented
session binding names before any authorization runs, and with no registry reachable every
namespace-carrying gateway assertion is answered `503 operation_context_unavailable`. A deployment
that supplies its own registry alongside the gateway assertion redemption store overrides this one.

## Portal enrollment routes

| Route                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/portal-auth/enrollment/start`      | Starts (or converges on) an Enrollment Attempt for one of the three supported journeys, durably claims its `provider.account.create` transition, and performs that one provider effect. This is the only Commerce route that carries an enrollment credential; the password is `Redacted` end to end, never enters the durable Attempt and never reaches an intent or request digest. |
| `GET /api/portal-auth/enrollment/{attemptId}` | Reads the Attempt projection back for the caller's own governed Tenant. The durable read is Tenant-scoped inside PostgreSQL, so an Attempt belonging to another Tenant answers exactly as an absent one does.                                                                                                                                                                         |

Both routes run the trusted-origin gate before any owner effect. There is no route that advances,
completes or terminates an Attempt from the outside: every later transition travels through the
governed enrollment Actions, and `COMPLETE` is derived from durable owner outcomes rather than
asserted by a caller.

`POST /enrollment/start` spends a budget scoped to the caller's Principal _and_ a customer-specific
signal that Principal alone never establishes, so a single shopper cannot exhaust it for every other
shopper behind the same shared Storefront Principal. Both budgets below are keyed under the
deployment secret; neither is route-wide:

1. **(Principal, address), per hour** (`rateLimit.accountCreation`) — what one (Principal, address)
   pair may spend on provider account creation. Spent only by the journeys that actually create a
   provider account (`RETAIL_SELF_ENROLLMENT`), after the caller's gateway assertion is verified;
   Existing-account proves ownership of an account that already exists and dispatches no provider
   effect this budget throttles.
2. **(Principal, session subject), per hour** (`rateLimit.accountCreation`, reused) — what one
   Existing-account session may spend on the ownership probe (a portal session read plus a provider
   directory lookup). Spent only after that session is confirmed live: a start with no session
   answers `401` without spending anything, so this budget can never be exhausted by an
   unauthenticated caller walking addresses.

A `429` names the window of whichever rule actually refused the request.

`journey: COUNTERPARTY_INVITATION` starts like a Retail self-enrollment — the same body plus the
`invitationId` it claims — and its journey declares four required transitions: the provider account,
the Tenant-scoped Principal Auth Binding's reservation and activation, and the Counterparty Access
invitation claim. The continuation drives the first three; the claim is the one transition it may
never dispatch, because the invitation's one-time secret was delivered to the recipient and exists
nowhere the server may read. `POST /api/portal-auth/enrollment/:attemptId/claim-invitation` is the
recipient presenting it: the secret is `Redacted` from decode to redemption, the caller's portal
session must be authenticated as the exact provider subject the Attempt journalled, and the caller's
gateway assertion must name the exact Principal Auth Binding the Attempt reserved — so a caller
holding any other Principal's assertion, the shared Storefront Client Principal included, is
answered exactly as an absent Attempt is. A request made before that binding is active answers `409
enrollment_binding_pending`. The redemption is the claimability gate as well as the secret check:
the owner routine locks the invitation, refuses anything but a current invitation with a staged,
unexpired proof, and stamps the claimant from the authenticated scope. The Counterparty Access
Grants the invitation intends are the claim Action's own outbox and
`reconcile-counterparty-access-invitation-claim-authorization-mutation.worker.ts`; the journey
records the claim and nothing more. `journey: EXISTING_ACCOUNT` creates no account either:
its journey definition drops the `provider.account.create` step and declares `provider.account.verify`
in its place, so the start must be made by the authenticated owner of that account — it requires a
live Commerce portal session whose subject holds the presented address (`401` without one, and the
group's invalid-request answer when the session owns a different account, in both cases before any
Attempt is persisted), then claims that transition and journals the session subject on the Attempt.
Its request body carries no `password` and no `displayName`: those fields exist only to create a
provider account, this journey never does, and a body that names either is refused at decode with
`400 invalid_request` before any Attempt is persisted.

A journey that halts is not abandoned. Reading an Attempt that is neither terminal nor under a live
lease advances it once more, and an in-process sweeper
(`src/workers/enrollment-continuation-sweeper.ts`) re-advances every halted Attempt whose last
activity is older than the lease window. The sweeper needs no Tenant knowledge: it pages through
`list_due_portal_enrollment_attempts`, a worker-only cross-Tenant listing that refuses any caller
whose transaction installed a verified Tenant, so an Attempt one process abandoned is finished by
the next even in a Tenant that process has never served. Both are safe to repeat: the durable claim
and its lease, not the caller, are what grant ownership.

A halt that keeps repeating is an operator fact rather than a retry loop, so the sweeper's budget is
durable too. Each pass is taken on the Attempt itself by `claim_portal_enrollment_sweep` — the same
worker-only credential the listing takes — into `sweep_revision`/`sweep_count`, and the listing
excludes an Attempt that has spent the budget while still standing at that revision. Taking the
pass and charging it are one statement: every replica's listing reports the same due row, so a
routine that charged first would let each replica that then lost the transition claim spend a sweep
it never performed. The winner also stamps `sweep_claimed_until`, which keeps the row out of every
other listing until the claim expires on its own — the replica holding it may be the process that
just died — and a replica whose claim is refused skips the row without charging it. A count held
only in a worker's memory would die with its process and be granted again in full by the next
listing, and because the listing is oldest-first that Attempt would then fill the first page of
every tick ahead of newer work. Anything that moves the Attempt — a read that resumes it, an owner
outcome — changes its revision and starts the count over.

Once start has committed, the journey is carried the rest of the way by the server-side enrollment
continuation (`src/enrollment/continuation/`), which the start route triggers as a detached,
concurrency-bounded fork. It reads the durable Attempt, asks the journey definition which required
transition the owner journal has not proven, looks that transition's owner effect up in the
owner-effect registry (`src/enrollment/orchestration/owner-effect-registry.ts`) and runs it through
the generic owner-transition driver — one committed transaction per phase, every owner effect
outside all of them. The continuation is idempotent: every owner invocation identity it claims under
is derived from the Attempt, so a re-run after a crash replays the durable operation instead of
repeating the external effect, and an owner whose answer was lost is settled by one authoritative
read rather than a second dispatch. The `provider.account.create` transition is reconcile-only
there — its credential-carrying dispatch belongs to the start route alone — and a transition this
deployment registers no owner effect for halts the journey with the Attempt untouched.
