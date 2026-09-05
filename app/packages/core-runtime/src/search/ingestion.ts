/* oxlint-disable sonarjs/no-duplicate-string */
/* eslint-disable anti-slop/no-unknown-parameters -- Public gateway input is decoded immediately by CoreSearchIngestionObservationSchema. */
import { Context, Effect, Layer, Schema } from 'effect';
import {
  CoreSearchProjectionInvalid,
  CoreSearchProjectionMutationSchema,
  CoreSearchProjectionStore,
} from './projection.ts';
import type { CoreSearchProjectionStoreService } from './projection.ts';

export const CORE_SEARCH_PARTY_LIFECYCLE_TOPICS = [
  'party.registry.party-created.v1',
  'party.registry.party-updated.v1',
  'party.registry.party-archived.v1',
  'party.registry.party-unarchived.v1',
  'party.registry.party-fact-corrected.v1',
  'party.registry.official-identifier-added.v1',
  'party.registry.official-identifier-updated.v1',
  'party.registry.official-identifier-ended.v1',
  'party.registry.contact-point-added.v1',
  'party.registry.contact-point-updated.v1',
  'party.registry.contact-point-ended.v1',
  'party.registry.counterparty-created.v1',
  'party.registry.counterparty-role-added.v1',
  'party.registry.counterparty-role-ended.v1',
  'party.registry.search-rebuild-requested.v1',
] as const;
export type CoreSearchPartyLifecycleTopic = (typeof CORE_SEARCH_PARTY_LIFECYCLE_TOPICS)[number];

export const CORE_SEARCH_PARTY_PROJECTOR_WORKER_KEYS = [
  'party.registry.project-party-created-to-search',
  'party.registry.project-party-updated-to-search',
  'party.registry.project-party-archived-to-search',
  'party.registry.project-party-unarchived-to-search',
  'party.registry.project-party-fact-corrected-to-search',
  'party.registry.project-official-identifier-added-to-search',
  'party.registry.project-official-identifier-updated-to-search',
  'party.registry.project-official-identifier-ended-to-search',
  'party.registry.project-contact-point-added-to-search',
  'party.registry.project-contact-point-updated-to-search',
  'party.registry.project-contact-point-ended-to-search',
  'party.registry.project-counterparty-created-to-search',
  'party.registry.project-counterparty-role-added-to-search',
  'party.registry.project-counterparty-role-ended-to-search',
  'party.registry.rebuild-search',
] as const;
export type CoreSearchPartyProjectorWorkerKey =
  (typeof CORE_SEARCH_PARTY_PROJECTOR_WORKER_KEYS)[number];

const topicSchema = Schema.Literals(CORE_SEARCH_PARTY_LIFECYCLE_TOPICS);
const workerKeySchema = Schema.Literals(CORE_SEARCH_PARTY_PROJECTOR_WORKER_KEYS);
const versionSchema = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));

export const CoreSearchIngestionObservationSchema = Schema.Struct({
  consumerModuleKey: Schema.Literal('party.registry'),
  mutation: CoreSearchProjectionMutationSchema,
  producerModuleKey: Schema.Literal('party.registry'),
  projectionVersion: versionSchema,
  tenantId: Schema.String.check(Schema.isUUID()),
  topic: topicSchema,
  workerKey: workerKeySchema,
});
export type CoreSearchIngestionObservation = typeof CoreSearchIngestionObservationSchema.Type;

export interface CoreSearchIngestionRegistration {
  readonly consumerModuleKey: 'party.registry';
  readonly producerModuleKey: 'party.registry';
  readonly topic: CoreSearchPartyLifecycleTopic;
  readonly workerKey: CoreSearchPartyProjectorWorkerKey;
}

export const CORE_SEARCH_INGESTION_REGISTRATIONS: readonly CoreSearchIngestionRegistration[] =
  Object.freeze(
    CORE_SEARCH_PARTY_LIFECYCLE_TOPICS.flatMap((topic, index) => {
      const workerKey = CORE_SEARCH_PARTY_PROJECTOR_WORKER_KEYS[index];
      return workerKey === undefined
        ? []
        : [
            Object.freeze({
              consumerModuleKey: 'party.registry' as const,
              producerModuleKey: 'party.registry' as const,
              topic,
              workerKey,
            }),
          ];
    }),
  );

const invalid = (reason: string) =>
  new CoreSearchProjectionInvalid({ code: 'core_search_projection_invalid', reason });

export interface CoreSearchIngestionService {
  readonly ingest: (input: unknown) => ReturnType<CoreSearchProjectionStoreService['apply']>;
}

/** Core-owned consumer seam for post-commit Party lifecycle observations. */
export class CoreSearchIngestion extends Context.Service<
  CoreSearchIngestion,
  CoreSearchIngestionService
>()('@app/core-runtime/search/ingestion/CoreSearchIngestion') {}

export const makeCoreSearchIngestion = (
  store: CoreSearchProjectionStoreService,
): CoreSearchIngestionService => ({
  ingest: (input) =>
    Schema.decodeUnknownEffect(CoreSearchIngestionObservationSchema)(input).pipe(
      Effect.mapError(() => invalid('Core Search ingestion observation is invalid')),
      Effect.flatMap((observation) => {
        const registered = CORE_SEARCH_INGESTION_REGISTRATIONS.some(
          (registration) =>
            registration.consumerModuleKey === observation.consumerModuleKey &&
            registration.producerModuleKey === observation.producerModuleKey &&
            registration.topic === observation.topic &&
            registration.workerKey === observation.workerKey,
        );
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
          mutationVersion !== observation.projectionVersion
        ) {
          return Effect.fail(
            invalid('Core Search ingestion identity does not match its post-commit observation'),
          );
        }
        return store.apply(observation.mutation);
      }),
    ),
});

export const CoreSearchIngestionLive = Layer.effect(
  CoreSearchIngestion,
  Effect.gen(function* makeCoreSearchIngestionLive() {
    const store = yield* CoreSearchProjectionStore;
    return makeCoreSearchIngestion(store);
  }),
);
