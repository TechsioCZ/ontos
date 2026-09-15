import type { Effect, Option } from 'effect';

import type { PrincipalRef } from '@app/core-runtime';
import type {
  CreateProcessingActivityInput,
  ProcessingActivity,
  ProcessingActivityLifecycle,
  ProcessingActivityRegistryError,
} from '../domain/processing-activity-registry.ts';
import type { ProcessingActivityAuthoritativeCoverage } from '../../shared/domain/processing-coverage.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Action factories inject this owner-local repository through their scoped service factories; it has no global Context lifetime. expires: 2027-03-31.
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
