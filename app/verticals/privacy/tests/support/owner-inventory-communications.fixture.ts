import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '@app/communications/api/privacy-owner-coverage';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { DateTime, Effect, Option, Schema } from 'effect';

import { OwnerInventoryRequestSchema } from '../../shared/apis/owner-inventory.ts';
import type { OwnerInventoryRequest } from '../../shared/apis/owner-inventory.ts';
import { PersonalDataCoverageSchema } from '../../shared/domain/processing-coverage.ts';
import type { OwnerInventoryActivity, OwnerInventoryCapabilities } from '../../src/api/owner-inventory.read.ts';

/** TEST-ONLY wiring of the owner inventory with a labelled Processing Activity. Every value is FICTIONAL. */

export const legalEntityId = '00000000-0000-4000-8000-000000000002';
export const fixtureTenantId = '00000000-0000-4000-8000-000000000001';

const decodeCoverage = Schema.decodeUnknownSync(PersonalDataCoverageSchema);
const decodeRequest = Schema.decodeUnknownSync(OwnerInventoryRequestSchema);

export const activityRefOf = (tenantId: string) => ({
  moduleId: 'privacy.core',
  resourceId: 'activity-1',
  resourceType: 'privacy.core.processing-activity',
  tenantId,
});

export const coverageEntry = (tenantId: string, moduleId: string, recordContentScope: string) =>
  decodeCoverage({
    dataCategoryRef: {
      moduleId: 'privacy.core',
      resourceId: `category-${recordContentScope}`,
      resourceType: 'privacy.core.data-category',
      tenantId,
    },
    ownerCapability: moduleId,
    ownerModuleId: moduleId,
    recordContentScope,
    systemOfRecordRef: {
      moduleId,
      resourceId: `record-${recordContentScope}`,
      resourceType: `${moduleId}.record`,
      tenantId,
    },
  });

export const activityWith = (
  tenantId: string,
  coverage: readonly ReturnType<typeof coverageEntry>[],
): OwnerInventoryActivity => ({ activityRef: activityRefOf(tenantId), dataCoverage: coverage });

/** The request for ONE confirmed subject, as a caller sends it. */
export const lookupRequestOf = (tenantId: string, subjectId: string): OwnerInventoryRequest =>
  decodeRequest({
    activityRef: activityRefOf(tenantId),
    ownerLookup: {
      controllerRef: 'FICTIONAL-controller',
      requestedScopeRef: 'FICTIONAL-requested-scope',
      subjectRef: 'FICTIONAL-subject-1',
      trustedLookups: [
        {
          _tag: 'SUBJECT_REFERENCE',
          lookupRef: `lookup-${subjectId}`,
          moduleId: 'fixture.party',
          resourceId: subjectId,
          resourceType: 'fixture.recipient',
        },
      ],
    },
  });

export const plainRequestOf = (tenantId: string): OwnerInventoryRequest =>
  decodeRequest({ activityRef: activityRefOf(tenantId) });

const transactionFacts = { operationAt: DateTime.makeUnsafe('2026-11-19T10:00:00.000Z'), sequence: 1 } as const;

/** The context the Read needs: a labelled activity, the governed call answered by `answer`, and the trusted scope. */
export const capabilitiesOf = (
  activity: OwnerInventoryActivity | undefined,
  scopeTenantId: string,
  answer: (request: PrivacyOwnerCoverageRequest) => Effect.Effect<CallOutcome<PrivacyOwnerCoverageResponse>>,
) => {
  const asked: PrivacyOwnerCoverageRequest[] = [];
  return {
    asked,
    capabilities: {
      call: (_name: 'communicationsCoverage', request: PrivacyOwnerCoverageRequest) =>
        Effect.suspend(() => {
          asked.push(request);
          return answer(request);
        }),
      scope: { legalEntityId, tenantId: scopeTenantId },
      transaction: (body) =>
        body(
          { get: () => Effect.succeed(activity === undefined ? Option.none() : Option.some(activity)) },
          transactionFacts,
        ),
    } satisfies OwnerInventoryCapabilities,
  };
};
