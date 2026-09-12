import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- External policy evidence remains unknown-valued until the local guards validate each accessed field and return domain denial codes on malformed input.
type PolicyRecord = Record<string, unknown>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- This policy guard intentionally classifies unparsed evidence so malformed payloads retain domain denial codes instead of escaping through a parse failure.
const isRecord = (value: unknown): value is PolicyRecord =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, effect-native/no-structural-document-walking -- Defensive classification keeps malformed policy evidence on the existing owner-denial path.
  typeof value === 'object' && value !== null && !Array.isArray(value);

// oxlint-disable-next-line anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- This field guard intentionally classifies unknown dictionary values so malformed evidence retains the policy's existing denial code.
const nonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- This field guard intentionally classifies unknown dictionary values so malformed evidence retains the policy's existing denial code.
const positiveInteger = (value: unknown): value is number =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Defensive classification keeps malformed numeric policy evidence on the existing owner-denial path.
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/* oxlint-disable anti-slop/no-unknown-parameters -- Canonical references are validated from unknown policy evidence against the call-specific owner identity before field access. */
const canonicalRef = (
  value: unknown,
  expected: { readonly moduleId: string; readonly resourceType: string },
  // oxlint-disable-next-line effect-native/no-refinement-outside-schema -- The expected owner identity is call-specific; an owning schema factory would broaden this Group 45 change and alter policy failure behavior.
): value is PolicyRecord =>
  isRecord(value) &&
  value['moduleId'] === expected.moduleId &&
  value['resourceType'] === expected.resourceType &&
  nonEmptyText(value['resourceId']) &&
  nonEmptyText(value['tenantId']);
/* oxlint-enable anti-slop/no-unknown-parameters */

// oxlint-disable-next-line anti-slop/no-unknown-parameters, effect-native/no-refinement-outside-schema -- This policy-local specialization intentionally validates an unknown reference through canonicalRef while preserving the existing denial path.
const counterpartyRef = (value: unknown): value is PolicyRecord =>
  canonicalRef(value, {
    moduleId: 'party.registry',
    resourceType: 'party.registry.counterparty',
  });

const deny = (reasonCode: string, reason: string) => Effect.fail(denyPolicy(reasonCode, reason));

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Rules receive only the guarded policy record and retain field-specific fail-closed validation before using unknown values.
type PolicyRule = (payload: PolicyRecord) => ReturnType<typeof deny> | undefined;
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Proposal rules intentionally validate both the nested proposal and enclosing guarded payload before producing domain denials.
type ProposalRule = (proposal: PolicyRecord, payload: PolicyRecord) => ReturnType<typeof deny> | undefined;

const evaluateMutationScope: PolicyRule = (payload) => {
  if (!nonEmptyText(payload['idempotencyKey'])) {
    return deny('idempotency_key_required', 'Every Purchasing Approval mutation requires an idempotency key');
  }

  const topLevelCounterparty = payload['counterpartyRef'];
  if (topLevelCounterparty !== undefined && !counterpartyRef(topLevelCounterparty)) {
    return deny('counterparty_scope_invalid', 'The Counterparty target is not canonical');
  }
  if (payload['storefrontId'] !== undefined && !nonEmptyText(payload['storefrontId'])) {
    return deny('storefront_scope_invalid', 'The Storefront target must be a non-empty identifier');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateProposalState: ProposalRule = (proposal) => {
  if (
    proposal['state'] !== 'CURRENT' ||
    proposal['approvalEvaluation'] !== 'APPROVAL_REQUIRED' ||
    proposal['reservation'] !== 'NONE' ||
    proposal['payment'] !== 'NONE'
  ) {
    return deny(
      'proposal_not_approval_required',
      'Only a current approval-required proposal without reservation or payment side effects may enter Purchasing Approval',
    );
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateProposalScope: ProposalRule = (proposal) => {
  const { identity } = proposal;
  const { context } = proposal;
  const { hierarchyInputs } = proposal;
  if (
    !isRecord(identity) ||
    !counterpartyRef(identity['counterpartyRef']) ||
    !isRecord(identity['profileRef']) ||
    !isRecord(context) ||
    !nonEmptyText(context['storefrontId']) ||
    !isRecord(hierarchyInputs) ||
    hierarchyInputs['storefrontId'] !== context['storefrontId'] ||
    !counterpartyRef(hierarchyInputs['counterpartyRef'])
  ) {
    return deny('proposal_scope_invalid', 'Proposal identity and hierarchy inputs must name one exact trusted scope');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateProposalEvidence: ProposalRule = (_proposal, payload) => {
  const { verifiedEvidence } = payload;
  const sourceRevisions = isRecord(verifiedEvidence) ? verifiedEvidence['sourceRevisions'] : undefined;
  const sourceNames = Array.isArray(sourceRevisions)
    ? new Set(sourceRevisions.flatMap((source) => (isRecord(source) ? [source['source']] : [])))
    : new Set<unknown>();
  if (
    !isRecord(verifiedEvidence) ||
    verifiedEvidence['buyerPermission'] !== 'ALLOWED' ||
    verifiedEvidence['profileState'] !== 'ACTIVE' ||
    verifiedEvidence['proposalCurrent'] !== true ||
    !Array.isArray(sourceRevisions) ||
    sourceRevisions.length === 0 ||
    ![
      'counterparty-policy',
      'customer-commerce-policy',
      'principal-override',
      'purchase-proposal',
      'purchasing-profile',
      'storefront-context',
    ].every((source) => sourceNames.has(source))
  ) {
    return deny(
      'proposal_evidence_missing',
      'Owner-composed buyer, profile, and source currentness evidence is required',
    );
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const proposalRules = [
  evaluateProposalState,
  evaluateProposalScope,
  evaluateProposalEvidence,
] as const satisfies readonly ProposalRule[];

const evaluateProposalSnapshot: PolicyRule = (payload) => {
  const { proposal } = payload;
  if (proposal === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- An omitted proposal has no denial in this optional policy contract.
    return undefined;
  }
  if (!isRecord(proposal)) {
    return deny('proposal_snapshot_missing', 'The immutable Purchase Proposal snapshot is required');
  }

  for (const evaluateRule of proposalRules) {
    const denial = evaluateRule(proposal, payload);
    if (denial !== undefined) {
      return denial;
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateHierarchySnapshot: PolicyRule = (payload) => {
  const { hierarchy } = payload;
  if (hierarchy !== undefined) {
    if (!isRecord(hierarchy) || !isRecord(hierarchy['selector'])) {
      return deny('hierarchy_snapshot_missing', 'The immutable Approval Hierarchy snapshot is required');
    }
    const { selector } = hierarchy;
    const { levels } = hierarchy;
    if (
      !counterpartyRef(selector['counterpartyRef']) ||
      (selector['storefrontId'] !== null && !nonEmptyText(selector['storefrontId'])) ||
      !Array.isArray(levels) ||
      levels.length === 0 ||
      levels.some(
        (level) =>
          !isRecord(level) ||
          !positiveInteger(level['order']) ||
          level['completionRule'] !== 'ONE_APPROVER' ||
          !Array.isArray(level['eligiblePrincipals']) ||
          level['eligiblePrincipals'].length === 0,
      )
    ) {
      return deny(
        'hierarchy_route_invalid',
        'Approval Hierarchy levels must be contiguous, eligible, and ONE_APPROVER',
      );
    }
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateRevisionBindings: PolicyRule = (payload) => {
  if (payload['proposalRevision'] !== undefined && !positiveInteger(payload['proposalRevision'])) {
    return deny('proposal_revision_required', 'Submission must bind one positive immutable proposal revision');
  }
  if (payload['expectedRequestRevision'] !== undefined && !positiveInteger(payload['expectedRequestRevision'])) {
    return deny('request_revision_required', 'The mutation must name its expected request revision');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateDecision: PolicyRule = (payload) => {
  const { decision } = payload;
  if (decision === 'RETURN' || decision === 'REJECT') {
    if (!nonEmptyText(payload['reason'])) {
      return deny('decision_reason_required', 'Return and reject decisions require a bounded reason');
    }
  } else if (decision !== undefined && decision !== 'APPROVE') {
    return deny('decision_kind_invalid', 'Approval decisions must be APPROVE, RETURN, or REJECT');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateOwnerDerivedState: PolicyRule = (payload) => {
  if (
    payload['buyerPermission'] !== undefined &&
    payload['buyerPermission'] !== 'ALLOWED' &&
    payload['buyerPermission'] !== 'DENIED'
  ) {
    return deny('buyer_permission_invalid', 'Buyer permission must be an owner-derived ALLOWED or DENIED state');
  }
  if (
    payload['profileState'] !== undefined &&
    payload['profileState'] !== 'ACTIVE' &&
    payload['profileState'] !== 'INACTIVE'
  ) {
    return deny('profile_state_invalid', 'Profile state must be an owner-derived ACTIVE or INACTIVE state');
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof, effect-native/no-structural-document-walking -- This policy boundary intentionally classifies an unknown owner-derived field so malformed evidence retains the route-currentness denial code.
  if (payload['routeCurrent'] !== undefined && typeof payload['routeCurrent'] !== 'boolean') {
    return deny('route_currentness_invalid', 'Route currentness must be an owner-derived boolean');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const evaluateOrderTarget: PolicyRule = (payload) => {
  const { orderRef } = payload;
  if (
    orderRef !== undefined &&
    !canonicalRef(orderRef, {
      moduleId: 'commerce.order',
      resourceType: 'commerce.order.order',
    })
  ) {
    return deny('order_target_invalid', 'Approval consumption requires the canonical committed Order reference');
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Policy success is represented explicitly by an absent denial.
  return undefined;
};

const purchasingApprovalRules = [
  evaluateMutationScope,
  evaluateProposalSnapshot,
  evaluateHierarchySnapshot,
  evaluateRevisionBindings,
  evaluateDecision,
  evaluateOwnerDerivedState,
  evaluateOrderTarget,
] as const satisfies readonly PolicyRule[];

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- The framework policy boundary supplies unparsed evidence, which this evaluator rejects fail-closed with owner denial codes.
const evaluatePurchasingApprovalPolicy = (payload: unknown) => {
  if (!isRecord(payload)) {
    return deny('policy_evidence_missing', 'Purchasing Approval policy evidence is missing');
  }

  for (const evaluateRule of purchasingApprovalRules) {
    const denial = evaluateRule(payload);
    if (denial !== undefined) {
      return denial;
    }
  }

  return Effect.void;
};

export const purchasingApprovalPolicy = defineMicroverticalPolicy<unknown, 'commerce.customer-context'>({
  evaluate: ({ payload }) => evaluatePurchasingApprovalPolicy(payload),
  owningModuleKey: 'commerce.customer-context',
  policyKey: 'commerce.customer-context.purchasing-approval.v1',
});
