import { privacyOwnerCoverageOperation } from '@app/communications/api/privacy-owner-coverage';
import type {
  PrivacyOwnerCoverageRequest,
  PrivacyOwnerCoverageResponse,
} from '@app/communications/api/privacy-owner-coverage';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { Effect, Match, Schema } from 'effect';

/**
 * TEST-ONLY, Privacy's OWN labelled double of the Communications owner. It answers from the PUBLISHED Owner Coverage Read
 * contract alone (its request and response schemas), with a small in-memory store of references per subject. It imports no
 * fixture, test support or table of the Communications vertical, so another deployment can never depend on that vertical's
 * test code. It proves how Privacy reads an answer of this shape, never that Communications answers so: the real owner over
 * native PostgreSQL is proven in the Communications suite. Every value is FICTIONAL.
 */

const decodeResponse = Schema.decodeUnknownSync(privacyOwnerCoverageOperation.response);
const OWNER = 'communications.core';
const OBSERVED_AT = '2026-11-19T10:00:00.000Z';
const BACKUP_PART = 'communications.provider-copy-working-copy-protection';

export interface CommunicationsOwnerDoubleOptions {
  /** True only when a backup evaluation is available: without it the provider-copy part cannot be completed (AC-08). */
  readonly backupEvaluated: boolean;
  /** Content references the owner holds per subject resource id, all attached to the request scope part. */
  readonly refsBySubject: Readonly<Record<string, readonly string[]>>;
  /** The only tenant the owner knows. A scope of any other tenant is not found. */
  readonly tenantId: string;
}

const subjectIdOf = (request: PrivacyOwnerCoverageRequest): string =>
  request.trustedLookups.flatMap((lookup) =>
    Match.value(lookup).pipe(
      Match.tag('SUBJECT_REFERENCE', ({ resourceId }) => [resourceId]),
      Match.orElse(() => []),
    ),
  )[0] ?? '';

const contentStatusOf = (found: boolean, complete: boolean): 'FOUND' | 'NO_DATA' | 'UNKNOWN' => {
  if (found) {
    return 'FOUND';
  }
  return complete ? 'NO_DATA' : 'UNKNOWN';
};

export const communicationsOwnerDouble =
  (options: CommunicationsOwnerDoubleOptions) =>
  (request: PrivacyOwnerCoverageRequest): Effect.Effect<CallOutcome<PrivacyOwnerCoverageResponse>> => {
    if (String(request.scope.tenantId) !== options.tenantId) {
      return Effect.succeed({ _tag: 'NotFound', reason: 'not found' });
    }
    const refs = options.refsBySubject[subjectIdOf(request)] ?? [];
    const [firstPart] = request.scope.requestedScopePartRefs;
    const parts = request.scope.requestedScopePartRefs.map((scopeRef) => {
      const base = {
        evidenceRefs: [`FICTIONAL-owner-evidence/${scopeRef}`],
        foundContentRefs: scopeRef === firstPart ? [...refs] : [],
        observedAt: OBSERVED_AT,
        scopeRef,
      };
      return scopeRef === BACKUP_PART && !options.backupEvaluated
        ? { ...base, coverageStatus: 'PARTIAL', unresolvedReason: 'BACKUP_AND_RECOVERY_COPIES_NOT_OBSERVABLE_BY_OWNER' }
        : { ...base, coverageStatus: 'COMPLETE' };
    });
    const complete = parts.every(({ coverageStatus }) => coverageStatus === 'COMPLETE');
    const found = refs.length > 0;
    return Effect.succeed({
      _tag: 'Ok',
      value: decodeResponse({
        configuration: [],
        contribution: null,
        coverage: {
          assessedAt: OBSERVED_AT,
          contentStatus: contentStatusOf(found, complete),
          coverageParts: parts,
          coverageStatus: complete ? 'COMPLETE' : 'PARTIAL',
          evidenceRefs: ['FICTIONAL-owner-evidence'],
          scope: { ...request.scope, tenantId: String(request.scope.tenantId) },
        },
        externalCopies: [],
        ownerCapability: OWNER,
        ownerMutationBoundary: 'NO_AUTOMATIC_OR_DESTRUCTIVE_OWNER_OPERATION',
      }),
    });
  };

export const ownerUnavailable: CallOutcome<PrivacyOwnerCoverageResponse> = {
  _tag: 'Unavailable',
  reason: 'owner unavailable',
  retryable: true,
};
