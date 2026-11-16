import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { OrganizationBusinessSourceStatement } from '@app/party-registry/apis/organization-record-facts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SymmyPinnedJobPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { projectSymmyCustomerIntakeRequests } from '../../src/services/symmy-customer-intake-privacy.ts';

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
