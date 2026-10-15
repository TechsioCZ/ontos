import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import type { PrivacyMeasureHandoff } from '@app/privacy/domain/privacy-measure-handoff';
import { Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

export interface OwnerResourceRef {
  readonly legalEntityId: string;
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export const parseOwnerResourceRef = (value: string): OwnerResourceRef | undefined => {
  const [moduleId, resourceType, legalEntityId, resourceId, overflow] = value.split('|');
  return overflow === undefined &&
    moduleId !== undefined &&
    moduleId.length > 0 &&
    resourceType !== undefined &&
    resourceType.length > 0 &&
    legalEntityId !== undefined &&
    legalEntityId.length > 0 &&
    resourceId !== undefined &&
    resourceId.length > 0
    ? { legalEntityId, moduleId, resourceId, resourceType }
    : undefined;
};

const encodeHandoff = Schema.encodeResult(Schema.fromJsonString(PrivacyMeasureHandoffSchema));

export const fingerprintPrivacyMeasureHandoff = (handoff: PrivacyMeasureHandoff): string =>
  Hex.encode(
    sha256(
      utf8ToBytes(
        Result.getOrThrow(
          encodeHandoff({
            ...handoff,
            contentScopeRefs: handoff.contentScopeRefs.toSorted(),
            expectedEvidenceRefs: handoff.expectedEvidenceRefs.toSorted(),
            preconditionRefs: handoff.preconditionRefs.toSorted(),
            resourceRefs: handoff.resourceRefs.toSorted(),
          }),
        ),
      ),
    ),
  );
