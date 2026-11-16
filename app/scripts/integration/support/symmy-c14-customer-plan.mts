import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { DateTime, Schema } from 'effect';

export const internalCustomerSource = {
  issuerId: 'INTERNAL_C14_CUSTOMER_ISSUER',
  mappingVersion: 'INTERNAL_C14_CUSTOMER_MAPPING_V1',
  namespace: 'INTERNAL_C14_CUSTOMERS',
  recordType: 'CUSTOMER',
  routeRevision: 'INTERNAL_C14_CUSTOMER_ROUTE_V1',
} as const;

const legalEntityIdSchema = Schema.String.pipe(Schema.brand('LegalEntityId'), Schema.decodeTo(Schema.String));
const occurrenceIdSchema = Schema.String.pipe(Schema.brand('OccurrenceId'), Schema.decodeTo(Schema.String));
const recordIdSchema = Schema.String.pipe(Schema.brand('RecordId'), Schema.decodeTo(Schema.String));
const sourceRouteIdSchema = Schema.String.pipe(Schema.brand('SourceRouteId'), Schema.decodeTo(Schema.String));
const tenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'), Schema.decodeTo(Schema.String));
const InputSchema = Schema.Struct({
  legalEntityId: legalEntityIdSchema,
  observedAt: Schema.DateTimeUtc,
  occurrenceId: occurrenceIdSchema,
  recordId: recordIdSchema,
  sourceRouteId: sourceRouteIdSchema,
  tenantId: tenantIdSchema,
});
export type InternalCustomerPlanInput = typeof InputSchema.Type;
const partyEffectKey = 'party-create';

/** One explicit source record, with separate canonical Party and Commerce effects. */
export const makeSymmyC14CustomerPlan = (input: InternalCustomerPlanInput) => {
  const observedAt = DateTime.formatIso(input.observedAt);
  const source = {
    issuer: internalCustomerSource.issuerId,
    namespace: internalCustomerSource.namespace,
    recordType: internalCustomerSource.recordType,
    routeRef: input.sourceRouteId,
  };
  const partySourceReference = {
    occurrenceId: input.occurrenceId,
    recordId: input.recordId,
    source,
  };
  return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: partyEffectKey,
            intent: {
              _tag: 'PartyCreate',
              payload: {
                candidate: {
                  evidenceRefs: ['INTERNAL_C14_EXPLICIT_CLIENT_RECORD'],
                  firstName: 'Internal',
                  lastName: 'Customer',
                  officialIdentifiers: [],
                  partyType: 'PERSON',
                  provenance: {
                    method: 'CLIENT_SOURCE_ASSERTION',
                    source: 'INTERNAL_C14_CUSTOMER_RECORD',
                  },
                  subjectEvidence: [
                    {
                      ...partySourceReference,
                      kind: 'CLIENT_SOURCE_ASSERTION',
                      observedSubject: 'PERSON',
                      sourceObservedAt: observedAt,
                      statement: 'The explicit internal customer record asserts this named concrete person',
                      subjectKey: input.recordId,
                    },
                  ],
                  validFrom: observedAt,
                },
              },
            },
            operation: {
              entrypointKey: 'party.registry.create-party',
              moduleId: 'party.registry',
              schemaVersion: '1',
            },
          },
          {
            dependsOn: [partyEffectKey],
            effectKey: 'retail-profile',
            intent: {
              _tag: 'EnsureRetailProfileFromParty',
              fromPartyEffect: { effectKey: partyEffectKey, itemKey: 'customer' },
              payload: {
                effectiveAt: observedAt,
                partySourceReference,
                source: {
                  effectId: 'INTERNAL_C14_ASSIGNED_AT_ADMISSION',
                  issuer: source.issuer,
                  mappingRevision: internalCustomerSource.mappingVersion,
                  namespace: source.namespace,
                  occurrenceId: input.occurrenceId,
                  order: 1,
                  recordId: input.recordId,
                  recordType: source.recordType,
                  revision: 'INTERNAL_C14_RECORD_REVISION_1',
                  route: { id: input.sourceRouteId, revision: internalCustomerSource.routeRevision },
                },
                subject: {
                  kind: 'RETAIL',
                  sellingLegalEntityRef: {
                    moduleId: 'core.identity',
                    resourceId: input.legalEntityId,
                    resourceType: 'core.identity.legal-entity',
                    tenantId: input.tenantId,
                  },
                },
                trigger: 'AUTHORIZED_ONBOARDING',
              },
            },
            operation: {
              entrypointKey: 'commerce.customer-context.ensure-retail-customer-profile',
              moduleId: 'commerce.customer-context',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'customer',
        source: {
          entityKind: source.recordType,
          issuerId: source.issuer,
          sourceNamespace: source.namespace,
          sourceRecordId: input.recordId,
        },
        sourceOccurrenceId: input.occurrenceId,
      },
    ],
  });
};
