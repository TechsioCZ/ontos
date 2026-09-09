import { Effect } from 'effect';
import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';

type PolicyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is PolicyRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const canonicalRef = (
  value: unknown,
  expected: { readonly moduleId: string; readonly resourceType: string },
): value is PolicyRecord =>
  isRecord(value) &&
  value['moduleId'] === expected.moduleId &&
  value['resourceType'] === expected.resourceType &&
  nonEmptyText(value['resourceId']) &&
  nonEmptyText(value['tenantId']);

const counterpartyRef = (value: unknown): value is PolicyRecord =>
  canonicalRef(value, {
    moduleId: 'party.registry',
    resourceType: 'party.registry.counterparty',
  });

const deny = (reasonCode: string, reason: string) => Effect.fail(denyPolicy(reasonCode, reason));

const evaluatePurchasingApprovalPolicy = (payload: unknown) => {
  if (!isRecord(payload)) {
    return deny('policy_evidence_missing', 'Purchasing Approval policy evidence is missing');
  }

  if (!nonEmptyText(payload['idempotencyKey'])) {
    return deny(
      'idempotency_key_required',
      'Every Purchasing Approval mutation requires an idempotency key',
    );
  }

  const topLevelCounterparty = payload['counterpartyRef'];
  if (topLevelCounterparty !== undefined && !counterpartyRef(topLevelCounterparty)) {
    return deny('counterparty_scope_invalid', 'The Counterparty target is not canonical');
  }
  if (payload['storefrontId'] !== undefined && !nonEmptyText(payload['storefrontId'])) {
    return deny('storefront_scope_invalid', 'The Storefront target must be a non-empty identifier');
  }

  const proposal = payload['proposal'];
  if (proposal !== undefined) {
    if (!isRecord(proposal)) {
      return deny(
        'proposal_snapshot_missing',
        'The immutable Purchase Proposal snapshot is required',
      );
    }
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
    const identity = proposal['identity'];
    const context = proposal['context'];
    const hierarchyInputs = proposal['hierarchyInputs'];
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
      return deny(
        'proposal_scope_invalid',
        'Proposal identity and hierarchy inputs must name one exact trusted scope',
      );
    }
    const verifiedEvidence = payload['verifiedEvidence'];
    const sourceRevisions = isRecord(verifiedEvidence)
      ? verifiedEvidence['sourceRevisions']
      : undefined;
    const sourceNames = Array.isArray(sourceRevisions)
      ? new Set(sourceRevisions.filter(isRecord).map((source) => source['source']))
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
  }

  const hierarchy = payload['hierarchy'];
  if (hierarchy !== undefined) {
    if (!isRecord(hierarchy) || !isRecord(hierarchy['selector'])) {
      return deny(
        'hierarchy_snapshot_missing',
        'The immutable Approval Hierarchy snapshot is required',
      );
    }
    const selector = hierarchy['selector'];
    const levels = hierarchy['levels'];
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

  if (payload['proposalRevision'] !== undefined && !positiveInteger(payload['proposalRevision'])) {
    return deny(
      'proposal_revision_required',
      'Submission must bind one positive immutable proposal revision',
    );
  }
  if (
    payload['expectedRequestRevision'] !== undefined &&
    !positiveInteger(payload['expectedRequestRevision'])
  ) {
    return deny(
      'request_revision_required',
      'The mutation must name its expected request revision',
    );
  }

  const decision = payload['decision'];
  if (decision === 'RETURN' || decision === 'REJECT') {
    if (!nonEmptyText(payload['reason'])) {
      return deny(
        'decision_reason_required',
        'Return and reject decisions require a bounded reason',
      );
    }
  } else if (decision !== undefined && decision !== 'APPROVE') {
    return deny('decision_kind_invalid', 'Approval decisions must be APPROVE, RETURN, or REJECT');
  }

  if (
    payload['buyerPermission'] !== undefined &&
    payload['buyerPermission'] !== 'ALLOWED' &&
    payload['buyerPermission'] !== 'DENIED'
  ) {
    return deny(
      'buyer_permission_invalid',
      'Buyer permission must be an owner-derived ALLOWED or DENIED state',
    );
  }
  if (
    payload['profileState'] !== undefined &&
    payload['profileState'] !== 'ACTIVE' &&
    payload['profileState'] !== 'INACTIVE'
  ) {
    return deny(
      'profile_state_invalid',
      'Profile state must be an owner-derived ACTIVE or INACTIVE state',
    );
  }
  if (payload['routeCurrent'] !== undefined && typeof payload['routeCurrent'] !== 'boolean') {
    return deny('route_currentness_invalid', 'Route currentness must be an owner-derived boolean');
  }

  const orderRef = payload['orderRef'];
  if (
    orderRef !== undefined &&
    !canonicalRef(orderRef, {
      moduleId: 'commerce.order',
      resourceType: 'commerce.order.order',
    })
  ) {
    return deny(
      'order_target_invalid',
      'Approval consumption requires the canonical committed Order reference',
    );
  }

  return Effect.void;
};

export const purchasingApprovalPolicy = defineMicroverticalPolicy<
  unknown,
  'commerce.customer-context'
>({
  evaluate: ({ payload }) => evaluatePurchasingApprovalPolicy(payload),
  owningModuleKey: 'commerce.customer-context',
  policyKey: 'commerce.customer-context.purchasing-approval.v1',
});
