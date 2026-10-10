# TAX owner acceptance (#961-#963) and the activation gate (#964)

The machine-checked source of truth for #961-#963 is `tests/unit/tax-acceptance-ledger.ts`. Its test checks that every coverage key is mapped, every named test exists verbatim, and that no gated row runs a test. This page explains the evidence classes and lists the #964 activation items.

## D6 evidence classes

| Class                | Meaning                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OWNER_PERSISTED`    | Real TAX over Postgres: Tax Rules, Seller VAT Regime Declarations and finals persisted through the owner services, read through the public read and Action handlers where the row says so. |
| `OWNER_KERNEL`       | Real TAX domain code with TAX own state injected. Never used for a #961 row.                                                                                                               |
| `GATED_NOT_EXECUTED` | A foreign owner's part that no test runs (Pricing #892, Promotion #894, Commerce #329/#330/#331, Approval #323, Inventory #877, Billing, Catalog). Never reported as passed.               |
| `SUPERSEDED`         | Issue text patched by the PO-approved OWNERSHIP-FINAL or Unit 12 decisions; the replacement rows carry the proof.                                                                          |
| `NOT_APPLICABLE`     | Nothing exists to exercise (no Tax TTL, no Outbox message, no external seller route); a guard test fails if that changes.                                                                  |

Real TAX covers rules, declarations, finals and the Accepted Tax Terms derivation. Foreign owners are contract-conforming test doubles, listed with their owner contract in `TAX_FOREIGN_OWNER_DOUBLES` (`tests/unit/tax-evaluation-fixtures.ts`): Catalog `catalogEntry`, Pricing `pricingLine`, Delivery `places` and `shippingCharge`, the Selling Legal Entity place `sellerPlace`, Order `purchaseBindingInput`, and Billing `acceptedTaxTermsInput`. Every result built from them is labelled `CALLER_SUPPLIED_UNVERIFIED`.

## Controlled doubles and limits

A green suite is TAX owner acceptance only (`TAX_OWNER_ACCEPTANCE_ONLY`). It is not Pricing→Tax (#892), not Catalog→Tax (Catalog publishes no Tax-purpose contract yet), not Checkout, Order or Billing E2E, not production configuration and not cutover. No gated row is reported as passed.

#893 is the Pricing external-source route (`status:now`, step 14). It is not a TAX route, TAX does not depend on it, and Launch has no external seller route.

## #964 activation items

`assessTaxActivationReadiness` (`src/domain/tax-activation-readiness.ts`) is NON_PRODUCTION evidence. It never claims activation or Commerce readiness. Every item below blocks production activation until it is resolved. `SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION` is computed from each seller's declaration timeline; every other item needs an evidence reference from its owner.

| Item                                       | Owner            | Scope            | Source                       | Blocks production activation until                             |
| ------------------------------------------ | ---------------- | ---------------- | ---------------------------- | -------------------------------------------------------------- |
| `SELLER_VAT_REGIME_DECLARED_AT_ACTIVATION` | TAX              | per seller       | #964 F25-F27 (patched), R1   | every activated seller has a declaration covering activation   |
| `BILLING_PAYER_DIC_GATE`                   | Billing          | per payer seller | OWNERSHIP §7, LEGAL §6.2     | Billing requires supplier and buyer DIČ on full § 29 documents |
| `BILLING_ISSUANCE_GUARD`                   | Billing          | activation       | OWNERSHIP §4, R2; LEGAL §3   | Billing blocks wrong-regime issuance                           |
| `CATALOG_TAX_PURPOSE_CONTRACT`             | Catalog          | activation       | #964 F24a-d, H12             | Catalog publishes the #926 Tax-purpose evidence contract       |
| `B2C_GROSS_AMOUNT_BASIS_CONTRACT`          | Pricing/Delivery | activation       | Unit 11 decision 2, LEGAL §2 | B2C amounts are published as GROSS under a contract            |
| `D3_CONTRACT_TEXTS_RECONCILED`             | PO               | activation       | LEGAL §2                     | #931 F3, #933 F21 and #935 F14 are reconciled                  |
| `Q5_LAUNCH_FLOWS_DECIDED`                  | PO               | activation       | OWNERSHIP Q5, §4; LEGAL §6.3 | Launch flows and blocked-case handling are decided             |
| `PARTIAL_CREDIT_RULE_APPROVED`             | Legal            | activation       | LEGAL §2, Unit 12 decision 5 | the partial-credit rule is approved                            |
| `LEGAL_L1A`                                | Legal            | activation       | LEGAL §7 q1                  | non-payer sale is a § 50(1) exempt supply                      |
| `LEGAL_L1B`                                | Legal            | activation       | LEGAL §7 q2                  | non-payer invoice statement and DIČ default                    |
| `LEGAL_L2`                                 | Legal            | activation       | LEGAL §7 q3                  | Shipping allocation key                                        |
| `LEGAL_D3A`                                | Legal            | activation       | LEGAL §7 q4                  | VAT per Taxable Supply Unit under § 37 písm. b)                |
| `LEGAL_L3A`                                | Legal            | activation       | LEGAL §7 q5                  | delivery events (DUZP)                                         |
| `LEGAL_L3B`                                | Legal            | activation       | LEGAL §7 q6                  | payment receipt event and evidence                             |
| `LEGAL_Q5A`                                | Legal            | activation       | LEGAL §7 q7                  | advances around the start of payer status                      |
| `LEGAL_Q5B`                                | Legal            | activation       | LEGAL §7 q8                  | payer at T, non-payer at DUZP                                  |
| `LEGAL_Q5C`                                | Legal            | activation       | LEGAL §7 q9                  | taxed advance, then delivery after deregistration              |
| `LEGAL_Q5D`                                | Legal            | activation       | LEGAL §7 q10                 | block, staff confirmation and 15-day issuance                  |
| `LEGAL_L4`                                 | Legal            | activation       | LEGAL §7 q11                 | document field lists and the full § 29 document                |
| `LEGAL_L5`                                 | Legal            | activation       | LEGAL §7 q12                 | identified person treated as a non-payer                       |
| `OWNER_ACCEPTANCE_961`                     | TAX              | activation       | #964 F8-F14                  | a CI run of #961 for the deployed revision                     |
| `OWNER_ACCEPTANCE_962`                     | TAX              | activation       | #964 F8-F14                  | a CI run of #962 for the deployed revision                     |
| `OWNER_ACCEPTANCE_963`                     | TAX              | activation       | #964 F8-F14                  | a CI run of #963 for the deployed revision                     |
| `PRODUCTION_SCOPE_INVENTORY`               | TAX operations   | activation       | #964 F15-F24                 | the reviewed production inventory, no fixture identities       |
| `TAX_RULE_COVERAGE`                        | TAX operations   | activation       | #964 F33-F41                 | complete production rule coverage for payer sellers            |
| `REQUIRED_SOURCE_ROUTES`                   | TAX operations   | activation       | #964 F42-F50                 | required routes are activated ("none required" stated)         |
| `PERMISSIONS_AND_AUDIT`                    | TAX operations   | activation       | #964 F51-F58                 | production permissions and audit are in place                  |
| `MUTATION_RECOVERY`                        | TAX operations   | activation       | #964 F59-F64                 | governed mutation recovery is proven                           |
| `PRIVACY_OWNER_INVENTORY`                  | Privacy          | activation       | #964 F65-F71                 | the Privacy inventory covers TAX data                          |
| `MIGRATION_RECONCILIATION`                 | TAX operations   | activation       | #964 F72-F82                 | migration is READY or stated not applicable                    |
| `UNSUPPORTED_CASES_FAIL_CLOSED`            | TAX              | activation       | #964 F83-F90                 | unsupported cases fail closed                                  |
| `OPERATIONAL_SIGNALS`                      | TAX operations   | activation       | #964 F91-F99                 | non-success and failed-mutation signals exist                  |
| `OPERATIONAL_RUNBOOK`                      | TAX operations   | activation       | #964 F100-F109               | a reviewed runbook exists                                      |
| `DEACTIVATION_PLAN`                        | TAX operations   | activation       | #964 F110-F117               | deactivation keeps one authority and history                   |
