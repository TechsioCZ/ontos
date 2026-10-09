import type { DomainEvent, DomainEventReference, OperationalScope, OutboxMessage } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CreateApplicabilityBindingPayloadSchema,
  EndApplicabilityBindingPayloadSchema,
  CreateRulePayloadSchema,
  CreateRuleRevisionPayloadSchema,
  RetireRulePayloadSchema,
  ReplaceApplicabilityBindingPayloadSchema,
} from '../../shared/actions/policy-administration.ts';
import type { CreateApplicabilityBindingPayload } from '../../shared/actions/policy-administration.ts';
import {
  AssortmentPolicyPersistenceUnavailable,
  AssortmentPolicyStaleBasis,
  AssortmentPolicyTargetInvariant,
} from '../../shared/domain/policy-errors.ts';
import {
  assortmentMeaningFingerprint,
  matchesBindingEndReplay,
  matchesBindingReplay,
  matchesCreateRuleReplay,
  matchesReplacementReplay,
  matchesRetirementReplay,
  matchesRuleRevisionReplay,
} from '../../src/services/policy-administration.service.ts';
import type { AssortmentPolicyPersistence } from '../../src/services/policy-administration.service.ts';
import {
  createBindingPermissionTarget,
  replaceBindingPermissionTargets,
} from '../../src/actions/policy-administration-support.ts';
import { handleCreateRule } from '../../src/actions/create-rule.action.ts';
import { handleCreateApplicabilityBinding } from '../../src/actions/create-applicability-binding.action.ts';
import { handleCreateRuleRevision } from '../../src/actions/create-rule-revision.action.ts';
import { handleEndApplicabilityBinding } from '../../src/actions/end-applicability-binding.action.ts';
import { handleReplaceApplicabilityBinding } from '../../src/actions/replace-applicability-binding.action.ts';
import { handleRetireRule } from '../../src/actions/retire-rule.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'better-auth-session:assortment-policy-test',
  authMethod: 'session',
  correlationId: 'assortment-policy-test',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;

const stableRuleRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'stable-rule-1',
  resourceType: 'commerce.assortment.stable-rule',
  tenantId,
} as const;
const revisionRef = {
  ownerModuleId: 'commerce.assortment',
  revision: '1',
  sourceRef: {
    moduleId: 'commerce.assortment',
    resourceId: 'rule-revision-1',
    resourceType: 'commerce.assortment.rule-revision',
    tenantId,
  },
} as const;
const bindingRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'binding-1',
  resourceType: 'commerce.assortment.applicability-binding',
  tenantId,
} as const;
const channelRef = {
  moduleId: 'commerce.channel',
  resourceId: 'channel-1',
  resourceType: 'commerce.channel.channel',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'party.registry',
  resourceId: legalEntityId,
  resourceType: 'party.registry.legal-entity',
  tenantId,
} as const;

const createRulePayload = Schema.decodeUnknownSync(CreateRulePayloadSchema)({
  effect: 'ALLOW',
  provenanceRef: 'test:create-rule',
  purpose: 'PURCHASE',
  reason: 'Create the initial rule revision',
  selector: { kind: 'ALL' },
  stableCode: 'rule-one',
});

const createRevisionPayload = Schema.decodeUnknownSync(CreateRuleRevisionPayloadSchema)({
  effect: 'DENY',
  expectedLatestRevision: 1,
  provenanceRef: 'test:create-revision',
  purpose: 'PURCHASE',
  reason: 'Create a revised meaning',
  selector: { kind: 'ALL' },
  stableRuleRef,
});

const retirePayload = Schema.decodeUnknownSync(RetireRulePayloadSchema)({
  effectiveAt: '2026-09-22T12:00:00.000Z',
  expectedBasisFingerprint: 'a'.repeat(64),
  provenanceRef: 'test:retire-rule',
  reason: 'Retire the rule',
  stableRuleRef,
});

const createBindingPayload = Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
  audience: { kind: 'SHARED' },
  commercialScope: { channelRef, sellingLegalEntityRef },
  effectiveFrom: '2026-09-22T12:00:00.000Z',
  provenanceRef: 'test:create-binding',
  reason: 'Bind the rule revision',
  ruleRevisionRef: revisionRef,
});

const endPayload = Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
  applicabilityBindingRef: bindingRef,
  effectiveAt: '2026-09-22T12:00:00.000Z',
  expectedBasisFingerprint: 'a'.repeat(64),
  provenanceRef: 'test:end-binding',
  reason: 'End the binding',
});

const replacePayload = Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
  effectiveAt: '2026-09-22T12:00:00.000Z',
  existingBindingRef: bindingRef,
  expectedExistingBasisFingerprint: 'a'.repeat(64),
  proposedAudience: { kind: 'SHARED' },
  proposedCommercialScope: { channelRef, sellingLegalEntityRef },
  proposedEffectiveFrom: '2026-09-22T12:00:00.000Z',
  proposedRuleRevisionRef: revisionRef,
  provenanceRef: 'test:replace-binding',
  reason: 'Replace the binding atomically',
});

const unused = () => Effect.die('unused policy service method');
const services = (overrides: Partial<AssortmentPolicyPersistence>): AssortmentPolicyPersistence => ({
  createBinding: unused,
  createRule: unused,
  createRuleRevision: unused,
  endBinding: unused,
  replaceBinding: unused,
  retireRule: unused,
  ...overrides,
});

const context = <Services>(
  servicesValue: Services,
  invocation = 'action-invocation-1',
  actionScope: OperationalScope = scope,
) => {
  const audit: unknown[] = [];
  const events: DomainEvent[] = [];
  const outbox: OutboxMessage[] = [];
  // The production collector owns this opaque reference; this handler unit harness never dereferences it.
  const eventReference: DomainEventReference = Schema.decodeUnknownSync(Schema.Any)({});
  const value = {
    actionInvocationId: invocation,
    addDomainEvent: (event: DomainEvent) => {
      events.push(event);
      return Effect.succeed(eventReference);
    },
    addOutboxMessage: (_reference: DomainEventReference, message: OutboxMessage) => {
      outbox.push(message);
      return Effect.void;
    },
    compositionRevision: 'a'.repeat(64),
    recordAuditEvidence: (evidence: Readonly<Record<string, Schema.Json>>) => {
      audit.push(evidence);
      return Effect.void;
    },
    recordDataAccess: () => Effect.void,
    scope: actionScope,
    services: servicesValue,
  };
  return { audit, events, outbox, value };
};

it.effect('Create Rule returns the Stable Rule and initial immutable revision from one service outcome', () =>
  Effect.gen(function* createRuleSuccess() {
    const service = services({
      createRule: () =>
        Effect.succeed({
          created: true,
          initialRevisionNumber: 1,
          initialRuleRevisionId: 'rule-revision-1',
          meaningFingerprint: assortmentMeaningFingerprint(createRulePayload),
          stableRuleId: 'stable-rule-1',
        }),
    });
    const prepared = context(service);
    const result = yield* handleCreateRule(createRulePayload, prepared.value);
    expect(result.created).toBe(true);
    expect(result.initialRuleRevisionRef.revision).toBe('1');
    expect(result.stableRuleRef.resourceId).toBe('stable-rule-1');
    expect(prepared.audit).toHaveLength(1);
    expect(prepared.events).toHaveLength(1);
    expect(prepared.events[0]?.eventType).toBe('commerce.assortment.rule-created.v1');
    expect(prepared.outbox).toHaveLength(1);
    expect(prepared.outbox[0]?.topic).toBe('commerce.assortment.rule-created.v1');
  }),
);

it.effect('Create Rule preserves idempotent retry outcomes and invocation identity', () =>
  Effect.gen(function* createRuleRetry() {
    const invocations: string[] = [];
    const service = services({
      createRule: (input) => {
        invocations.push(input.actionInvocationId);
        return Effect.succeed({
          created: invocations.length === 1,
          initialRevisionNumber: 1,
          initialRuleRevisionId: 'rule-revision-1',
          meaningFingerprint: 'b'.repeat(64),
          stableRuleId: 'stable-rule-1',
        });
      },
    });
    const first = context(service, 'same-invocation');
    const second = context(service, 'same-invocation');
    expect((yield* handleCreateRule(createRulePayload, first.value)).created).toBe(true);
    expect((yield* handleCreateRule(createRulePayload, second.value)).created).toBe(false);
    expect(invocations).toEqual(['same-invocation', 'same-invocation']);
    expect(first.events).toHaveLength(1);
    expect(first.outbox).toHaveLength(1);
    expect(second.events).toHaveLength(0);
    expect(second.outbox).toHaveLength(0);
  }),
);

it.effect('does not emit projection invalidation for replayed Binding mutations', () =>
  Effect.gen(function* bindingReplay() {
    const created = context(
      services({
        createBinding: () => Effect.succeed({ bindingId: bindingRef.resourceId, created: false }),
      }),
    );
    expect((yield* handleCreateApplicabilityBinding(createBindingPayload, created.value)).created).toBe(false);
    expect(created.events).toHaveLength(0);
    expect(created.outbox).toHaveLength(0);

    const ended = context(
      services({
        endBinding: () => Effect.succeed({ ended: false }),
      }),
      'end-replay',
    );
    expect((yield* handleEndApplicabilityBinding(endPayload, ended.value)).ended).toBe(false);
    expect(ended.events).toHaveLength(0);
    expect(ended.outbox).toHaveLength(0);

    const replaced = context(
      services({
        replaceBinding: () =>
          Effect.succeed({ createdBindingId: 'binding-2', endedBindingId: bindingRef.resourceId, replaced: false }),
      }),
      'replace-replay',
    );
    expect((yield* handleReplaceApplicabilityBinding(replacePayload, replaced.value)).replaced).toBe(false);
    expect(replaced.events).toHaveLength(0);
    expect(replaced.outbox).toHaveLength(0);
  }),
);

it.effect('does not emit projection invalidation for replayed Rule Revision and Retire mutations', () =>
  Effect.gen(function* ruleReplay() {
    const revision = context(
      services({
        createRuleRevision: () =>
          Effect.succeed({
            created: false,
            meaningFingerprint: 'b'.repeat(64),
            revisionNumber: 2,
            ruleRevisionId: 'rule-revision-2',
          }),
      }),
      'revision-replay',
    );
    expect((yield* handleCreateRuleRevision(createRevisionPayload, revision.value)).created).toBe(false);
    expect(revision.audit).toMatchObject([
      {
        action: 'CREATE_RULE_REVISION',
        changed: false,
        operation: 'CREATE',
        resourceId: 'rule-revision-2',
      },
    ]);
    expect(revision.events).toHaveLength(0);
    expect(revision.outbox).toHaveLength(0);

    const retirement = context(services({ retireRule: () => Effect.succeed({ retired: false }) }), 'retire-replay');
    expect((yield* handleRetireRule(retirePayload, retirement.value)).retired).toBe(false);
    expect(retirement.audit).toMatchObject([
      {
        action: 'RETIRE_RULE',
        changed: false,
        operation: 'RETIRE',
        resourceId: stableRuleRef.resourceId,
      },
    ]);
    expect(retirement.events).toHaveLength(0);
    expect(retirement.outbox).toHaveLength(0);
  }),
);

it('requires one effective instant for replacement and keeps the half-open boundary', () => {
  expect(replacePayload.effectiveAt).toStrictEqual(replacePayload.proposedEffectiveFrom);
  expect(() =>
    Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
      ...replacePayload,
      proposedEffectiveFrom: '2026-09-22T12:00:00.001Z',
    }),
  ).toThrow();
});

it.effect('Create Rule Revision maps stale basis to a typed domain error', () =>
  Effect.gen(function* staleRevision() {
    const service = services({ createRuleRevision: () => Effect.succeed({ kind: 'stale_basis' as const }) });
    const error = yield* Effect.flip(handleCreateRuleRevision(createRevisionPayload, context(service).value));
    expect(error).toBeInstanceOf(AssortmentPolicyStaleBasis);
  }),
);

it.effect('End Binding fails closed before the handler service when Legal Entity context is unavailable', () =>
  Effect.gen(function* missingLegalEntity() {
    let calls = 0;
    const service = services({
      endBinding: () => {
        calls += 1;
        return Effect.succeed({ ended: true });
      },
    });
    // SAFETY: this fixture intentionally omits legalEntityId to verify fail-closed preflight.
    const tenantOnlyScope = {
      authContextRef: scope.authContextRef,
      authMethod: scope.authMethod,
      correlationId: scope.correlationId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    } as OperationalScope;
    const error = yield* Effect.flip(
      handleEndApplicabilityBinding(
        Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
          applicabilityBindingRef: bindingRef,
          effectiveAt: '2026-09-22T12:00:00.000Z',
          expectedBasisFingerprint: 'a'.repeat(64),
          provenanceRef: 'test:end-binding',
          reason: 'End binding',
        }),
        context(service, 'end-invocation', tenantOnlyScope).value,
      ),
    );
    expect(error).toBeInstanceOf(AssortmentPolicyPersistenceUnavailable);
    expect(calls).toBe(0);
  }),
);

it('resolves replacement as two exact conjunctive targets at one effective time', () => {
  const targets = replaceBindingPermissionTargets(replacePayload, scope);
  expect(targets).toHaveLength(2);
  expect(targets[0]).toMatchObject({ mode: 'end', permission: 'assortment.binding.end' });
  expect(targets[1]).toMatchObject({ mode: 'create', permission: 'assortment.binding.create' });
  expect(targets[1].effectiveFrom).toBe('2026-09-22T12:00:00.000Z');
});

it('rejects a cross-tenant Binding target before authorization can use it', () => {
  const foreignPayload: CreateApplicabilityBindingPayload = Schema.decodeUnknownSync(
    CreateApplicabilityBindingPayloadSchema,
  )({
    audience: { kind: 'SHARED' },
    commercialScope: {
      channelRef: { ...channelRef, tenantId: '10000000-0000-4000-8000-000000000099' },
      sellingLegalEntityRef,
    },
    effectiveFrom: '2026-09-22T12:00:00.000Z',
    provenanceRef: 'test:foreign-binding',
    reason: 'Reject a cross-tenant target',
    ruleRevisionRef: revisionRef,
  });
  expect(() => createBindingPermissionTarget(foreignPayload, scope)).toThrow(AssortmentPolicyTargetInvariant);
});

it('canonicalizes nested meaning objects before fingerprinting', () => {
  const first = assortmentMeaningFingerprint(
    Object.fromEntries([
      [
        'selector',
        Object.fromEntries([
          [
            'refs',
            Object.fromEntries([
              ['category', 'category-1'],
              ['tenant', tenantId],
            ]),
          ],
          ['kind', 'CATEGORY'],
        ]),
      ],
      ['effect', 'ALLOW'],
    ]),
  );
  const second = assortmentMeaningFingerprint(
    Object.fromEntries([
      ['effect', 'ALLOW'],
      [
        'selector',
        Object.fromEntries([
          ['kind', 'CATEGORY'],
          [
            'refs',
            Object.fromEntries([
              ['tenant', tenantId],
              ['category', 'category-1'],
            ]),
          ],
        ]),
      ],
    ]),
  );
  expect(first).toBe(second);
});

it('requires exact replay identity for all six policy mutations', () => {
  const actionInvocationId = '40000000-0000-4000-8000-000000000001';
  const actorPrincipalId = principalId;
  const replayCreateRule = { ...createRulePayload, actionInvocationId, actorPrincipalId };
  const replayCreateRuleStable = {
    actionInvocationId,
    actorPrincipalId,
    idempotencyKey: actionInvocationId,
    provenanceRef: createRulePayload.provenanceRef,
    reason: createRulePayload.reason,
    stableCode: createRulePayload.stableCode,
    stableRuleId: 'stable-rule-1',
  };
  const replayCreateRuleRevision = {
    actionInvocationId,
    actorPrincipalId,
    idempotencyKey: actionInvocationId,
    provenanceRef: createRulePayload.provenanceRef,
    reason: createRulePayload.reason,
    revisionNumber: 1,
    ruleRevisionId: 'rule-revision-1',
    semanticFingerprint: assortmentMeaningFingerprint({
      effect: createRulePayload.effect,
      purpose: createRulePayload.purpose,
      selector: createRulePayload.selector,
    }),
    stableRuleId: 'stable-rule-1',
  };
  expect(matchesCreateRuleReplay(replayCreateRuleStable, replayCreateRuleRevision, replayCreateRule)).toBe(true);
  const createRuleRevisionTwo = { ...replayCreateRuleRevision, revisionNumber: 2 };
  expect(matchesCreateRuleReplay(replayCreateRuleStable, createRuleRevisionTwo, replayCreateRule)).toBe(false);
  for (const changed of [
    { ...replayCreateRule, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayCreateRule, provenanceRef: 'test:changed-provenance' },
    { ...replayCreateRule, reason: 'Changed reason' },
    { ...replayCreateRule, stableCode: 'rule-two' },
    { ...replayCreateRule, effect: 'DENY' as const },
  ]) {
    expect(matchesCreateRuleReplay(replayCreateRuleStable, replayCreateRuleRevision, changed)).toBe(false);
  }

  const replayRevision = { ...createRevisionPayload, actionInvocationId, actorPrincipalId };
  const replayRevisionRow = {
    actionInvocationId,
    actorPrincipalId,
    idempotencyKey: actionInvocationId,
    provenanceRef: replayRevision.provenanceRef,
    reason: replayRevision.reason,
    revisionNumber: 2,
    ruleRevisionId: 'rule-revision-2',
    semanticFingerprint: assortmentMeaningFingerprint({
      effect: replayRevision.effect,
      purpose: replayRevision.purpose,
      selector: replayRevision.selector,
    }),
    stableRuleId: stableRuleRef.resourceId,
  };
  expect(matchesRuleRevisionReplay(replayRevisionRow, replayRevision)).toBe(true);
  for (const changed of [
    { ...replayRevision, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayRevision, provenanceRef: 'test:changed-provenance' },
    { ...replayRevision, reason: 'Changed reason' },
    { ...replayRevision, effect: 'ALLOW' as const },
    { ...replayRevision, stableRuleRef: { ...stableRuleRef, resourceId: 'stable-rule-2' } },
  ]) {
    expect(matchesRuleRevisionReplay(replayRevisionRow, changed)).toBe(false);
  }

  const replayRetire = { ...retirePayload, actionInvocationId, actorPrincipalId };
  const replayRetireRow = {
    actionInvocationId,
    actorPrincipalId,
    effectiveAt: DateTime.toDateUtc(retirePayload.effectiveAt),
    idempotencyKey: actionInvocationId,
    provenanceRef: retirePayload.provenanceRef,
    reason: retirePayload.reason,
    stableRuleId: stableRuleRef.resourceId,
  };
  expect(matchesRetirementReplay(replayRetireRow, replayRetire)).toBe(true);
  for (const changed of [
    { ...replayRetire, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayRetire, provenanceRef: 'test:changed-provenance' },
    { ...replayRetire, reason: 'Changed reason' },
    { ...replayRetire, stableRuleRef: { ...stableRuleRef, resourceId: 'stable-rule-2' } },
    {
      ...replayRetire,
      effectiveAt: Schema.decodeUnknownSync(RetireRulePayloadSchema)({
        ...retirePayload,
        effectiveAt: '2026-09-23T12:00:00.000Z',
      }).effectiveAt,
    },
  ]) {
    expect(matchesRetirementReplay(replayRetireRow, changed)).toBe(false);
  }

  const replayBinding = { ...createBindingPayload, actionInvocationId, actorPrincipalId };
  const replayBindingRow = {
    actionInvocationId,
    actorPrincipalId,
    applicabilityBindingId: 'binding-2',
    bindingKind: 'SHARED',
    channelResourceId: channelRef.resourceId,
    customerGroupResourceId: null,
    effectiveFrom: DateTime.toDateUtc(createBindingPayload.effectiveFrom),
    idempotencyKey: actionInvocationId,
    marketResourceId: null,
    provenanceRef: replayBinding.provenanceRef,
    reason: replayBinding.reason,
    ruleRevisionId: revisionRef.sourceRef.resourceId,
    storefrontResourceId: null,
    subjectKind: null,
    subjectResourceId: null,
  };
  expect(matchesBindingReplay(replayBindingRow, replayBinding)).toBe(true);
  for (const changed of [
    { ...replayBinding, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayBinding, provenanceRef: 'test:changed-provenance' },
    { ...replayBinding, reason: 'Changed reason' },
    {
      ...replayBinding,
      ruleRevisionRef: { ...revisionRef, sourceRef: { ...revisionRef.sourceRef, resourceId: 'rule-revision-2' } },
    },
    {
      ...replayBinding,
      effectiveFrom: Schema.decodeUnknownSync(CreateApplicabilityBindingPayloadSchema)({
        ...createBindingPayload,
        effectiveFrom: '2026-09-23T12:00:00.000Z',
      }).effectiveFrom,
    },
  ]) {
    expect(matchesBindingReplay(replayBindingRow, changed)).toBe(false);
  }

  const replayEnd = { ...endPayload, actionInvocationId, actorPrincipalId };
  const replayEndRow = {
    actionInvocationId,
    actorPrincipalId,
    applicabilityBindingId: bindingRef.resourceId,
    effectiveAt: DateTime.toDateUtc(endPayload.effectiveAt),
    idempotencyKey: actionInvocationId,
    provenanceRef: replayEnd.provenanceRef,
    reason: replayEnd.reason,
  };
  expect(matchesBindingEndReplay(replayEndRow, replayEnd)).toBe(true);
  for (const changed of [
    { ...replayEnd, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayEnd, provenanceRef: 'test:changed-provenance' },
    { ...replayEnd, reason: 'Changed reason' },
    { ...replayEnd, applicabilityBindingRef: { ...bindingRef, resourceId: 'binding-2' } },
    {
      ...replayEnd,
      effectiveAt: Schema.decodeUnknownSync(EndApplicabilityBindingPayloadSchema)({
        ...endPayload,
        effectiveAt: '2026-09-23T12:00:00.000Z',
      }).effectiveAt,
    },
  ]) {
    expect(matchesBindingEndReplay(replayEndRow, changed)).toBe(false);
  }

  const replayReplace = { ...replacePayload, actionInvocationId, actorPrincipalId };
  const replayReplaceBinding = {
    ...replayBindingRow,
    actionInvocationId,
    actorPrincipalId,
    applicabilityBindingId: 'binding-3',
    effectiveFrom: DateTime.toDateUtc(replacePayload.proposedEffectiveFrom),
    provenanceRef: replayReplace.provenanceRef,
    reason: replayReplace.reason,
    ruleRevisionId: replacePayload.proposedRuleRevisionRef.sourceRef.resourceId,
  };
  const replayReplaceEnd = {
    ...replayEndRow,
    actionInvocationId,
    actorPrincipalId,
    applicabilityBindingId: replacePayload.existingBindingRef.resourceId,
    effectiveAt: DateTime.toDateUtc(replacePayload.effectiveAt),
    provenanceRef: replayReplace.provenanceRef,
    reason: replayReplace.reason,
  };
  expect(matchesReplacementReplay(replayReplaceBinding, replayReplaceEnd, replayReplace)).toBe(true);
  for (const changed of [
    { ...replayReplace, actorPrincipalId: '20000000-0000-4000-8000-000000000099' },
    { ...replayReplace, provenanceRef: 'test:changed-provenance' },
    { ...replayReplace, reason: 'Changed reason' },
    { ...replayReplace, existingBindingRef: { ...bindingRef, resourceId: 'binding-2' } },
    {
      ...replayReplace,
      effectiveAt: Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
        ...replacePayload,
        effectiveAt: '2026-09-23T12:00:00.000Z',
        proposedEffectiveFrom: '2026-09-23T12:00:00.000Z',
      }).effectiveAt,
      proposedEffectiveFrom: Schema.decodeUnknownSync(ReplaceApplicabilityBindingPayloadSchema)({
        ...replacePayload,
        effectiveAt: '2026-09-23T12:00:00.000Z',
        proposedEffectiveFrom: '2026-09-23T12:00:00.000Z',
      }).proposedEffectiveFrom,
    },
  ]) {
    expect(matchesReplacementReplay(replayReplaceBinding, replayReplaceEnd, changed)).toBe(false);
  }
});
