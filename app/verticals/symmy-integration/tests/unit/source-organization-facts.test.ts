import {
  OrganizationBusinessSourceStatement,
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessOnboardTemplateProjectionVersion,
  organizationBusinessSourceInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import { Effect, Option, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { projectSymmyOrganizationAcceptedEffect } from '../../shared/domain/symmy-source-organization-projections.ts';
import { SymmyPinnedJobPlanSchema, SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmySourceOrganizationFactsRequestSchema } from '../../shared/apis/symmy-source-organization-facts.ts';
import { symmyOrganizationProjectionForEffect } from '../../src/persistence/symmy-source-organization-facts-store.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const routeId = '10000000-0000-4000-8000-000000000002';
const effectId = '10000000-0000-4000-8000-000000000003';
const source = { issuer: 'INTERNAL', namespace: 'organizations', recordType: 'ORGANIZATION', routeRef: routeId };
const candidate = {
  businessName: 'Internal organization fixture',
  evidenceRefs: [],
  officialIdentifiers: [],
  partyType: 'ORGANIZATION',
  provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: routeId },
  subjectEvidence: [
    {
      kind: 'CLIENT_SOURCE_ASSERTION',
      observedSubject: 'ORGANIZATION',
      occurrenceId: 'occurrence-1',
      recordId: 'org-1',
      source,
      sourceObservedAt: '2026-01-01T00:00:00.000Z',
      statement: OrganizationBusinessSourceStatement,
      subjectKey: 'org-1',
    },
  ],
  validFrom: '2026-01-01T00:00:00.000Z',
};
const effect = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  effectKey: 'party-create',
  intent: { _tag: 'PartyCreate', payload: { candidate } },
  itemId: '10000000-0000-4000-8000-000000000004',
  ref: {
    effectId,
    mappingVersion: 'mapping-1',
    occurrence: {
      occurrenceId: 'occurrence-1',
      record: {
        entityKind: 'ORGANIZATION',
        issuerId: source.issuer,
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: source.namespace,
        sourceRecordId: 'org-1',
      },
    },
    operation: { entrypointKey: 'party.registry.create-party', moduleId: 'party.registry', schemaVersion: '1' },
    routeRevision: 'route-1',
  },
});

describe('retained Organization source projection', () => {
  it.effect('recomputes the one owner-public normalized digest from the complete admitted native payload', () =>
    Effect.gen(function* exactDigest() {
      const expected = yield* organizationBusinessSourceInputDigest({ operation: 'CREATE', payload: { candidate } });
      const actual = yield* symmyOrganizationProjectionForEffect(effect);
      expect(Option.getOrUndefined(actual)).toEqual(expected);
      expect(Object.keys(expected)).toHaveLength(3);
      expect(Object.keys(expected)).toEqual(
        expect.arrayContaining(['inputDigest', 'projectionVersion', 'sourceReference']),
      );
    }),
  );
  it.effect('never sanitizes a personal or extra native field into safe organization evidence', () =>
    Effect.gen(function* noSanitizer() {
      for (const unsafe of [
        { ...candidate, firstName: 'Personal field' },
        { ...candidate, evidenceRefs: ['free-text evidence'] },
        { ...candidate, subjectEvidence: [{ ...candidate.subjectEvidence[0], statement: 'An arbitrary narrative' }] },
      ]) {
        const changed = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
          ...effect,
          intent: { _tag: 'PartyCreate', payload: { candidate: unsafe } },
        });
        const actual = yield* symmyOrganizationProjectionForEffect(changed);
        expect(Option.isNone(actual)).toBe(true);
      }
      expect(candidate.evidenceRefs).toEqual([]);
    }),
  );
  it.effect(
    'requires the exact admitted source occurrence and native operation rather than matching a record name',
    () =>
      Effect.gen(function* pins() {
        const differentOccurrence = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
          ...effect,
          ref: { ...effect.ref, occurrence: { ...effect.ref.occurrence, occurrenceId: 'other-occurrence' } },
        });
        const actual = yield* symmyOrganizationProjectionForEffect(differentOccurrence);
        expect(Option.isNone(actual)).toBe(true);
        const differentOperation = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
          ...effect,
          ref: { ...effect.ref, operation: { ...effect.ref.operation, entrypointKey: 'party.registry.match-party' } },
        });
        expect(Option.isNone(yield* symmyOrganizationProjectionForEffect(differentOperation))).toBe(true);
      }),
  );
  it('separates real governance locators from processing admission anchors', () => {
    const governance = {
      effectKey: 'party-create',
      execution: { jobId: '10000000-0000-4000-8000-000000000005', kind: 'JOB' },
      purpose: 'GOVERNANCE',
      sourceReference: { occurrenceId: 'occurrence-1', recordId: 'org-1', source },
    };
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(SymmySourceOrganizationFactsRequestSchema, { onExcessProperty: 'error' })(
          governance,
        ),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(SymmySourceOrganizationFactsRequestSchema, { onExcessProperty: 'error' })({
          ...governance,
          purpose: 'PROCESSING',
        }),
      ),
    ).toBe(true);
  });
});

const onboard = Schema.decodeUnknownSync(SymmyPinnedEffectSchema)({
  ...effect,
  dependsOn: ['party-create'],
  effectKey: 'onboard',
  intent: {
    _tag: 'OnboardCounterpartyCustomerFromParty',
    fromPartyEffect: { effectKey: 'party-create', itemKey: 'company' },
    payload: {
      counterpartyProvenance: {
        evidenceReference: 'org-1',
        method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
        reason: OrganizationBusinessCounterpartyContextReason,
        source: routeId,
      },
      customerEvidence: {
        evidenceReference: 'org-1',
        method: 'APPROVED_PURCHASING_RELATIONSHIP',
        reason: OrganizationBusinessCustomerRoleReason,
        source: routeId,
      },
      sourceReference: { occurrenceId: 'occurrence-1', recordId: 'org-1', source },
      validFrom: '2026-01-01T00:00:00.000Z',
    },
  },
  ref: {
    ...effect.ref,
    effectId: '10000000-0000-4000-8000-000000000006',
    operation: {
      entrypointKey: 'party.registry.counterparty-customer-onboard',
      moduleId: 'party.registry',
      schemaVersion: '1',
    },
  },
});
const companyPlan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
  items: [{ effects: [effect, onboard], itemId: effect.itemId, itemKey: 'company' }],
});
describe('accepted organization semantic DAG', () => {
  it.effect('classifies exact approved pending Onboard without a future Party UUID', () =>
    Effect.gen(function* pendingTemplate() {
      const projected = yield* projectSymmyOrganizationAcceptedEffect(companyPlan, onboard);
      expect(Option.isSome(projected)).toBe(true);
      expect(Option.getOrUndefined(projected)?.projectionVersion).toBe(
        OrganizationBusinessOnboardTemplateProjectionVersion,
      );
      expect(Option.getOrUndefined(projected)?.parents).toEqual([{ effectKey: 'party-create', itemKey: 'company' }]);
      expect(JSON.stringify(Option.getOrUndefined(projected))).not.toContain('businessName');
    }),
  );
  it.effect('requires the accepted unchanged effect and declared safe organization ancestor', () =>
    Effect.gen(function* exactAcceptedDAG() {
      const changed = { ...onboard, dependsOn: [] };
      expect(Option.isNone(yield* projectSymmyOrganizationAcceptedEffect(companyPlan, changed))).toBe(true);
      const unsafeParty = {
        ...effect,
        intent: { _tag: 'PartyCreate', payload: { candidate: { ...candidate, evidenceRefs: ['unbounded evidence'] } } },
      };
      const unsafePlan = Schema.decodeUnknownSync(SymmyPinnedJobPlanSchema)({
        items: [{ ...companyPlan.items[0], effects: [unsafeParty, onboard] }],
      });
      expect(Option.isNone(yield* projectSymmyOrganizationAcceptedEffect(unsafePlan, onboard))).toBe(true);
    }),
  );
});

it.effect(
  'binds the full Counterparty profile template and independent qualified citations without future native IDs',
  () =>
    Effect.gen(function* profileTemplate() {
      const profileEffectId = '10000000-0000-4000-8000-000000000007';
      const commerceSource = {
        effectId: profileEffectId,
        issuer: 'COMMERCE_INTERNAL',
        mappingRevision: 'mapping-1',
        namespace: 'purchasing',
        occurrenceId: 'profile-occurrence-1',
        order: 2,
        recordId: 'profile-1',
        recordType: 'CUSTOMER_PROFILE',
        revision: 'source-1',
        route: { id: routeId, revision: 'route-1' },
      };
      const profile = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
        ...effect,
        dependsOn: ['onboard'],
        effectKey: 'profile',
        intent: {
          _tag: 'CreateCounterpartyProfileFromCounterparty',
          fromCounterpartyEffect: { effectKey: 'onboard', itemKey: 'company' },
          payload: {
            effectiveAt: '2026-01-01T00:00:00.000Z',
            partySourceReference: { occurrenceId: 'occurrence-1', recordId: 'org-1', source },
            source: commerceSource,
            subject: {
              kind: 'COUNTERPARTY',
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: '10000000-0000-4000-8000-000000000008',
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
            },
            trigger: 'AUTHORIZED_ONBOARDING',
          },
        },
        ref: {
          ...effect.ref,
          effectId: profileEffectId,
          occurrence: {
            occurrenceId: commerceSource.occurrenceId,
            record: {
              ...effect.ref.occurrence.record,
              entityKind: commerceSource.recordType,
              issuerId: commerceSource.issuer,
              sourceNamespace: commerceSource.namespace,
              sourceRecordId: commerceSource.recordId,
            },
          },
          operation: {
            entrypointKey: 'commerce.customer-context.create-counterparty-purchasing-profile',
            moduleId: 'commerce.customer-context',
            schemaVersion: '1',
          },
        },
      });
      const plan = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
        items: [{ ...companyPlan.items[0], effects: [effect, onboard, profile] }],
      });
      const projection = yield* projectSymmyOrganizationAcceptedEffect(plan, profile);
      expect(Option.isSome(projection)).toBe(true);
      expect(Option.getOrUndefined(projection)?.sourceReference.source.namespace).toBe('purchasing');
      expect(Option.getOrUndefined(projection)?.parents).toEqual(
        expect.arrayContaining([
          { effectKey: 'party-create', itemKey: 'company' },
          { effectKey: 'onboard', itemKey: 'company' },
        ]),
      );
      expect(Option.getOrUndefined(projection)?.parents).toHaveLength(2);
      expect(JSON.stringify(Option.getOrUndefined(projection))).not.toContain('counterpartyRef');
    }),
);
