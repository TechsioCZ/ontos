import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { PrincipalRef } from '@app/core-runtime';
import type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
  ProcessingActivityRegistryError,
} from '../domain/processing-activity-registry.ts';
import type { ProcessingActivityAuthoritativeCoverage } from '../../shared/domain/processing-coverage.ts';

export interface ProcessingActivityRepositoryService {
  readonly create: (
    tenantId: string,
    legalEntityId: string,
    actor: PrincipalRef,
    actionInvocationId: string,
    input: CreateProcessingActivityInput,
  ) => Effect.Effect<ProcessingActivity, ProcessingActivityRegistryError>;
  readonly get: (
    tenantId: string,
    legalEntityId: string,
    resourceId: string,
  ) => Effect.Effect<Option.Option<ProcessingActivity>, ProcessingActivityRegistryError>;
  readonly list: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly ProcessingActivity[], ProcessingActivityRegistryError>;
  readonly transition: (
    tenantId: string,
    legalEntityId: string,
    resourceId: string,
    actor: PrincipalRef,
    actionInvocationId: string,
    to: ProcessingActivityLifecycle,
    decisionEvidenceRefs: readonly string[],
    effectiveAt: string,
    authoritativeCoverage?: ProcessingActivityAuthoritativeCoverage,
  ) => Effect.Effect<ProcessingActivity, ProcessingActivityRegistryError>;
}

/** Owner-local service contract; scope is supplied by its transaction factory. */
export class ProcessingActivityRepository extends Context.Service<
  ProcessingActivityRepository,
  ProcessingActivityRepositoryService
>()('@app/privacy/persistence/processing-activity-repository/ProcessingActivityRepository') {}
