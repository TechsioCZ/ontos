# Payment gateways (GoPay, Stripe, Comgate)

> [!IMPORTANT] This document owns the gateway protocol, the Launch capability matrix, and the notification contract of the `payment.core` gateway adapters. Payment state, approval and the Payment Operation lifecycle are owned by Payment. A gateway never writes Payment state directly.

## Placement

The adapters live in the `payment.core` module (`app/verticals/payment`), not in a separate module. There is no separate Module Contract Identity for them.

- `src/integrations/gopay/`, `src/integrations/stripe/`, `src/integrations/comgate/`: one owner-private adapter per provider. Each is an external HTTP adapter (the ARES pattern, see [ARES](./ares.md)).
- `src/integrations/psp/`: provider-neutral ports, the executor, recovery, the dispatch ledger, credentials, evidence and notification processing.
- `shared/domain/psp-*.ts`: browser-safe schemas.
- `src/integrations/paykit-adoption/`: the upstream PayKit adoption record (see `ORIGIN.md` next to it).

No provider SDK is used. Outbound calls go through the Effect `HttpClient`. The Stripe SDK is not a dependency; Stripe webhook signatures are checked with the documented v1 scheme.

## What the module exposes

| Kind               | Name                                                                                | Who calls it                                          |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Admin Action       | configure Provider Account Binding, rotate credential, configure Gateway Enablement | Operators (critical, approval mode available)         |
| Read               | gateway configuration, customer action, return status, reconciliation debt          | Admin UI, customer return page, reconciliation driver |
| Workload Action    | `capture-provider-notification`                                                     | Notification relay (integration principal)            |
| Background workers | execute gateway operation, recover gateway operation, process provider notification | Core outbox                                           |

The reconciliation debt Read lists operations whose provider outcome is still unknown or whose evidence is still pending.

## Governed apply path

Provider facts reach Payment only through the public A8 `accept-payment-observation` Action.

- A worker calls A8 with a `RegisteredWorkload` assertion, never with a human session.
- That path works only when the original admission of the delivery was workload-admitted. Those originals are the capture Action and A10 `request-payment-operation-recovery` when the reconciliation driver calls it.
- Evidence the executor gets from a human-admitted origin stays in the C17 evidence table as `PENDING_SUBMISSION`. It is reconciliation debt until a workload-admitted recovery submits it.
- The shared gateway client only sends the request. Shell checks the Tenant, the claimed delivery, the original invocation, its company and the rule for the request.
- A worker that runs per company names that company. Shell binds it to the company of the original admission and refuses any other company.
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
- The driver that runs this loop is not built yet (open item N1).

## Capability matrix (Launch)

| Capability                    | GoPay                               | Stripe                     | Comgate                                                 |
| ----------------------------- | ----------------------------------- | -------------------------- | ------------------------------------------------------- |
| Collect (hosted payment page) | Supported                           | Supported                  | Built, not enableable (N9)                              |
| Retrieve (lookup)             | Supported                           | Supported                  | Supported                                               |
| Notification                  | Supported (lookup only)             | Supported (signed)         | Supported (shared secret plus lookup)                   |
| Refund                        | Supported (proof by refund history) | Supported                  | Accepted as pending only; completion not provable (N10) |
| Cancel or void                | **Unsupported** (N8)                | Supported (expire session) | Supported (lookup decides on refusal)                   |

Limitations, in plain words:

- **GoPay cancel:** GoPay has no cancel for a standard payment. The attempt is recorded as unsupported, and the collection is not erased. Evidence is recorded as "cancel not effected" and waits for a governed submission. There is no fallback to another operation.
- **Comgate refund:** Comgate documents no refund status or identifier. A successful call is recorded as pending only. Comgate refund conformance is blocked until the owner confirms a proof (N10).
- **Comgate payer contact:** Comgate needs the payer's email or phone. Payment has no source for it yet, so enabling Comgate is rejected with `gateway_payer_contact_source_missing` (N9). Comgate collection conformance is blocked until an owner exists.
- Settlement and remittance data are not mapped in Launch for any provider (N15).

## Credentials

- Credentials are one deployment value, `ONTOS_PAYMENT_PROVIDER_CREDENTIALS`, read as `Config.Redacted`.
- The value is one JSON object keyed by the opaque secret reference stored on the binding revision:

  ```json
  { "<secretRef>": { "family": "GOPAY", "clientId": "...", "clientSecret": "..." } }
  ```

- Each entry is decoded on its own. A missing variable, malformed JSON, or a malformed, unknown or wrong-family entry fails only the resolve that needs it, with a typed unavailable result.
- Layer construction never reads the value. A broken GoPay entry does not stop Stripe or non-gateway Payment.
- Errors never contain the raw value or a decode message.
- Rotation and who operates it are open (N3).

## Notification ACK contract

The relay that receives provider calls is not built yet (N1). Its response rule is fixed:

| Capture result  | Meaning                                                                                                      | HTTP answer |
| --------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| `CAPTURED`      | Authentic, stored, will be processed                                                                         | 2xx         |
| `DUPLICATE`     | Already stored                                                                                               | 2xx         |
| `IGNORED`       | Authentic and stored, but not actionable (e.g. an unmapped Stripe event type, or a GoPay recurring callback) | 2xx         |
| `REJECTED`      | Failed verification or malformed                                                                             | non-2xx     |
| Capture failure | Storage or infrastructure failed                                                                             | non-2xx     |

Only `REJECTED` and capture failure are non-2xx. An authentic event that OntOS does not act on is still acknowledged, so the provider is not asked to resend it forever.

Per provider:

- **GoPay:** unsigned HTTP GET with `?id=`. The callback is a trigger only. The state is read again through the original binding.
- **Stripe:** signed. `Stripe-Signature` with `v1` values, HMAC-SHA256 over `t.rawBody`, constant-time compare, 300 s tolerance. Objects are read again before a collection is confirmed. Invoice and customer events never become Billing.
- **Comgate:** the shared secret, merchant and environment are checked. The status is always read again through lookup, and the lookup wins.

## Sandbox variables

The sandbox run is opt-in and reports `NOT RUN (credentials absent)` when a variable is missing. It never reports a pass.

| Gateway | Variables                                                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GoPay   | `ONTOS_C17_SANDBOX_GOPAY_CLIENT_ID`, `ONTOS_C17_SANDBOX_GOPAY_CLIENT_SECRET`, `ONTOS_C17_SANDBOX_GOPAY_GOID`; optional `ONTOS_C17_SANDBOX_GOPAY_NOTIFICATION_URL` |
| Stripe  | `ONTOS_C17_SANDBOX_STRIPE_SECRET_KEY` (`sk_test_` or restricted `rk_test_`), `ONTOS_C17_SANDBOX_STRIPE_WEBHOOK_SECRET`, `ONTOS_C17_SANDBOX_STRIPE_ACCOUNT_ID`     |
| Comgate | `ONTOS_C17_SANDBOX_COMGATE_MERCHANT_ID`, `ONTOS_C17_SANDBOX_COMGATE_SECRET`; the runner's public IPv4 must be on the shop's allowed list                          |

Hosted payments need a person to complete the page with a test card or the Comgate simulator. The harness prints the redirect URL and polls lookup for up to 15 minutes. Agents do not open browsers.

Run it from `app/` with `mise exec -- pnpm --filter @app/payment test:sandbox`. The full variable list is in the header of `verticals/payment/tests/sandbox/sandbox-harness.ts`. Before a run:

- A hosted scenario fails when nobody pays within 15 minutes.
- Pay the GoPay hosted payment by bank transfer; the partial refund scenario needs it.
- Comgate needs the runner's public IPv4 on the shop's allowed-IP list and a Client Portal user with the Tester role.
- The Stripe account must accept CZK.

## Open product and owner items (plan §7)

- **N1** Relay surface, its principal scope, and who runs the reconciliation driver.
- **N2** Approval of the workload admission for A10 and the payment-to-payment self call. Blocker if the delegation probe fails.
- **N3** Credential storage in one redacted JSON, and who rotates it.
- **N4** Admin preset coverage. Payment's permissions reach the full-access role only through a catalog release on main.
- **N5** Source authorities and principals (operator setup, relay, driver, receiving system principal per tenant).
- **N6** Stripe without the SDK, as the "official" webhook verification.
- **N7** Release intent: Payment is absent from the application release intent file.
- **N8** GoPay cancel: accept "cancel not effected" as unsupported, or reject GoPay cancel at A6.
- **N9** Payer contact source for Comgate. Comgate enablement stays rejected until an owner exists.
- **N10** Comgate refund proof. Blocks Comgate refund conformance.
- **N11** Ownership of the return and notification URLs, and the return token format.
- **N12** Wording and location of the licence notice for the PayKit adoption.
- **N13** Sandbox accounts and a human operator for the live-sandbox run.
- **N14** Meaning of "cancel confirmed" for a collection that was never sent.
- **N15** Settlement and remittance mapping. Deferred for all three providers.
