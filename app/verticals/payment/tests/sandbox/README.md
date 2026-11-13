# Provider sandbox conformance (#1159 level 4)

Opt-in tests that run the production GoPay, Stripe and Comgate adapters against the providers' real sandboxes.
Run from `app/`:

```sh
mise exec -- pnpm --filter @app/payment test:sandbox
```

Without a provider's `ONTOS_C17_SANDBOX_*` variables (listed in `sandbox-harness.ts`), every scenario of that
provider prints `NOT RUN (credentials absent: …)` and is skipped. A skipped scenario is never a pass. Nothing
here opens a browser or prints a secret.

## Hosted pages

Scenarios that need a paid hosted page print the redirect URL and the instrument to use, then poll lookup for up
to 15 minutes. With `ONTOS_C17_SANDBOX_HOSTED_URL_FILE` set, each page is also appended there as one JSON line
`{provider, scenario, url}` before polling starts, so a browser agent can pick it up.

Only documented sandbox instruments work for an automated browser:

| Provider | Instrument                                                   | Notes                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GoPay    | Offline bank-transfer simulator                              | Choose bank transfer, then the offline transfer. Use the simulator's published fictitious payer account and the payment id as variable symbol. Do **not** pick an online bank: it redirects to the bank's real login and cannot be completed. |
| GoPay    | Card 5447 3800 0000 0006, any future expiry, any 3-digit CVC | Amount ending 00 is approved, ending 04 is declined. Card payments can only be refunded in full.                                                                                                                                              |
| Stripe   | Card 4242 4242 4242 4242, any future expiry, any CVC         |                                                                                                                                                                                                                                               |

GoPay source: <https://help.gopay.com/en/articles/16847061-making-payments-in-the-test-environment>.
Stripe source: <https://docs.stripe.com/testing>.

## Scenarios

| Provider | Scenario                                                                                                                               | Hosted page             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| GoPay    | create and retrieve; fractional amount 159950 (1 599,50 CZK) kept on create and lookup                                                 | no                      |
| GoPay    | paid by bank transfer, confirmed by lookup, **partial** refund proven                                                                  | bank-transfer simulator |
| GoPay    | paid by card, confirmed by lookup, **full** refund proven                                                                              | card, amount ending 00  |
| GoPay    | declined card (amount ending 04) ends CANCELED and NOT_EFFECTED                                                                        | card, amount ending 04  |
| GoPay    | cancel is UNSUPPORTED; callback is a lookup trigger; lost create recovered by callback id                                              | no                      |
| Stripe   | create and retrieve; hosted payment confirmed by lookup                                                                                | card (hosted test only) |
| Stripe   | expiring a paid session: HTTP 400 `invalid_request_error` with no `error.code`, lookup keeps it paid, cancel NOT_EFFECTED              | card                    |
| Stripe   | partial and full refund confirmed; asynchronous refund pending then confirmed; `pm_card_refundFail` first confirmed, then NOT_EFFECTED | no                      |
| Stripe   | cancel of an open session; real `checkout.session.expired` signature; lost create replayed                                             | no                      |
| Stripe   | same idempotency key with a changed amount: `idempotency_error`, OUTCOME_UNKNOWN, nothing else sent                                    | no                      |
| Comgate  | see `comgate-sandbox.test.ts`                                                                                                          |                         |

## GoPay refund proof

The real GoPay sandbox returns refund history rows with their own row id (not the payment id) and a date-only
`date_requested`. A date cannot place a same-day refund after its dispatch. The adapter's refund prepare therefore
reads the history first and returns its row ids as `prepared.refundBaseline` (the ledger commits it with the
request, before the send); a read that is not a decodable `200` stops the refund before it is sent. The scenarios
check that this baseline is exactly what GoPay returned, then pass it to the settle lookups as the ledger does for
an acknowledged refund. They pass only when GoPay shows exactly one new SUCCESS row of the exact amount **and**
the adapter confirms the refund. An unproven refund must stay unconfirmed.

The first refund of a payment also checks the one unverified assumption: that a payment without refunds answers
`200 []`.
