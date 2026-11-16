import { computeActionRequestHash } from '@app/core-runtime/access/enforcement';
import {
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessSourceStatement,
} from '@app/party-registry/apis/organization-record-facts';
import {
  createPartyRequestIdentity,
  counterpartyCustomerOnboardRequestIdentity,
} from '@app/party-registry/api/native-action-request-identity';
import { createCounterpartyPurchasingProfileRequestIdentity } from '@app/commerce-customer-context/domain/native-action-request-identity';
import { Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import {
  SymmyExecutionEffectStateSchema,
  SymmyPinnedEffectSchema,
  SymmyPinnedJobPlanSchema,
} from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyPinnedEffect } from '../../shared/domain/symmy-job-execution.ts';
import {
  SymmyPartyCommerceIntentSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
  resolveSymmyCounterpartyOnboardParty,
  resolveSymmyCounterpartyProfileCounterparty,
} from '../../shared/domain/symmy-party-commerce-intents.ts';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import { selectSymmyOrganizationMaterialization } from '../../src/persistence/symmy-source-organization-facts-store.ts';

const id = (suffix: string) => `10000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const tenantId = id('1');
const legalEntityId = id('2');
const originalAdmissionInvocationId = id('3');
const principalId = id('4');
const routeId = id('5');
const partySource = { issuer: 'INTERNAL', namespace: 'organizations', recordType: 'ORGANIZATION', routeRef: routeId };
const partySourceReference = { occurrenceId: 'party-occurrence', recordId: 'organization-1', source: partySource };
const partyRef = { moduleId: 'party.registry', resourceId: id('6'), resourceType: 'party.registry.party', tenantId };
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: id('7'),
  resourceType: 'party.registry.counterparty',
  tenantId,
};
const legalEntityRef = {
  moduleId: 'core.identity',
  resourceId: legalEntityId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
};
const rolePeriodRef = {
  moduleId: 'party.registry',
  resourceId: id('8'),
  resourceType: 'party.registry.counterparty-role-period',
  tenantId,
};
const ref = (effectId: string, entrypointKey: string, moduleId = 'party.registry') => ({
  effectId,
  mappingVersion: 'mapping-1',
  occurrence: {
    occurrenceId: partySourceReference.occurrenceId,
    record: {
      entityKind: partySource.recordType,
      issuerId: partySource.issuer,
      route: { integrationRouteId: routeId, tenantId },
      sourceNamespace: partySource.namespace,
      sourceRecordId: partySourceReference.recordId,
    },
  },
  operation: { entrypointKey, moduleId, schemaVersion: '1' },
  routeRevision: 'route-1',
});
const plan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
  items: [
    {
      effects: [
        {
          effectKey: 'party',
          intent: {
            _tag: 'PartyCreate',
            payload: {
              candidate: {
                businessName: 'Internal organization fixture',
                evidenceRefs: [],
                officialIdentifiers: [],
                partyType: 'ORGANIZATION',
                provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: routeId },
                subjectEvidence: [
                  {
                    ...partySourceReference,
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    observedSubject: 'ORGANIZATION',
                    sourceObservedAt: '2026-11-07T00:00:00.000Z',
                    statement: OrganizationBusinessSourceStatement,
                    subjectKey: partySourceReference.recordId,
                  },
                ],
                validFrom: '2026-11-07T00:00:00.000Z',
              },
            },
          },
          itemId: id('10'),
          ref: ref(id('11'), 'party.registry.create-party'),
        },
        {
          dependsOn: [{ effectKey: 'party', itemKey: 'organization' }],
          effectKey: 'onboard',
          intent: {
            _tag: 'OnboardCounterpartyCustomerFromParty',
            fromPartyEffect: { effectKey: 'party', itemKey: 'organization' },
            payload: {
              counterpartyProvenance: {
                evidenceReference: partySourceReference.recordId,
                method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
                reason: OrganizationBusinessCounterpartyContextReason,
                source: routeId,
              },
              customerEvidence: {
                evidenceReference: partySourceReference.recordId,
                method: 'APPROVED_PURCHASING_RELATIONSHIP',
                reason: OrganizationBusinessCustomerRoleReason,
                source: routeId,
              },
              sourceReference: partySourceReference,
              validFrom: '2026-11-07T00:00:00.000Z',
            },
          },
          itemId: id('10'),
          ref: ref(id('12'), 'party.registry.counterparty-customer-onboard'),
        },
      ],
      itemId: id('10'),
      itemKey: 'organization',
    },
    {
      effects: [
        {
          dependsOn: [{ effectKey: 'onboard', itemKey: 'organization' }],
          effectKey: 'profile',
          intent: {
            _tag: 'CreateCounterpartyProfileFromCounterparty',
            fromCounterpartyEffect: { effectKey: 'onboard', itemKey: 'organization' },
            payload: {
              effectiveAt: '2026-11-07T00:00:00.000Z',
              partySourceReference,
              source: {
                effectId: id('14'),
                issuer: 'INTERNAL',
                mappingRevision: 'mapping-1',
                namespace: 'customer-profiles',
                occurrenceId: 'profile-occurrence',
                order: 1,
                recordId: 'customer-1',
                recordType: 'CUSTOMER_PROFILE',
                revision: 'source-1',
                route: { id: routeId, revision: 'route-1' },
              },
              subject: { kind: 'COUNTERPARTY', sellingLegalEntityRef: legalEntityRef },
              trigger: 'AUTHORIZED_ONBOARDING',
            },
          },
          itemId: id('13'),
          ref: {
            ...ref(
              id('14'),
              'commerce.customer-context.create-counterparty-purchasing-profile',
              'commerce.customer-context',
            ),
            occurrence: {
              occurrenceId: 'profile-occurrence',
              record: {
                entityKind: 'CUSTOMER_PROFILE',
                issuerId: 'INTERNAL',
                route: { integrationRouteId: routeId, tenantId },
                sourceNamespace: 'customer-profiles',
                sourceRecordId: 'customer-1',
              },
            },
          },
        },
      ],
      itemId: id('13'),
      itemKey: 'profile',
    },
  ],
});
const [partyEffect, onboardEffect, profileEffect] = plan.items.flatMap((item) => item.effects);
const requiredEffect = (effect: SymmyPinnedEffect | undefined) =>
  Schema.decodeUnknownSync(Schema.toType(SymmyPinnedEffectSchema))(effect);
const party = requiredEffect(partyEffect);
const onboard = requiredEffect(onboardEffect);
const profile = requiredEffect(profileEffect);
const createdReceipt = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
  _tag: 'PartyCreated',
  actionInvocationId: id('90'),
  partyRef,
});
const onboardReceipt = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
  _tag: 'CounterpartyCustomerOnboarded',
  actionInvocationId: id('91'),
  counterpartyRef,
  legalEntityRef,
  partyRef,
  rolePeriodRef,
});
const actualHash = Effect.fn('OrganizationMaterializationTest.actualHash')(function* actualHash(
  effect: SymmyPinnedEffect,
) {
  const { intent } = effect;
  if (intent === undefined) {
    return '';
  }
  const principal = { legalEntityId, principalId, tenantId };
  return yield* Match.value(intent).pipe(
    Match.tag('PartyCreate', (value) =>
      Schema.decodeUnknownEffect(Schema.Json)(value.payload).pipe(
        Effect.flatMap(createPartyRequestIdentity),
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
      ),
    ),
    Match.tag('OnboardCounterpartyCustomer', (value) =>
      counterpartyCustomerOnboardRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
      ),
    ),
    Match.tag('CreateCounterpartyProfile', (value) =>
      createCounterpartyPurchasingProfileRequestIdentity(value.payload).pipe(
        Effect.map((identity) => computeActionRequestHash({ ...identity, principal })),
      ),
    ),
    Match.orElse(() => Effect.succeed('')),
  );
});
const nativeInvocationForEffect = (effect: SymmyPinnedEffect) => (effect.effectKey === 'party' ? id('20') : id('21'));
const stateFor = Effect.fn('OrganizationMaterializationTest.state')(function* stateFor(
  effect: SymmyPinnedEffect,
  resolved: SymmyPinnedEffect,
  settled: boolean,
  ownerReceipt: typeof SymmyPartyCommerceOwnerReceiptSchema.Type | null,
) {
  return yield* Schema.decodeUnknownEffect(SymmyExecutionEffectStateSchema)({
    effect,
    outcome: settled
      ? { effectId: effect.ref.effectId, owner: effect.ref.operation.moduleId, status: 'accepted_change' }
      : null,
    ownerAuthContextRef: `original-native-${effect.effectKey}`,
    ownerExecutorPrincipalId: principalId,
    ownerInvocationId: settled ? nativeInvocationForEffect(effect) : null,
    ownerReceipt,
    ownerRequestHash: yield* actualHash(resolved),
    resolvedEffect: effect === resolved ? null : resolved,
    state: settled ? 'settled' : 'attempting',
    version: 1,
  });
});
const fixture = Effect.fn('OrganizationMaterializationTest.fixture')(function* fixture() {
  const onboardProjection = yield* projectSymmyOrganizationAcceptedEffect(plan, onboard);
  const profileProjection = yield* projectSymmyOrganizationAcceptedEffect(plan, profile);
  const sourceWitness = (effect: SymmyPinnedEffect, projection: typeof onboardProjection) => {
    const value = Option.getOrUndefined(projection);
    return {
      effectId: effect.ref.effectId,
      originalAdmissionInvocationId,
      semanticInputDigest: value?.inputDigest ?? '',
      semanticProjectionVersion: value?.projectionVersion ?? '',
    };
  };
  const onboardIntent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(onboard.intent);
  const profileIntent = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceIntentSchema)(profile.intent);
  const resolvedOnboard = yield* Match.value(onboardIntent).pipe(
    Match.tag('OnboardCounterpartyCustomerFromParty', (intent) =>
      Match.value(createdReceipt).pipe(
        Match.tag('PartyCreated', (receipt) => Effect.succeed(resolveSymmyCounterpartyOnboardParty(intent, receipt))),
        Match.orElse(() => Effect.fail('fixture-Party-receipt-missing')),
      ),
    ),
    Match.orElse(() => Effect.fail('fixture-Onboard-template-missing')),
  );
  const resolvedProfile = yield* Match.value(profileIntent).pipe(
    Match.tag('CreateCounterpartyProfileFromCounterparty', (intent) =>
      Match.value(onboardReceipt).pipe(
        Match.tag('CounterpartyCustomerOnboarded', (receipt) =>
          Effect.succeed(resolveSymmyCounterpartyProfileCounterparty(intent, receipt)),
        ),
        Match.orElse(() => Effect.fail('fixture-Onboard-receipt-missing')),
      ),
    ),
    Match.orElse(() => Effect.fail('fixture-profile-template-missing')),
  );
  const onboardNative = {
    ...onboard,
    intent: {
      ...resolvedOnboard,
      payload: { ...resolvedOnboard.payload, sourceOrganizationWitness: sourceWitness(onboard, onboardProjection) },
    },
  };
  const profileNative = {
    ...profile,
    intent: {
      ...resolvedProfile,
      payload: { ...resolvedProfile.payload, sourceOrganizationWitness: sourceWitness(profile, profileProjection) },
    },
  };
  const partyState = yield* stateFor(party, party, true, createdReceipt);
  const onboardState = yield* stateFor(onboard, onboardNative, true, onboardReceipt);
  const profileState = yield* stateFor(profile, profileNative, false, null);
  return { onboardNative, onboardProjection, onboardState, partyState, profileNative, profileProjection, profileState };
});
const proof = Effect.fn('OrganizationMaterializationTest.proof')(function* proof(
  states: readonly (typeof SymmyExecutionEffectStateSchema.Type)[],
  effect = profile,
) {
  const projection = yield* projectSymmyOrganizationAcceptedEffect(plan, effect);
  if (Option.isNone(projection)) {
    return Option.none();
  }
  return yield* selectSymmyOrganizationMaterialization({
    effect,
    legalEntityId,
    originalAdmissionInvocationId,
    plan,
    projection: projection.value,
    states,
  });
});

describe('retained source-only organization DAG materialization', () => {
  it.effect('proves the exact Party parent before the Onboard native action commits', () =>
    Effect.gen(function* precommit() {
      const value = yield* fixture();
      const selected = {
        ...value.onboardState,
        outcome: Option.none(),
        ownerInvocationId: Option.none(),
        ownerReceipt: Option.none(),
        state: 'attempting' as const,
      };
      const actual = yield* proof([value.partyState, selected], onboard);
      expect(Option.getOrUndefined(actual)?.materialization.target).toEqual({ kind: 'PARTY', partyRef });
      expect(Option.getOrUndefined(actual)?.materialization.parents).toEqual([
        { actionInvocationId: id('20'), effectId: party.ref.effectId },
      ]);
    }),
  );
  it.effect('binds distinct Commerce and Party sources and original actual Onboard role refs', () =>
    Effect.gen(function* completeChain() {
      const value = yield* fixture();
      const actual = yield* proof([value.partyState, value.onboardState, value.profileState]);
      expect(Option.getOrUndefined(actual)?.materialization.target).toEqual({
        counterpartyRef,
        kind: 'COUNTERPARTY_CUSTOMER',
        legalEntityRef,
        partyRef,
        rolePeriodRef,
      });
      expect(Option.getOrUndefined(actual)?.materialization.parents).toEqual(
        expect.arrayContaining([
          { actionInvocationId: id('20'), effectId: party.ref.effectId },
          { actionInvocationId: id('21'), effectId: onboard.ref.effectId },
        ]),
      );
    }),
  );
  it.effect(
    'accepts Create matched-existing using its native Create invocation and rejects an unrelated operation',
    () =>
      Effect.gen(function* createMatchedExisting() {
        const value = yield* fixture();
        const matched = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)({
          _tag: 'PartyMatched',
          partyRef,
        });
        const matchedState = { ...value.partyState, ownerReceipt: Option.some(matched) };
        expect(Option.isSome(yield* proof([matchedState, value.onboardState, value.profileState]))).toBe(true);
        const wrongOperation = yield* Schema.decodeUnknownEffect(Schema.toType(SymmyExecutionEffectStateSchema))({
          ...matchedState,
          effect: {
            ...matchedState.effect,
            ref: {
              ...matchedState.effect.ref,
              operation: { ...matchedState.effect.ref.operation, entrypointKey: 'party.registry.update-party' },
            },
          },
        });
        expect(Option.isNone(yield* proof([wrongOperation, value.onboardState, value.profileState]))).toBe(true);
      }),
  );
  it.effect('requires actual current Core invocation pins separately from the immutable business receipt ID', () =>
    Effect.gen(function* nativePins() {
      const value = yield* fixture();
      expect(Option.isSome(yield* proof([value.partyState, value.onboardState, value.profileState]))).toBe(true);
      const withoutNativeId = { ...value.partyState, ownerInvocationId: Option.none() };
      expect(Option.isNone(yield* proof([withoutNativeId, value.onboardState, value.profileState]))).toBe(true);
    }),
  );
  it.effect('rejects unresolved or failed parents and ambiguous duplicate state rows', () =>
    Effect.gen(function* failClosed() {
      const value = yield* fixture();
      const blocked = Schema.decodeUnknownSync(Schema.toType(SymmyExecutionEffectStateSchema))({
        ...value.onboardState,
        state: 'blocked',
      });
      expect(Option.isNone(yield* proof([value.partyState, blocked, value.profileState]))).toBe(true);
      expect(
        Option.isNone(yield* proof([value.partyState, value.partyState, value.onboardState, value.profileState])),
      ).toBe(true);
    }),
  );
  it.effect('keeps legacy receipts without original LE and role refs ineligible for a new company proof', () =>
    Effect.gen(function* legacy() {
      const value = yield* fixture();
      const old = Schema.decodeUnknownSync(SymmyPartyCommerceOwnerReceiptSchema)({
        _tag: 'CounterpartyCustomerOnboarded',
        counterpartyRef,
        partyRef,
      });
      const legacyState = { ...value.onboardState, ownerReceipt: Option.some(old) };
      expect(Option.isNone(yield* proof([value.partyState, legacyState, value.profileState]))).toBe(true);
    }),
  );
  it.effect('rejects a newly hashed native target that differs from the retained canonical parent', () =>
    Effect.gen(function* changedNativeTarget() {
      const value = yield* fixture();
      const forged = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...value.profileNative,
        intent: {
          ...value.profileNative.intent,
          payload: {
            ...value.profileNative.intent.payload,
            subject: {
              ...value.profileNative.intent.payload.subject,
              counterpartyRef: { ...counterpartyRef, resourceId: id('89') },
            },
          },
        },
      });
      const forgedState = {
        ...value.profileState,
        ownerRequestHash: Option.some(yield* actualHash(forged)),
        resolvedEffect: Option.some(forged),
      };
      expect(Option.isNone(yield* proof([value.partyState, value.onboardState, forgedState]))).toBe(true);
    }),
  );
  it.effect('rejects foreign Tenant and selected Legal Entity refs in an otherwise successful Onboard receipt', () =>
    Effect.gen(function* currentScope() {
      const value = yield* fixture();
      const foreignTenant = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)({
        _tag: 'CounterpartyCustomerOnboarded',
        counterpartyRef,
        legalEntityRef,
        partyRef,
        rolePeriodRef: { ...rolePeriodRef, tenantId: id('87') },
      });
      const foreignEntity = yield* Schema.decodeUnknownEffect(SymmyPartyCommerceOwnerReceiptSchema)({
        _tag: 'CounterpartyCustomerOnboarded',
        counterpartyRef,
        legalEntityRef: { ...legalEntityRef, resourceId: id('86') },
        partyRef,
        rolePeriodRef,
      });
      const tenantState = { ...value.onboardState, ownerReceipt: Option.some(foreignTenant) };
      const entityState = { ...value.onboardState, ownerReceipt: Option.some(foreignEntity) };
      expect(Option.isNone(yield* proof([value.partyState, tenantState, value.profileState]))).toBe(true);
      expect(Option.isNone(yield* proof([value.partyState, entityState, value.profileState]))).toBe(true);
    }),
  );
  it.effect('rejects native hash or executor changes even when supplied refs remain well formed', () =>
    Effect.gen(function* hashFence() {
      const value = yield* fixture();
      const altered = { ...value.profileState, ownerRequestHash: Option.some('a'.repeat(64)) };
      expect(Option.isNone(yield* proof([value.partyState, value.onboardState, altered]))).toBe(true);
      const changedActor = Schema.decodeUnknownSync(Schema.toType(SymmyExecutionEffectStateSchema))({
        ...value.profileState,
        ownerExecutorPrincipalId: Option.some(id('88')),
      });
      expect(Option.isNone(yield* proof([value.partyState, value.onboardState, changedActor]))).toBe(true);
    }),
  );
});
