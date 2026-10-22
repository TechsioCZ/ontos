import { Context, Effect, Layer, Schema } from 'effect';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';

import {
  CoreSearchProjectionInvalid,
  CoreSearchProjectionMutationSchema,
  CoreSearchProjectionStore,
  validateCoreSearchProjectionWorkerContext,
} from './projection.ts';
import type { CoreSearchProjectionStoreService } from './projection.ts';
import { CoreSearchIngestionRegistry, isCoreSearchIngestionRegistered } from './ingestion-registry.ts';
import type { CoreSearchIngestionRegistration } from './ingestion-registry.ts';

const tenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId'));
const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const moduleKeySchema = nonEmpty.pipe(Schema.brand('ModuleId'));
const workerKeySchema = nonEmpty.pipe(Schema.brand('SearchWorkerKey'));
type UnparsedCoreSearchIngestionObservation = typeof Schema.Unknown.Type;
type CoreSearchProjectionMutationSink = Pick<CoreSearchProjectionStoreService, 'apply'>;

const versionSchema = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));

export const CoreSearchIngestionObservationSchema = Schema.Struct({
  consumerModuleKey: moduleKeySchema,
  mutation: CoreSearchProjectionMutationSchema,
  producerModuleKey: moduleKeySchema,
  projectionVersion: versionSchema,
  tenantId: tenantIdSchema,
  topic: nonEmpty,
  workerKey: workerKeySchema,
});
export type CoreSearchIngestionObservation = typeof CoreSearchIngestionObservationSchema.Type;

const invalid = (reason: string, cause?: unknown): CoreSearchProjectionInvalid => {
  if (cause === undefined) {
    return new CoreSearchProjectionInvalid({
      code: 'core_search_projection_invalid',
      reason,
    });
  }
  return new CoreSearchProjectionInvalid({
    cause,
    code: 'core_search_projection_invalid',
    reason,
  });
};

export interface CoreSearchIngestionService {
  readonly ingest: (
    input: UnparsedCoreSearchIngestionObservation,
    context: OutboxWorkerHandlerContext,
  ) => ReturnType<CoreSearchProjectionStoreService['apply']>;
}

/** Core-owned consumer seam for post-commit observations a producing module registered for search. */
export class CoreSearchIngestion extends Context.Service<CoreSearchIngestion, CoreSearchIngestionService>()(
  '@app/core-runtime/search/ingestion/CoreSearchIngestion',
) {}

export const makeCoreSearchIngestion = (
  store: CoreSearchProjectionMutationSink,
  registrations: readonly CoreSearchIngestionRegistration[],
): CoreSearchIngestionService => ({
  ingest: Effect.fn('makeCoreSearchIngestion.ingest')(function* ingestVerifiedObservation(
    input: UnparsedCoreSearchIngestionObservation,
    context: OutboxWorkerHandlerContext,
  ) {
    const observation = yield* Schema.decodeUnknownEffect(CoreSearchIngestionObservationSchema)(input).pipe(
      Effect.mapError((cause) => invalid('Core Search ingestion observation is invalid', cause)),
    );
    yield* validateCoreSearchProjectionWorkerContext(context, {
      moduleId: observation.producerModuleKey,
      tenantId: observation.tenantId,
    });
    const registered = isCoreSearchIngestionRegistered(registrations, observation);
    const mutationTenantId =
      observation.mutation.kind === 'upsert'
        ? observation.mutation.document.ref.tenantId
        : observation.mutation.ref.tenantId;
    const mutationModuleId =
      observation.mutation.kind === 'upsert'
        ? observation.mutation.document.ref.moduleId
        : observation.mutation.ref.moduleId;
    const mutationVersion =
      observation.mutation.kind === 'upsert'
        ? observation.mutation.document.projectionVersion
        : observation.mutation.projectionVersion;
    if (
      !registered ||
      mutationTenantId !== observation.tenantId ||
      mutationModuleId !== observation.producerModuleKey ||
      mutationVersion !== observation.projectionVersion ||
      context.consumerModuleKey !== observation.consumerModuleKey ||
      context.topic !== observation.topic ||
      context.workerKey !== observation.workerKey
    ) {
      return yield* invalid('Core Search ingestion identity does not match its post-commit observation');
    }
    return yield* store.apply(observation.mutation, context);
  }),
});

export const CoreSearchIngestionLive = Layer.effect(
  CoreSearchIngestion,
  Effect.gen(function* makeCoreSearchIngestionLive() {
    const store = yield* CoreSearchProjectionStore;
    const registrations = yield* CoreSearchIngestionRegistry;
    return makeCoreSearchIngestion(store, registrations);
  }),
);
