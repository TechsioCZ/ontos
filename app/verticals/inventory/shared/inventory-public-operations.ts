/**
 * Public Inventory owner-contract catalog.
 *
 * This is schema-name and behavior metadata only. It deliberately imports no executable
 * implementation, provider contract, repository, or private deployment source.
 */

export const inventoryPublicOperationBoundaries = [
  {
    key: 'ONE_CONFIGURATION_ONE_BACKEND',
    rule: 'One Customer Configuration selects exactly one Inventory Backend.',
  },
  {
    key: 'OWNER_CONTRACT_ONLY',
    rule: 'Consumers use Inventory owner contracts and never a provider-specific WMS or ERP API.',
  },
  {
    key: 'EXACT_BINDING',
    rule: 'Each supported exact Catalog Selection resolves to one Stock Item or a typed binding-resolution failure.',
  },
  {
    key: 'EXACT_QUANTITY_AND_UNIT',
    rule: 'Inventory preserves exact Quantity and Unit without conversion or Package/Set decomposition.',
  },
  {
    key: 'ONE_RESERVATION_PER_ATTEMPT',
    rule: 'One normal-runtime Attempt has exactly one Reservation, with one or more exact Allocations.',
  },
  {
    key: 'DISTINCT_MUTATION_IDENTITY',
    rule: 'Every mutation uses a distinct stable owner-scoped idempotency identity.',
  },
  {
    key: 'RECOVER_ORIGINAL_IDENTITY',
    rule: 'An indeterminate effect is verified or recovered through its original identity, never a fresh key.',
  },
  {
    key: 'CORRECTION_AUTHORITY_ONLY',
    rule: 'Stock Correction is accepted only where the selected authority permits that correction.',
  },
  {
    key: 'PROTECTION_IS_NOT_CONFIRMATION',
    rule: 'Commitment Protection is an Attempt-bound owner fence distinct from Reservation Confirmation.',
  },
  {
    key: 'TYPED_SOURCE_COVERAGE',
    rule: 'Source-effect coverage uncertainty is typed; arrival order and guessed arithmetic do not establish Current truth.',
  },
  {
    key: 'NO_AUTOMATIC_BACKEND_FALLBACK',
    rule: 'Changing an external backend to OntOS WMS is an explicit cutover, never automatic fallback.',
  },
  {
    key: 'POSITIVE_UNION_SHARING',
    rule: 'Every applicable Current positive sharing relation grants eligibility; there is no DENY or specificity override.',
  },
  {
    key: 'SHARING_CHANGES_NEW_RESERVATIONS_ONLY',
    rule: 'Sharing lifecycle changes affect new Reservations only and never rewrite existing Allocations or history.',
  },
  {
    key: 'NO_AVAILABILITY_CONTRACT',
    rule: 'Inventory publishes governed stock evidence, not customer-facing Availability computation.',
  },
] as const;

export type InventoryPublicOperationBoundaryKey = (typeof inventoryPublicOperationBoundaries)[number]['key'];

export interface InventoryPublicOperationDescriptor {
  readonly authority: string;
  readonly boundaries: readonly InventoryPublicOperationBoundaryKey[];
  readonly businessIntent: string;
  readonly idempotency: {
    readonly identity: string;
    readonly recovery: string;
    readonly retry: string;
  };
  readonly inputPrecision: string;
  readonly key: `commerce.inventory.${string}`;
  readonly kind: 'ACTION' | 'GOVERNED_READ';
  readonly outcomes: {
    readonly sourceSchemaName: `${string}${'ResponseSchema' | 'ResultSchema'}`;
    readonly vocabulary: readonly string[];
  };
  readonly owner: 'commerce.inventory';
  readonly safeCallerNextSteps: readonly string[];
  readonly scopeSubject: string;
}

const INVENTORY_OWNER = 'commerce.inventory' as const;
const CATALOG_BINDING_SCOPE = 'Exact Catalog Selection -> Stock Item relation';
const EXTERNAL_CORRELATION_SCOPE = 'Qualified external key -> exact Inventory target correlation';
const STOCK_SHARING_SCOPE = 'Exact Stock Position -> Selling Legal Entity + Channel (+ optional Market/Storefront)';

export const inventoryPublicActionContracts = [
  {
    authority: 'Inventory owns the Customer Configuration selection and cutover evidence.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'OWNER_CONTRACT_ONLY', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Select the one authoritative Inventory Backend for one Customer Configuration.',
    idempotency: {
      identity: 'One owner-scoped selection mutation identity for the exact Customer Configuration and selection.',
      recovery: 'A conflicting selection becomes typed conflict/cutover evidence; a fallback is never fabricated.',
      retry: 'Retry the same identity and payload; an exact committed selection is an exact replay.',
    },
    inputPrecision: 'Exact Customer Configuration and complete backend capability selection.',
    key: 'commerce.inventory.select-inventory-backend',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'SelectInventoryBackendResultSchema',
      vocabulary: ['SELECTED', 'EXACT_REPLAY', 'BACKEND_CONFIGURATION_CONFLICT'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Continue only with the returned Current configuration.', 'Resolve conflict before cutover.'],
    scopeSubject: 'Customer Configuration',
  },
  {
    authority:
      'The selected external Inventory Backend supplies qualified source evidence; Inventory owns import truth.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'OWNER_CONTRACT_ONLY', 'TYPED_SOURCE_COVERAGE'],
    businessIntent: 'Import a qualified external source assertion without inferring Current truth from arrival order.',
    idempotency: {
      identity: 'One import identity for the exact issuer/backend origin, source revision, scope, and assertion.',
      recovery: 'Indeterminate source coverage remains reconciliation evidence under the original import identity.',
      retry: 'Retry the same identity and assertion; never synthesize a newer revision or alternate source.',
    },
    inputPrecision:
      'Exact correlated Stock Position, Stock Item, Stock Location, Unit, coverage, and source ordering evidence.',
    key: 'commerce.inventory.import-source-assertion',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'ImportSourceAssertionResultSchema',
      vocabulary: ['IMPORTED', 'EXACT_REPLAY', 'CONFLICT_RECORDED', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use only determinate Current evidence.', 'Reconcile typed conflicts or uncertainty.'],
    scopeSubject: 'External source assertion for one exact Stock Position',
  },
  {
    authority: 'Inventory resolves its durable source conflict; no provider write is exposed.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'TYPED_SOURCE_COVERAGE', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Resolve one exact Inventory source conflict using owner-qualified evidence.',
    idempotency: {
      identity: 'One resolution mutation identity for the exact conflict and proposed owner resolution.',
      recovery: 'Re-read the original conflict outcome; never bypass it with a fresh conflict identity.',
      retry: 'Retry the same identity and resolution proposal only.',
    },
    inputPrecision: 'Exact conflict ResourceRef, expected revision, resolution proposal, and evidence.',
    key: 'commerce.inventory.resolve-inventory-source-conflict',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'ResolveInventorySourceConflictResultSchema', vocabulary: ['RESOLVED'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Refresh the governed affected-resource read.', 'Stop on a typed stale/conflict outcome.'],
    scopeSubject: 'Inventory Source Conflict',
  },
  {
    authority: 'Inventory owns cleanup of its pre-commit Reservation effect under authoritative Order truth.',
    boundaries: ['ONE_RESERVATION_PER_ATTEMPT', 'DISTINCT_MUTATION_IDENTITY', 'RECOVER_ORIGINAL_IDENTITY'],
    businessIntent:
      'Compensate one exact pre-commit Reservation when final Order commit did not establish an obligation.',
    idempotency: {
      identity: 'One compensation mutation identity tied to the original Attempt and Reservation.',
      recovery: 'Uncertain release remains attached to the original release effect identity.',
      retry: 'Retry only after authoritative Order and protection truth is re-established.',
    },
    inputPrecision: 'Exact Attempt, Reservation, original allocation scope, and authoritative non-commit evidence.',
    key: 'commerce.inventory.compensate-inventory-pre-commit',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'CompensateInventoryPreCommitResultSchema',
      vocabulary: ['NO_CLEANUP_REQUIRED', 'RELEASED', 'ALREADY_RELEASED', 'RECONCILIATION_REQUIRED'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Close the predecessor only after definite release.',
      'Reconcile uncertain cleanup before replacement.',
    ],
    scopeSubject: 'Original Attempt + provisional Reservation',
  },
  {
    authority: 'The selected backend establishes the exact Reservation; Inventory owns the durable request and result.',
    boundaries: [
      'ONE_CONFIGURATION_ONE_BACKEND',
      'EXACT_BINDING',
      'EXACT_QUANTITY_AND_UNIT',
      'ONE_RESERVATION_PER_ATTEMPT',
      'DISTINCT_MUTATION_IDENTITY',
      'RECOVER_ORIGINAL_IDENTITY',
    ],
    businessIntent: 'Establish or recover the one exact Reservation whose Allocations cover every Attempt requirement.',
    idempotency: {
      identity: 'One create effect and mutation identity for the one Reservation bound to the normal-runtime Attempt.',
      recovery: 'INDETERMINATE is recovered only through that original create effect identity.',
      retry: 'Retry the same exact request; a replacement requires safe predecessor closure and a new Attempt.',
    },
    inputPrecision: 'Exact Stock Item + Quantity + Unit requirements and 1..N exact Stock Position allocations.',
    key: 'commerce.inventory.create-inventory-reservation',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'CreateInventoryReservationResultSchema',
      vocabulary: [
        'PENDING',
        'ESTABLISHED',
        'EXACT_REPLAY',
        'RECONCILIATION_REQUIRED',
        'INDETERMINATE',
        'RESOLVED_NO_RESERVATION',
      ],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Proceed to Confirmation only when ESTABLISHED.',
      'Recover the original effect when unresolved or indeterminate.',
      'Create a new Attempt only after safe predecessor closure.',
    ],
    scopeSubject: 'Normal-runtime Attempt + exact Reservation + Allocations',
  },
  {
    authority: 'The selected backend releases only after Inventory verifies authoritative owner and Order truth.',
    boundaries: ['ONE_RESERVATION_PER_ATTEMPT', 'DISTINCT_MUTATION_IDENTITY', 'RECOVER_ORIGINAL_IDENTITY'],
    businessIntent: 'Release one whole provisional Reservation when owner and Order truth prove release is safe.',
    idempotency: {
      identity: 'One release effect and mutation identity for the whole original Reservation.',
      recovery: 'INDETERMINATE remains attached to the original release effect identity.',
      retry: 'Retry the same whole-release identity; partial release and renewed Confirmation are forbidden.',
    },
    inputPrecision: 'Exact Reservation + Attempt; whole-reservation scope only.',
    key: 'commerce.inventory.release-inventory-reservation',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'ReleaseInventoryReservationResultSchema',
      vocabulary: ['PENDING', 'RELEASED', 'ALREADY_RELEASED', 'NOT_RELEASABLE', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Close the predecessor on definite release.',
      'Reconcile original release before replacement.',
    ],
    scopeSubject: 'Whole provisional Reservation + original Attempt',
  },
  {
    authority: 'Inventory establishes the selected-backend owner fence immediately before final Order commit.',
    boundaries: [
      'ONE_RESERVATION_PER_ATTEMPT',
      'DISTINCT_MUTATION_IDENTITY',
      'RECOVER_ORIGINAL_IDENTITY',
      'PROTECTION_IS_NOT_CONFIRMATION',
    ],
    businessIntent: 'Establish exact Reservation + Attempt-bound Commitment Protection before final Order commit.',
    idempotency: {
      identity: 'One protection effect identity for the exact Reservation and Attempt.',
      recovery: 'Uncertain establishment is recovered only through the original protection identity.',
      retry: 'Retry the same identity while the verified Confirmation and owner fence remain valid.',
    },
    inputPrecision: 'Exact Reservation, Attempt, Confirmation, backend authority, and observed owner-health instant.',
    key: 'commerce.inventory.establish-commitment-protection',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'EstablishCommitmentProtectionResultSchema',
      vocabulary: ['PROTECTED', 'AT_RISK', 'INDETERMINATE', 'NOT_PROTECTABLE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Commit only when PROTECTED.',
      'Reconcile AT_RISK or INDETERMINATE.',
      'Stop when NOT_PROTECTABLE.',
    ],
    scopeSubject: 'Exact Reservation + Attempt Commitment Protection',
  },
  {
    authority: 'The selected Inventory Backend performs the authoritative inbound physical change when permitted.',
    boundaries: [
      'ONE_CONFIGURATION_ONE_BACKEND',
      'OWNER_CONTRACT_ONLY',
      'EXACT_QUANTITY_AND_UNIT',
      'RECOVER_ORIGINAL_IDENTITY',
    ],
    businessIntent: 'Request one authoritative inbound physical Stock Receipt.',
    idempotency: {
      identity: 'One owner-scoped receipt effect identity for the exact physical change.',
      recovery: 'An indeterminate receipt is recovered through its original effect identity.',
      retry: 'Retry the same Stock Position, Quantity, Unit, reason, and effect identity.',
    },
    inputPrecision: 'Exact Stock Position, Stock Item, Stock Location, positive Quantity, and Unit.',
    key: 'commerce.inventory.stock-receipt',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'StockReceiptResultSchema',
      vocabulary: ['REQUESTED', 'APPLIED', 'REJECTED', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Use APPLIED evidence.',
      'Stop on REJECTED.',
      'Recover the original effect on INDETERMINATE.',
    ],
    scopeSubject: 'Exact Stock Position physical inbound effect',
  },
  {
    authority: 'The selected Inventory Backend performs the authoritative physical decrease when permitted.',
    boundaries: [
      'ONE_CONFIGURATION_ONE_BACKEND',
      'OWNER_CONTRACT_ONLY',
      'EXACT_QUANTITY_AND_UNIT',
      'RECOVER_ORIGINAL_IDENTITY',
    ],
    businessIntent: 'Request one authoritative physical Stock Issue; Fulfillment trigger remains downstream.',
    idempotency: {
      identity: 'One owner-scoped issue effect identity for the exact physical change.',
      recovery: 'An indeterminate issue is recovered through its original effect identity.',
      retry: 'Retry the same Stock Position, Quantity, Unit, reason, and effect identity.',
    },
    inputPrecision: 'Exact Stock Position, Stock Item, Stock Location, positive Quantity, and Unit.',
    key: 'commerce.inventory.stock-issue',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'StockIssueResultSchema',
      vocabulary: ['REQUESTED', 'APPLIED', 'REJECTED', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Use APPLIED evidence.',
      'Stop on REJECTED.',
      'Recover the original effect on INDETERMINATE.',
    ],
    scopeSubject: 'Exact Stock Position physical outbound effect',
  },
  {
    authority:
      'Only the selected backend authority may establish corrected absolute ON_HAND from still-current evidence.',
    boundaries: [
      'ONE_CONFIGURATION_ONE_BACKEND',
      'EXACT_QUANTITY_AND_UNIT',
      'CORRECTION_AUTHORITY_ONLY',
      'TYPED_SOURCE_COVERAGE',
      'NO_AUTOMATIC_BACKEND_FALLBACK',
    ],
    businessIntent: 'Establish corrected absolute ON_HAND for one Stock Position in an authority-permitted scope.',
    idempotency: {
      identity: 'One correction effect identity for the exact Position, absolute Quantity + Unit, and source evidence.',
      recovery: 'Indeterminate correction remains under its original correction identity.',
      retry: 'Retry the same correction only while its exact source evidence remains owner-valid.',
    },
    inputPrecision:
      'Exact Stock Position, Stock Item, Stock Location, absolute ON_HAND Quantity + Unit, and source evidence.',
    key: 'commerce.inventory.correct-stock-position',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'CorrectStockPositionResultSchema',
      vocabulary: ['APPLIED', 'EXACT_REPLAY', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use APPLIED Current evidence.', 'Reconcile INDETERMINATE.', 'Stop on authority rejection.'],
    scopeSubject: 'Exact Stock Position absolute ON_HAND correction',
  },
  {
    authority: 'Inventory owns the Selection-to-Stock Item relation under the selected Customer Configuration.',
    boundaries: ['EXACT_BINDING', 'DISTINCT_MUTATION_IDENTITY'],
    businessIntent: 'Establish one explicit exact Catalog Selection to Stock Item binding.',
    idempotency: {
      identity: 'One lifecycle mutation identity for the exact binding ResourceRef and candidate.',
      recovery: 'Read the exact binding after uncertainty; never infer from SKU, Product, or stock.',
      retry: 'Retry the same candidate and identity; use Correct for a new Current relation.',
    },
    inputPrecision:
      'Exact Catalog Selection identity, Stock Item, Unit meaning, configuration, and lifecycle evidence.',
    key: 'commerce.inventory.establish-catalog-to-stock-binding',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EstablishCatalogToStockBindingResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Resolve through the governed binding read.', 'Stop on typed scope or uniqueness rejection.'],
    scopeSubject: CATALOG_BINDING_SCOPE,
  },
  {
    authority: 'Inventory owns correction of its explicit Selection-to-Stock Item relation.',
    boundaries: ['EXACT_BINDING', 'DISTINCT_MUTATION_IDENTITY'],
    businessIntent: 'Correct one Current exact Catalog Selection to Stock Item binding with preserved history.',
    idempotency: {
      identity: 'One correction identity for the exact binding and expected revision.',
      recovery: 'Read the exact binding revision after uncertainty; never silently replace it.',
      retry: 'Retry the same expected revision and candidate only.',
    },
    inputPrecision: 'Exact binding ResourceRef, expected revision, corrected Stock Item/Unit meaning, and evidence.',
    key: 'commerce.inventory.correct-catalog-to-stock-binding',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'CorrectCatalogToStockBindingResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use the returned revision.', 'Refresh and decide explicitly on a typed revision conflict.'],
    scopeSubject: CATALOG_BINDING_SCOPE,
  },
  {
    authority: 'Inventory owns ending its explicit Selection-to-Stock Item relation.',
    boundaries: ['EXACT_BINDING', 'DISTINCT_MUTATION_IDENTITY'],
    businessIntent: 'End one Current exact Catalog Selection to Stock Item binding without erasing history.',
    idempotency: {
      identity: 'One end identity for the exact binding and expected revision.',
      recovery: 'Read the exact lifecycle state after uncertainty.',
      retry: 'Retry the same end identity and evidence; do not create a replacement implicitly.',
    },
    inputPrecision: 'Exact binding ResourceRef, expected revision, end instant, and lifecycle evidence.',
    key: 'commerce.inventory.end-catalog-to-stock-binding',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EndCatalogToStockBindingResultSchema', vocabulary: ['ENDED'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Treat future resolution as a typed non-success until explicitly re-established.'],
    scopeSubject: CATALOG_BINDING_SCOPE,
  },
  {
    authority: 'Inventory owns the qualified external-key correlation and preserves its issuer/backend origin.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'DISTINCT_MUTATION_IDENTITY', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Establish one qualified external stock correlation.',
    idempotency: {
      identity: 'One lifecycle identity for the exact correlation ResourceRef and qualified external key.',
      recovery: 'Read the exact correlation after uncertainty; Current backend selection never rewrites key identity.',
      retry: 'Retry the same origin, namespace/scope, identifier kind, external value, and target.',
    },
    inputPrecision: 'Exact issuer/backend origin + namespace/scope + identifier kind + external ID value + target.',
    key: 'commerce.inventory.establish-external-stock-correlation',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EstablishExternalStockCorrelationResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use only the returned exact correlation.', 'Stop on ambiguous or conflicting identity.'],
    scopeSubject: EXTERNAL_CORRELATION_SCOPE,
  },
  {
    authority: 'Inventory owns correction of the qualified external-key correlation.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'DISTINCT_MUTATION_IDENTITY', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Correct one Current qualified external stock correlation while preserving history.',
    idempotency: {
      identity: 'One correction identity for the exact correlation and expected revision.',
      recovery: 'Read the exact correlation revision after uncertainty.',
      retry: 'Retry the same qualified identity, target, expected revision, and evidence.',
    },
    inputPrecision:
      'Exact correlation ResourceRef, immutable qualified key origin, corrected target, and expected revision.',
    key: 'commerce.inventory.correct-external-stock-correlation',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'CorrectExternalStockCorrelationResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use the returned revision.', 'Resolve a typed collision explicitly.'],
    scopeSubject: EXTERNAL_CORRELATION_SCOPE,
  },
  {
    authority: 'Inventory owns ending the qualified external-key correlation.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'DISTINCT_MUTATION_IDENTITY', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'End one Current qualified external stock correlation without erasing historical identity.',
    idempotency: {
      identity: 'One end identity for the exact correlation and expected revision.',
      recovery: 'Use authorized ended-correlation evidence lookup after uncertainty.',
      retry: 'Retry the same end identity and evidence only.',
    },
    inputPrecision: 'Exact correlation ResourceRef, expected revision, end instant, and evidence.',
    key: 'commerce.inventory.end-external-stock-correlation',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EndExternalStockCorrelationResultSchema', vocabulary: ['ENDED'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Stop using the external key for Current resolution.',
      'Use authorized history for reconciliation.',
    ],
    scopeSubject: EXTERNAL_CORRELATION_SCOPE,
  },
  {
    authority: 'Inventory owns the positive relation after validating the trusted Commerce scope.',
    boundaries: ['DISTINCT_MUTATION_IDENTITY', 'POSITIVE_UNION_SHARING', 'SHARING_CHANGES_NEW_RESERVATIONS_ONLY'],
    businessIntent: 'Establish one Current positive Stock Sharing Eligibility relation.',
    idempotency: {
      identity: 'One lifecycle identity for the exact Position and Commerce subject relation.',
      recovery: 'Re-read the exact relation; never infer a DENY or broader Sales Context Resource.',
      retry: 'Retry the same relation identity and scope evidence.',
    },
    inputPrecision: 'Exact Position + required Selling Legal Entity + Channel + optional Market and/or Storefront.',
    key: 'commerce.inventory.establish-stock-sharing-eligibility',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EstablishStockSharingEligibilityResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Evaluate trusted Current purchase context through the governed positive-union read.'],
    scopeSubject: STOCK_SHARING_SCOPE,
  },
  {
    authority: 'Inventory owns changes to the positive relation after validating trusted Commerce scope.',
    boundaries: ['DISTINCT_MUTATION_IDENTITY', 'POSITIVE_UNION_SHARING', 'SHARING_CHANGES_NEW_RESERVATIONS_ONLY'],
    businessIntent: 'Change one Current positive Stock Sharing Eligibility relation with preserved history.',
    idempotency: {
      identity: 'One change identity for the exact relation and expected revision.',
      recovery: 'Re-read the exact relation revision after uncertainty.',
      retry: 'Retry the same subject, expected revision, and evidence.',
    },
    inputPrecision: 'Exact relation + Position + required Selling Legal Entity + Channel + optional restrictions.',
    key: 'commerce.inventory.change-stock-sharing-eligibility',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'ChangeStockSharingEligibilityResultSchema', vocabulary: ['CURRENT'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Apply the new relation only to new Reservations.',
      'Preserve existing Allocations and history.',
    ],
    scopeSubject: STOCK_SHARING_SCOPE,
  },
  {
    authority: 'Inventory owns ending one positive relation; other applicable Current relations remain effective.',
    boundaries: ['DISTINCT_MUTATION_IDENTITY', 'POSITIVE_UNION_SHARING', 'SHARING_CHANGES_NEW_RESERVATIONS_ONLY'],
    businessIntent: 'End one Current positive Stock Sharing Eligibility relation without creating a DENY.',
    idempotency: {
      identity: 'One end identity for the exact relation and expected revision.',
      recovery: 'Re-read the exact relation and positive-union result after uncertainty.',
      retry: 'Retry the same end identity and evidence only.',
    },
    inputPrecision: 'Exact relation ResourceRef and end evidence for its Selling Legal Entity + Channel subject.',
    key: 'commerce.inventory.end-stock-sharing-eligibility',
    kind: 'ACTION',
    outcomes: { sourceSchemaName: 'EndStockSharingEligibilityResultSchema', vocabulary: ['ENDED'] },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Re-evaluate positive-union eligibility.',
      'Do not revoke access proven by another applicable relation.',
    ],
    scopeSubject: STOCK_SHARING_SCOPE,
  },
  {
    authority: 'Inventory consults the original selected-backend owner recovery adapter for the exact durable target.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'OWNER_CONTRACT_ONLY', 'RECOVER_ORIGINAL_IDENTITY'],
    businessIntent: 'Resolve one uncertain Inventory effect using its original owner-scoped identity and intent.',
    idempotency: {
      identity: 'The original effect ID, kind, target, backend, scope, and intent are immutable recovery identity.',
      recovery:
        'Recovery can prove original success, definitive non-effect, existing terminal state, or continuing uncertainty.',
      retry: 'Repeat only the same original effect identity; a fresh key is a different mutation, not recovery.',
    },
    inputPrecision:
      'Exact original effect ID + kind + durable target ResourceRef; original stored intent remains authoritative.',
    key: 'commerce.inventory.recover-inventory-effect',
    kind: 'ACTION',
    outcomes: {
      sourceSchemaName: 'RecoverInventoryEffectResultSchema',
      vocabulary: ['RECOVERED', 'DEFINITIVE_NON_EFFECT', 'ALREADY_TERMINAL', 'INDETERMINATE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Continue only on proven success.',
      'Stop on definitive non-effect/rejection.',
      'Retry original recovery on INDETERMINATE.',
    ],
    scopeSubject: 'Original owner-scoped Inventory Effect + exact durable target',
  },
] as const satisfies readonly InventoryPublicOperationDescriptor[];

export const inventoryGovernedReadContracts = [
  {
    authority: 'Inventory resolves its owner-governed Current binding under the selected Customer Configuration.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'EXACT_BINDING'],
    businessIntent: 'Resolve one supported exact Catalog Selection to its one Current Stock Item binding.',
    idempotency: {
      identity: 'The read identity is the exact Customer Configuration and Catalog Selection demand.',
      recovery: 'Unavailable or ambiguous resolution is re-read; no guessed binding is cached as truth.',
      retry: 'Repeat the same governed read after the typed cause changes.',
    },
    inputPrecision: 'Exact Catalog Selection, Quantity, Unit, occurrence, and Customer Configuration.',
    key: 'commerce.inventory.api.catalog-to-stock-binding-resolution',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'CatalogToStockBindingResolutionResponseSchema',
      vocabulary: ['RESOLVED', 'AMBIGUOUS', 'UNSUPPORTED', 'UNAVAILABLE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Use the exact resolved Stock Item.',
      'Invoke an explicit binding lifecycle Action on typed failure.',
    ],
    scopeSubject: 'Exact Catalog Selection -> Stock Item binding',
  },
  {
    authority: 'Inventory evaluates Current positive relations against trusted Commerce-owner context evidence.',
    boundaries: ['POSITIVE_UNION_SHARING', 'SHARING_CHANGES_NEW_RESERVATIONS_ONLY'],
    businessIntent: 'Resolve Current Stock Sharing Eligibility for one Position and trusted Current purchase context.',
    idempotency: {
      identity: 'The read identity is the exact Position plus trusted Current Commerce context evidence.',
      recovery: 'Unverifiable evidence cannot fabricate eligibility; obtain fresh trusted evidence and re-read.',
      retry: 'Repeat the same governed read with Current owner evidence.',
    },
    inputPrecision:
      'Exact Position + required Selling Legal Entity + Channel + every specified Market/Storefront restriction.',
    key: 'commerce.inventory.api.stock-sharing-eligibility-resolution',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'StockSharingEligibilityResolutionResponseSchema',
      vocabulary: ['ELIGIBLE', 'NO_APPLICABLE_RELATION', 'UNVERIFIABLE'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Permit this gate when at least one applicable Current positive relation is proven.',
      'Otherwise stop or refresh evidence.',
    ],
    scopeSubject: 'Exact Stock Position + trusted Selling Legal Entity + Channel purchase context',
  },
  {
    authority: 'Inventory returns owner-governed evidence for the exact durable Stock Position identity.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'TYPED_SOURCE_COVERAGE', 'NO_AVAILABILITY_CONTRACT'],
    businessIntent: 'Read Current stock evidence for one exact durable Stock Position without computing Availability.',
    idempotency: {
      identity: 'The read identity is the exact Stock Position ResourceRef.',
      recovery: 'Missing, stale, or unverifiable evidence remains typed and is refreshed through owner contracts.',
      retry: 'Repeat the same governed read after owner evidence changes.',
    },
    inputPrecision: 'Exact Stock Position ResourceRef; never ad-hoc (Stock Item, Stock Location) identity.',
    key: 'commerce.inventory.api.current-stock-evidence-for-availability',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'CurrentStockEvidenceForAvailabilityResponseSchema',
      vocabulary: [
        'STOCK_EVIDENCE_ONLY',
        'OWNER_MANAGED',
        'EXTERNAL_SOURCE_ASSERTION',
        'MISSING',
        'EXACT',
        'INDETERMINATE',
      ],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Apply caller-owned Availability policy.',
      'Do not infer reusable stock from unresolved effects or missing source evidence.',
    ],
    scopeSubject: 'Exact durable Stock Position ResourceRef',
  },
  {
    authority: 'Inventory owns and returns the one Current backend selection for the Customer Configuration.',
    boundaries: ['ONE_CONFIGURATION_ONE_BACKEND', 'OWNER_CONTRACT_ONLY', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Read the Current authoritative Inventory Backend selection for one Customer Configuration.',
    idempotency: {
      identity: 'The read identity is the exact Customer Configuration.',
      recovery: 'Missing or unavailable configuration remains typed; callers never infer or substitute a backend.',
      retry: 'Repeat the same governed read after the owner configuration changes or becomes available.',
    },
    inputPrecision: 'Exact Customer Configuration identifier in the authenticated Tenant scope.',
    key: 'commerce.inventory.api.inventory-backend-configuration-current',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'InventoryBackendConfigurationCurrentResponseSchema',
      vocabulary: ['CURRENT_CONFIGURATION'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Use only the returned Current backend configuration.',
      'Stop when no Current configuration exists.',
    ],
    scopeSubject: 'Exact Customer Configuration backend selection',
  },
  {
    authority: 'Inventory returns the Current owner record for the exact Reservation.',
    boundaries: ['ONE_RESERVATION_PER_ATTEMPT', 'EXACT_QUANTITY_AND_UNIT'],
    businessIntent: 'Read one exact provisional Reservation or runtime committed obligation.',
    idempotency: {
      identity: 'The read identity is the exact Reservation ResourceRef.',
      recovery: 'A typed unavailable/conflict result is re-read; callers do not reconstruct Reservation truth.',
      retry: 'Repeat the same governed read after owner state settles.',
    },
    inputPrecision: 'Exact Reservation ResourceRef with preserved Allocations, Stock Items, Quantities, and Units.',
    key: 'commerce.inventory.api.inventory-reservation-detail',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'InventoryReservationDetailResponseSchema',
      vocabulary: ['PROVISIONAL_RESERVATION', 'COMMITTED_OBLIGATION'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Use the returned owner state.', 'Verify Confirmation separately before protection.'],
    scopeSubject: 'Exact Reservation ResourceRef',
  },
  {
    authority: 'Inventory returns the exact durable source conflict and its owner-qualified reconciliation evidence.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'TYPED_SOURCE_COVERAGE', 'NO_AUTOMATIC_BACKEND_FALLBACK'],
    businessIntent: 'Read one exact Inventory Source Conflict without exposing provider-private state.',
    idempotency: {
      identity: 'The read identity is the exact Inventory Source Conflict ResourceRef.',
      recovery: 'Missing or unavailable conflict evidence remains typed; callers never reconstruct conflict truth.',
      retry: 'Repeat the same governed read after owner evidence or conflict state changes.',
    },
    inputPrecision: 'Exact Inventory Source Conflict ResourceRef in the authenticated Tenant scope.',
    key: 'commerce.inventory.api.inventory-source-conflict-detail',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'InventorySourceConflictDetailResponseSchema',
      vocabulary: ['OPEN', 'RESOLVED'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Resolve only an OPEN conflict through the owning Action.',
      'Use RESOLVED evidence as immutable reconciliation history.',
    ],
    scopeSubject: 'Exact Inventory Source Conflict ResourceRef',
  },
  {
    authority: 'Inventory evaluates owner Confirmation health for the exact Reservation + Attempt.',
    boundaries: ['ONE_RESERVATION_PER_ATTEMPT', 'PROTECTION_IS_NOT_CONFIRMATION'],
    businessIntent: 'Verify Current Reservation Confirmation and readiness for Commitment Protection.',
    idempotency: {
      identity: 'The read identity is the exact Confirmation + Reservation + Attempt at the evaluation instant.',
      recovery: 'Expired or terminal Confirmation is not renewed by this read.',
      retry: 'Repeat with Current owner evidence; use a new Attempt only after safe predecessor closure.',
    },
    inputPrecision: 'Exact Confirmation ResourceRef, Reservation ResourceRef, Attempt, and evaluation instant.',
    key: 'commerce.inventory.api.reservation-confirmation-verification',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'ReservationConfirmationVerificationResponseSchema',
      vocabulary: ['READY_TO_ESTABLISH_PROTECTION', 'NOT_READY', 'TERMINAL_READINESS_LOSS'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Establish protection only when ready.', 'Resolve predecessor before a replacement Attempt.'],
    scopeSubject: 'Exact Reservation + Attempt + Confirmation',
  },
  {
    authority: 'Inventory verifies the Current selected-backend protection fence for the exact Reservation + Attempt.',
    boundaries: ['ONE_RESERVATION_PER_ATTEMPT', 'PROTECTION_IS_NOT_CONFIRMATION'],
    businessIntent: 'Verify Commitment Protection immediately before the caller relies on the owner fence.',
    idempotency: {
      identity: 'The read identity is the exact Protection + Reservation + Attempt.',
      recovery: 'AT_RISK is reconciled; verification never upgrades or backdates protection.',
      retry: 'Repeat the exact governed read with Current owner evidence.',
    },
    inputPrecision: 'Exact Protection ResourceRef, Reservation ResourceRef, and Attempt.',
    key: 'commerce.inventory.api.commitment-protection-verification',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'CommitmentProtectionVerificationResponseSchema',
      vocabulary: ['PROTECTED', 'AT_RISK'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: ['Continue only when PROTECTED.', 'Reconcile when AT_RISK.'],
    scopeSubject: 'Exact Reservation + Attempt Commitment Protection',
  },
  {
    authority: 'Inventory resolves its durable effect ledger using the original immutable owner intent.',
    boundaries: ['RECOVER_ORIGINAL_IDENTITY', 'OWNER_CONTRACT_ONLY'],
    businessIntent: 'Resolve one Inventory Effect outcome by original owner-scoped idempotency identity.',
    idempotency: {
      identity: 'The read identity is the original effect ID plus the exact immutable stored intent.',
      recovery: 'UNRESOLVED or INDETERMINATE directs recovery of the same original effect identity.',
      retry: 'Repeat the same governed read; never substitute a fresh mutation key.',
    },
    inputPrecision: 'Exact original effect ID and original owner intent.',
    key: 'commerce.inventory.api.inventory-effect-outcome',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'InventoryEffectOutcomeResponseSchema',
      vocabulary: ['UNRESOLVED', 'INDETERMINATE', 'RESOLVED'],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Recover only the original effect identity when unresolved or indeterminate.',
      'Continue or stop only from the terminal owner result.',
    ],
    scopeSubject: 'Original owner-scoped Inventory Effect identity + intent',
  },
  {
    authority:
      'Inventory exposes bounded authorized history and reconciliation evidence for its exact owner resources.',
    boundaries: ['OWNER_CONTRACT_ONLY', 'RECOVER_ORIGINAL_IDENTITY', 'TYPED_SOURCE_COVERAGE'],
    businessIntent: 'Look up authorized historical or reconciliation evidence for one exact Inventory owner subject.',
    idempotency: {
      identity: 'The read identity is the exact requested evidence kind and owner ResourceRef/effect identity.',
      recovery: 'Unavailable evidence remains typed; callers neither scrape private history nor infer missing truth.',
      retry: 'Repeat the same bounded governed read after evidence becomes available.',
    },
    inputPrecision:
      'Exact binding, ended correlation, sharing, Confirmation, Protection, effect, or conflict identity.',
    key: 'commerce.inventory.api.inventory-reconciliation-evidence',
    kind: 'GOVERNED_READ',
    outcomes: {
      sourceSchemaName: 'InventoryReconciliationEvidenceResponseSchema',
      vocabulary: [
        'BINDING_HISTORY',
        'ENDED_CORRELATION',
        'SHARING_HISTORY',
        'CONFIRMATION_HISTORY',
        'PROTECTION_HISTORY',
        'EFFECT_OUTCOME',
        'SOURCE_CONFLICT_DETAIL',
      ],
    },
    owner: INVENTORY_OWNER,
    safeCallerNextSteps: [
      'Use evidence only for its declared reconciliation subject.',
      'Use the owning mutation/recovery Action for any state change.',
    ],
    scopeSubject: 'Exact authorized historical or reconciliation evidence subject',
  },
] as const satisfies readonly InventoryPublicOperationDescriptor[];

export const inventoryPublicOperations = [
  ...inventoryPublicActionContracts,
  ...inventoryGovernedReadContracts,
] as const satisfies readonly InventoryPublicOperationDescriptor[];
