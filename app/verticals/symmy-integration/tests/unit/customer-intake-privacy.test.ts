import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { AdmitSourceProcessingSubjectPayloadSchema } from '@app/privacy/api/admit-source-processing-subject-action';
import { OrganizationBusinessSourceStatement } from '@app/party-registry/apis/organization-record-facts';
import { Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobStoreError } from '../../src/persistence/symmy-job-store.ts';
import {
  projectSymmyCustomerIntake,
  projectSymmyCustomerIntakeAdmissions,
  projectSymmyCustomerIntakeRequests,
  settleSymmyCustomerIntake,
} from '../../src/services/symmy-customer-intake-privacy.ts';
import type { SymmyCustomerIntakePrivacyCalls } from '../../src/services/symmy-customer-intake-privacy.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '10000000-0000-4000-8000-000000000002';
const routeRef = '10000000-0000-4000-8000-000000000003';
const occurrenceId = '10000000-0000-4000-8000-000000000004';
const itemId = '10000000-0000-4000-8000-000000000005';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '10000000-0000-4000-8000-000000000006',
  resourceType: 'party.registry.party',
  tenantId,
};
const source = { issuer: 'fixture-issuer', namespace: 'fixture-customers', recordType: 'CUSTOMER', routeRef };
const recordId = 'fixture:linked-source-alias';
const observedAt = '2026-11-10T10:00:00.000Z';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '10000000-0000-4000-8000-000000000007',
    authContextRef: 'better-auth-api-key:fixture-integration',
    authMethod: 'api_key',
    legalEntityId,
    principalId: '10000000-0000-4000-8000-000000000008',
    tenantId,
  }),
  audience: 'symmy-integration',
  correlationId: 'customer-intake-privacy',
};
const personalName = { firstName: 'Personal value not needed for eligibility' };
const companyName = { businessName: 'Fixture company name' };
const plan = (
  subjectRecordId: string,
  name: { readonly businessName?: string; readonly firstName?: string } = personalName,
  observedSubject: 'PERSON' | 'ORGANIZATION' = 'PERSON',
) =>
  Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'party-update',
            intent: {
              _tag: 'PartyUpdate',
              payload: {
                expectedRevision: 1,
                ...name,
                partyRef,
                provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
                provenanceSource: routeRef,
                subjectEvidence: [
                  {
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    observedSubject,
                    occurrenceId,
                    recordId: subjectRecordId,
                    source,
                    sourceObservedAt: observedAt,
                    statement: OrganizationBusinessSourceStatement,
                    subjectKey: subjectRecordId,
                  },
                ],
                validFrom: observedAt,
              },
            },
            itemId,
            ref: {
              effectId: '10000000-0000-4000-8000-000000000009',
              mappingVersion: 'fixture-mapping',
              occurrence: {
                occurrenceId,
                record: {
                  entityKind: source.recordType,
                  issuerId: source.issuer,
                  route: { integrationRouteId: routeRef, tenantId },
                  sourceNamespace: source.namespace,
                  sourceRecordId: recordId,
                },
              },
              operation: {
                entrypointKey: 'party.registry.update-party',
                moduleId: 'party.registry',
                schemaVersion: '1',
              },
              originalTarget: partyRef,
              routeRevision: 'fixture-revision',
            },
          },
        ],
        itemId,
        itemKey: 'customer',
      },
    ],
  });

it.effect('passes the qualified incoming alias and original Party target without copying personal fields', () =>
  Effect.gen(function* verifyIntakeRequest() {
    const requests = yield* projectSymmyCustomerIntakeRequests(scope, yield* plan(recordId));
    expect(requests).toEqual([
      {
        consumerModuleId: 'integration.symmy',
        operation: 'CUSTOMER_SOURCE_INTAKE',
        source: { ...source, occurrenceId, recordId },
        target: { kind: 'PARTY', resourceId: partyRef.resourceId },
      },
    ]);
  }),
);

it.effect('requires separate company-name intake only for the finite business-only payload', () =>
  Effect.gen(function* verifyCompanyIntake() {
    const companyPlan = yield* plan(recordId, companyName, 'ORGANIZATION');
    const mixedPlan = yield* plan(recordId, { ...companyName, ...personalName }, 'ORGANIZATION');
    const [company] = yield* projectSymmyCustomerIntakeRequests(scope, companyPlan);
    const [mixed] = yield* projectSymmyCustomerIntakeRequests(scope, mixedPlan);
    expect(company?.organizationBusinessUse).toBe('COMPANY_NAME');
    expect(mixed?.organizationBusinessUse).toBeUndefined();
  }),
);

it.effect('rejects private input tied to a different subject source than the pinned item', () =>
  Effect.gen(function* rejectMismatchedSource() {
    const rejected = yield* projectSymmyCustomerIntakeRequests(scope, yield* plan('fixture:foreign-source')).pipe(
      Effect.flip,
    );
    expect(rejected).toMatchObject({ code: 'route_denied' });
  }),
);

const admissionItem = (
  index: number,
  itemKey: string,
  sourceRecordId: string,
  dependsOn: readonly { readonly effectKey: string; readonly itemKey: string }[] = [],
) => ({
  effects: [
    {
      dependsOn,
      effectKey: 'party-update',
      itemId: `10000000-0000-4000-8000-00000000010${index}`,
      ref: {
        effectId: `10000000-0000-4000-8000-00000000020${index}`,
        mappingVersion: 'fixture-mapping',
        occurrence: {
          occurrenceId: `10000000-0000-4000-8000-00000000030${index}`,
          record: {
            entityKind: source.recordType,
            issuerId: source.issuer,
            route: { integrationRouteId: routeRef, tenantId },
            sourceNamespace: source.namespace,
            sourceRecordId,
          },
        },
        operation: { entrypointKey: 'party.registry.update-party', moduleId: 'party.registry', schemaVersion: '1' },
        originalTarget: partyRef,
        routeRevision: 'fixture-revision',
      },
    },
  ],
  itemId: `10000000-0000-4000-8000-00000000010${index}`,
  itemKey,
});

const sourceRecord = (sourceRecordId: string) => ({ ...source, recordId: sourceRecordId });

it.effect('admits one subject per customer and keeps each contact on the customer it builds on', () =>
  Effect.gen(function* projectAdmissions() {
    const admissionPlan = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
      items: [
        admissionItem(1, 'customer-0', 'customer:one'),
        admissionItem(2, 'contact-0-0', 'contact:one', [{ effectKey: 'party-update', itemKey: 'customer-0' }]),
        admissionItem(3, 'customer-1', 'customer:two'),
        admissionItem(4, 'group-0', 'group:not-personal'),
      ],
    });
    expect(
      yield* projectSymmyCustomerIntakeAdmissions(admissionPlan, new Set(['customer-0', 'contact-0-0', 'customer-1'])),
    ).toEqual([
      {
        occurrenceId: '10000000-0000-4000-8000-000000000301',
        payload: { childSources: [sourceRecord('contact:one')], source: sourceRecord('customer:one') },
      },
      {
        occurrenceId: '10000000-0000-4000-8000-000000000303',
        payload: { childSources: [], source: sourceRecord('customer:two') },
      },
    ]);
  }),
);

it.effect('encodes only a membership record as a child, not a CUSTOMER containing a membership effect', () =>
  Effect.gen(function* membership() {
    const sourceId = 'customer:one';
    const root = admissionItem(1, 'customer', sourceId);
    const [effect] = root.effects;
    assert.isOk(effect !== undefined);
    const profileRef = {
      moduleId: 'commerce.customer-context',
      resourceId: partyRef.resourceId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId,
    };
    const intent = {
      _tag: 'CustomerGroupMembership',
      payload: {
        completenessProofRef: 'fixture:complete',
        effectiveAt: observedAt,
        groupRefs: [],
        manager: {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
          issuer: source.issuer,
          sourceNamespace: source.namespace,
          tenantId,
        },
        operation: 'COMPLETE',
        profile: { profileKind: 'RETAIL', profileRef },
        reason: 'Fixture membership',
        route: { id: routeRef, revision: 'fixture-revision' },
        source: { assertionId: occurrenceId, effectId: 'fixture:effect', order: 1, sourceRecordId: sourceId },
      },
    };
    for (const entityKind of ['CUSTOMER', 'CUSTOMER_GROUP_MEMBERSHIP']) {
      const occurrence = { ...effect.ref.occurrence, record: { ...effect.ref.occurrence.record, entityKind } };
      const job = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
        items: [{ ...root, effects: [{ ...effect, intent, ref: { ...effect.ref, occurrence } }] }],
      });
      const [projected] = yield* projectSymmyCustomerIntakeAdmissions(job, new Set(['customer']));
      const payload = yield* Schema.decodeUnknownEffect(AdmitSourceProcessingSubjectPayloadSchema)(projected?.payload);
      expect(payload.membershipProfile).toEqual(
        entityKind === 'CUSTOMER' ? undefined : { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profileRef.resourceId },
      );
    }
  }),
);

/** A personal use of one source record: the item's own record is the subject evidence of its Party update. */
const personalItem = (
  index: number,
  itemKey: string,
  sourceRecordId: string,
  dependsOn: readonly { readonly effectKey: string; readonly itemKey: string }[] = [],
) => {
  const item = admissionItem(index, itemKey, sourceRecordId, dependsOn);
  return {
    ...item,
    effects: item.effects.map((effect) => ({
      ...effect,
      intent: {
        _tag: 'PartyUpdate',
        payload: {
          expectedRevision: 1,
          ...personalName,
          partyRef,
          provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
          provenanceSource: routeRef,
          subjectEvidence: [
            {
              kind: 'CLIENT_SOURCE_ASSERTION',
              observedSubject: 'PERSON',
              occurrenceId: effect.ref.occurrence.occurrenceId,
              recordId: sourceRecordId,
              source,
              sourceObservedAt: observedAt,
              statement: OrganizationBusinessSourceStatement,
              subjectKey: sourceRecordId,
            },
          ],
          validFrom: observedAt,
        },
      },
    })),
  };
};
const customerWithContact = (customerRecordId: string) =>
  Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
    items: [
      personalItem(1, 'customer-0', customerRecordId),
      personalItem(2, 'contact-0-0', 'contact:one', [{ effectKey: 'party-update', itemKey: 'customer-0' }]),
    ],
  });

it.effect('never applies customer root rules to items with no personal use', () =>
  Effect.gen(function* noPersonalUse() {
    // A valid effect DAG can cross its item boundary in both directions: create product, create variant, retire
    // product. No Privacy request is projected, so collapsing it into an item graph must not invent a refusal.
    const product = admissionItem(1, 'product', 'product:one');
    const variant = admissionItem(2, 'variant', 'variant:one', [{ effectKey: 'party-update', itemKey: 'product' }]);
    const [created] = product.effects;
    assert.isOk(created !== undefined);
    const finish = {
      ...created,
      dependsOn: [{ effectKey: 'party-update', itemKey: 'variant' }],
      effectKey: 'finish',
      ref: { ...created.ref, effectId: '10000000-0000-4000-8000-000000000299' },
    };
    const job = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
      items: [{ ...product, effects: [...product.effects, finish] }, variant],
    });
    expect(yield* projectSymmyCustomerIntake(scope, job)).toEqual({ admissions: [], requests: [] });
  }),
);

it.effect('rejects cross-customer prerequisites in either order before proposing any binding', () =>
  Effect.gen(function* ambiguousRoot() {
    const group = personalItem(3, 'group-definition', 'group:one');
    const customer = personalItem(1, 'customer', 'customer:one');
    const groupDependency = { effectKey: 'party-update', itemKey: 'group-definition' };
    const customerDependency = { effectKey: 'party-update', itemKey: 'customer' };
    for (const ordered of [
      [groupDependency, customerDependency],
      [customerDependency, groupDependency],
    ]) {
      const job = yield* Schema.decodeUnknownEffect(SymmyPinnedJobPlanSchema)({
        items: [group, customer, personalItem(2, 'membership', 'membership:one', ordered)],
      });
      expect(yield* projectSymmyCustomerIntake(scope, job).pipe(Effect.flip)).toMatchObject({ code: 'route_denied' });
      expect(yield* projectSymmyCustomerIntakeAdmissions(job, new Set(['membership'])).pipe(Effect.flip)).toMatchObject(
        { code: 'route_denied' },
      );
    }
  }),
);

it.effect('names the customer record a contact describes, so Privacy can check it before any binding exists', () =>
  Effect.gen(function* describedCustomer() {
    const { admissions, requests } = yield* projectSymmyCustomerIntake(
      scope,
      yield* customerWithContact('customer:one'),
    );
    expect(requests).toEqual([
      {
        consumerModuleId: 'integration.symmy',
        operation: 'CUSTOMER_SOURCE_INTAKE',
        source: { ...source, occurrenceId: '10000000-0000-4000-8000-000000000301', recordId: 'customer:one' },
        target: { kind: 'PARTY', resourceId: partyRef.resourceId },
      },
      {
        consumerModuleId: 'integration.symmy',
        describedSubjectSource: sourceRecord('customer:one'),
        operation: 'CUSTOMER_SOURCE_INTAKE',
        source: { ...source, occurrenceId: '10000000-0000-4000-8000-000000000302', recordId: 'contact:one' },
        target: { kind: 'PARTY', resourceId: partyRef.resourceId },
      },
    ]);
    expect(admissions.map(({ payload }) => payload)).toEqual([
      { childSources: [sourceRecord('contact:one')], source: sourceRecord('customer:one') },
    ]);
  }),
);

/** What Privacy holds after the calls of an intake: admitted subjects and the bindings of other records to them. */
const recordingPrivacy = (refuses: (checkedRecordId: string) => boolean) => {
  const bindings = new Map<string, string>();
  const calls: string[] = [];
  const subjects = new Set<string>();
  const privacy: SymmyCustomerIntakePrivacyCalls = {
    admit: (payload) =>
      Effect.sync(() => {
        subjects.add(payload.source.recordId);
        for (const child of payload.childSources) {
          bindings.set(child.recordId, payload.source.recordId);
        }
        calls.push(`admit:${payload.source.recordId}:${payload.childSources.length}`);
      }),
    check: (request) => {
      const checked = request.source?.recordId ?? '';
      calls.push(`check:${checked}`);
      return refuses(checked) ? Effect.fail(new SymmyJobStoreError({ code: 'route_denied' })) : Effect.void;
    },
  };
  return { bindings, calls, privacy, subjects };
};

it.effect('leaves no binding behind a refused plan, and binds the contact of the corrected plan', () =>
  Effect.gen(function* refusedThenCorrected() {
    const refused = recordingPrivacy((checked) => checked === 'contact:one');
    const wrongCustomer = yield* projectSymmyCustomerIntake(scope, yield* customerWithContact('customer:wrong'));
    expect(yield* settleSymmyCustomerIntake(wrongCustomer, refused.privacy).pipe(Effect.flip)).toMatchObject({
      code: 'route_denied',
    });
    // Only the customer's own subject was admitted; the contact is bound to nobody.
    expect(refused.calls).toEqual(['admit:customer:wrong:0', 'check:customer:wrong', 'check:contact:one']);
    expect([...refused.bindings]).toEqual([]);

    const allowed = recordingPrivacy(() => false);
    const corrected = yield* projectSymmyCustomerIntake(scope, yield* customerWithContact('customer:one'));
    yield* settleSymmyCustomerIntake(corrected, allowed.privacy);
    // Subjects first, every use next, the immutable binding last.
    expect(allowed.calls).toEqual([
      'admit:customer:one:0',
      'check:customer:one',
      'check:contact:one',
      'admit:customer:one:1',
    ]);
    expect([...allowed.bindings]).toEqual([['contact:one', 'customer:one']]);
  }),
);
