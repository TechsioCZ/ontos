import { Context } from 'effect';
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

/** Owner-local service contract; scope is supplied by its transaction factory. */
export class ProcessingPurposeRepository extends Context.Service<
  ProcessingPurposeRepository,
  ProcessingPurposeRepositoryService
>()('@app/privacy/persistence/processing-purpose-repository/ProcessingPurposeRepository') {}
