# Payment gateways (GoPay, Stripe, Comgate)

> [!IMPORTANT] This document owns the gateway protocol, the Launch capability matrix, and the notification contract of the `payment.core` gateway adapters. Payment state, approval and the Payment Operation lifecycle are owned by Payment. A gateway never writes Payment state directly.

## Placement

The adapters live in the `payment.core` module (`app/verticals/payment`), not in a separate module. There is no separate Module Contract Identity for them.

- `src/integrations/gopay/`, `src/integrations/stripe/`, `src/integrations/comgate/`: one owner-private adapter per provider. Each is an external HTTP adapter (the ARES pattern, see [ARES](./ares.md)).
- `src/integrations/psp/`: provider-neutral ports, the executor, recovery, the dispatch ledger, credentials, evidence and notification processing.
- `shared/domain/psp-*.ts`: browser-safe schemas.
- `src/integrations/paykit-adoption/`: the upstream PayKit adoption record (see `ORIGIN.md` next to it).

No provider SDK is used. Outbound calls go through the Effect `HttpClient`. The Stripe SDK is not a dependency; Stripe webhook signatures are checked with the documented v1 scheme. GoPay is called on its REST API v3 (`/api`).

## What the module exposes

| Kind               | Name                                                                                | Who calls it                                          |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Admin Action       | configure Provider Account Binding, rotate credential, configure Gateway Enablement | Operators (critical, approval mode available)         |
| Read               | gateway configuration, customer action, return status, reconciliation debt          | Admin UI, customer return page, reconciliation driver |
| Workload Action    | `capture-provider-notification`, `request-payment-operation-recovery` (A10)         | Notification relay, reconciliation driver             |
| Background workers | execute gateway operation, recover gateway operation, process provider notification | Core outbox                                           |
| Scoped loop        | reconciliation driver (see below)                                                   | Payment Outbox Worker entry                           |

The reconciliation debt Read lists operations whose provider outcome is still unknown or whose evidence is still pending.

## Governed apply path

Provider facts reach Payment only through the public A8 `accept-payment-observation` Action.

- A worker calls A8 with a `RegisteredWorkload` assertion, never with a human session.
- That path works only when the original admission of the delivery was workload-admitted. Those originals are the capture Action and A10 `request-payment-operation-recovery` when the reconciliation driver calls it.
- Evidence the executor gets from a human-admitted origin stays in the C17 evidence table as `PENDING_SUBMISSION`. It is reconciliation debt until a workload-admitted recovery submits it.
- The shared gateway client only sends the request. Shell checks the Tenant, the claimed delivery, the original invocation, its company and the rule for the request.
- A worker that runs per company names that company. Shell binds it to the company of the original admission and refuses any other company.
- Route scopes for the relay and the driver are described in [Authorization](../architecture/AUTHORIZATION.md).
- There is no owner-local bypass and no toggle.

## Reconciliation debt

```text
driver (integration principal, payment.provider-reconciliation)
  -> Read gateway-reconciliation-debt   (operation, payment, ledger state, pending evidence, recommended trigger)
  -> A10 request-payment-operation-recovery   (workload admission)
       -> recover-gateway-operation worker
            LOOKUP or REPLAY at the provider
            append evidence
            submit pending evidence via A8 when the origin was workload-admitted
```

- Lost responses, unknown outcomes and unsupported cancels all stay visible as debt until evidence is accepted.
- Nothing is dropped as a silent failure. A delivery is completed only when no retry can still change the outcome.

## Reconciliation driver

The driver is the only thing that asks A10 for a recovery of a debt row. It makes no provider call, chooses no recovery mode and never marks anything resolved.

- It runs as one scoped loop in the Payment Outbox Worker entry. The first tick comes 60 seconds after start, then one tick every 60 seconds.
- It runs only when Payment is in the release intent and the approved `payment.core` release is this build. Otherwise it logs one refusal per change and does nothing.
- It needs two values on `payment-worker` and `outbox-worker-host`: `ONTOS_PAYMENT_RECONCILIATION_CREDENTIALS` and `ONTOS_SHELL_GATEWAY_BASE_URL`. A tenant without a valid key entry is skipped and logged at most once per hour.
- `/ready` does not cover this loop. `/ready` tracks the polling cycles only. A defect that ends the driver does not stop the host and does not turn `/ready` red. Watch the driver's log lines.

Budgets:

| Limit                                    | Value                                    |
| ---------------------------------------- | ---------------------------------------- |
| Debt rows read per tick                  | 4 pages of 50                            |
| A10 requests per tick                    | 50                                       |
| A10 requests per tenant and Legal Entity | 20                                       |
| A10 requests per provider family         | 15                                       |
| Requests in flight                       | 2                                        |
| Rounds per operation                     | 24                                       |
| Wait before round r                      | 15 minutes × 2^(r−1), capped at 24 hours |
| Wait after a refusal                     | 1 hour                                   |
| Payer contact purge                      | Rows older than 48 hours, every tick     |

With these waits, 24 rounds cover about 19 days. After that a person owns the debt.

Each request uses the key `payment.gateway-reconciliation:<operationId>:r<round>`. Two drivers send the same key and the same payload, so Core commits one recovery.

Answers from Shell and what the driver does with them:

| Answer                                                            | Driver outcome   | Effect                                                                       |
| ----------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| 409 `payment_recovery_operation_already_resolved`                 | already resolved | That row waits 1 hour. The debt Read decides what is left.                   |
| 409 `action_request_hash_conflict` or `action_already_committed`  | hash conflict    | Another driver sent this round. That row waits 1 hour.                       |
| Other 409, and 422                                                | held             | That row waits 1 hour.                                                       |
| 401, 403, 404                                                     | forbidden        | The tenant cools down for 1 hour and stops for this tick.                    |
| 503, timeout, transport failure, unreadable 2xx, missing base URL | unavailable      | Only that tenant and provider family stop for this tick. Other families run. |

Nothing retries inside a tick. A lost answer is sent again with the same key in a later tick. A round that committed gets a new key, so it is never blocked by an old cooldown.

## Capability matrix (Launch)

| Capability                    | GoPay                                 | Stripe                     | Comgate                                                                   |
| ----------------------------- | ------------------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| Collect (hosted payment page) | Supported; no payer contact           | Supported                  | Built; payer full name plus email or phone required, live sandbox pending |
| Retrieve (lookup)             | Supported                             | Supported                  | Supported                                                                 |
| Notification                  | Supported (lookup only)               | Supported (signed)         | Supported (shared secret plus lookup)                                     |
| Refund                        | Supported (proof from refund history) | Supported                  | Pending on send; proof from production statements only                    |
| Cancel or void                | **Unsupported** (N8)                  | Supported (expire session) | Supported (lookup decides on refusal)                                     |

Limitations, in plain words:

- **GoPay cancel.** GoPay's API v3 has no cancel for a standard payment. The attempt is recorded as unsupported, and the collection is not erased. Evidence is recorded as "cancel not effected" (`provider_cancel_unsupported`) and waits for a governed submission. There is no fallback to another operation.
  - API v4 has a cancel (`DELETE` before the payer chooses a method), but v4 access was refused in the sandbox on 2026-11-13 (HTTP 403 `Scope not allowed: payment:read`). Moving to v4 is a follow-up once GoPay confirms v4 access for the production merchant (N8).
- **GoPay refund.** A refund is sent once. `FAILED` is not effected. `ACCEPTED` and `FINISHED` are pending: GoPay gives no refund id, so completion comes from the payment's refund history. Only exactly one `SUCCESS` entry with the expected amount, requested at or after the dispatch, confirms it. Zero or several candidates stay indeterminate. A new GoPay refund waits until the previous refund of the same payment is confirmed or not effected.
- **Comgate refund.** Comgate's send answer alone never proves a refund. Codes `1400`, `1401` and `1402` mean not effected. Code `0` means pending. Proof comes from the production settlement statement, which Payment reads for each day from the dispatch date for up to 24 days:
  - One debit row with the same merchant, order reference and currency, and the same amount, confirms the refund.
  - The same reference with another amount or currency, a credit row, or more than one row is a conflict.
  - No row is indeterminate. It is never "not effected".
  - Sandbox refunds stay `REFUND_PENDING`. Statements exist only for production payments.
  - Still unverified: whether refund rows appear in the JSON statement (the CSV statement is the fallback), whether a live refund shows its reference as the client order id, what a reversal row looks like after a rejection, and whether a code `1400` truly means nothing was created.
  - Comgate refund conformance needs one small real production refund (N10).
  - A new Comgate refund waits only for another refund of the same payment that is still being sent or has an unknown outcome.
- **Comgate payer contact.** The caller supplies the contact. See [Payer contact](#payer-contact).
- Settlement and remittance data are not mapped in Launch for any provider (N15).

## Payer contact

The caller of `start-payment-collection` may send `payerContact` with `fullName`, `email` and `phone`. Each provider family accepts a different set:

| Payment method or family                | Contact required                   | Any other contact                                      |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| Comgate                                 | `fullName` plus `email` or `phone` | All three fields are used; nothing is refused as extra |
| GoPay, Stripe                           | Nothing                            | Any contact is refused as not applicable               |
| Bank transfer, cash on delivery, pickup | Nothing                            | Any contact is refused as not applicable               |

- A missing required contact, or one that breaks the family's rule (for example a Comgate contact without `email` or `phone`), gives 422 `payment_payer_contact_required`.
- A contact or field the method does not use gives 422 `payment_payer_contact_not_applicable`.
- Contact data is kept in a short-lived row. It is written only when a new collection is created. A replay stores nothing, so the first contact wins.
- The row is deleted when the operation is prepared, withheld or not sent. The driver purges any row older than 48 hours.
- The contact is not part of the operation material, its hash, events, outbox messages or read views.

## Notification relay and provider setup

Providers send notifications to the Shell relay. Payment builds each binding's URL from `ONTOS_PAYMENT_NOTIFICATION_BASE_URL`:

```text
<ONTOS_PAYMENT_NOTIFICATION_BASE_URL>/api/payment/v1/notifications/<gopay|stripe|comgate>/<tenantId>/<routeKey>
```

- `ONTOS_PAYMENT_NOTIFICATION_BASE_URL` must be an exact `https` origin: scheme, host and optional port only. No path (a single trailing slash is tolerated), query, fragment or credentials. Any other value is refused.
- If the value is missing or invalid, creating a provider binding fails with 503 `payment_notification_route_unavailable`. Nothing else in Payment stops.
- The URL comes from Payment only. A caller cannot supply `notificationUrl`.
- The route key is 43 random characters. It routes a request, but it is not a credential.
- The Shell always mounts `/api/payment/v1` as its own prefix, next to `/shell-super-app-api`. The framework batch path under that prefix gets the relay's 404.

Per provider:

- **GoPay:** automatic. Payment sends the URL in each payment create call (`callback.notification_url`). No separate setup is needed.
- **Stripe:** the operator creates a webhook endpoint in the Stripe account with the binding's URL. The endpoint's signing secret (`whsec`) goes into that binding's `ONTOS_PAYMENT_PROVIDER_CREDENTIALS` entry as `webhookSigningSecret`.
- **Comgate:** the operator sets the binding's URL as the Result URL of the shop connection in the Comgate client portal. Payment does not send that URL with each payment.

Relay answers:

| Capture result                   | Meaning                                                                                                      | HTTP answer |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| `CAPTURED`                       | Authentic, stored, will be processed                                                                         | 2xx         |
| `DUPLICATE`                      | Already stored                                                                                               | 2xx         |
| `IGNORED`                        | Authentic and stored, but not actionable (e.g. an unmapped Stripe event type, or a GoPay recurring callback) | 2xx         |
| `REJECTED`                       | Failed verification or malformed                                                                             | 400         |
| Unknown route, tenant or binding | Indistinguishable on purpose                                                                                 | 404         |
| Body over 65 536 bytes           | Too large                                                                                                    | 413         |
| Storage or infrastructure failed | Anything else                                                                                                | 503         |

- Only the `REJECTED` answer and failures are non-2xx for an authentic event. An authentic event that OntOS does not act on is still acknowledged, so the provider is not asked to resend it forever.
- Comgate receives the body `code=0&message=OK` on success.
- The Modern BFF host parses every `application/json` body before routing. Invalid JSON gets its own 400 `Invalid JSON request body`. The whole body is read before the 413 limit applies, and valid bytes reach the relay unchanged.
- The framework access log records the full request path, so the route key appears in logs. Redaction is open. It belongs to the framework, not to Payment, and is recorded as a gap.

Per provider, after the relay accepts a notification:

- **GoPay:** unsigned HTTP GET with `?id=`. The callback is a trigger only. The state is read again through the original binding.
- **Stripe:** signed. `Stripe-Signature` with `v1` values, HMAC-SHA256 over `t.rawBody`, constant-time compare, 300 s tolerance. Objects are read again before a collection is confirmed. Invoice and customer events never become Billing.
- **Comgate:** the shared secret, merchant and environment are checked. The status is always read again through lookup, and the lookup wins.

## Credentials

- Credentials are one deployment value, `ONTOS_PAYMENT_PROVIDER_CREDENTIALS`, read as `Config.Redacted`.
- The value is one JSON object keyed by the opaque secret reference stored on the binding revision:

  ```json
  { "<secretRef>": { "family": "GOPAY", "clientId": "...", "clientSecret": "..." } }
  ```

- GoPay entries are used with the REST API v3. The GoID comes from the binding, not from the entry.
- A Stripe key must match the binding's environment. A SANDBOX binding takes `sk_test_`, `rk_test_` or a claimable sandbox's `rkcs_test_`. A LIVE binding takes only `sk_live_` or `rk_live_`. Any other key is refused before a request is sent.
- Each entry is decoded on its own. A missing variable, malformed JSON, or a malformed, unknown or wrong-family entry fails only the resolve that needs it, with a typed unavailable result.
- Layer construction never reads the value. A broken GoPay entry does not stop Stripe or non-gateway Payment.
- Errors never contain the raw value or a decode message.
- Rotation and who operates it are open (N3).

## Sandbox variables

The sandbox run is opt-in and reports `NOT RUN (credentials absent)` when a variable is missing. It never reports a pass.

| Gateway | Variables                                                                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GoPay   | `ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID`, `ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET`, `ONTOS_C17_SANDBOX_GOPAY_GOID`; optional `ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL`                                  |
| Stripe  | `ONTOS_C17_SANDBOX_STRIPE_SECRET_KEY` (`sk_test_`, restricted `rk_test_`, or a claimable sandbox's `rkcs_test_`), `ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET`, `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID` |
| Comgate | `ONTOS_C17_SANDBOX_COMGATE_MERCHANT_ID`, `ONTOS_C17_SANDBOX_COMGATE_SECRET`; the runner's public IPv4 must be on the shop's allowed list                                                           |

Hosted payment pages need someone to complete them with a test card or the Comgate simulator. Two ways:

- A person completes the page. The harness prints the redirect URL and polls lookup for up to 15 minutes.
- A headless browser agent completes the page. At most two browser sessions run at once. The agent reads the page URLs from `ONTOS_C17_SANDBOX_HOSTED_URL_FILE`, a file of JSON lines `{provider, scenario, url}` that the harness writes. Headed browsers are not used.

Run it from `app/` with `mise exec -- pnpm --filter @app/payment test:sandbox`. The full variable list is in the header of `verticals/payment/tests/sandbox/sandbox-harness.ts`. Before a run:

- A hosted scenario fails when nobody pays within 15 minutes.
- Pay the GoPay hosted payment by bank transfer; the partial refund scenario needs it.
- GoPay needs API v3 sandbox credentials with the `payment-all` scope. A GoPay test merchant that is not an OntOS account is used only with the user's agreement.
- Comgate needs the runner's public IPv4 on the shop's allowed-IP list and a Client Portal user with the Tester role.
- The Stripe account must accept CZK. The suite takes the account id from `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID` and never reads `/v1/account`, which a claimable sandbox key may not read. The key needs read access to Events.
- Two Stripe refund scenarios use Stripe's delayed refund test cards and wait up to 10 minutes each: pending then succeeded, and succeeded then failed (ends as not effected).
- Test contacts use fake values only.

## Known gaps

- Driver health is not part of `/ready` (see the reconciliation driver section).
- The framework access log records relay route keys (see the relay section).
- Comgate statement assumptions are listed under Comgate refund above.

## Open product and owner items (plan §7)

- **N2** Approval of the workload admission for A10 and the payment-to-payment self call. Blocker if the delegation probe fails.
- **N3** Credential storage in one redacted JSON, and who rotates it.
- **N4** Admin preset coverage. Payment's permissions reach the full-access role only through a catalog release on main.
- **N5** Source authorities and principals (operator setup, relay, driver, receiving system principal per tenant).
- **N6** Stripe without the SDK, as the "official" webhook verification.
- **N7** Release intent: Payment must be in the application release intent file. Without it, the driver never runs in host mode.
- **N8** GoPay cancel stays unsupported on API v3 and ends as "cancel not effected". The product owner accepts that or rejects GoPay cancel at A6. The v4 move was dropped after the sandbox refused v4 access (HTTP 403) on 2026-11-13; it returns only once GoPay confirms v4 access for the merchant.
- **N10** Comgate refund proof: statement lookup is built. Production proof needs one real refund and a product owner decision. Blocks Comgate refund conformance until then.
- **N12** Wording and location of the licence notice for the PayKit adoption.
- **N13** Sandbox accounts and a human operator for the live-sandbox run.
- **N14** Meaning of "cancel confirmed" for a collection that was never sent. The owner confirms it once for all three providers.
- **N15** Settlement and remittance mapping. Deferred for all three providers.
- **Privacy** Declare Payment as a transient processor, with Comgate as the only recipient. Payer contacts are kept for up to 48 hours.
