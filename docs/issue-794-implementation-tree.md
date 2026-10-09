# Issue #794 implementation decision tree

Snapshot of the complete GitHub sub-issue tree rooted at
[`#794 B11_INVENTORY`](https://github.com/TechsioCZ/ontos/issues/794), captured on
2026-09-22.

This file is a non-canonical planning report. GitHub issue state and execution-status labels remain
authoritative. Re-check them before starting work.

## Decision rules

- **IMPLEMENT** — the issue is open and has exactly one `status:now` execution label.
- **DO NOT IMPLEMENT — TRACKING** — `status:tracking` is an umbrella/index; separately eligible
  descendants may still be implemented.
- **DO NOT IMPLEMENT — PARKED** — `status:park` is not executable until a product-owner/HITL status
  change.
- **DO NOT IMPLEMENT — LATER** — `status:later` is outside the accepted Launch scope.
- **DO NOT IMPLEMENT — CLOSED** — a closed issue is non-actionable regardless of its old labels.

## Summary

| Decision | Count |
| --- | ---: |
| IMPLEMENT (`status:now`) | 47 |
| DO NOT IMPLEMENT — TRACKING | 12 |
| DO NOT IMPLEMENT — PARKED | 8 |
| DO NOT IMPLEMENT — LATER | 1 |
| DO NOT IMPLEMENT — CLOSED | 1 |
| **Total** | **69** |

## Complete tree

- ❌ [#794 B11_INVENTORY](https://github.com/TechsioCZ/ontos/issues/794) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
  - ❌ [#796 INVENTORY_SCOPE_AND_AUTHORITY](https://github.com/TechsioCZ/ontos/issues/796) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#814 INVENTORY_LAUNCH_SCOPE](https://github.com/TechsioCZ/ontos/issues/814) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#815 INVENTORY_FACT_AND_LIFECYCLE_AUTHORITY](https://github.com/TechsioCZ/ontos/issues/815) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#816 INVENTORY_BACKEND_AND_RESERVATION_BOUNDARY](https://github.com/TechsioCZ/ontos/issues/816) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#817 INVENTORY_RESERVATION_ISSUER](https://github.com/TechsioCZ/ontos/issues/817) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#798 INVENTORY_STOCK_MODEL](https://github.com/TechsioCZ/ontos/issues/798) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#818 INVENTORY_STOCK_ITEM_IDENTITY_AND_LIFECYCLE](https://github.com/TechsioCZ/ontos/issues/818) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#819 INVENTORY_STOCK_LOCATION_AND_SCOPE](https://github.com/TechsioCZ/ontos/issues/819) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#820 INVENTORY_STOCK_POSITION_AND_QUANTITY_MEANING](https://github.com/TechsioCZ/ontos/issues/820) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#821 INVENTORY_SHARED_STOCK_ACROSS_CHANNELS_AND_SELLING_LEGAL_ENTITIES](https://github.com/TechsioCZ/ontos/issues/821) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#801 INVENTORY_CATALOG_TO_STOCK_REQUIREMENTS](https://github.com/TechsioCZ/ontos/issues/801) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#822 INVENTORY_EXACT_SELECTION_STOCK_ITEM_BINDING](https://github.com/TechsioCZ/ontos/issues/822) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#823 INVENTORY_PACKAGE_STOCK_ITEM_BINDING](https://github.com/TechsioCZ/ontos/issues/823) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#824 INVENTORY_FIXED_SET_STOCK_ITEM_BINDING](https://github.com/TechsioCZ/ontos/issues/824) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#825 INVENTORY_CONFIGURATION_STOCK_ITEM_BINDING](https://github.com/TechsioCZ/ontos/issues/825) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ❌ [#826 INVENTORY_SHARED_STOCK_DEMAND_AGGREGATION \[SUPERSEDED\]](https://github.com/TechsioCZ/ontos/issues/826) — state: `CLOSED`; labels: `specified` — **DO NOT IMPLEMENT — CLOSED**
    - ✅ [#827 INVENTORY_SELECTION_STOCK_ITEM_BINDING_AND_FAILURES](https://github.com/TechsioCZ/ontos/issues/827) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#804 INVENTORY_OWNED_STOCK_CHANGES](https://github.com/TechsioCZ/ontos/issues/804) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#828 INVENTORY_STOCK_RECEIPT_AND_ISSUE](https://github.com/TechsioCZ/ontos/issues/828) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ❌ [#829 INVENTORY_STOCK_BLOCK_AND_RELEASE](https://github.com/TechsioCZ/ontos/issues/829) — labels: `specified`, `status:later` — **DO NOT IMPLEMENT — LATER**
    - ✅ [#830 INVENTORY_STOCK_CORRECTION_AND_DISCREPANCY](https://github.com/TechsioCZ/ontos/issues/830) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#831 INVENTORY_STOCK_CHANGE_IMPACT_ON_RESERVATIONS](https://github.com/TechsioCZ/ontos/issues/831) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#806 INVENTORY_EXTERNAL_STOCK_CONTRACTS](https://github.com/TechsioCZ/ontos/issues/806) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#832 INVENTORY_EXTERNAL_STOCK_CORRELATION](https://github.com/TechsioCZ/ontos/issues/832) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#833 INVENTORY_SOURCE_ASSERTION_QUANTITY_AND_COVERAGE](https://github.com/TechsioCZ/ontos/issues/833) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#834 INVENTORY_SOURCE_ORDERING_DUPLICATES_AND_PARTIAL_IMPORT](https://github.com/TechsioCZ/ontos/issues/834) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#835 INVENTORY_SOURCE_ABSENCE_ZERO_AND_CURRENTNESS](https://github.com/TechsioCZ/ontos/issues/835) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#836 INVENTORY_SOURCE_OBLIGATION_AND_PHYSICAL_EFFECT_RECONCILIATION](https://github.com/TechsioCZ/ontos/issues/836) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#837 INVENTORY_EXTERNAL_SOURCE_CONFLICT_RESOLUTION](https://github.com/TechsioCZ/ontos/issues/837) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ❌ [#875 INVENTORY_EXTERNAL_BACKEND_CONFORMANCE_AND_ROUTE](https://github.com/TechsioCZ/ontos/issues/875) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
  - ❌ [#808 INVENTORY_RESERVATION_LIFECYCLE](https://github.com/TechsioCZ/ontos/issues/808) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#838 INVENTORY_RESERVATION_IDENTITY_AND_ORIGIN](https://github.com/TechsioCZ/ontos/issues/838) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#839 INVENTORY_RESERVATION_CREATE_RESULT](https://github.com/TechsioCZ/ontos/issues/839) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#840 INVENTORY_RESERVATION_CONFIRMATION](https://github.com/TechsioCZ/ontos/issues/840) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#841 INVENTORY_RESERVATION_CONFIRMATION_EXPIRY](https://github.com/TechsioCZ/ontos/issues/841) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#842 INVENTORY_RESERVATION_RELEASE](https://github.com/TechsioCZ/ontos/issues/842) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#843 INVENTORY_RESERVATION_AFTER_ORDER_COMMIT](https://github.com/TechsioCZ/ontos/issues/843) — labels: `specified`, `status:now` — **IMPLEMENT**
      - ❌ [#878 INVENTORY_FULFILLMENT_INTEGRATION](https://github.com/TechsioCZ/ontos/issues/878) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
  - ❌ [#810 INVENTORY_RESERVATION_CONSISTENCY_AND_RECOVERY](https://github.com/TechsioCZ/ontos/issues/810) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#844 INVENTORY_CONCURRENT_RESERVATIONS](https://github.com/TechsioCZ/ontos/issues/844) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#845 INVENTORY_RESERVATION_IDEMPOTENCY_AND_CONFLICT](https://github.com/TechsioCZ/ontos/issues/845) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#846 INVENTORY_COMMITMENT_PROTECTION](https://github.com/TechsioCZ/ontos/issues/846) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#847 INVENTORY_INDETERMINATE_RESERVATION_RECOVERY](https://github.com/TechsioCZ/ontos/issues/847) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#848 INVENTORY_PRE_COMMIT_COMPENSATION](https://github.com/TechsioCZ/ontos/issues/848) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#849 INVENTORY_POST_COMMIT_RESERVATION_RECONCILIATION](https://github.com/TechsioCZ/ontos/issues/849) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#850 INVENTORY_CLOSED_ATTEMPT_AND_REPLACEMENT_LINEAGE](https://github.com/TechsioCZ/ontos/issues/850) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#811 INVENTORY_PUBLIC_CONTRACTS_AND_CONSUMERS](https://github.com/TechsioCZ/ontos/issues/811) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#851 INVENTORY_ACTIONS_AND_GOVERNED_READS](https://github.com/TechsioCZ/ontos/issues/851) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#852 INVENTORY_TYPED_OUTCOMES](https://github.com/TechsioCZ/ontos/issues/852) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#853 INVENTORY_STOCK_EVIDENCE_FOR_AVAILABILITY](https://github.com/TechsioCZ/ontos/issues/853) — labels: `specified`, `status:now` — **IMPLEMENT**
      - ❌ [#874 INVENTORY_AVAILABILITY_INTEGRATION](https://github.com/TechsioCZ/ontos/issues/874) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
    - ✅ [#854 INVENTORY_RESERVATION_EVIDENCE_HANDOFF](https://github.com/TechsioCZ/ontos/issues/854) — labels: `specified`, `status:now` — **IMPLEMENT**
      - ❌ [#877 INVENTORY_ORDER_COMMITMENT_INTEGRATION](https://github.com/TechsioCZ/ontos/issues/877) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
    - ✅ [#855 INVENTORY_DOMAIN_EVENTS_AND_OWNER_HANDOFFS](https://github.com/TechsioCZ/ontos/issues/855) — labels: `specified`, `status:now` — **IMPLEMENT**
  - ❌ [#812 INVENTORY_GOVERNANCE_AND_OPERATIONS](https://github.com/TechsioCZ/ontos/issues/812) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#856 INVENTORY_PERMISSIONS_AND_RESOURCE_SCOPE](https://github.com/TechsioCZ/ontos/issues/856) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#857 INVENTORY_AUDIT_AND_HISTORICAL_EVIDENCE](https://github.com/TechsioCZ/ontos/issues/857) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#858 INVENTORY_PRIVACY_OWNER_CONTRACT_ADOPTION](https://github.com/TechsioCZ/ontos/issues/858) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#859 INVENTORY_OPERATOR_RECOVERY_AND_MONITORING](https://github.com/TechsioCZ/ontos/issues/859) — labels: `specified`, `status:now` — **IMPLEMENT**
      - ❌ [#876 INVENTORY_COMMERCE_OPERATIONS_ADOPTION](https://github.com/TechsioCZ/ontos/issues/876) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
  - ❌ [#813 INVENTORY_MIGRATION_AND_ACCEPTANCE](https://github.com/TechsioCZ/ontos/issues/813) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
    - ✅ [#860 INVENTORY_OPENING_STOCK_AND_OPEN_OBLIGATIONS](https://github.com/TechsioCZ/ontos/issues/860) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ✅ [#861 INVENTORY_BACKEND_CUTOVER_AND_RECONCILIATION](https://github.com/TechsioCZ/ontos/issues/861) — labels: `specified`, `status:now` — **IMPLEMENT**
      - ❌ [#881 INVENTORY_FINAL_CUTOVER](https://github.com/TechsioCZ/ontos/issues/881) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
    - ❌ [#862 INVENTORY_CROSS_DOMAIN_ACCEPTANCE](https://github.com/TechsioCZ/ontos/issues/862) — labels: `specified`, `status:tracking` — **DO NOT IMPLEMENT — TRACKING**
      - ❌ [#880 INVENTORY_PRODUCTION_ACCEPTANCE](https://github.com/TechsioCZ/ontos/issues/880) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
      - ✅ [#882 INVENTORY_OWNER_CONTRACT_ACCEPTANCE](https://github.com/TechsioCZ/ontos/issues/882) — labels: `specified`, `status:now` — **IMPLEMENT**
    - ❌ [#879 INVENTORY_MIGRATION_REHEARSAL](https://github.com/TechsioCZ/ontos/issues/879) — labels: `status:park` — **DO NOT IMPLEMENT — PARKED**
