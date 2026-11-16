import type {
  SourcePersonAdmissionReferenceSchema,
  SourcePersonAdmissionResponse,
} from '@app/party-registry/apis/source-person-admission';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { DateTime, Schema } from 'effect';

import { internalCustomerSource } from './symmy-c14-customer-plan.mts';
import type { InternalCustomerPlanInput } from './symmy-c14-customer-plan.mts';

type RevisionInput = InternalCustomerPlanInput & {
  readonly admission: Extract<SourcePersonAdmissionResponse, { readonly outcome: 'SOURCE_PERSON_CURRENT' }>;
  readonly partySourceReference: typeof SourcePersonAdmissionReferenceSchema.Type;
  readonly revision: 2 | 3;
};

/** A fresh source assertion revises the original Party; Commerce retains the original admission citation. */
export const makeSymmyC14CustomerRevisionPlan = (input: RevisionInput) => {
  const observedAt = DateTime.formatIso(input.observedAt);
  const source = {
    issuer: internalCustomerSource.issuerId,
    namespace: internalCustomerSource.namespace,
    recordType: internalCustomerSource.recordType,
    routeRef: input.sourceRouteId,
  };
  return Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'party-revision',
            intent: {
              _tag: 'PartyUpdate',
              payload: {
                expectedRevision: input.admission.partyRevision,
                firstName: input.revision === 2 ? 'RevisedInternal' : 'ReadbackInternal',
                partyRef: input.admission.partyRef,
                provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
                provenanceSource: `INTERNAL_C14_CUSTOMER_RECORD_REVISION_${input.revision}`,
                subjectEvidence: [
                  {
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    observedSubject: 'PERSON',
                    occurrenceId: input.occurrenceId,
                    recordId: input.recordId,
                    source,
                    sourceObservedAt: observedAt,
                    statement: 'The explicit internal customer record now reports the revised first name',
                    subjectKey: input.recordId,
                  },
                ],
                validFrom: observedAt,
              },
            },
            operation: { entrypointKey: 'party.registry.update-party', moduleId: 'party.registry', schemaVersion: '1' },
            originalTarget: input.admission.partyRef,
          },
          {
            dependsOn: ['party-revision'],
            effectKey: 'retail-source-revision',
            intent: {
              _tag: 'EnsureRetailProfile',
              payload: {
                effectiveAt: observedAt,
                partySourceReference: input.partySourceReference,
                source: {
                  effectId: 'INTERNAL_C14_ASSIGNED_AT_ADMISSION',
                  issuer: source.issuer,
                  mappingRevision: internalCustomerSource.mappingVersion,
                  namespace: source.namespace,
                  occurrenceId: input.occurrenceId,
                  order: input.revision,
                  recordId: input.recordId,
                  recordType: source.recordType,
                  revision: `INTERNAL_C14_RECORD_REVISION_${input.revision}`,
                  route: { id: input.sourceRouteId, revision: internalCustomerSource.routeRevision },
                },
                subject: {
                  kind: 'RETAIL',
                  partyRef: input.admission.partyRef,
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
        itemKey: 'customer-revision',
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
