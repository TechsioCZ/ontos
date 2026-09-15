import type { Effect, Option } from 'effect';

import type {
  CreateProcessingPurposeInput,
  CreatePurposeVersionInput,
  ProcessingPurpose,
  PurposeNotFound,
  PurposeVersionConflict,
} from '../../shared/domain/processing-purpose.ts';
import type { ProcessingPurposePersistenceUnavailableError } from './processing-purpose-persistence-unavailable.ts';

export { ProcessingPurposePersistenceUnavailable } from './processing-purpose-persistence-unavailable.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Action and governed-read factories inject this owner-local repository through their scoped service factories; it has no global Context lifetime. expires: 2027-03-31.
export interface ProcessingPurposeRepositoryService {
  readonly addVersion: (
    tenantId: string,
    legalEntityId: string,
    purposeId: string,
    actionInvocationId: string,
    input: CreatePurposeVersionInput,
  ) => Effect.Effect<
    ProcessingPurpose,
    ProcessingPurposePersistenceUnavailableError | PurposeNotFound | PurposeVersionConflict
  >;
  readonly create: (
    tenantId: string,
    legalEntityId: string,
    actionInvocationId: string,
    input: CreateProcessingPurposeInput,
  ) => Effect.Effect<ProcessingPurpose, ProcessingPurposePersistenceUnavailableError>;
  readonly get: (
    tenantId: string,
    legalEntityId: string,
    purposeId: string,
  ) => Effect.Effect<Option.Option<ProcessingPurpose>, ProcessingPurposePersistenceUnavailableError>;
  readonly list: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly ProcessingPurpose[], ProcessingPurposePersistenceUnavailableError>;
}
