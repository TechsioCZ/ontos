import { DateTime, Effect, Schema } from 'effect';
import type {
  BusinessPolicyState,
  CounterpartyOrderHistoryInput,
  CounterpartyOrderHistoryDetailInput,
  CustomerArchiveInput,
  CustomerArchiveItem,
  CustomerOrderHistoryItem,
  CustomerOrderHistoryDetail,
  CounterpartyHistoryScope,
  HistoryDegradation,
  RepeatOrderLineResult,
  RepeatOrderPreparationInput,
  RepeatOrderPreparationResult,
  RetailOrderHistoryInput,
  RetailOrderHistoryDetailInput,
} from './history-contracts.ts';
import { HistoryAccessDenied, HistoryOwnerUnavailable, HistoryRecordNotFound } from './history-errors.ts';
import type {
  ArchiveRecordCandidate,
  CounterpartyHistoryAuthorizationFacts,
  CustomerHistoryPorts,
  CustomerRecordVisibilityLookup,
  HistoricalOrderCandidate,
  HistoricalOrderDetailAuthorizationCandidate,
  RetailHistoryAuthorizationFacts,
} from './history-ports.ts';
import { evaluateCustomerRecordVisibility } from './record-visibility-contracts.ts';
import type {
  CustomerFacingFieldSet,
  CustomerHistorySubject,
  HistoricalRecordRef,
  CustomerRecordTypeOnboarding,
  CustomerRecordVisibilityDecision,
} from './record-visibility-contracts.ts';

const CUSTOMER_HISTORY_SUMMARY_FIELD_SET = Object.freeze({
  name: 'customer-history.summary',
  version: '1',
}) satisfies CustomerFacingFieldSet;
const CUSTOMER_ORDER_HISTORY_DETAIL_FIELD_SET = Object.freeze({
  name: 'customer-order-history.detail',
  version: '1',
}) satisfies CustomerFacingFieldSet;
const COUNTERPARTY_HISTORY_READ_ALL = 'counterparty.history.read_all' as const;
const COUNTERPARTY_HISTORY_READ_OWN = 'counterparty.history.read_own' as const;
const CUSTOMER_CONTEXT_OWNER = 'commerce.customer-context';
const RETAIL_HISTORY_READ = 'retail.history.read' as const;

const staleListRecordAllowed = (observedAt: string, now: string, maximumAge: number): boolean => {
  const observedAtMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(observedAt));
  const nowMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(now));
  return observedAtMilliseconds <= nowMilliseconds && nowMilliseconds - observedAtMilliseconds <= maximumAge;
};

interface HistoryCollection<Item> {
  readonly degradations: readonly HistoryDegradation[];
  readonly items: readonly Item[];
}

interface ArchiveSourceOutcome extends HistoryCollection<CustomerArchiveItem> {
  readonly available: boolean;
}

const successfulArchiveSource = (
  outcomes: readonly HistoryCollection<CustomerArchiveItem>[],
): ArchiveSourceOutcome => ({
  available: true,
  degradations: outcomes.flatMap((outcome) => outcome.degradations),
  items: outcomes.flatMap((outcome) => outcome.items),
});

const sameRecord = (left: HistoricalRecordRef, right: HistoricalRecordRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameCounterpartySubject = (
  left: Extract<CustomerHistorySubject, { readonly kind: 'COUNTERPARTY' }>,
  right: Extract<CustomerHistorySubject, { readonly kind: 'COUNTERPARTY' }>,
): boolean => sameRecord(left.profileRef, right.profileRef) && sameRecord(left.counterpartyRef, right.counterpartyRef);

const sameSubject = (left: CustomerHistorySubject, right: CustomerHistorySubject): boolean => {
  if (left.kind !== right.kind || !sameRecord(left.profileRef, right.profileRef)) {
    return false;
  }
  if (left.kind !== 'COUNTERPARTY' || right.kind !== 'COUNTERPARTY') {
    return true;
  }
  return sameCounterpartySubject(left, right);
};

const recordTypeContractMatches = (
  recordRef: HistoricalRecordRef,
  contract: {
    readonly canonicalOwnerModuleId: string;
    readonly canonicalResourceType: string;
    readonly transitionContract: { readonly ownerModuleId: string };
  },
): boolean =>
  contract.canonicalOwnerModuleId === recordRef.moduleId &&
  contract.canonicalResourceType === recordRef.resourceType &&
  contract.transitionContract.ownerModuleId === contract.canonicalOwnerModuleId;

const recordTypeContractAdmitsSubject = (
  relationship: 'EXACT_COUNTERPARTY' | 'EXACT_RETAIL_PROFILE' | 'RETAIL_OR_COUNTERPARTY',
  subject: CustomerHistorySubject,
): boolean =>
  relationship === 'RETAIL_OR_COUNTERPARTY' ||
  (relationship === 'EXACT_RETAIL_PROFILE' && subject.kind === 'RETAIL_PROFILE') ||
  (relationship === 'EXACT_COUNTERPARTY' && subject.kind === 'COUNTERPARTY');

const fieldSetMatches = (left: CustomerFacingFieldSet, right: CustomerFacingFieldSet): boolean =>
  left.name === right.name && left.version === right.version;

const allowsFields = (allowlist: readonly string[], fields: readonly string[]): boolean => {
  const allowed = new Set(allowlist);
  return fields.every((field) => allowed.has(field));
};

const allowsCallerPermissions = (declared: readonly string[], granted: readonly string[]): boolean => {
  const grantedPermissions = new Set(granted);
  return declared.some((permission) => grantedPermissions.has(permission));
};

const requestedFieldSetIsDeclared = (
  contract: CustomerRecordTypeOnboarding,
  requestedFieldSet: CustomerFacingFieldSet,
): boolean =>
  fieldSetMatches(contract.fieldContracts.list, requestedFieldSet) ||
  fieldSetMatches(contract.fieldContracts.detail, requestedFieldSet) ||
  (contract.fieldContracts.download !== null && fieldSetMatches(contract.fieldContracts.download, requestedFieldSet));

/**
 * Keep the owner onboarding document closed by default even when a test double or
 * transport adapter returns an object without going through the schema decoder.
 *
 * `additionalBusinessPolicies` is a declaration that the owner policy gate is part
 * of this record type's admission contract.  The current customer-context policy
 * state is checked before each composition entrypoint; an empty declaration must
 * never be interpreted as "no policy required".
 */
const onboardingContractIsUsable = (contract: {
  readonly additionalBusinessPolicies: readonly string[];
  readonly callerPermissions: readonly string[];
}): boolean => {
  const policies = contract.additionalBusinessPolicies;
  const permissions = contract.callerPermissions;
  return (
    policies.length > 0 &&
    permissions.length > 0 &&
    policies.every((policy) => policy.trim().length > 0) &&
    permissions.every((permission) => permission.trim().length > 0) &&
    new Set(policies).size === policies.length &&
    new Set(permissions).size === permissions.length
  );
};

const recordTypeAllowsVisibility = (
  contract: CustomerRecordTypeOnboarding | null,
  recordRef: HistoricalRecordRef,
  subject: CustomerHistorySubject,
  callerPermissions: readonly string[],
  requestedFieldSet: CustomerFacingFieldSet,
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- This contextual admission check depends on the requested record, subject, permissions, and field set; moving it into the public onboarding schema would change that contract.
): contract is CustomerRecordTypeOnboarding =>
  contract !== null &&
  onboardingContractIsUsable(contract) &&
  recordTypeContractMatches(recordRef, contract) &&
  recordTypeContractAdmitsSubject(contract.customerContextRelationship, subject) &&
  allowsCallerPermissions(contract.callerPermissions, callerPermissions) &&
  requestedFieldSetIsDeclared(contract, requestedFieldSet);

const futureObservation = (observedAt: string, now: string): boolean =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(observedAt)) > DateTime.toEpochMillis(DateTime.makeUnsafe(now));

const repeatCallerPermission = (subject: CustomerHistorySubject, scope: CounterpartyHistoryScope | null): string => {
  if (subject.kind === 'RETAIL_PROFILE') {
    return RETAIL_HISTORY_READ;
  }
  return scope === 'ALL_COUNTERPARTY_ORDERS' ? COUNTERPARTY_HISTORY_READ_ALL : COUNTERPARTY_HISTORY_READ_OWN;
};

const unavailable = (ownerModuleId: string) => new HistoryOwnerUnavailable({ ownerModuleId });
const denied = (reason: HistoryAccessDenied['reason']) =>
  new HistoryAccessDenied({ code: 'history_access_denied', reason });
const historyRecordNotFound = () =>
  new HistoryRecordNotFound({
    code: 'history_record_not_found',
    reason: 'HISTORICAL_RECORD_NOT_FOUND',
  });

const requireCounterpartyAssociation = Effect.fn('HistoryComposition.requireCounterpartyAssociation')(
  function* association(
    ports: CustomerHistoryPorts,
    subject: Extract<CustomerHistorySubject, { readonly kind: 'COUNTERPARTY' }>,
  ) {
    const state = yield* ports.counterpartyProfiles.current({
      counterpartyRef: subject.counterpartyRef,
      profileRef: subject.profileRef,
    });
    if (state === 'INDETERMINATE') {
      return yield* unavailable(CUSTOMER_CONTEXT_OWNER);
    }
    if (state === 'ABSENT') {
      return yield* new HistoryAccessDenied({
        code: 'history_access_denied',
        reason: 'TARGET_CONTEXT_MISMATCH',
      });
    }
    return yield* Effect.void;
  },
);

const visibilityFactFromLookup = (lookup: CustomerRecordVisibilityLookup) => {
  if (lookup.outcome === 'FOUND') {
    return lookup.fact;
  }
  if (lookup.outcome === 'INDETERMINATE') {
    return 'INDETERMINATE' as const;
  }
  return null;
};

const requirePolicy = (policy: 'ALLOWED' | 'DENIED' | 'INDETERMINATE') => {
  if (policy === 'INDETERMINATE') {
    return Effect.fail(unavailable(CUSTOMER_CONTEXT_OWNER));
  }
  return policy === 'ALLOWED' ? Effect.void : Effect.fail(denied('OWNER_POLICY_DENIED'));
};

/**
 * Record owners may publish more than one business Policy for a customer-facing record type.
 * New adapters provide the keyed projection; older adapters expose only the aggregate decision,
 * which remains the compatibility fallback until those adapters are upgraded. An explicitly
 * supplied but incomplete projection fails closed instead of silently skipping a Policy.
 */
const requireRecordPolicy = (
  policy: BusinessPolicyState | undefined,
): Effect.Effect<void, HistoryAccessDenied | HistoryOwnerUnavailable> =>
  policy === undefined ? Effect.fail(unavailable(CUSTOMER_CONTEXT_OWNER)) : requirePolicy(policy);

const requireRecordPolicies = Effect.fn('HistoryComposition.requireRecordPolicies')(function* requireRecordPolicies(
  contract: { readonly additionalBusinessPolicies: readonly string[] },
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
) {
  yield* Effect.forEach(
    contract.additionalBusinessPolicies,
    (policyKey): Effect.Effect<void, HistoryAccessDenied | HistoryOwnerUnavailable> =>
      requireRecordPolicy(policies === undefined ? aggregatePolicy : policies[policyKey]),
    { concurrency: 1, discard: true },
  );
});

const requireGate = (gate: 'ABSENT' | 'CURRENT' | 'INDETERMINATE', absentReason: HistoryAccessDenied['reason']) => {
  if (gate === 'INDETERMINATE') {
    return Effect.fail(unavailable(CUSTOMER_CONTEXT_OWNER));
  }
  return gate === 'CURRENT' ? Effect.void : Effect.fail(denied(absentReason));
};

const requireHistoricalResourceAccess = Effect.fn('HistoryComposition.requireHistoricalResourceAccess')(
  function* resourceAccess(ports: CustomerHistoryPorts, principalId: string, refs: readonly HistoricalRecordRef[]) {
    const decision = yield* ports.resources.current({ principalId, refs });
    if (decision === 'INDETERMINATE') {
      return yield* unavailable('commerce.authorization');
    }
    if (decision === 'ABSENT') {
      return yield* denied('RESOURCE_READ_REQUIRED');
    }
    return yield* Effect.void;
  },
);

const authorizeRetailHistory = Effect.fn('HistoryComposition.authorizeRetailHistory')(function* authorize(
  facts: RetailHistoryAuthorizationFacts,
) {
  yield* requireGate(facts.binding, 'CURRENT_BINDING_REQUIRED');
  yield* requireGate(facts.historyPermission, 'HISTORY_PERMISSION_REQUIRED');
  yield* requirePolicy(facts.policy);
});

type CounterpartyHistoryPermission = Exclude<
  CounterpartyHistoryAuthorizationFacts['historyPermission'],
  'INDETERMINATE' | null
>;

const authorizeCounterpartyHistory = Effect.fn('HistoryComposition.authorizeCounterpartyHistory')(function* authorize(
  facts: CounterpartyHistoryAuthorizationFacts,
  requiredPermission: CounterpartyHistoryPermission,
) {
  yield* requireGate(facts.access, 'COUNTERPARTY_ACCESS_REQUIRED');
  if (facts.historyPermission === 'INDETERMINATE') {
    return yield* unavailable(CUSTOMER_CONTEXT_OWNER);
  }
  if (facts.historyPermission === null || facts.historyPermission !== requiredPermission) {
    return yield* denied('COUNTERPARTY_HISTORY_PERMISSION_REQUIRED');
  }
  yield* requirePolicy(facts.policy);
  return facts.historyPermission === COUNTERPARTY_HISTORY_READ_ALL
    ? ('ALL_COUNTERPARTY_ORDERS' as const)
    : ('OWN_ORDERS' as const);
});

const authorizeAnyCounterpartyHistory = Effect.fn('HistoryComposition.authorizeAnyCounterpartyHistory')(
  function* authorize(facts: CounterpartyHistoryAuthorizationFacts) {
    yield* requireGate(facts.access, 'COUNTERPARTY_ACCESS_REQUIRED');
    if (facts.historyPermission === 'INDETERMINATE') {
      return yield* unavailable(CUSTOMER_CONTEXT_OWNER);
    }
    if (
      facts.historyPermission !== COUNTERPARTY_HISTORY_READ_ALL &&
      facts.historyPermission !== COUNTERPARTY_HISTORY_READ_OWN
    ) {
      return yield* denied('COUNTERPARTY_HISTORY_PERMISSION_REQUIRED');
    }
    yield* requirePolicy(facts.policy);
    return facts.historyPermission === COUNTERPARTY_HISTORY_READ_ALL
      ? ('ALL_COUNTERPARTY_ORDERS' as const)
      : ('OWN_ORDERS' as const);
  },
);

const visibilityFor = Effect.fn('HistoryComposition.visibilityFor')(function* visibility(
  ports: CustomerHistoryPorts,
  recordRef: HistoricalRecordRef,
  subject: CustomerHistorySubject,
  principalId: string,
  now: string,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
  requestedFieldSet: CustomerFacingFieldSet = CUSTOMER_HISTORY_SUMMARY_FIELD_SET,
) {
  const contract = yield* ports.recordTypes.get({
    ownerModuleId: recordRef.moduleId,
    resourceType: recordRef.resourceType,
  });
  if (!recordTypeAllowsVisibility(contract, recordRef, subject, callerPermissions, requestedFieldSet)) {
    return { outcome: 'DENIED', reason: 'VISIBILITY_MISSING' } as const;
  }
  yield* requireRecordPolicies(contract, aggregatePolicy, policies);
  const lookup = yield* ports.visibility.get({ recordRef, subject });
  const decision = evaluateCustomerRecordVisibility({
    fact: visibilityFactFromLookup(lookup),
    now,
    recordRef,
    requestedFieldSet,
    subject,
  });
  if (decision.outcome !== 'VISIBLE') {
    return decision;
  }
  yield* requireHistoricalResourceAccess(ports, principalId, [recordRef, decision.evidenceRef]);
  return decision;
});

const visibleOrderItems = Effect.fn('HistoryComposition.visibleOrderItems')(function* collect(
  ports: CustomerHistoryPorts,
  orders: readonly HistoricalOrderCandidate[],
  subject: CustomerHistorySubject,
  principalId: string,
  now: string,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
) {
  const admissions = yield* Effect.forEach(
    orders,
    (order) =>
      ports.recordTypes.get({ ownerModuleId: order.orderRef.moduleId, resourceType: order.orderRef.resourceType }).pipe(
        Effect.match({
          onFailure: (error) => ({
            order,
            outcome: 'UNAVAILABLE' as const,
            ownerModuleId: error.ownerModuleId,
          }),
          onSuccess: (contract) =>
            contract !== null &&
            onboardingContractIsUsable(contract) &&
            recordTypeContractMatches(order.orderRef, contract) &&
            recordTypeContractAdmitsSubject(contract.customerContextRelationship, subject) &&
            allowsCallerPermissions(contract.callerPermissions, callerPermissions) &&
            fieldSetMatches(contract.fieldContracts.list, CUSTOMER_HISTORY_SUMMARY_FIELD_SET) &&
            allowsFields(contract.fieldAllowlist.list, ['acceptedAt', 'displayLabel', 'freshness', 'orderRef'])
              ? ({ contract, order, outcome: 'ADMITTED' as const } as const)
              : ({ order, outcome: 'NOT_ADMITTED' as const } as const),
        }),
      ),
    { concurrency: 8 },
  );
  const admissionDegradations = admissions.flatMap((admission): readonly HistoryDegradation[] =>
    admission.outcome === 'UNAVAILABLE'
      ? [
          {
            code: 'ONBOARDING_UNAVAILABLE',
            ownerModuleId: admission.ownerModuleId,
            retryable: true,
          },
        ]
      : [],
  );
  const admittedOrders = admissions.filter((admission) => admission.outcome === 'ADMITTED');
  const outcomes = yield* Effect.forEach(
    admittedOrders,
    ({ contract, order }) => {
      if (!sameSubject(order.subject, subject)) {
        return Effect.succeed<HistoryCollection<CustomerOrderHistoryItem>>({
          degradations: [],
          items: [],
        });
      }
      if (
        futureObservation(order.freshness.observedAt, now) ||
        (order.freshness.status === 'STALE' &&
          !staleListRecordAllowed(order.freshness.observedAt, now, contract.freshnessPolicy.listMaxAgeMilliseconds))
      ) {
        return Effect.succeed<HistoryCollection<CustomerOrderHistoryItem>>({
          degradations: [
            {
              code: 'SOURCE_STALE',
              ownerModuleId: order.orderRef.moduleId,
              retryable: true,
            },
          ],
          items: [],
        });
      }
      return visibilityFor(
        ports,
        order.orderRef,
        subject,
        principalId,
        now,
        callerPermissions,
        aggregatePolicy,
        policies,
      ).pipe(
        Effect.match({
          onFailure: (error): HistoryCollection<CustomerOrderHistoryItem> =>
            Schema.is(HistoryOwnerUnavailable)(error)
              ? {
                  degradations: [
                    {
                      code: 'VISIBILITY_UNAVAILABLE' as const,
                      ownerModuleId: error.ownerModuleId,
                      retryable: true,
                    },
                  ],
                  items: [],
                }
              : { degradations: [], items: [] },
          onSuccess: (decision): HistoryCollection<CustomerOrderHistoryItem> => {
            if (decision.outcome === 'DENIED') {
              return { degradations: [], items: [] };
            }
            if (decision.outcome === 'UNAVAILABLE') {
              return {
                degradations: [
                  {
                    code: 'VISIBILITY_UNAVAILABLE' as const,
                    ownerModuleId: order.orderRef.moduleId,
                    retryable: true,
                  },
                ],
                items: [],
              };
            }
            const item: CustomerOrderHistoryItem = {
              acceptedAt: order.acceptedAt,
              displayLabel: order.displayLabel,
              freshness: order.freshness,
              orderRef: order.orderRef,
              visibility: decision,
            };
            return {
              degradations:
                order.freshness.status === 'STALE'
                  ? [
                      {
                        code: 'SOURCE_STALE' as const,
                        ownerModuleId: order.orderRef.moduleId,
                        retryable: true,
                      },
                    ]
                  : [],
              items: [item],
            };
          },
        }),
      );
    },
    { concurrency: 8 },
  );
  return {
    degradations: [...admissionDegradations, ...outcomes.flatMap((outcome) => outcome.degradations)],
    items: outcomes.flatMap((outcome) => outcome.items),
  };
});

export const composeRetailOrderHistory = Effect.fn('HistoryComposition.composeRetailOrderHistory')(
  function* retailHistory(ports: CustomerHistoryPorts, input: RetailOrderHistoryInput) {
    const facts = yield* ports.access.retail({
      principalId: input.principalId,
      profileRef: input.profileRef,
    });
    yield* authorizeRetailHistory(facts);
    const subject = { kind: 'RETAIL_PROFILE' as const, profileRef: input.profileRef };
    const orders = yield* ports.orders.listRetail({ profileRef: input.profileRef });
    const visible = yield* visibleOrderItems(
      ports,
      orders,
      subject,
      input.principalId,
      input.now,
      [RETAIL_HISTORY_READ],
      facts.policy,
      facts.policies,
    );
    return { ...visible, profileRef: input.profileRef };
  },
);

const composeCounterpartyHistoryForPermission = Effect.fn('HistoryComposition.composeCounterpartyHistoryForPermission')(
  function* counterpartyHistory(
    ports: CustomerHistoryPorts,
    input: CounterpartyOrderHistoryInput,
    requiredPermission: CounterpartyHistoryPermission,
  ) {
    const facts = yield* ports.access.counterparty({
      principalId: input.principalId,
      profileRef: input.profileRef,
    });
    yield* requireCounterpartyAssociation(ports, {
      counterpartyRef: input.counterpartyRef,
      kind: 'COUNTERPARTY',
      profileRef: input.profileRef,
    });
    const scope = yield* authorizeCounterpartyHistory(facts, requiredPermission);
    const subject = {
      counterpartyRef: input.counterpartyRef,
      kind: 'COUNTERPARTY' as const,
      profileRef: input.profileRef,
    };
    const orders = yield* ports.orders.listCounterparty({
      counterpartyRef: input.counterpartyRef,
      profileRef: input.profileRef,
    });
    const scopedOrders =
      scope === 'OWN_ORDERS' ? orders.filter((order) => order.submittedByPrincipalId === input.principalId) : orders;
    const visible = yield* visibleOrderItems(
      ports,
      scopedOrders,
      subject,
      input.principalId,
      input.now,
      [requiredPermission],
      facts.policy,
      facts.policies,
    );
    return { ...visible, profileRef: input.profileRef, scope };
  },
);

export const composeCounterpartyOrderHistory = (ports: CustomerHistoryPorts, input: CounterpartyOrderHistoryInput) =>
  composeCounterpartyHistoryForPermission(ports, input, COUNTERPARTY_HISTORY_READ_OWN);

export const composeCounterpartyAllOrderHistory = (ports: CustomerHistoryPorts, input: CounterpartyOrderHistoryInput) =>
  composeCounterpartyHistoryForPermission(ports, input, COUNTERPARTY_HISTORY_READ_ALL);

const fieldGrantContractAllows = (
  contract: CustomerRecordTypeOnboarding | null,
  field: CustomerOrderHistoryDetail['fields'][number],
  subject: CustomerHistorySubject,
  callerPermissions: readonly string[],
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- This contextual field authorization depends on the requested field, subject, and caller permissions; it is not an intrinsic onboarding-schema invariant.
): contract is CustomerRecordTypeOnboarding =>
  contract !== null &&
  onboardingContractIsUsable(contract) &&
  recordTypeContractMatches(field.visibility.recordRef, contract) &&
  recordTypeContractAdmitsSubject(contract.customerContextRelationship, subject) &&
  allowsCallerPermissions(contract.callerPermissions, callerPermissions) &&
  fieldSetMatches(contract.fieldContracts.detail, field.visibility.fieldSet) &&
  contract.fieldAllowlist.detail.includes(field.fieldName);

const fieldGrantMatchesDecision = (
  decision: CustomerRecordVisibilityDecision,
  field: CustomerOrderHistoryDetail['fields'][number],
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- This correlates an already-decoded decision with runtime field provenance; placing field-specific equality in the shared decision schema would change its public contract.
): decision is Extract<CustomerRecordVisibilityDecision, { readonly outcome: 'VISIBLE' }> =>
  decision.outcome === 'VISIBLE' &&
  decision.ownerModuleId === field.ownerModuleId &&
  decision.sourceRevision === field.sourceRevision;

const resolveCurrentFieldGrant = Effect.fn('HistoryComposition.resolveCurrentFieldGrant')(function* resolve(
  ports: CustomerHistoryPorts,
  field: CustomerOrderHistoryDetail['fields'][number],
  principalId: string,
  decision: CustomerRecordVisibilityDecision,
) {
  if (decision.outcome === 'UNAVAILABLE') {
    return yield* unavailable(field.ownerModuleId);
  }
  if (!fieldGrantMatchesDecision(decision, field)) {
    return null;
  }
  if (field.value.kind === 'REFERENCE') {
    yield* requireHistoricalResourceAccess(ports, principalId, [field.value.value]);
  }
  return { ...field, visibility: decision };
});

const currentFieldGrant = Effect.fn('HistoryComposition.currentFieldGrant')(function* fieldGrant(
  ports: CustomerHistoryPorts,
  field: CustomerOrderHistoryDetail['fields'][number],
  subject: CustomerHistorySubject,
  principalId: string,
  now: string,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
) {
  const recordTypeContract = yield* ports.recordTypes.get({
    ownerModuleId: field.visibility.recordRef.moduleId,
    resourceType: field.visibility.recordRef.resourceType,
  });
  if (!fieldGrantContractAllows(recordTypeContract, field, subject, callerPermissions)) {
    return null;
  }
  const decision = yield* visibilityFor(
    ports,
    field.visibility.recordRef,
    subject,
    principalId,
    now,
    callerPermissions,
    aggregatePolicy,
    policies,
    field.visibility.fieldSet,
  );
  return yield* resolveCurrentFieldGrant(ports, field, principalId, decision);
});

const detailAuthorizationMatches = (
  candidate: HistoricalOrderDetailAuthorizationCandidate,
  input: RetailOrderHistoryDetailInput | CounterpartyOrderHistoryDetailInput,
  subject: CustomerHistorySubject,
  scope: CounterpartyHistoryScope | null,
): boolean =>
  sameRecord(candidate.orderRef, input.orderRef) &&
  sameSubject(candidate.subject, subject) &&
  (scope !== 'OWN_ORDERS' || candidate.submittedByPrincipalId === input.principalId);

const customerDetailMatchesAuthorization = (
  detail: CustomerOrderHistoryDetail,
  authorization: HistoricalOrderDetailAuthorizationCandidate,
  input: RetailOrderHistoryDetailInput | CounterpartyOrderHistoryDetailInput,
): boolean =>
  sameRecord(detail.orderRef, input.orderRef) &&
  detail.acceptedAt === authorization.acceptedAt &&
  detail.freshness.sourceRevision === authorization.freshness.sourceRevision &&
  detail.freshness.status === 'CURRENT' &&
  !futureObservation(detail.freshness.observedAt, input.now);

const loadHistoryDetailAuthorization = Effect.fn('HistoryComposition.loadHistoryDetailAuthorization')(function* load(
  ports: CustomerHistoryPorts,
  input: RetailOrderHistoryDetailInput | CounterpartyOrderHistoryDetailInput,
  subject: CustomerHistorySubject,
  scope: CounterpartyHistoryScope | null,
) {
  const authorization = yield* ports.orders.getForHistoryDetailAuthorization({
    orderRef: input.orderRef,
  });
  if (
    authorization.outcome === 'NOT_FOUND' ||
    !detailAuthorizationMatches(authorization.value, input, subject, scope)
  ) {
    return yield* historyRecordNotFound();
  }
  if (
    authorization.value.freshness.status !== 'CURRENT' ||
    futureObservation(authorization.value.freshness.observedAt, input.now)
  ) {
    return yield* unavailable(authorization.value.orderRef.moduleId);
  }
  return authorization.value;
});

const detailContractAllows = (
  contract: CustomerRecordTypeOnboarding | null,
  recordRef: HistoricalRecordRef,
  subject: CustomerHistorySubject,
  callerPermissions: readonly string[],
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- Detail admission combines an owner contract with request-specific identity and authorization, so it cannot be an intrinsic public onboarding-schema refinement.
): contract is CustomerRecordTypeOnboarding =>
  contract !== null &&
  onboardingContractIsUsable(contract) &&
  recordTypeContractMatches(recordRef, contract) &&
  recordTypeContractAdmitsSubject(contract.customerContextRelationship, subject) &&
  allowsCallerPermissions(contract.callerPermissions, callerPermissions) &&
  fieldSetMatches(contract.fieldContracts.detail, CUSTOMER_ORDER_HISTORY_DETAIL_FIELD_SET);

const requireVisibleHistoryDetail = (
  visibility: CustomerRecordVisibilityDecision,
  ownerModuleId: string,
): Effect.Effect<
  Extract<CustomerRecordVisibilityDecision, { readonly outcome: 'VISIBLE' }>,
  HistoryOwnerUnavailable | HistoryRecordNotFound
> => {
  if (visibility.outcome === 'VISIBLE') {
    return Effect.succeed(visibility);
  }
  return visibility.outcome === 'UNAVAILABLE'
    ? Effect.fail(unavailable(ownerModuleId))
    : Effect.fail(historyRecordNotFound());
};

const composeOrderHistoryDetail = Effect.fn('HistoryComposition.composeOrderHistoryDetail')(function* historyDetail(
  ports: CustomerHistoryPorts,
  input: RetailOrderHistoryDetailInput | CounterpartyOrderHistoryDetailInput,
  subject: CustomerHistorySubject,
  scope: CounterpartyHistoryScope | null,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
) {
  const authorization = yield* loadHistoryDetailAuthorization(ports, input, subject, scope);
  // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Authorization must succeed before querying owner record-type metadata, preserving fail-closed access and failure ordering.
  const recordTypeContract = yield* ports.recordTypes.get({
    ownerModuleId: input.orderRef.moduleId,
    resourceType: input.orderRef.resourceType,
  });
  if (!detailContractAllows(recordTypeContract, input.orderRef, subject, callerPermissions)) {
    return yield* historyRecordNotFound();
  }
  const visibility = yield* visibilityFor(
    ports,
    input.orderRef,
    subject,
    input.principalId,
    input.now,
    callerPermissions,
    aggregatePolicy,
    policies,
    CUSTOMER_ORDER_HISTORY_DETAIL_FIELD_SET,
  );
  const visible = yield* requireVisibleHistoryDetail(visibility, input.orderRef.moduleId);
  const lookup = yield* ports.orders.getCustomerFacingDetail({
    orderRef: input.orderRef,
    subject,
  });
  if (lookup.outcome === 'NOT_FOUND' || !customerDetailMatchesAuthorization(lookup.value, authorization, input)) {
    return yield* historyRecordNotFound();
  }
  const checkedFields = yield* Effect.forEach(
    lookup.value.fields,
    (field) =>
      currentFieldGrant(
        ports,
        field,
        subject,
        input.principalId,
        input.now,
        callerPermissions,
        aggregatePolicy,
        policies,
      ),
    { concurrency: 8 },
  );
  return {
    ...lookup.value,
    fields: checkedFields.filter((field) => field !== null),
    visibility: visible,
  } satisfies CustomerOrderHistoryDetail;
});

export const composeRetailOrderHistoryDetail = Effect.fn('HistoryComposition.composeRetailOrderHistoryDetail')(
  function* retailHistoryDetail(ports: CustomerHistoryPorts, input: RetailOrderHistoryDetailInput) {
    const facts = yield* ports.access.retail({
      principalId: input.principalId,
      profileRef: input.profileRef,
    });
    yield* authorizeRetailHistory(facts);
    return yield* composeOrderHistoryDetail(
      ports,
      input,
      { kind: 'RETAIL_PROFILE', profileRef: input.profileRef },
      null,
      [RETAIL_HISTORY_READ],
      facts.policy,
      facts.policies,
    );
  },
);

const composeCounterpartyOrderHistoryDetailForPermission = Effect.fn(
  'HistoryComposition.composeCounterpartyOrderHistoryDetailForPermission',
)(function* counterpartyHistoryDetail(
  ports: CustomerHistoryPorts,
  input: CounterpartyOrderHistoryDetailInput,
  permission: CounterpartyHistoryPermission,
) {
  const subject = {
    counterpartyRef: input.counterpartyRef,
    kind: 'COUNTERPARTY' as const,
    profileRef: input.profileRef,
  };
  yield* requireCounterpartyAssociation(ports, subject);
  const facts = yield* ports.access.counterparty({
    principalId: input.principalId,
    profileRef: input.profileRef,
  });
  const scope = yield* authorizeCounterpartyHistory(facts, permission);
  return yield* composeOrderHistoryDetail(ports, input, subject, scope, [permission], facts.policy, facts.policies);
});

export const composeCounterpartyOrderHistoryDetail = (
  ports: CustomerHistoryPorts,
  input: CounterpartyOrderHistoryDetailInput,
) => composeCounterpartyOrderHistoryDetailForPermission(ports, input, COUNTERPARTY_HISTORY_READ_OWN);

export const composeCounterpartyAllOrderHistoryDetail = (
  ports: CustomerHistoryPorts,
  input: CounterpartyOrderHistoryDetailInput,
) => composeCounterpartyOrderHistoryDetailForPermission(ports, input, COUNTERPARTY_HISTORY_READ_ALL);

interface ArchiveAuthorization {
  readonly policies: Readonly<Record<string, BusinessPolicyState>> | undefined;
  readonly policy: BusinessPolicyState;
  readonly scope: CounterpartyHistoryScope | null;
}

const authorizeArchive = Effect.fn('HistoryComposition.authorizeArchive')(function* archiveAuthorization(
  ports: CustomerHistoryPorts,
  input: CustomerArchiveInput,
  counterpartyPermission: CounterpartyHistoryPermission,
) {
  if (input.subject.kind === 'RETAIL_PROFILE') {
    const facts = yield* ports.access.retail({
      principalId: input.principalId,
      profileRef: input.subject.profileRef,
    });
    yield* requireGate(facts.binding, 'CURRENT_BINDING_REQUIRED');
    yield* requireGate(facts.historyPermission, 'HISTORY_PERMISSION_REQUIRED');
    yield* requireGate(facts.archivePermission, 'ARCHIVE_PERMISSION_REQUIRED');
    yield* requirePolicy(facts.policy);
    return {
      policies: facts.policies,
      policy: facts.policy,
      scope: null,
    } satisfies ArchiveAuthorization;
  }
  yield* requireCounterpartyAssociation(ports, input.subject);
  const facts = yield* ports.access.counterparty({
    principalId: input.principalId,
    profileRef: input.subject.profileRef,
  });
  yield* requireGate(facts.access, 'COUNTERPARTY_ACCESS_REQUIRED');
  yield* requireGate(facts.archivePermission, 'ARCHIVE_PERMISSION_REQUIRED');
  const scope = yield* authorizeCounterpartyHistory(facts, counterpartyPermission);
  return {
    policies: facts.policies,
    policy: facts.policy,
    scope,
  } satisfies ArchiveAuthorization;
});

const archiveRecordContractAllows = (
  contract: CustomerRecordTypeOnboarding | null,
  record: ArchiveRecordCandidate,
  subject: CustomerHistorySubject,
  callerPermissions: readonly string[],
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- Archive admission combines an owner contract with a runtime record, subject, and permissions; moving it into the public onboarding schema would change that contract.
): contract is CustomerRecordTypeOnboarding =>
  contract !== null &&
  onboardingContractIsUsable(contract) &&
  recordTypeContractMatches(record.recordRef, contract) &&
  recordTypeContractAdmitsSubject(contract.customerContextRelationship, subject) &&
  allowsCallerPermissions(contract.callerPermissions, callerPermissions) &&
  fieldSetMatches(contract.fieldContracts.list, CUSTOMER_HISTORY_SUMMARY_FIELD_SET) &&
  allowsFields(contract.fieldAllowlist.list, ['displayLabel', 'freshness', 'occurredAt', 'recordKind', 'recordRef']);

const archiveRecordSuccess = (
  ports: CustomerHistoryPorts,
  input: CustomerArchiveInput,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
  record: ArchiveRecordCandidate,
  contract: CustomerRecordTypeOnboarding | null,
) => {
  if (!archiveRecordContractAllows(contract, record, input.subject, callerPermissions)) {
    return Effect.succeed<HistoryCollection<CustomerArchiveItem>>({
      degradations: [],
      items: [],
    });
  }
  if (
    futureObservation(record.freshness.observedAt, input.now) ||
    (record.freshness.status === 'STALE' &&
      !staleListRecordAllowed(record.freshness.observedAt, input.now, contract.freshnessPolicy.listMaxAgeMilliseconds))
  ) {
    return Effect.succeed<HistoryCollection<CustomerArchiveItem>>({
      degradations: [
        {
          code: 'SOURCE_STALE',
          ownerModuleId: record.recordRef.moduleId,
          retryable: true,
        },
      ],
      items: [],
    });
  }
  return visibilityFor(
    ports,
    record.recordRef,
    input.subject,
    input.principalId,
    input.now,
    callerPermissions,
    aggregatePolicy,
    policies,
  ).pipe(
    Effect.match({
      onFailure: (error): HistoryCollection<CustomerArchiveItem> =>
        Schema.is(HistoryOwnerUnavailable)(error)
          ? {
              degradations: [
                {
                  code: 'VISIBILITY_UNAVAILABLE' as const,
                  ownerModuleId: error.ownerModuleId,
                  retryable: true,
                },
              ],
              items: [],
            }
          : { degradations: [], items: [] },
      onSuccess: (decision): HistoryCollection<CustomerArchiveItem> => {
        if (decision.outcome === 'DENIED') {
          return { degradations: [], items: [] };
        }
        if (decision.outcome === 'UNAVAILABLE') {
          return {
            degradations: [
              {
                code: 'VISIBILITY_UNAVAILABLE' as const,
                ownerModuleId: record.recordRef.moduleId,
                retryable: true,
              },
            ],
            items: [],
          };
        }
        const item: CustomerArchiveItem = {
          displayLabel: record.displayLabel,
          freshness: record.freshness,
          occurredAt: record.occurredAt,
          recordKind: record.recordKind,
          recordRef: record.recordRef,
          visibility: decision,
        };
        return {
          degradations:
            record.freshness.status === 'STALE'
              ? [
                  {
                    code: 'SOURCE_STALE' as const,
                    ownerModuleId: record.recordRef.moduleId,
                    retryable: true,
                  },
                ]
              : [],
          items: [item],
        };
      },
    }),
  );
};

const archiveRecordOutcome = (
  ports: CustomerHistoryPorts,
  input: CustomerArchiveInput,
  counterpartyHistoryScope: CounterpartyHistoryScope | null,
  callerPermissions: readonly string[],
  aggregatePolicy: BusinessPolicyState,
  policies: Readonly<Record<string, BusinessPolicyState>> | undefined,
  record: ArchiveRecordCandidate,
) => {
  if (
    !sameSubject(record.subject, input.subject) ||
    (counterpartyHistoryScope === 'OWN_ORDERS' && record.submittedByPrincipalId !== input.principalId)
  ) {
    return Effect.succeed<HistoryCollection<CustomerArchiveItem>>({
      degradations: [],
      items: [],
    });
  }
  return ports.recordTypes
    .get({ ownerModuleId: record.recordRef.moduleId, resourceType: record.recordRef.resourceType })
    .pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed<HistoryCollection<CustomerArchiveItem>>({
            degradations: [
              {
                code: 'ONBOARDING_UNAVAILABLE',
                ownerModuleId: error.ownerModuleId,
                retryable: true,
              },
            ],
            items: [],
          }),
        onSuccess: (contract) =>
          archiveRecordSuccess(ports, input, callerPermissions, aggregatePolicy, policies, record, contract),
      }),
    );
};

const composeCustomerArchiveForPermission = Effect.fn('HistoryComposition.composeCustomerArchiveForPermission')(
  function* customerArchive(
    ports: CustomerHistoryPorts,
    input: CustomerArchiveInput,
    counterpartyPermission: CounterpartyHistoryPermission,
  ) {
    const authorization = yield* authorizeArchive(ports, input, counterpartyPermission);
    const counterpartyHistoryScope = authorization.scope;
    const callerPermissions = [input.subject.kind === 'RETAIL_PROFILE' ? RETAIL_HISTORY_READ : counterpartyPermission];
    if (ports.archiveSources.length === 0) {
      return yield* unavailable(CUSTOMER_CONTEXT_OWNER);
    }
    const sourceOutcomes = yield* Effect.forEach(
      ports.archiveSources,
      (source) =>
        source.list({ subject: input.subject }).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed<ArchiveSourceOutcome>({
                available: false,
                degradations: [
                  {
                    code: 'SOURCE_UNAVAILABLE' as const,
                    ownerModuleId: error.ownerModuleId,
                    retryable: true,
                  },
                ],
                items: [],
              }),
            onSuccess: (records) =>
              Effect.forEach(
                records,
                (record) =>
                  archiveRecordOutcome(
                    ports,
                    input,
                    counterpartyHistoryScope,
                    callerPermissions,
                    authorization.policy,
                    authorization.policies,
                    record,
                  ),
                { concurrency: 8 },
              ).pipe(Effect.map(successfulArchiveSource)),
          }),
        ),
      { concurrency: 8 },
    );
    if (!sourceOutcomes.some((outcome) => outcome.available)) {
      return yield* unavailable(CUSTOMER_CONTEXT_OWNER);
    }
    return {
      degradations: sourceOutcomes.flatMap((outcome) => outcome.degradations),
      items: sourceOutcomes.flatMap((outcome) => outcome.items),
      subject: input.subject,
    };
  },
);

export const composeCustomerArchive = (ports: CustomerHistoryPorts, input: CustomerArchiveInput) =>
  composeCustomerArchiveForPermission(ports, input, COUNTERPARTY_HISTORY_READ_OWN);

export const composeCounterpartyAllCustomerArchive = (
  ports: CustomerHistoryPorts,
  input: CounterpartyOrderHistoryInput,
) =>
  composeCustomerArchiveForPermission(
    ports,
    {
      now: input.now,
      principalId: input.principalId,
      subject: {
        counterpartyRef: input.counterpartyRef,
        kind: 'COUNTERPARTY',
        profileRef: input.profileRef,
      },
    },
    COUNTERPARTY_HISTORY_READ_ALL,
  );

interface RepeatAuthorization {
  readonly policies: Readonly<Record<string, BusinessPolicyState>> | undefined;
  readonly policy: BusinessPolicyState;
  readonly scope: CounterpartyHistoryScope | null;
}

const authorizeRepeat = Effect.fn('HistoryComposition.authorizeRepeat')(function* repeatAuthorization(
  ports: CustomerHistoryPorts,
  input: RepeatOrderPreparationInput,
) {
  if (input.subject.kind === 'RETAIL_PROFILE') {
    const facts = yield* ports.access.retail({
      principalId: input.principalId,
      profileRef: input.subject.profileRef,
    });
    yield* authorizeRetailHistory(facts);
    yield* requireGate(facts.repeatPermission, 'REPEAT_PERMISSION_REQUIRED');
    return {
      policies: facts.policies,
      policy: facts.policy,
      scope: null,
    } satisfies RepeatAuthorization;
  }
  yield* requireCounterpartyAssociation(ports, input.subject);
  const facts = yield* ports.access.counterparty({
    principalId: input.principalId,
    profileRef: input.subject.profileRef,
  });
  const historyScope = yield* authorizeAnyCounterpartyHistory(facts);
  yield* requireGate(facts.purchasePermission, 'PURCHASE_PERMISSION_REQUIRED');
  return {
    policies: facts.policies,
    policy: facts.policy,
    scope: historyScope,
  } satisfies RepeatAuthorization;
});

const repeatOrderLineResult = (
  line: Parameters<CustomerHistoryPorts['cart']['prepareLine']>[1],
  prepared: RepeatOrderLineResult,
) => {
  if (prepared.sourceLineRef !== line.sourceLineRef || prepared.requestedQuantity !== line.requestedQuantity) {
    return Effect.fail(unavailable('commerce.cart'));
  }
  return Effect.succeed<RepeatOrderLineResult>(
    prepared.status === 'REPEATABLE' && prepared.currentProductRef !== line.productRef
      ? {
          reason: 'CURRENT_SELECTION_REQUIRED',
          requestedQuantity: line.requestedQuantity,
          sourceLineRef: line.sourceLineRef,
          status: 'REQUIRES_EXPLICIT_CHANGE',
        }
      : prepared,
  );
};

const repeatOrderMatchesRequest = (
  order: HistoricalOrderCandidate,
  input: RepeatOrderPreparationInput,
  counterpartyHistoryScope: CounterpartyHistoryScope | null,
): boolean =>
  sameRecord(order.orderRef, input.orderRef) &&
  sameSubject(order.subject, input.subject) &&
  (counterpartyHistoryScope !== 'OWN_ORDERS' || order.submittedByPrincipalId === input.principalId);

const repeatOrderIsCurrent = (order: HistoricalOrderCandidate, now: string): boolean =>
  order.freshness.status === 'CURRENT' && !futureObservation(order.freshness.observedAt, now);

const repeatOrderPreparationOutcome = (
  lines: readonly RepeatOrderLineResult[],
): RepeatOrderPreparationResult['outcome'] =>
  lines.some((line) => line.status === 'REPEATABLE') ? 'PREPARED' : 'NO_REPEATABLE_LINES';

export const prepareRepeatOrder = Effect.fn('HistoryComposition.prepareRepeatOrder')(function* repeatOrder(
  ports: CustomerHistoryPorts,
  input: RepeatOrderPreparationInput,
) {
  const authorization = yield* authorizeRepeat(ports, input);
  const counterpartyHistoryScope = authorization.scope;
  const orderLookup = yield* ports.orders.getForRepeat({ orderRef: input.orderRef });
  if (
    orderLookup.outcome === 'NOT_FOUND' ||
    !repeatOrderMatchesRequest(orderLookup.value, input, counterpartyHistoryScope)
  ) {
    return yield* new HistoryRecordNotFound({
      code: 'history_record_not_found',
      reason: 'HISTORICAL_RECORD_NOT_FOUND',
    });
  }
  const order = orderLookup.value;
  if (!repeatOrderIsCurrent(order, input.now)) {
    return yield* unavailable(order.orderRef.moduleId);
  }
  const visibility = yield* visibilityFor(
    ports,
    order.orderRef,
    input.subject,
    input.principalId,
    input.now,
    [repeatCallerPermission(input.subject, counterpartyHistoryScope)],
    authorization.policy,
    authorization.policies,
  );
  if (visibility.outcome === 'UNAVAILABLE') {
    return yield* unavailable(order.orderRef.moduleId);
  }
  if (visibility.outcome === 'DENIED') {
    return yield* new HistoryRecordNotFound({
      code: 'history_record_not_found',
      reason: 'HISTORICAL_RECORD_NOT_FOUND',
    });
  }
  const lines = yield* Effect.forEach(
    order.lines,
    (line) =>
      ports.cart.prepareLine(input.subject, line).pipe(
        Effect.flatMap((prepared) => repeatOrderLineResult(line, prepared)),
        Effect.orElseSucceed((): RepeatOrderLineResult => ({
          reason: 'CURRENT_RULE_UNAVAILABLE',
          requestedQuantity: line.requestedQuantity,
          sourceLineRef: line.sourceLineRef,
          status: 'SKIPPED',
        })),
      ),
    { concurrency: 8 },
  );
  return {
    lines,
    outcome: repeatOrderPreparationOutcome(lines),
    sourceOrderRef: order.orderRef,
  } satisfies RepeatOrderPreparationResult;
});

const authorizeRecordVisibility = Effect.fn('HistoryComposition.authorizeRecordVisibility')(function* authorize(
  ports: CustomerHistoryPorts,
  input: {
    readonly principalId: string;
    readonly purpose: 'ARCHIVE' | 'HISTORY';
    readonly subject: CustomerHistorySubject;
  },
) {
  if (input.subject.kind === 'RETAIL_PROFILE') {
    const facts = yield* ports.access.retail({
      principalId: input.principalId,
      profileRef: input.subject.profileRef,
    });
    const { archivePermission, binding, historyPermission, policies, policy: aggregatePolicy } = facts;
    yield* requireGate(binding, 'CURRENT_BINDING_REQUIRED');
    yield* requireGate(historyPermission, 'HISTORY_PERMISSION_REQUIRED');
    if (input.purpose === 'ARCHIVE') {
      yield* requireGate(archivePermission, 'ARCHIVE_PERMISSION_REQUIRED');
    }
    yield* requirePolicy(aggregatePolicy);
    return {
      aggregatePolicy,
      callerPermissions: [RETAIL_HISTORY_READ],
      policies,
    };
  }

  yield* requireCounterpartyAssociation(ports, input.subject);
  const facts = yield* ports.access.counterparty({
    principalId: input.principalId,
    profileRef: input.subject.profileRef,
  });
  const { archivePermission, policies, policy: aggregatePolicy } = facts;
  yield* authorizeCounterpartyHistory(facts, COUNTERPARTY_HISTORY_READ_OWN);
  if (input.purpose === 'ARCHIVE') {
    yield* requireGate(archivePermission, 'ARCHIVE_PERMISSION_REQUIRED');
  }
  return {
    aggregatePolicy,
    callerPermissions: [COUNTERPARTY_HISTORY_READ_OWN],
    policies,
  };
});

export const resolveCustomerRecordVisibility = Effect.fn('HistoryComposition.resolveCustomerRecordVisibility')(
  function* recordVisibility(
    ports: CustomerHistoryPorts,
    input: {
      readonly now: string;
      readonly principalId: string;
      readonly purpose: 'ARCHIVE' | 'HISTORY';
      readonly recordRef: HistoricalRecordRef;
      readonly requestedFieldSet: CustomerFacingFieldSet;
      readonly subject: CustomerHistorySubject;
    },
  ) {
    const { aggregatePolicy, callerPermissions, policies } = yield* authorizeRecordVisibility(ports, input);
    return yield* visibilityFor(
      ports,
      input.recordRef,
      input.subject,
      input.principalId,
      input.now,
      callerPermissions,
      aggregatePolicy,
      policies,
      input.requestedFieldSet,
    );
  },
);
