import { randomUUID } from 'node:crypto';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  CreatePurposeVersionInput,
  ProcessingPurpose,
  PurposeVersion,
} from '../../shared/domain/processing-purpose.ts';
import {
  CreatePurposeVersionInputSchema,
  PurposeNotFound,
  PurposeVersionConflict,
} from '../../shared/domain/processing-purpose.ts';
import type { ProcessingPurposeRef } from '../../shared/resources/processing-purpose.ts';
import type { ProcessingPurposeRepositoryService } from '../persistence/processing-purpose-repository.ts';
import { deriveMaterialVersionEvidence } from './processing-purpose-materiality.ts';

const ref = (tenantId: string, purposeId: string): ProcessingPurposeRef => ({
  moduleId: 'privacy.core',
  resourceId: purposeId,
  resourceType: 'privacy.core.processing-purpose',
  tenantId,
});
const processingPurposeScopedKey = (tenantId: string, legalEntityId: string, purposeId: string): string =>
  `${tenantId}:${legalEntityId}:${purposeId}`;

const versionInputEquivalent = Schema.toEquivalence(CreatePurposeVersionInputSchema);

const replayVersionMatches = (
  replay: Readonly<{ input: CreatePurposeVersionInput; purposeId: string }>,
  purposeId: string,
  input: CreatePurposeVersionInput,
): boolean => replay.purposeId === purposeId && versionInputEquivalent(replay.input, input);

const validateVersionAppend = (
  materiality: ReturnType<typeof deriveMaterialVersionEvidence>,
  input: CreatePurposeVersionInput,
  previous: PurposeVersion | undefined,
):
  | {
      readonly materiality: Exclude<
        ReturnType<typeof deriveMaterialVersionEvidence>,
        { readonly conflictReason: string }
      >;
      readonly valid: true;
    }
  | { readonly reason: string; readonly valid: false } => {
  if ('conflictReason' in materiality) {
    return { reason: materiality.conflictReason, valid: false };
  }
  return previous !== undefined && input.effectiveFrom <= previous.effectiveFrom
    ? { reason: 'Purpose Version effective time must follow the latest retained version', valid: false }
    : { materiality, valid: true };
};

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
          if (!replayVersionMatches(replay, purposeId, input)) {
            return yield* new PurposeVersionConflict({
              code: 'privacy_purpose_version_conflict',
              reason: 'Purpose Version Action invocation was replayed with different input',
            });
          }
          return current;
        }
        const versionId = randomUUID();
        const materiality = deriveMaterialVersionEvidence(current, input, versionId);
        const previous = current.versions.at(-1);
        const validation = validateVersionAppend(materiality, input, previous);
        if (!validation.valid) {
          return yield* new PurposeVersionConflict({
            code: 'privacy_purpose_version_conflict',
            reason: validation.reason,
          });
        }
        const recordedAt = DateTime.formatIso(yield* DateTime.now);
        const version: PurposeVersion = {
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          materialChangeAssessment: validation.materiality,
          materialScope: input.materialScope,
          meaning: input.meaning,
          recordedAt,
          requiredConsentDimensions: [...(input.requiredConsentDimensions ?? [])],
          versionId,
          versionNumber: (previous?.versionNumber ?? 0) + 1,
        };
        const updated: ProcessingPurpose = {
          ...current,
          versions: [
            ...current.versions.slice(0, -1),
            ...(previous === undefined ? [] : [{ ...previous, effectiveTo: input.effectiveFrom }]),
            version,
          ],
        };
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
              materialChangeAssessment: null,
              materialScope: input.materialScope ?? null,
              meaning: input.meaning,
              recordedAt: createdAt,
              requiredConsentDimensions: [...(input.requiredConsentDimensions ?? [])],
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
