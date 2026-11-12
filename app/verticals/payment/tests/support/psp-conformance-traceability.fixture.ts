/**
 * #1159 required traceability: accepted Payment rule -> provider capability evidence -> adapter mapping -> test ->
 * expected Payment observation, one row per requirement of #1159 ("Minimum matrix", "Audit closure", "Mandatory
 * negative/race coverage", the gherkin scenarios of #1153-#1159) and per plan section 6 level-3 scenario.
 *
 * `ran` lists the evidence levels that actually ran for the row, derived from where its cited tests live (`levelOf`):
 * `unit`, `fixture` (level 2, production adapters over recorded documented provider bodies) or `native` (level 3,
 * native PostgreSQL + Core runtime boundary). A fixture is never sandbox or native evidence. Level-4 provider sandbox evidence is NOT RUN:
 * no sandbox credentials were present (plan N13). `psp-conformance-traceability.test.ts` checks every cited test
 * exists, every requirement has a row, every level claim matches where its tests live, and the README table.
 */

export const EVIDENCE_LEVELS = ['unit', 'fixture', 'native'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const SANDBOX_NOT_RUN = 'NOT RUN (credentials absent)';
export const SANDBOX_NOT_APPLICABLE = 'not applicable';
export type SandboxStatus = typeof SANDBOX_NOT_APPLICABLE | typeof SANDBOX_NOT_RUN;

/** A test by repository path (from `app/`) and the exact title text as written in its source. */
export interface TracedTest {
  readonly file: string;
  readonly title: string;
}

export interface TraceRow {
  /** Provider capability evidence: the documented provider behaviour the mapping relies on. */
  readonly capability: string;
  readonly expected: string;
  readonly id: string;
  /** What is not proven by the tests that ran. */
  readonly limits: string;
  /** Adopted adapter mapping (module under `src/`). */
  readonly mapping: string;
  /** Derived from where the cited tests run (see `levelOf`); never written by hand. */
  readonly ran: readonly EvidenceLevel[];
  /** The requirement text, quoted or condensed from its issue. */
  readonly requirement: string;
  /** Accepted Payment rule. */
  readonly rule: string;
  readonly sandbox: SandboxStatus;
  readonly tests: readonly TracedTest[];
}

const P = 'verticals/payment/tests';
const MATRIX = `${P}/unit/psp-conformance-matrix.test.ts`;
const CHAIN = `${P}/integration/psp-gateway-chain-native-postgres.test.ts`;
const SHELL = 'apps/shell-super-app/tests/integration/payment-self-registered-workload-probe.test.ts';
const CORE_OUTBOX = 'packages/core-runtime/tests/integration/outbox-runtime.test.ts';

const u = (file: string, title: string): TracedTest => ({ file: `${P}/unit/${file}.test.ts`, title });
const i = (file: string, title: string): TracedTest => ({ file: `${P}/integration/${file}.test.ts`, title });
const l2 = (title: string): TracedTest => ({ file: MATRIX, title });
/** The literal `${family}` placeholder of the matrix test titles (one test per gateway family). */
const FAMILY = ['$', '{family}'].join('');

const STRIPE_ADAPTER = 'stripe-adapter';
const PSP_EXECUTOR_POSTGRES = 'psp-executor-postgres';
const GOPAY_ADAPTER = 'gopay-adapter';
const COMGATE_ADAPTER = 'comgate-adapter';
const PSP_CAPTURE_POSTGRES = 'psp-capture-postgres';
const PSP_RECOVERY_POSTGRES = 'psp-recovery-postgres';
const PSP_MONEY = 'psp-money';
const PSP_BINDING_CONFIGURATION_POSTGRES = 'psp-binding-configuration-postgres';
const PSP_NOTIFICATION_POSTGRES = 'psp-notification-postgres';
const REFUND_REQUEST_POSTGRES = 'refund-request-postgres';
const LIFECYCLE_POSTGRES = 'lifecycle-postgres';
const DATABASE_PSP_GUARDS_POSTGRES = 'database-psp-guards-postgres';
const PSP_ENABLEMENT_POSTGRES = 'psp-enablement-postgres';
const PSP_CUSTOMER_ACTION_POSTGRES = 'psp-customer-action-postgres';
const STRIPE_EVIDENCE = 'stripe-evidence';
const EVIDENCE_RECOVERY_POSTGRES = 'evidence-recovery-postgres';
const PSP_EXECUTOR = 'psp-executor';
const PSP_PROVIDER_HTTP = 'psp-provider-http';
const PSP_NOTIFICATION_PROCESSOR = 'psp-notification-processor';
const ACCEPTANCE_MODULE_STATE_POSTGRES = 'acceptance-module-state-postgres';
const PSP_CAPTURE = 'psp-capture';
const ACCEPTANCE_COMPOSITION_FENCE_POSTGRES = 'acceptance-composition-fence-postgres';
const PSP_CORRELATION = 'psp-correlation';
const EVIDENCE_RECOVERY_PLANNING = 'evidence-recovery-planning';
const ACCEPTANCE_EVIDENCE_BOUNDARY_POSTGRES = 'acceptance-evidence-boundary-postgres';
const PSP_LEDGER_STORES_POSTGRES = 'psp-ledger-stores-postgres';
const GATEWAY_WORKER_RETRY_POLICY = 'gateway-worker-retry-policy';
const GOPAY_NOTIFICATION = 'gopay-notification';
const STRIPE_EVENT = 'stripe-event';
const PSP_RECOVERY = 'psp-recovery';
const PSP_CREDENTIALS = 'psp-credentials';
const COMGATE_PUSH = 'comgate-push';
const AUTHORIZATION_NATIVE_RUNTIME = 'authorization-native-runtime';
const APPLICABILITY_EVALUATION = 'applicability-evaluation';
const ACCEPTANCE_INGRESS_PERMISSION_POSTGRES = 'acceptance-ingress-permission-postgres';
const ACCEPTANCE_ENTRYPOINT_CLASSIFICATION = 'acceptance-entrypoint-classification';

const T = {
  a5xxMutationIsOutcome: u(
    PSP_PROVIDER_HTTP,
    '#1158 A 5xx mutation is OUTCOME_UNKNOWN and is never resent (inverts the donor POST retry)',
  ),
  anAcceptedGopayRefundIs: u(
    GOPAY_ADAPTER,
    '#1156 GoPay refund response without completion evidence stays pending; SUCCESS confirms',
  ),
  aNotificationAddressedToAnother: u(
    GOPAY_NOTIFICATION,
    '#1157 A notification addressed to another binding or environment is rejected',
  ),
  anUnsafeUnresolvedTaskStill: i(
    ACCEPTANCE_COMPOSITION_FENCE_POSTGRES,
    '#1153 An unsafe unresolved task still prevents false completion',
  ),
  aRejectedOrUnboundNotification: u(
    PSP_CAPTURE,
    '#1157 a rejected or unbound notification stores nothing; an unavailable gateway fails the capture',
  ),
  aRotatedEntryIsPicked: u(PSP_CREDENTIALS, 'a rotated entry is picked up once the short cache window passes'),
  aStripeOutcomeStillUnknown: u(
    PSP_EXECUTOR,
    '#1158 A Stripe outcome still unknown after its replay window stays as debt',
  ),
  authenticNotificationIsDurablyCaptured: i(
    PSP_CAPTURE_POSTGRES,
    '#1157 Authentic notification is durably captured before ACK',
  ),
  bindingIsImmutableForAn: i(PSP_BINDING_CONFIGURATION_POSTGRES, '#1155 Binding is immutable for an existing payment'),
  browserIndependentNotificationAloneDrives: i(
    PSP_NOTIFICATION_POSTGRES,
    '#1157 Browser-independent: notification alone drives the outcome',
  ),
  browserReturnWithoutFinancialEvidence: i(
    PSP_CUSTOMER_ACTION_POSTGRES,
    '#1157 Browser return without financial evidence does not change payment state',
  ),
  cancellationRacesWithCollection: i(DATABASE_PSP_GUARDS_POSTGRES, '#1156 Cancellation races with collection'),
  cancellationRacesWithCollectionCancel: i(
    PSP_EXECUTOR_POSTGRES,
    '#1156 Cancellation races with collection (cancel first)',
  ),
  cancellationRacesWithCollectionCollection: i(
    PSP_EXECUTOR_POSTGRES,
    '#1156 Cancellation races with collection (collection first)',
  ),
  captureIsRefusedWhileThe: u(
    PSP_CAPTURE,
    '#1153 Capture is refused while the module is suspended/read_only/quarantined',
  ),
  captureMethodIsExplicitlyAutomatic: u(STRIPE_ADAPTER, '#1154 capture_method is explicitly automatic'),
  captureWithAnUnboundWorkload: u(PSP_CAPTURE, '#1159 Capture with an unbound workload principal is denied'),
  chainBrokenGopay: {
    file: CHAIN,
    title:
      '#1154 #1158 #1159 L3-11 boundary executor+ledger routines+live credential store: a broken GoPay credential leaves Stripe and a non-gateway Payment working',
  },
  chainComgateCancel: {
    file: CHAIN,
    title:
      '#1156 #1158 #1159 boundary executor+ledger routines+production Comgate adapter: a transaction-id DELETE cancel is prepared, sent once and confirmed by the status lookup',
  },
  chainGopayCancel: {
    file: CHAIN,
    title:
      '#1156 #1159 L3-14 boundary executor+ledger routines+production GoPay adapter: a GoPay v4 cancel is sent once and decided by the lookup (204 CANCELED confirmed, 409 PAYMENT_METHOD_CHOSEN not effected)',
  },
  chainGopayComgateRefund: {
    file: CHAIN,
    title:
      '#1156 #1158 #1159 boundary executor+ledger routines+production GoPay and Comgate adapters: a refund is prepared, sent once and recorded as pending',
  },
  chainLostCreate: {
    file: CHAIN,
    title:
      '#1157 #1158 #1159 L3-8 boundary executor+processor+ledger routines: lost Stripe create, then a notification, then a refund on the notified PaymentIntent',
  },
  chainStripeCancel: {
    file: CHAIN,
    title:
      '#1156 #1158 #1159 boundary executor+ledger routines+production Stripe adapter: a body-less Checkout Session expire is prepared with its replay record, sent once and confirmed',
  },
  codCommitmentBeforeHandoverIssues: i(
    AUTHORIZATION_NATIVE_RUNTIME,
    '#1149 COD commitment before handover issues a method-condition proof and records no collection',
  ),
  collectedPaymentButCommitmentProves: i(
    REFUND_REQUEST_POSTGRES,
    '#1150 Collected payment but commitment proves no Order: compensation reserves the exact remainder',
  ),
  comgatePushTestFlagMismatch: u(COMGATE_PUSH, '#1157 Comgate push test flag mismatch is rejected'),
  comgateRefundIsPendingOnly: u(COMGATE_ADAPTER, '#1156 Comgate refund is pending only'),
  concurrentCollectionAndCancellationNever: i(
    PSP_EXECUTOR_POSTGRES,
    '#1156 Concurrent collection and cancellation never send a withheld collection',
  ),
  coreClaimStates: {
    file: CORE_OUTBOX,
    title: 'gates claims on every non-active consumer state and permits one concurrent live claim',
  },
  correlationIsDeterministicForThe: u(PSP_CORRELATION, '#1158 Correlation is deterministic for the same operation'),
  crashAfterHandoffNeverDouble: i(PSP_EXECUTOR_POSTGRES, '#1158 Crash after handoff never double-sends'),
  crashBeforeDurableHandoffSends: i(PSP_EXECUTOR_POSTGRES, '#1158 Crash before durable handoff sends nothing'),
  createResponseLostThenNotification: i(
    PSP_NOTIFICATION_POSTGRES,
    '#1157 Create response lost then notification arrives correlates and enables a later refund',
  ),
  credentialRotationDoesNotOrphan: i(
    PSP_BINDING_CONFIGURATION_POSTGRES,
    '#1155 Credential rotation does not orphan in-flight operations',
  ),
  czkIsMinorUnits: u(PSP_MONEY, '#1156 1 599,50 CZK is 159950 minor units'),
  disabledGatewayIsNotOffered: i(PSP_ENABLEMENT_POSTGRES, '#1155 Disabled gateway is not offered to new intents'),
  drainIsBlockedWhileGateway: i(
    ACCEPTANCE_COMPOSITION_FENCE_POSTGRES,
    '#1153 Drain is blocked while gateway dispatch is unfinished: the executor checkpoint releases R1',
  ),
  drainIsBlockedWhileGateway2: i(
    ACCEPTANCE_COMPOSITION_FENCE_POSTGRES,
    '#1153 Drain is blocked while gateway dispatch is unfinished',
  ),
  duplicateAndCorroboratingObservationsThrough: i(
    ACCEPTANCE_EVIDENCE_BOUNDARY_POSTGRES,
    '#1151 Duplicate and corroborating observations through the accept Action',
  ),
  duplicateDeliveryIsAcknowledgedIdempotently: i(
    PSP_CAPTURE_POSTGRES,
    '#1157 Duplicate delivery is acknowledged idempotently',
  ),
  enableWithoutSourceAuthoritiesIs: i(
    PSP_ENABLEMENT_POSTGRES,
    '#1155 Enable without source authorities is rejected and writes nothing',
  ),
  everyRegisteredEntrypointGetsExactly: u(
    ACCEPTANCE_ENTRYPOINT_CLASSIFICATION,
    '#1153 every registered entrypoint gets exactly the #1153 decision for its class in every state',
  ),
  forgedStripeSignatureCannotMutate: i(PSP_CAPTURE_POSTGRES, '#1157 Forged Stripe signature cannot mutate'),
  gatewayCollectionDispatchIsTracked: i(
    LIFECYCLE_POSTGRES,
    '#1149 #1158 Gateway collection dispatch is tracked durable work',
  ),
  genuineNotEffectedConfirmedAllows: i(
    LIFECYCLE_POSTGRES,
    '#1148 genuine NOT_EFFECTED_CONFIRMED allows a new COLLECT under the unchanged meaning and binding',
  ),
  gopayNotificationTriggersLookupOnly: u(GOPAY_NOTIFICATION, '#1157 GoPay notification triggers lookup only'),
  gopayReplayAndOrderReference: u(GOPAY_ADAPTER, '#1158 GoPay replay and order-reference lookup are UNSUPPORTED'),
  historicalInformationDoesNotAuthorize: i(
    ACCEPTANCE_MODULE_STATE_POSTGRES,
    '#1153 Historical information does not authorize suspended-module writes',
  ),
  ingressCredentialsDoNotReplace: i(
    ACCEPTANCE_INGRESS_PERMISSION_POSTGRES,
    '#1153 Ingress credentials do not replace owner permission',
  ),
  l2Amount: l2(`#1159 L2 ${FAMILY} amount mismatch is a discrepancy, never a confirmation or a recollection`),
  l2Cancel: l2(`#1159 L2 ${FAMILY} cancel: supported cancel is confirmed only by the provider, unsupported is typed`),
  l2Contract: l2(
    '#1159 L2 manual capture, saved methods, subscriptions and settlement are unreachable from the adapter contract',
  ),
  l2Create: l2(`#1159 L2 ${FAMILY} create: one-shot direct collection, a provider ACK is never EFFECT_CONFIRMED`),
  l2FiveXx: l2(
    `#1159 L2 ${FAMILY} a 5xx create is OUTCOME_UNKNOWN with exactly one attempt (no generic mutating retry)`,
  ),
  l2Foreign: l2(`#1159 L2 ${FAMILY} foreign merchant or environment answer never confirms and carries no evidence`),
  l2ForeignFamily: l2(`#1159 L2 ${FAMILY} a provider object of another family is never acted on`),
  l2LostCreate: l2(`#1159 L2 ${FAMILY} lost create response is OUTCOME_UNKNOWN and the mutation is never resent`),
  l2LostRefund: l2(`#1159 L2 ${FAMILY} lost refund response is OUTCOME_UNKNOWN and the refund is never resent`),
  l2Matrix: l2('#1159 L2 the matrix names exactly the three Launch gateway families and five capabilities'),
  l2Miss: l2(`#1159 L2 ${FAMILY} lookup miss is INDETERMINATE, never NOT_EFFECTED`),
  l2Notification: l2(
    `#1159 L2 ${FAMILY} notification: authentic delivery is a trigger; forged, foreign and wrong-environment deliveries are rejected`,
  ),
  l2Refund: l2(`#1159 L2 ${FAMILY} refund: both refund bases send the exact amount and acceptance stays pending`),
  l2Retrieve: l2(
    `#1159 L2 ${FAMILY} retrieve: an exact paid lookup is COLLECTION_CONFIRMED for the expected operation`,
  ),
  l2Selected: l2(`#1159 L2 ${FAMILY} adapter is selected by exact family and declares its Launch capabilities`),
  l2Settlement: l2(`#1159 L2 ${FAMILY} settlement and balance deliveries create no Payment operation`),
  lateCallbackIsAdmittedBy: i(
    EVIDENCE_RECOVERY_POSTGRES,
    '#1151 Late callback is admitted by a compatible new runtime and preserves the original lineage',
  ),
  lateGatewayCallbackThroughThe: i(
    ACCEPTANCE_EVIDENCE_BOUNDARY_POSTGRES,
    '#1151 Late gateway callback through the accept Action under R2',
  ),
  livemodeMismatchIsRejected: u(STRIPE_EVENT, '#1157 livemode mismatch is rejected'),
  lookupMissStaysIndeterminate: i(PSP_RECOVERY_POSTGRES, '#1158 Lookup miss stays INDETERMINATE'),
  lookupRecoveryDeliveryIsTracked: i(
    EVIDENCE_RECOVERY_POSTGRES,
    '#1158 Lookup recovery delivery is tracked: Core durable work of the recovering revision until done',
  ),
  lookupThroughTheOriginalBinding: i(
    PSP_RECOVERY_POSTGRES,
    '#1156 Lookup through the original binding after a binding is retired for new intents',
  ),
  missingLookupCredentialsOrAuthority: u(
    EVIDENCE_RECOVERY_PLANNING,
    '#1151 missing lookup credentials or authority hold the operation for reconciliation, never NOT_EFFECTED',
  ),
  nativeReplayKeepsTheOriginal: i(
    EVIDENCE_RECOVERY_POSTGRES,
    '#1151/#1153 Native replay keeps the original operation and drains only after matched recovery completes',
  ),
  notificationForAnotherBindingIs: i(
    PSP_NOTIFICATION_POSTGRES,
    '#1156 Notification for another binding is never applied',
  ),
  observedAmountMismatchIsA: u(PSP_MONEY, '#1156 Observed amount mismatch is a discrepancy, never a confirmation'),
  oneDispatchPerPaymentOperation: i(DATABASE_PSP_GUARDS_POSTGRES, '#1158 One dispatch per Payment Operation'),
  oneProviderOutageDoesNot: i(PSP_ENABLEMENT_POSTGRES, '#1155 One provider outage does not gate unrelated providers'),
  providerIdempotencyWindowHasExpired: i(
    EVIDENCE_RECOVERY_POSTGRES,
    '#1151 Provider idempotency window has expired: recovery falls back to lookup, never a replay',
  ),
  pspEnvironmentIsNotInterchangeable: i(
    PSP_BINDING_CONFIGURATION_POSTGRES,
    '#1155 PSP environment is not interchangeable',
  ),
  recoveryResolvesTheOriginalBinding: u(
    PSP_RECOVERY,
    '#1156 Recovery resolves the original binding and never asks another binding',
  ),
  refundOneItemFromA: i(
    REFUND_REQUEST_POSTGRES,
    '#1150 Refund one item from a three-item Order: B is refunded whole and A and C stay refundable',
  ),
  refundResponseIsLostB: i(
    REFUND_REQUEST_POSTGRES,
    '#1150 Refund response is lost: B stays reserved and the same REFUND keeps its original binding',
  ),
  refundSucceededThenFailedIs: u(STRIPE_EVIDENCE, '#1156 Refund succeeded then failed is a new occurrence'),
  replayOutsideTheWindowIs: u(STRIPE_ADAPTER, '#1158 Replay outside the window is refused'),
  requiredCodEvidenceCannotBe: u(
    APPLICABILITY_EVALUATION,
    '#1147 Required COD evidence cannot be verified while bank transfer stays AVAILABLE (H1094-01=A)',
  ),
  sameLogicalRefundButChanged: i(PSP_EXECUTOR_POSTGRES, '#1158 Same logical refund but changed basis conflicts'),
  sameLogicalRefundButChanged2: i(
    PSP_LEDGER_STORES_POSTGRES,
    '#1158 Same logical refund but changed basis returns a conflict without a provider mutation',
  ),
  sameProviderPaymentReportsA: u(PSP_NOTIFICATION_PROCESSOR, '#1157 Same provider payment reports a later state'),
  selectedBindingMustEqualAn: i(
    PSP_ENABLEMENT_POSTGRES,
    '#1156 Selected binding must equal an enabled binding exactly',
  ),
  settlementBalanceEventsNeverCreate: u(STRIPE_EVENT, '#1156 Settlement/balance events never create an operation'),
  shellA8: {
    file: SHELL,
    title:
      '#1159 Payment workers reach A8 as a RegisteredWorkload only for workload-admitted originals in their own scope',
  },
  stripeLostCreateResponseIs: u(
    STRIPE_ADAPTER,
    '#1158 Stripe lost create response is recovered by exact replay inside 24 h',
  ),
  stripeLostResponseRecoveredInside: i(PSP_EXECUTOR_POSTGRES, '#1158 Stripe lost response recovered inside 24 h'),
  theExecutorMayDeferAcross: u(
    GATEWAY_WORKER_RETRY_POLICY,
    '#1158 The executor may defer across the whole Stripe replay window',
  ),
  theWindowBoundaryItselfIs: u(
    EVIDENCE_RECOVERY_PLANNING,
    '#1151 the window boundary itself is already expired (actual now, not frozen time)',
  ),
  timeoutOrLostResponseBecomes: i(
    PSP_RECOVERY_POSTGRES,
    '#1158 Timeout or lost response becomes INDETERMINATE and recovery uses lookup',
  ),
  twoConcurrentDistinctCollectIdentities: i(
    LIFECYCLE_POSTGRES,
    '#1148 two concurrent distinct COLLECT identities race on PostgreSQL: one wins, one conflicts',
  ),
  unrelatedGatewayIsUnavailable: i(PSP_EXECUTOR_POSTGRES, '#1156 Unrelated gateway is unavailable'),
  unsupportedProviderOperationYieldsTyped: i(
    PSP_EXECUTOR_POSTGRES,
    '#1156 Unsupported provider operation yields typed unsupported, no fallback',
  ),
  verifiedNotificationStillNeedsThe: i(
    PSP_NOTIFICATION_POSTGRES,
    "#1157 Verified notification still needs the receiver's normal write admission",
  ),
  waitsStartAtSDouble: u(PSP_EXECUTOR, '#1158 Waits start at 60 s, double the time waited and stop at the deadline'),
} as const satisfies Record<string, TracedTest>;

const ALL_FAMILIES = 'GoPay, Stripe, Comgate documented REST APIs (fixtures cite the pages)';
const NONE = 'none (Payment owner rule)';
const NO_LIMIT_BEYOND_FIXTURE = 'none beyond fixture level';
const NO_LIMIT_BEYOND_NATIVE = 'none beyond native level';
const RETURN_STATUS_READ = 'gateway-return-status Read';
const BINDING_RESOLVER = 'binding-resolver-live.ts';
const ORIGINAL_BINDING_RETAINED = 'Original binding is retained';
const AMOUNT_ONLY_REFUND = 'Amount-only refund primitive';
const PER_FAMILY_CREDENTIALS = 'Per-family credentials';

type RowInput = Omit<TraceRow, 'ran'>;

const C16_OWNER = (
  id: string,
  requirement: string,
  rule: string,
  tests: readonly TracedTest[],
  expected: string,
): RowInput => ({
  capability: NONE,
  expected,
  id,
  limits: 'C16 owner evidence (#1153); downstream owners are public-contract fixtures; no provider involved',
  mapping: 'none (no adapter on this path)',
  requirement,
  rule,
  sandbox: SANDBOX_NOT_APPLICABLE,
  tests,
});

const rows: readonly RowInput[] = [
  // ---------------------------------------------------------------------------------------------
  // #1159 Minimum matrix per GoPay / Stripe / Comgate
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'GoPay standard payment; Stripe Checkout Session mode=payment; Comgate REST v2 create',
    expected: 'CUSTOMER_ACTION_REQUIRED with redirect; COLLECTION_PENDING at most, never EFFECT_CONFIRMED',
    id: 'MIN-1',
    limits: 'Provider acceptance of the request body is not proven without a sandbox',
    mapping: '{gopay,stripe,comgate}-payment.service.ts prepareCollect/send',
    requirement: 'one-shot create / direct collection',
    rule: 'Payment authorizes one COLLECT on its exact binding; ACK or browser return never proves collection',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Create, T.l2Selected, T.captureMethodIsExplicitlyAutomatic],
  },
  {
    capability: 'GoPay payment inquiry; Stripe PaymentIntent / Checkout Session retrieve; Comgate status',
    expected: 'EFFECT_CONFIRMED + COLLECTION_CONFIRMED with exact observed amount, for the expected operation only',
    id: 'MIN-2',
    limits: 'Live response shapes (Stripe default API version, Comgate `test` flag form) unverified',
    mapping: '{gopay,stripe,comgate}-evidence.ts lookup mapping',
    requirement: 'retrieve / verify',
    rule: 'Only verified provider evidence for the bound operation qualifies as an observation',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Retrieve, T.l2Miss],
  },
  {
    capability:
      'Stripe Checkout Session expire; Comgate DELETE transId; GoPay v4 DELETE /payments/{id} (CREATED only: 204, else 409)',
    expected:
      'CANCEL_CONFIRMED only from a provider lookup; a refused GoPay cancel of a paid payment keeps COLLECTION_CONFIRMED',
    id: 'MIN-3',
    limits:
      'GoPay v4 cancel not sandbox-verified and v4 for the merchant unconfirmed (N8 merge gate); Comgate DELETE path not sandbox-verified (ORIGIN C-11)',
    mapping: '{stripe,comgate,gopay} prepareCancel/send; gopay DELETE then GET /payments/{id} (mapGopayCancelAnswer)',
    requirement: 'pending cancellation / void path as supported',
    rule: 'CANCEL_OR_VOID is distinct from refund; unsupported is explicit, never a fallback',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.l2Cancel,
      T.unsupportedProviderOperationYieldsTyped,
      T.chainStripeCancel,
      T.chainComgateCancel,
      T.chainGopayCancel,
    ],
  },
  {
    capability:
      'GoPay v4 refund resource (REQUESTED/SUCCESS/FAILED); Stripe Refunds API; Comgate refund (no completion API, N10)',
    expected: 'ACCEPTED_PENDING + REFUND_PENDING on acceptance; REFUND_CONFIRMED only from provider proof',
    id: 'MIN-4',
    limits:
      'Comgate refund completion cannot be proven (N10); GoPay refuses an early partial card refund with 409 (L4)',
    mapping: '{gopay,stripe,comgate}-payment.service.ts prepareRefund/send',
    requirement: 'amount-based refund',
    rule: 'A REFUND sends exactly the Payment-authorized amount on the original binding',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.l2Refund,
      T.chainLostCreate,
      T.anAcceptedGopayRefundIs,
      T.comgateRefundIsPendingOnly,
      T.chainGopayComgateRefund,
    ],
  },
  {
    capability: 'Stripe webhook v1 signature; GoPay unsigned callback + inquiry; Comgate push shared secret',
    expected:
      'Authentic delivery -> trigger (lookup required); forged/foreign/wrong environment -> rejected, nothing stored',
    id: 'MIN-5',
    limits: 'Real provider delivery to a public endpoint not exercised (relay surface N1)',
    mapping: 'stripe-webhook-signature.ts, stripe-event.ts, gopay-notification.ts, comgate-push.ts',
    requirement: 'callback / webhook / notification verification',
    rule: 'A notification is a trigger, never a financial fact; it cannot bypass owner admission',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Notification, T.forgedStripeSignatureCannotMutate],
  },
  {
    capability: 'Stripe Idempotency-Key 24 h; GoPay/Comgate no idempotency (no replay)',
    expected: 'OUTCOME_UNKNOWN -> INDETERMINATE; Stripe exact replay in window; otherwise lookup, never a blind resend',
    id: 'MIN-6',
    limits: 'Provider-side idempotency behaviour not sandbox-verified',
    mapping: 'provider-http-live.ts, gateway-operation-executor.ts, gateway-operation-recovery.ts',
    requirement: 'lost-response / recovery behavior',
    rule: 'An unknown effect is debt until proven; no competing new key or operation',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2LostCreate, T.chainLostCreate, T.stripeLostResponseRecoveredInside, T.timeoutOrLostResponseBecomes],
  },
  {
    capability: 'Provider-reported amount and currency in minor units',
    expected: 'VERIFICATION_CONFLICT with discrepancy {expected, observed}; never confirmation or recollection',
    id: 'MIN-7',
    limits: NO_LIMIT_BEYOND_FIXTURE,
    mapping: 'psp-money.ts, {gopay,stripe,comgate}-money.ts and -evidence.ts',
    requirement: 'amount / currency correlation',
    rule: 'Exact CZK minor units; an authentic mismatch stays visible discrepancy evidence',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Amount, T.observedAmountMismatchIsA],
  },
  {
    capability: 'GoPay GoID path + own order_number; Stripe livemode + key prefix; Comgate merchant + test flag',
    expected: 'Foreign merchant/environment answers never confirm; environments are not interchangeable',
    id: 'MIN-8',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'binding-resolver-live.ts, family evidence/notification verifiers',
    requirement: 'account / environment isolation',
    rule: 'Every operation keeps its original Provider Account Binding and environment',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Foreign, T.l2ForeignFamily, T.pspEnvironmentIsNotInterchangeable, T.notificationForAnotherBindingIs],
  },
  // ---------------------------------------------------------------------------------------------
  // #1159 Audit closure
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'Provider refund primitive is amount-only',
    expected: 'Same provider bytes for REFUNDABLE_ITEMS and FAILED_COMMITMENT_COMPENSATION; original binding kept',
    id: 'AC-1',
    limits: 'FAILED_COMMITMENT_COMPENSATION executed through an adapter only at L2; native C16 admission is #1153',
    mapping: 'GatewayRefundRequest.refundBasisKind is audit only (D13)',
    requirement: 'both authorized refund bases execute their exact amount on the original gateway',
    rule: 'Refund basis is Payment-owned; the adapter neither demands nor fabricates Order items',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Refund, T.collectedPaymentButCommitmentProves],
  },
  {
    capability: 'Providers would accept two different idempotency keys',
    expected: 'One COLLECT wins, the other conflicts; one dispatch per operation',
    id: 'AC-2',
    limits: 'none',
    mapping: 'psp_prepare_dispatch (one dispatch per operation)',
    requirement: 'two distinct COLLECTs are never sent concurrently',
    rule: 'C16 aggregate one-collection guard is mandatory input to adapter execution',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.twoConcurrentDistinctCollectIdentities, T.oneDispatchPerPaymentOperation],
  },
  // ---------------------------------------------------------------------------------------------
  // #1159 Mandatory negative / race coverage
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'Provider amounts in minor units',
    expected: '1 599,50 CZK = 159950; mismatch is discrepancy',
    id: 'NEG-01',
    limits: NO_LIMIT_BEYOND_FIXTURE,
    mapping: 'psp-money.ts, family money modules',
    requirement: 'exact money round-trip and mismatch',
    rule: 'Exact CZK integer minor units',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.czkIsMinorUnits, T.l2Amount],
  },
  {
    capability: 'Merchant identity and environment per binding',
    expected: 'Disabled gateway not offered; foreign/other-environment binding unavailable, no failover',
    id: 'NEG-02',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'gateway-binding-live.ts, binding-resolver-live.ts',
    requirement: 'disabled / wrong merchant / environment',
    rule: 'Only Current Gateway Enablement offers a gateway; operations keep their binding',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.disabledGatewayIsNotOffered, T.pspEnvironmentIsNotInterchangeable, T.l2Foreign],
  },
  {
    capability: 'Stripe v1 signature; Comgate secret; GoPay id shape + lookup',
    expected: 'Rejected before capture; nothing stored; non-2xx to relay',
    id: 'NEG-03',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'stripe-webhook-signature.ts, comgate-push.ts, gopay-notification.ts',
    requirement: 'invalid webhook / signature / verification',
    rule: 'Only verified notifications are captured',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.forgedStripeSignatureCannotMutate, T.l2Notification],
  },
  {
    capability: 'Provider return URL carries no financial proof',
    expected: 'Return status reads Payment-owned state only; no evidence submitted',
    id: 'NEG-04',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: RETURN_STATUS_READ,
    requirement: 'browser return without financial evidence',
    rule: 'Browser return never proves collection',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.browserReturnWithoutFinancialEvidence, T.browserIndependentNotificationAloneDrives],
  },
  {
    capability: 'Providers redeliver; Stripe event ids; later contrary states',
    expected: 'DUPLICATE ACK; ALREADY_PROCESSED; contrary later state is a new occurrence',
    id: 'NEG-05',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'notification-store-live.ts, stripe-evidence.ts',
    requirement: 'duplicate / out-of-order event',
    rule: 'Arrival order never establishes truth; one economic effect counts once',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.duplicateDeliveryIsAcknowledgedIdempotently,
      T.browserIndependentNotificationAloneDrives,
      T.refundSucceededThenFailedIs,
    ],
  },
  {
    capability: 'Transport drop after write',
    expected: 'OUTCOME_UNKNOWN, one mutation; later notification correlates by order reference',
    id: 'NEG-06',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'provider-http-live.ts, dispatch-ledger-live.ts, provider-notification-processor.ts',
    requirement: 'create response lost',
    rule: 'Lost create never authorizes another charge',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2LostCreate, T.chainLostCreate],
  },
  {
    capability: 'Transport drop after write on refund',
    expected: 'OUTCOME_UNKNOWN, one refund mutation; the same REFUND keeps its binding',
    id: 'NEG-07',
    limits: 'Refund lost response through the executor is not a native C17 test; C16 native covers reservation',
    mapping: 'provider-http-live.ts, family send',
    requirement: 'refund response lost',
    rule: 'Lost refund response stays unknown; no second refund',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2LostRefund, T.refundResponseIsLostB],
  },
  {
    capability: 'Stripe 24 h idempotency window; GoPay/Comgate none',
    expected: 'Outside the window or without support: lookup, never replay',
    id: 'NEG-08',
    limits: 'Provider window behaviour not sandbox-verified',
    mapping: 'replay-guarantee-live.ts, stripe-payment.service.ts replay',
    requirement: 'provider idempotency unavailable / expired',
    rule: 'No blind retry outside a proven guarantee',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.providerIdempotencyWindowHasExpired,
      T.replayOutsideTheWindowIs,
      T.gopayReplayAndOrderReference,
      T.aStripeOutcomeStillUnknown,
    ],
  },
  {
    capability: 'Credential rotation authenticates the same account',
    expected: 'In-flight operations keep their binding; current ACTIVE revision used',
    id: 'NEG-09',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'psp-binding-persistence.ts, binding-resolver-live.ts',
    requirement: 'configuration rotated after historical operation',
    rule: 'Binding of an operation is immutable',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.credentialRotationDoesNotOrphan, T.bindingIsImmutableForAn],
  },
  {
    capability: 'Donor preauth/capture, saved cards, subscriptions not adopted',
    expected: 'Typed UNSUPPORTED; no fallback; no public field to request them',
    id: 'NEG-10',
    limits: 'none',
    mapping: 'capability-matrix.ts, psp-request.ts',
    requirement: 'unsupported donor operation',
    rule: 'Launch has no manual capture / off-session / subscription',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Contract, T.l2Cancel, T.unsupportedProviderOperationYieldsTyped],
  },
  {
    capability: 'Refund acceptance responses',
    expected: 'ACCEPTED_PENDING / REFUND_PENDING; never completion',
    id: 'NEG-11',
    limits: 'Comgate refund completion is a PO blocker (N10)',
    mapping: 'family refund mapping',
    requirement: 'provider refund accepted but not completion-proven',
    rule: 'Acceptance is not completion',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Refund, T.chainLostCreate, T.comgateRefundIsPendingOnly],
  },
  {
    capability: 'Donor POST retry on 5xx inverted',
    expected: 'Exactly one mutation attempt; 5xx is OUTCOME_UNKNOWN',
    id: 'NEG-12',
    limits: 'none',
    mapping: 'provider-http-live.ts',
    requirement: 'generic mutating HTTP retry disabled where unsafe',
    rule: 'Mutations are single-attempt',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.a5xxMutationIsOutcome, T.l2FiveXx],
  },
  {
    capability: 'Provider occurrence ids, payment ids, event/received/verified instants',
    expected: 'Later state of the same payment id is retained; receivedAt kept, verifiedAt from the clock',
    id: 'NEG-13',
    limits: 'Provider event time is carried, not compared against live provider clocks',
    mapping: 'notification-envelope.ts, provider-notification-processor.ts',
    requirement: 'occurrence ID vs repeated provider payment ID; receivedAt vs verifiedAt vs provider event time',
    rule: 'Occurrences are distinct from provider objects; each instant is the actual one',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.sameProviderPaymentReportsA, T.createResponseLostThenNotification, T.l2Notification],
  },
  {
    capability: 'Signature authenticity is independent of owner authority',
    expected: 'Denied/held; SUBMISSION_DENIED; no Payment write',
    id: 'NEG-14',
    limits: 'Capture Action under Module States is unit-level (Core gate fake); A8 receiver decision is native (Shell)',
    mapping: 'evidence-submission-live.ts, capture Action descriptor',
    requirement:
      'verified webhook with insufficient permission, suspended module, stale Composition or wrong source binding cannot mutate',
    rule: 'Normal write admission is required for every provider-driven mutation',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [
      T.verifiedNotificationStillNeedsThe,
      T.shellA8,
      T.historicalInformationDoesNotAuthorize,
      T.captureIsRefusedWhileThe,
      T.captureWithAnUnboundWorkload,
    ],
  },
  {
    capability: 'Relay ACK semantics',
    expected: 'ACK only after the durable capture commits; nothing claims financial completion',
    id: 'NEG-15',
    limits: 'The relay HTTP surface itself is N1 (not built)',
    mapping: 'capture-provider-notification Action',
    requirement: 'durable ACK only after authorized safe ingress capture',
    rule: 'Durable capture before acknowledgement',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.authenticNotificationIsDurablyCaptured, T.aRejectedOrUnboundNotification],
  },
  {
    capability: 'Merchant replacement and credential rotation',
    expected: 'Lookup/refund through the original binding X, never Y',
    id: 'NEG-16',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: BINDING_RESOLVER,
    requirement: 'new REFUND of an old collection preserves original binding after replacement and rotation',
    rule: ORIGINAL_BINDING_RETAINED,
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.lookupThroughTheOriginalBinding, T.bindingIsImmutableForAn, T.credentialRotationDoesNotOrphan],
  },
  {
    capability: NONE,
    expected: 'R1 blocks drain until checkpoint; R2 late evidence keeps lineage; unsafe debt stays explicit',
    id: 'NEG-17',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'completion-bound workers (executor, recovery)',
    requirement:
      'R1 work tracking, safe checkpoints, unresolved debt and an authorized R2 late observation remain distinguishable',
    rule: 'No forced DONE; no relabelled R1 task',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.drainIsBlockedWhileGateway, T.anUnsafeUnresolvedTaskStill, T.lateCallbackIsAdmittedBy],
  },
  {
    capability: 'Stripe idempotency key per operation, 24 h window from preparedAt',
    expected: 'New assertion never resets the window; deferral schedule from actual instants',
    id: 'NEG-18',
    limits: 'Outbox claim lease/backoff is Core-owned (generic Core suite)',
    mapping: 'psp-correlation.ts, gateway-operation-executor.ts deferral',
    requirement: 'fresh gateway assertion/JTI vs stable operation and PSP key/window; actual-time lease/backoff',
    rule: 'Actual operation instants, stable operation identity',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.correlationIsDeterministicForThe,
      T.theWindowBoundaryItselfIs,
      T.waitsStartAtSDouble,
      T.nativeReplayKeepsTheOriginal,
    ],
  },
  {
    capability: 'Per-family credentials and bindings',
    expected: 'Stripe and non-gateway Payment proceed while GoPay is unavailable; GoPay not sent',
    id: 'NEG-19',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'credentials-live.ts, gateway-adapters-live.ts',
    requirement: 'unrelated gateway/provider outage cannot block an independent operation',
    rule: 'H1094-01=A independence',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainBrokenGopay, T.unrelatedGatewayIsUnavailable, T.oneProviderOutageDoesNot],
  },
  // ---------------------------------------------------------------------------------------------
  // #1159 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: ALL_FAMILIES,
    expected: 'One-shot create; ACK/return never EFFECT_CONFIRMED',
    id: 'G1159-1',
    limits: '"sandbox evidence verifies the accepted create/retrieve/notification flow" is NOT RUN (N13)',
    mapping: 'family prepareCollect/send/lookup/verifyNotification',
    requirement: 'Direct one-shot collection requires qualified provider effect (GoPay, Stripe, Comgate)',
    rule: 'Qualified provider effect only',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Create, T.l2Retrieve, T.l2Notification, T.l2Contract],
  },
  {
    capability: AMOUNT_ONLY_REFUND,
    expected: 'Exact amount and binding X; no items; pending until proof',
    id: 'G1159-2',
    limits: 'FAILED_COMMITMENT_COMPENSATION through an adapter only at L2',
    mapping: 'family prepareRefund/send',
    requirement: 'Each authorized refund basis reaches the original gateway account',
    rule: 'Refund basis is Payment-owned',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Refund, T.chainLostCreate],
  },
  {
    capability: 'Provider payment id stable across states',
    expected: 'New qualified observation retained; effect reconciled once',
    id: 'G1159-3',
    limits: 'C17 side is unit-level; C16 duplicate counting is native under #1153',
    mapping: 'provider-notification-processor.ts',
    requirement: 'Same provider payment ID may deliver a later observation',
    rule: 'One economic effect counts once',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.sameProviderPaymentReportsA, T.duplicateAndCorroboratingObservationsThrough],
  },
  {
    capability: 'Signature authenticity',
    expected: 'Denied through the real Core boundary; historical_read unused',
    id: 'G1159-4',
    limits: 'Capture under Module States is unit-level',
    mapping: 'capture descriptor, evidence submission',
    requirement: 'Verified notification cannot bypass suspended Payment state',
    rule: 'Write/background admission required',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.historicalInformationDoesNotAuthorize, T.shellA8, T.captureIsRefusedWhileThe],
  },
  {
    capability: NONE,
    expected: 'Not forced DONE; R2 only after safe R1 checkpoint; no competing operation',
    id: 'G1159-5',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'executor checkpoint, recovery',
    requirement: 'Indeterminate provider effect survives worker restart and Composition change',
    rule: 'Unsafe unknown effect stays debt',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.drainIsBlockedWhileGateway, T.crashAfterHandoffNeverDouble, T.lateCallbackIsAdmittedBy],
  },
  {
    capability: 'Stripe 24 h idempotency window',
    expected: 'Lookup without blind mutating retry; new assertion does not reset the window',
    id: 'G1159-6',
    limits: 'Provider window not sandbox-verified',
    mapping: 'replay-guarantee-live.ts, recovery',
    requirement: 'Actual-operation provider retry expiry',
    rule: 'Actual operation time governs',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.providerIdempotencyWindowHasExpired, T.replayOutsideTheWindowIs],
  },
  // ---------------------------------------------------------------------------------------------
  // #1158 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'Stripe exact replay with the original key',
    expected: 'Original O and X preserved; no duplicate COLLECT/REFUND',
    id: 'G1158-1',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'recovery replay, executor',
    requirement: 'New authorization credentials do not create a new provider effect',
    rule: 'Fresh assertion is not a new operation',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.nativeReplayKeepsTheOriginal, T.crashAfterHandoffNeverDouble],
  },
  C16_OWNER(
    'G1158-2',
    'Definitively non-effected collection has a separate later attempt',
    'New attempt B has its own identity; aggregate guard enforced',
    [T.genuineNotEffectedConfirmedAllows, T.oneDispatchPerPaymentOperation],
    'Distinct operation B; A unchanged; one dispatch per operation',
  ),
  {
    capability: NONE,
    expected: 'Conflict; no provider mutation',
    id: 'G1158-3',
    limits: 'none',
    mapping: 'psp_prepare_dispatch material hash',
    requirement: 'Same logical refund but changed basis is not a safe replay',
    rule: 'Material hash covers the refund basis',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.sameLogicalRefundButChanged, T.sameLogicalRefundButChanged2],
  },
  {
    capability: 'Stripe search eventually consistent; GoPay/Comgate no order-reference lookup',
    expected: 'Lookup first; no resend or new key; INDETERMINATE debt kept',
    id: 'G1158-4',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'gateway-operation-recovery.ts',
    requirement: 'Unknown provider result and expired deduplication window',
    rule: 'Unknown effect stays debt',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.providerIdempotencyWindowHasExpired, T.lookupMissStaysIndeterminate, T.l2Miss],
  },
  {
    capability: NONE,
    expected: 'Deferral from actual instants; claims gated per Core runtime',
    id: 'G1158-5',
    limits:
      'Claim lease and stale-claim completion are Core Outbox runtime behaviour, proven in the Core suite with a generic consumer',
    mapping: 'gateway-operation-executor.ts deferral schedule',
    requirement: 'Sequential worker deliveries use their actual times',
    rule: 'Actual transition instants',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.waitsStartAtSDouble, T.theExecutorMayDeferAcross, T.coreClaimStates],
  },
  {
    capability: PER_FAMILY_CREDENTIALS,
    expected: 'Stripe executes; GoPay truthfully not sent',
    id: 'G1158-6',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'credentials-live.ts',
    requirement: 'Required gateway unavailable but independent payment still usable',
    rule: 'H1094-01=A',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainBrokenGopay, T.unrelatedGatewayIsUnavailable],
  },
  // ---------------------------------------------------------------------------------------------
  // #1157 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'Return URL carries only the return token',
    expected: 'No collection inferred; canonical read pending',
    id: 'G1157-1',
    limits: 'none',
    mapping: RETURN_STATUS_READ,
    requirement: 'Browser success return arrives before webhook',
    rule: 'Browser return is not evidence',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.browserReturnWithoutFinancialEvidence],
  },
  {
    capability: 'GoPay unsigned callback `?id=`, payment inquiry',
    expected: 'LOOKUP_REQUIRED trigger; only lookup evidence submitted',
    id: 'G1157-2',
    limits: 'GoPay notification processing on native Postgres not run (Stripe only natively)',
    mapping: 'gopay-notification.ts, gopay lookup',
    requirement: 'GoPay callback contains a payment id',
    rule: 'Only verified lookup evidence reaches Payment',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.gopayNotificationTriggersLookupOnly, T.l2Notification, T.l2Retrieve],
  },
  {
    capability: 'Stripe livemode; Comgate test flag; binding environment',
    expected: 'Rejected/held; no Payment effect',
    id: 'G1157-3',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'family verifiers, notification processor',
    requirement: 'Valid signature for wrong environment',
    rule: 'No cross-environment assignment',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.livemodeMismatchIsRejected, T.l2Notification, T.notificationForAnotherBindingIs],
  },
  {
    capability: 'Provider payment id stable across states',
    expected: 'Not discarded as duplicate; reconciled once',
    id: 'G1157-4',
    limits: 'C17 side unit-level',
    mapping: 'provider-notification-processor.ts',
    requirement: 'Same provider payment ID reports a later state',
    rule: 'Occurrence identity, not object identity',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.sameProviderPaymentReportsA],
  },
  {
    capability: 'Signature authenticity',
    expected: 'SUBMISSION_DENIED; no write; transport result truthful',
    id: 'G1157-5',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'evidence-submission-live.ts',
    requirement: 'Signature verified but owner write is not authorized',
    rule: 'Owner admission required',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.verifiedNotificationStillNeedsThe, T.shellA8],
  },
  {
    capability: 'Relay ACK semantics',
    expected: 'No durable ACK; no financial claim',
    id: 'G1157-6',
    limits: 'Relay surface N1',
    mapping: 'capture Action',
    requirement: 'Crash before durable ingress handoff',
    rule: 'Durable capture before acknowledgement',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.authenticNotificationIsDurablyCaptured, T.aRejectedOrUnboundNotification],
  },
  {
    capability: NONE,
    expected: 'Same operation and binding; R1 and R2 provenance kept',
    id: 'G1157-7',
    limits: 'C16 owner boundary with the C17 contract',
    mapping: 'A8 submission',
    requirement: 'Late callback after compatible release',
    rule: 'Late evidence targets the original operation',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.lateCallbackIsAdmittedBy, T.lateGatewayCallbackThroughThe],
  },
  // ---------------------------------------------------------------------------------------------
  // #1156 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: 'Merchant replacement',
    expected: 'Refund through X, never Y',
    id: 'G1156-1',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: BINDING_RESOLVER,
    requirement: 'New refund after merchant account replacement',
    rule: ORIGINAL_BINDING_RETAINED,
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.bindingIsImmutableForAn, T.lookupThroughTheOriginalBinding],
  },
  {
    capability: AMOUNT_ONLY_REFUND,
    expected: 'Exact amount, original binding, no items',
    id: 'G1156-2',
    limits: 'Adapter path at L2; C16 admission native under #1153',
    mapping: 'family prepareRefund',
    requirement: 'Failed commitment compensation has no invented Order items',
    rule: 'Basis is Payment-owned',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Refund],
  },
  {
    capability: 'Provider-reported amount',
    expected: 'Not EFFECT_CONFIRMED; discrepancy visible; no recollection',
    id: 'G1156-3',
    limits: NO_LIMIT_BEYOND_FIXTURE,
    mapping: 'family evidence mapping',
    requirement: 'Provider confirms a different monetary amount',
    rule: 'Exact amount or discrepancy',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Amount, T.observedAmountMismatchIsA],
  },
  {
    capability: 'Stripe expire of a paid session; Comgate 1400 on paid',
    expected: 'Proven collection preserved; funds return only by REFUND',
    id: 'G1156-4',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'executor cancel handling, psp_prepare_dispatch lock',
    requirement: 'Cancellation races with collection',
    rule: 'Cancel cannot erase a proven collection',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.cancellationRacesWithCollectionCancel,
      T.cancellationRacesWithCollectionCollection,
      T.concurrentCollectionAndCancellationNever,
      T.cancellationRacesWithCollection,
    ],
  },
  {
    capability: 'Stripe balance/payout events; settlement not mapped (N15)',
    expected: 'Observations only; no operation kind; settlement IGNORED',
    id: 'G1156-5',
    limits: 'Settlement mapping returned to PO (N15)',
    mapping: 'stripe-event.ts, psp-vocabulary.ts fact kinds',
    requirement: 'Provider read and settlement fact are not payment commands',
    rule: 'No extra Payment Operation kinds',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Settlement, T.l2Retrieve, T.settlementBalanceEventsNeverCreate],
  },
  // ---------------------------------------------------------------------------------------------
  // #1155 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: NONE,
    expected: 'Only enabled families offered per configuration; exact binding',
    id: 'G1155-1',
    limits: 'Two Customer Configurations under one Legal Entity are asserted through the enablement port, not a UI',
    mapping: 'gateway-binding-live.ts',
    requirement: 'Different configurations enable different gateway families',
    rule: 'Enablement per Customer Configuration + Legal Entity',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.disabledGatewayIsNotOffered, T.selectedBindingMustEqualAn],
  },
  {
    capability: 'Merchant replacement',
    expected: 'R and late C use X',
    id: 'G1155-2',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: BINDING_RESOLVER,
    requirement: 'New refund after Current merchant account replacement',
    rule: ORIGINAL_BINDING_RETAINED,
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.bindingIsImmutableForAn, T.lookupThroughTheOriginalBinding],
  },
  {
    capability: 'Per-binding credentials',
    expected: 'Explicit unavailable / reconciliation; no substitute merchant',
    id: 'G1155-3',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'credentials-live.ts, gateway-operation-recovery.ts',
    requirement: 'Original credentials are unavailable',
    rule: 'No other merchant account substituted',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainBrokenGopay, T.recoveryResolvesTheOriginalBinding, T.missingLookupCredentialsOrAuthority],
  },
  {
    capability: 'Rotation keeps the account',
    expected: 'Current ACTIVE revision authenticates X; operation stays on X',
    id: 'G1155-4',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'binding-resolver-live.ts, credentials-live.ts',
    requirement: 'Credential rotation is not merchant-account replacement',
    rule: 'Rotation is not replacement',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.credentialRotationDoesNotOrphan, T.aRotatedEntryIsPicked],
  },
  {
    capability: NONE,
    expected: 'Gateway not implicitly enabled',
    id: 'G1155-5',
    limits: 'none',
    mapping: 'configure-gateway-enablement Action',
    requirement: 'Configuration permission is not enablement',
    rule: 'Enablement is explicit',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.enableWithoutSourceAuthoritiesIs, T.disabledGatewayIsNotOffered],
  },
  {
    capability: 'Environment-distinct bindings',
    expected: 'Not assigned to another merchant; not financial proof',
    id: 'G1155-6',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'family verifiers, binding resolver',
    requirement: 'A callback cannot cross provider environments',
    rule: 'Environment isolation',
    sandbox: SANDBOX_NOT_RUN,
    tests: [
      T.aNotificationAddressedToAnother,
      T.comgatePushTestFlagMismatch,
      T.l2Notification,
      T.pspEnvironmentIsNotInterchangeable,
    ],
  },
  // ---------------------------------------------------------------------------------------------
  // #1154 gherkin
  // ---------------------------------------------------------------------------------------------
  {
    capability: ALL_FAMILIES,
    expected: 'Direct/automatic collection; no stored card, off-session, delayed capture or donor state',
    id: 'G1154-1',
    limits: 'Provider acceptance not sandbox-verified',
    mapping: 'family prepareCollect',
    requirement: 'Each required gateway maps a direct collection (GoPay, Stripe, Comgate)',
    rule: 'One-shot Launch collection',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Create, T.l2Contract, T.captureMethodIsExplicitlyAutomatic],
  },
  {
    capability: AMOUNT_ONLY_REFUND,
    expected: 'Exact amount, stable identity, no items, acceptance pending',
    id: 'G1154-2',
    limits: 'Adapter path at L2',
    mapping: 'family prepareRefund',
    requirement: 'Refund basis does not alter the provider primitive',
    rule: 'Basis is Payment-owned',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Refund],
  },
  {
    capability: PER_FAMILY_CREDENTIALS,
    expected: 'GoPay is not a dependency of Stripe; no provider switch',
    id: 'G1154-3',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'gateway-adapters-live.ts, credentials-live.ts',
    requirement: 'Unrelated gateway is unavailable',
    rule: 'No cross-family fallback',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainBrokenGopay, T.unrelatedGatewayIsUnavailable],
  },
  // ---------------------------------------------------------------------------------------------
  // #1153 gherkin (C16 owner evidence; no provider)
  // ---------------------------------------------------------------------------------------------
  C16_OWNER(
    'G1153-1',
    'Commitment requests a COD proof',
    'Attempt-bound method-condition proof; no collection claimed',
    [T.codCommitmentBeforeHandoverIssues],
    'Proof issued; no COLLECT',
  ),
  C16_OWNER(
    'G1153-2',
    'Staff refunds one complete item',
    'One REFUND for that item',
    [T.refundOneItemFromA],
    'One REFUND operation; Order/Claim/Billing untouched',
  ),
  C16_OWNER(
    'G1153-3',
    'Failed commitment compensates without fictitious items',
    'Exact remaining amount; no synthesized items',
    [T.collectedPaymentButCommitmentProves],
    'Compensation REFUND of the exact remainder',
  ),
  C16_OWNER(
    'G1153-4',
    'Missing COD capability leaves an unrelated method independent',
    'COD UNAVAILABLE_TO_VERIFY; bank transfer on its own prerequisites',
    [T.requiredCodEvidenceCannotBe],
    'Independent applicability outcomes',
  ),
  C16_OWNER(
    'G1153-5',
    'Historical information does not authorize suspended-module writes',
    'History returned; callback, refund and recovery denied',
    [T.historicalInformationDoesNotAuthorize],
    'Denied writes; permitted historical read',
  ),
  C16_OWNER(
    'G1153-6',
    'Ingress credentials do not replace owner permission',
    'Denied before any business effect',
    [T.ingressCredentialsDoNotReplace],
    'Denial, no effect',
  ),
  C16_OWNER(
    'G1153-7',
    'New runtime authority preserves the original monetary lineage',
    'Same O and effect; R2 authority recorded separately',
    [T.lateGatewayCallbackThroughThe, T.lateCallbackIsAdmittedBy],
    'Original lineage, separate R2 provenance',
  ),
  C16_OWNER(
    'G1153-8',
    'An unsafe unresolved task still prevents false completion',
    'Debt explicit; no fake DONE',
    [T.anUnsafeUnresolvedTaskStill],
    'R1 neither drains nor seals',
  ),
  C16_OWNER(
    'G1153-9',
    'Owner tests are not reported as provider conformance',
    'This traceability states the level that ran and NOT RUN sandbox evidence',
    [{ file: `${P}/unit/psp-conformance-traceability.test.ts`, title: '#1159 no row claims sandbox evidence' }],
    'Owner evidence distinguished from provider evidence',
  ),
  // ---------------------------------------------------------------------------------------------
  // Plan section 6, level-3 scenarios (each names its boundary in the test file)
  // ---------------------------------------------------------------------------------------------
  {
    capability: NONE,
    expected: 'Capture refused for suspended / read_only / quarantined',
    id: 'L3-1',
    limits:
      'NOT native: the acceptance-module-state matrix lists the 16 C16 entrypoints and not capture-provider-notification; the capture gate ran only against the Core gate in a unit test',
    mapping: 'capture-provider-notification descriptor',
    requirement: 'capture Action under module states active/suspended/read_only/quarantined',
    rule: 'Core entrypoint gate',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.captureIsRefusedWhileThe, T.everyRegisteredEntrypointGetsExactly],
  },
  {
    capability: NONE,
    expected: 'Refused: stale Composition, suspended Payment, unbound workload, wrong binding',
    id: 'L3-2',
    limits: 'Capture Action denied source permission is unit-level',
    mapping: 'Shell RegisteredWorkload issuance + A8 receiver decision',
    requirement:
      'capture with stale Composition revision, denied source permission, wrong source binding / workload unbound (#1159:91)',
    rule: 'Core gate + A8 qualification',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.shellA8, T.captureWithAnUnboundWorkload],
  },
  {
    capability: NONE,
    expected: 'No claim in any non-active consumer state',
    id: 'L3-3',
    limits: 'Proven by the Core Outbox suite with a generic fixture consumer, not with Payment workers',
    mapping: 'Core claim SQL',
    requirement: 'worker claim eligibility per module state (claim SQL)',
    rule: 'Background admission per Module State',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.coreClaimStates],
  },
  {
    capability: NONE,
    expected: 'operation-requested and lookup recovery are durable work; drain blocked until done',
    id: 'L3-4',
    limits: 'none',
    mapping: 'completion-bound subscriptions',
    requirement: 'completion-bound operation-requested and lookup recovery; drain blocking',
    rule: 'Core composition',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.gatewayCollectionDispatchIsTracked, T.lookupRecoveryDeliveryIsTracked, T.drainIsBlockedWhileGateway2],
  },
  {
    capability: NONE,
    expected: 'One dispatch; cancel-first withholds the collect, collect-first sends then cancels',
    id: 'L3-5',
    limits: 'none',
    mapping: 'psp_prepare_dispatch advisory lock',
    requirement: 'ledger uniqueness under two concurrent executors; cancel-vs-collect race in both orders',
    rule: 'Advisory lock + prepare refusal',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [
      T.oneDispatchPerPaymentOperation,
      T.cancellationRacesWithCollectionCancel,
      T.cancellationRacesWithCollectionCollection,
      T.concurrentCollectionAndCancellationNever,
    ],
  },
  {
    capability: 'Stripe replay; GoPay/Comgate no replay',
    expected: 'No double send; Stripe replay; GoPay OUTCOME_UNKNOWN',
    id: 'L3-6',
    limits: 'none',
    mapping: 'executor + ledger',
    requirement: 'crash before/after psp_prepare_dispatch commit',
    rule: 'Never double-send',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.crashBeforeDurableHandoffSends, T.crashAfterHandoffNeverDouble],
  },
  {
    capability: 'Stripe Idempotency-Key 24 h',
    expected: 'Deferred, then one exact replay; ACKNOWLEDGED',
    id: 'L3-7',
    limits: 'Executor native test uses a fake adapter; the real Stripe replay is L2 (stripe-adapter unit)',
    mapping: 'executor replay',
    requirement: 'Stripe lost create response automatically recovered by executor replay within 24 h',
    rule: 'Replay only inside the proven window',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.stripeLostResponseRecoveredInside, T.stripeLostCreateResponseIs],
  },
  {
    capability: 'Stripe event metadata order reference; PaymentIntent retrieve; Refunds API',
    expected: 'Correlated; COLLECTION_CONFIRMED submitted; refund names the notified PaymentIntent',
    id: 'L3-8',
    limits: 'Stripe only natively; capture row inserted, A8 hop is a stand-in',
    mapping: 'executor, notification processor, ledger correlation, Stripe adapter',
    requirement:
      'create response lost, then notification arrives -> order-reference correlation -> later refund has provider target',
    rule: 'Lost create never blocks a later refund of the proven collection',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainLostCreate, T.createResponseLostThenNotification],
  },
  {
    capability: NONE,
    expected: 'R1 checkpoint releases drain; R2 late observation keeps lineage',
    id: 'L3-9',
    limits: NO_LIMIT_BEYOND_NATIVE,
    mapping: 'executor checkpoint, A8',
    requirement:
      'R1 checkpoint vs R2 late observation after a Composition change; worker restart + Composition change with an unresolved effect',
    rule: 'No forced DONE; no relabelling',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.drainIsBlockedWhileGateway2, T.lateCallbackIsAdmittedBy, T.crashAfterHandoffNeverDouble],
  },
  {
    capability: NONE,
    expected: 'Workload originals admitted to A8; human-admitted A10 denied',
    id: 'L3-10',
    limits: 'Payment contract restated in the Shell test (Shell does not depend on @app/payment)',
    mapping: 'Shell gateway issuance',
    requirement: 'RegisteredWorkload path to A8 via Shell native fixture; denial for a human-admitted A10 origin',
    rule: 'Only workload-admitted originals',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.shellA8],
  },
  {
    capability: PER_FAMILY_CREDENTIALS,
    expected: 'Stripe ACKNOWLEDGED; GoPay never sent; bank Payment unaffected',
    id: 'L3-11',
    limits: 'Bank Payment created through persistence, not through the Action runtime',
    mapping: 'credentials-live.ts',
    requirement: 'broken GoPay credential entry: Stripe execution and non-gateway Payment unaffected',
    rule: 'H1094-01=A',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.chainBrokenGopay],
  },
  {
    capability: 'Return URL',
    expected: 'No evidence submitted',
    id: 'L3-12',
    limits: 'none',
    mapping: RETURN_STATUS_READ,
    requirement: 'browser return produces no evidence submission',
    rule: 'Browser return is not evidence',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.browserReturnWithoutFinancialEvidence],
  },
  {
    capability: NONE,
    expected: 'Conflict; no provider call',
    id: 'L3-13',
    limits: 'none',
    mapping: 'psp_prepare_dispatch material hash',
    requirement: 'refund basis-only change -> conflict, no provider call',
    rule: 'Material hash covers the basis',
    sandbox: SANDBOX_NOT_APPLICABLE,
    tests: [T.sameLogicalRefundButChanged],
  },
  {
    capability: 'GoPay v4 DELETE /payments/{id} then GET /payments/{id}',
    expected:
      '204+CANCELED: CANCEL_CONFIRMED + COLLECTION_NOT_EFFECTED; 409+PAYMENT_METHOD_CHOSEN: CANCEL_NOT_EFFECTED; never resent',
    id: 'L3-14',
    limits: 'GoPay v4 cancel not sandbox-verified (N8 merge gate)',
    mapping: 'gopay prepareCancel/send, mapGopayCancelAnswer',
    requirement: 'GoPay cancel is sent once through the original binding and decided by the lookup',
    rule: 'A cancel answer alone never proves its effect',
    sandbox: SANDBOX_NOT_RUN,
    tests: [T.l2Cancel, T.chainGopayCancel],
  },
];

/**
 * The evidence level of one test, by where it runs: `native` = tests/integration (native PostgreSQL + Core runtime);
 * `fixture` = the level-2 provider matrix and the per-family adapter suites (production adapters over recorded,
 * documented provider bodies); `unit` = any other unit test.
 */
export const levelOf = (test: TracedTest): EvidenceLevel => {
  if (test.file.includes('/tests/integration/')) {
    return 'native';
  }
  return test.file === MATRIX || test.file.endsWith('-adapter.test.ts') ? 'fixture' : 'unit';
};

/** Every traced requirement; owner rows built by `C16_OWNER` take their id from their requirement text. */
export const TRACEABILITY: readonly TraceRow[] = rows.map((row) => ({
  ...row,
  ran: EVIDENCE_LEVELS.filter((level) => row.tests.some((test) => levelOf(test) === level)),
}));

const range = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(prefix === 'NEG-' ? 2 : 1, '0')}`);

/** The requirement ids #1159 and plan section 6 demand; every one needs a row. */
export const REQUIRED_TRACE_IDS: readonly string[] = [
  ...range('MIN-', 8),
  ...range('AC-', 2),
  ...range('NEG-', 19),
  ...range('G1153-', 9),
  ...range('G1154-', 3),
  ...range('G1155-', 6),
  ...range('G1156-', 5),
  ...range('G1157-', 7),
  ...range('G1158-', 6),
  ...range('G1159-', 6),
  ...range('L3-', 14),
];

/** Conformance blockers returned to PO (#1159 completion gate); no gateway is silently dropped. */
export const PO_BLOCKERS = ['N8', 'N9', 'N10', 'N15'] as const;

/** README columns of the traceability table, in order. */
export const TRACE_TABLE_HEADER = [
  'ID',
  'Requirement',
  'Accepted Payment rule',
  'Provider capability evidence',
  'Adapter mapping',
  'Tests',
  'Expected observation',
  'Ran',
  'Provider sandbox',
  'Not proven',
] as const;

const testFileLabel = (file: string) =>
  file.startsWith(`${P}/`) ? file.slice(P.length + 1).replace(/\.test\.ts$/u, '') : file.replace(/\.test\.ts$/u, '');

const testKeyOf = (test: TracedTest) => `${test.file}\u0000${test.title}`;

/** Every cited test once, in order of first citation, with its README key (`T001`, ...). */
export const TRACE_TEST_INDEX: readonly (TracedTest & { readonly key: string })[] = [
  ...new Map(TRACEABILITY.flatMap(({ tests }) => tests).map((test) => [testKeyOf(test), test])).values(),
].map((test, index) => ({ ...test, key: `T${String(index + 1).padStart(3, '0')}` }));

const indexKeyOf = (test: TracedTest) =>
  TRACE_TEST_INDEX.find((entry) => testKeyOf(entry) === testKeyOf(test))?.key ?? 'unindexed';

/** README cells of one test index entry. */
export const traceTestIndexCells = (entry: (typeof TRACE_TEST_INDEX)[number]): readonly string[] => [
  entry.key,
  testFileLabel(entry.file),
  entry.title,
];

/** The README cells of one row (the README table is checked against these). */
export const traceTableCells = (row: TraceRow): readonly string[] => [
  row.id,
  row.requirement,
  row.rule,
  row.capability,
  row.mapping,
  row.tests.map(indexKeyOf).join(', '),
  row.expected,
  row.ran.join(' + '),
  row.sandbox,
  row.limits,
];
