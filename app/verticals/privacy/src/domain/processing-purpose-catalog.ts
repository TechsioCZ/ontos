import { randomUUID } from 'node:crypto';
import { DateTime, Effect, Option } from 'effect';

import type {
  CreatePurposeVersionInput,
  ProcessingPurpose,
  PurposeVersion,
} from '../../shared/domain/processing-purpose.ts';
import { PurposeNotFound, PurposeVersionConflict } from '../../shared/domain/processing-purpose.ts';
import type { ProcessingPurposeRef } from '../../shared/resources/processing-purpose.ts';
import type { ProcessingPurposeRepositoryService } from '../persistence/processing-purpose-repository.ts';

const ref = (tenantId: string, purposeId: string): ProcessingPurposeRef => ({
  moduleId: 'privacy.core',
  resourceId: purposeId,
  resourceType: 'privacy.core.processing-purpose',
  tenantId,
});
const processingPurposeScopedKey = (tenantId: string, legalEntityId: string, purposeId: string): string =>
  `${tenantId}:${legalEntityId}:${purposeId}`;

export const makeInMemoryProcessingPurposeRepository = (): ProcessingPurposeRepositoryService => {
  const purposes = new Map<string, ProcessingPurpose>();
  const versionInvocations = new Map<string, Readonly<{ input: CreatePurposeVersionInput; purposeId: string }>>();
  return {
    addVersion: Effect.fn('makeInMemoryProcessingPurposeRepository.addVersion')(
      function* addVersion(tenantId, legalEntityId, purposeId, _actionInvocationId, input) {
        const key = processingPurposeScopedKey(tenantId, legalEntityId, purposeId);
        const current = purposes.get(key);
        if (current === undefined) {
          return yield* new PurposeNotFound({
            code: 'privacy_purpose_not_found',
            reason: 'Processing Purpose was not found',
          });
        }
        const invocationKey = processingPurposeScopedKey(tenantId, legalEntityId, _actionInvocationId);
        const replay = versionInvocations.get(invocationKey);
        if (replay !== undefined) {
          if (
            replay.purposeId !== purposeId ||
            replay.input.effectiveFrom !== input.effectiveFrom ||
            replay.input.meaning !== input.meaning
          ) {
            return yield* new PurposeVersionConflict({
              code: 'privacy_purpose_version_conflict',
              reason: 'Purpose Version Action invocation was replayed with different input',
            });
          }
          return current;
        }
        const recordedAt = DateTime.formatIso(yield* DateTime.now);
        const previous = current.versions.at(-1);
        if (previous !== undefined && input.effectiveFrom <= previous.effectiveFrom) {
          return yield* new PurposeVersionConflict({
            code: 'privacy_purpose_version_conflict',
            reason: 'Purpose Version effective time must follow the latest retained version',
          });
        }
        const version: PurposeVersion = {
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          meaning: input.meaning,
          recordedAt,
          versionId: randomUUID(),
          versionNumber: (previous?.versionNumber ?? 0) + 1,
        };
        const updated: ProcessingPurpose = { ...current, versions: [...current.versions, version] };
        purposes.set(key, updated);
        versionInvocations.set(invocationKey, { input, purposeId });
        return updated;
      },
    ),
    create: Effect.fn('makeInMemoryProcessingPurposeRepository.create')(
      function* create(tenantId, legalEntityId, _actionInvocationId, input) {
        const purposeId = randomUUID();
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const purpose: ProcessingPurpose = {
          businessCode: input.businessCode,
          createdAt,
          governanceOwnerId: input.governanceOwnerId,
          legalEntityId,
          lifecycle: 'ACTIVE',
          purposeRef: ref(tenantId, purposeId),
          retiredAt: null,
          versions: [
            {
              effectiveFrom: input.effectiveFrom,
              effectiveTo: null,
              meaning: input.meaning,
              recordedAt: createdAt,
              versionId: randomUUID(),
              versionNumber: 1,
            },
          ],
        };
        purposes.set(processingPurposeScopedKey(tenantId, legalEntityId, purposeId), purpose);
        return purpose;
      },
    ),
    get: (tenantId, legalEntityId, purposeId) =>
      Effect.sync(() =>
        Option.fromNullishOr(purposes.get(processingPurposeScopedKey(tenantId, legalEntityId, purposeId))),
      ),
    list: (tenantId, legalEntityId) =>
      Effect.sync(() =>
        [...purposes.values()].filter(
          (purpose) => purpose.purposeRef.tenantId === tenantId && purpose.legalEntityId === legalEntityId,
        ),
      ),
  };
};
