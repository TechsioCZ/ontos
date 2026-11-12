# PayKit SDK adoption record

- Upstream URL: https://github.com/payrouteshq/paykit-sdk
- Upstream commit: `c8f11bf8005ff0ca1a5821042731979774e266bc` (merge of PR #70, commit date 2026-09-04)
- Package versions at snapshot: `@paykit-sdk/core` 1.3.4, `@paykit-sdk/stripe` 1.3.3, `@paykit-sdk/gopay` 1.3.4, `@paykit-sdk/comgate` 1.3.4
- Declared licence: SPDX `ISC` (root and package `package.json` files, and the Stripe, GoPay and Comgate READMEs). Author in `package.json`: Emmanuel Odii.
- Licence file: upstream has no `LICENSE` file and no copyright line in source. The `LICENSE` in this directory is the ISC text with the copyright line `Copyright (c) Emmanuel Odii and PayKit contributors`. **Open question N12:** the wording and location of this notice are pending legal confirmation.
- Vendored path: `app/verticals/payment/src/integrations/paykit-adoption/` (this record and `LICENSE` only; no upstream code is copied here yet).
- Donor clone used for the map: `agent-scratch/c17/donor/paykit-sdk`, read only. Nothing was installed or executed from it.

## Adopted file inventory

Line ranges refer to the upstream commit above. `P:` means `packages/paykit/src/`.

| Upstream file                              | Lines      | Adopted part                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P:error.ts`                               | 334        | Error classes, adapted into OntOS typed failures (UNSUPPORTED / UNAVAILABLE / INDETERMINATE / CONFLICT). The GitHub-pointing messages at 43-64 are dropped.                                                                                                                                                                                                                            |
| `P:http-client.ts`                         | 158        | HTTP client for GoPay and Comgate. Retry policy is rewritten (G-1).                                                                                                                                                                                                                                                                                                                    |
| `P:oauth2-token-manager.ts`                | 187        | GoPay OAuth2 `client_credentials` token cache. One instance per Provider Account Binding. GET branch (126-130) dropped.                                                                                                                                                                                                                                                                |
| `P:tools/classify-error.ts`                | 39         | HTTP status and network classification, as transport input only.                                                                                                                                                                                                                                                                                                                       |
| `P:tools/utils.ts`                         | 284        | Partial: `Result`/`OK`/`ERR` (11-23), `executeWithRetryWithHandler` (64-106), `buildError` (108-114), `validateRequiredKeys` (116-145), `schema<>()` (166-175), `omitInternalMetadata` (177-187), `stringifyMetadataValues` (200-209), `hashWebhookPayload` (277-284, see G-7). `safeEncode`/`safeDecode`, `parseJSON`, `getURLFromHeaders` and `refundReasonMatcher` are not adopted. |
| `packages/stripe/src/stripe-provider.ts`   | see map 1b | Stripe provider ranges for retrieve, refund, webhook signature (`constructEvent`, 913-940) and checkout-session resolution (`_resolvePaymentIntentId`, 126-141). Adopted only as reference for the rewrite (S-*).                                                                                                                                                                      |
| `packages/stripe/src/utils/mapper.ts`      | see map 1b | Refund and payment inbound mapping, reference only (S-9).                                                                                                                                                                                                                                                                                                                              |
| `packages/gopay/src/gopay-provider.ts`     | 1333       | Ranges: options 62-110; constructor/HTTP/OAuth 114-172; `submitPayment` 174-196; createPayment 777-885; retrievePayment 887-909; cancelPayment 975-994; createRefund 1020-1073; handleWebhook 1075-1116 (lookup only).                                                                                                                                                                 |
| `packages/gopay/src/schema.ts`             | 361        | TS interfaces only: `GoPayPaymentBaseResponse` 1-95, `GoPayPaymentItem` 129+, `GoPayPaymentRequest` 166-361 (`preauthorization?` 358-360). No runtime validation in upstream.                                                                                                                                                                                                          |
| `packages/gopay/src/utils/mapper.ts`       | 328        | `decodeHtmlEntities` 19-25, `Payment$inboundSchema` 30-83, `Refund$inboundSchema` 318-328.                                                                                                                                                                                                                                                                                             |
| `packages/comgate/src/comgate-provider.ts` | 798        | Ranges: options/constructor 56-120; `_throwOnError` 122-172; createPayment 303-385; retrievePayment 415-437; cancelPayment 480-490; createRefund 495-540; handleWebhook 609-700 (shared secret, `timingSafeEqual`, status lookup).                                                                                                                                                     |
| `packages/comgate/src/schema.ts`           | 345        | TS interfaces only: webhook/status responses 1-90 and 162-300, `ComgateRefundResponse` 303-313, `ComgatePaymentOperationResponse` 315-345.                                                                                                                                                                                                                                             |
| `packages/comgate/src/utils/mapper.ts`     | 62         | `Payment$inboundSchema` 11-30. Invoice mapping (35-61) not adopted.                                                                                                                                                                                                                                                                                                                    |

Adoption means reading these ranges as reference for OntOS-owned code. Source is rewritten; it is not a verbatim copy, except where a later lane records otherwise here.

## Not adopted

- **Core:** the `PayKit` facade class (`index.ts` 17-181) and its `_track` telemetry. `P:telemetry.ts` posts amounts, currency, status and provider to an external endpoint and must never be adopted (G-4). Also not adopted: `P:server/*` endpoint helpers, `P:provider-schema.ts`, the customer and billing resources beyond the payee fields, `P:resources/metadata.ts` (the `__paykit` convention), and `P:webhook-provider.ts` dispatcher (only the input shape idea was kept).
- **Stripe:** `createCheckout`/`retrieve`/`update`/`deleteCheckout` (143-279); customers (284-354); subscriptions (356-478); `updatePayment` (654-704); `capturePayment` (798-818); off-session and stored-method branch of `createPayment` (559-651); invoice, customer and subscription webhook branches (958-1099).
- **GoPay:** checkout (198-340); customers (342-369); subscriptions and recurrence (371-775); `capturePayment` (922-973); `updatePayment` (999-1018); subscription and invoice webhook branches (1212-1292).
- **Comgate:** `createCheckout` (174-235); `capturePayment` and preauth confirm (439-478); subscriptions and customers (266-301, 542-607); `deletePayment` (397-413); Invoice mapping (35-61); `invoice.generated` (773-778).
- **Other packages:** `adapters/medusajs`, `examples/medusa-shop` (MIT, Medusa), `react`, `registry`, `custom-provider`, `apps/*`, root tooling, and the other 13 providers (bachs, chapa, lemonsqueezy, mercadopago, moneygram, monnify, paypal, paystack, polar, razorpay, redsys, remita, xendit). Stray `packages/comgate/pnpm-lock.yaml` is not adopted.
- **Dependencies:** no upstream npm package is added as a runtime dependency. External SDK use (for example the Stripe SDK) is a separate decision recorded in the payment vertical.

## Modifications and donor gap log

Resolutions are filled in by W5-DOCS. Each entry gives the gap id, the donor behaviour and the OntOS resolution.

- G-1 to G-7 (shared core): _pending W5-DOCS_
- S-1 to S-15 (Stripe): _pending W5-DOCS_
- G-P1 to G-P11 (GoPay, map 4.2): _pending W5-DOCS_
- C-1 to C-12 (Comgate): _pending W5-DOCS_
- Conversion functions and webhook verification summary (map 4.4): _pending W5-DOCS_

## Rule

Every later manual upstream source import requires a full C17 conformance rerun (#1159:161).
