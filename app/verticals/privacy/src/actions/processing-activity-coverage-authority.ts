import { Context, Effect, Layer } from 'effect';

import type { ProcessingActivityAuthoritativeCoverage } from '../../shared/domain/processing-coverage.ts';
import type { ProcessingActivityRef } from '../../shared/resources/processing-activity.ts';
import { ProcessingActivityRegistryError } from '../domain/processing-activity-registry.ts';

interface ProcessingActivityCoverageAuthorityContext {
  readonly actionInvocationId: string;
  readonly activityRef: ProcessingActivityRef;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/**
 * Private inventory/ownership boundary for Processing Activity activation.
 * The public transition payload contains no coverage or system references.
 */
export interface ProcessingActivityCoverageAuthorityService {
  readonly resolve: (
    context: ProcessingActivityCoverageAuthorityContext,
  ) => Effect.Effect<ProcessingActivityAuthoritativeCoverage, ProcessingActivityRegistryError>;
}

export class ProcessingActivityCoverageAuthority extends Context.Service<
  ProcessingActivityCoverageAuthority,
  ProcessingActivityCoverageAuthorityService
>()('@app/privacy/actions/processing-activity-coverage-authority/ProcessingActivityCoverageAuthority') {}

export const processingActivityCoverageAuthorityUnavailable = Object.freeze({
  resolve: () =>
    Effect.fail(
      new ProcessingActivityRegistryError({
        code: 'privacy_processing_activity_persistence_unavailable',
        reason: 'Processing Activity owner coverage authority is not configured',
      }),
    ),
}) satisfies ProcessingActivityCoverageAuthorityService;

export const ProcessingActivityCoverageAuthorityUnavailableLive = Layer.succeed(
  ProcessingActivityCoverageAuthority,
  processingActivityCoverageAuthorityUnavailable,
);
