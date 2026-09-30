import { Context, DateTime, Effect, Layer, Schema } from 'effect';

import { encodedActiveApplicationCompositionSnapshot } from '#active-application-composition-source';

import { ApplicationCompositionSchema } from './application-composition.ts';
import { ActiveApplicationCompositionUnavailableError } from './active-application-composition-errors.ts';

/**
 * One bounded observation of the deployment-owned active revision. The publisher owns promotion;
 * consumers only read the immutable revision and must stop trusting the observation at validUntil.
 */
export const ActiveApplicationCompositionSnapshotSchema = Schema.Struct({
  composition: ApplicationCompositionSchema,
  observedAt: Schema.DateTimeUtcFromString,
  validUntil: Schema.DateTimeUtcFromString,
}).check(
  Schema.makeFilter(({ observedAt, validUntil }) =>
    DateTime.toEpochMillis(validUntil) > DateTime.toEpochMillis(observedAt)
      ? undefined
      : 'active Application Composition validity must end after it was observed',
  ),
);
export type ActiveApplicationCompositionSnapshot = typeof ActiveApplicationCompositionSnapshotSchema.Type;

export interface ActiveApplicationCompositionServiceContract {
  readonly load: Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>;
}

export class ActiveApplicationCompositionService extends Context.Service<
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionServiceContract
>()('@app/core-runtime/modules/active-application-composition/ActiveApplicationCompositionService') {}

export const makeActiveApplicationCompositionLayer = (
  load: ActiveApplicationCompositionServiceContract['load'],
): Layer.Layer<ActiveApplicationCompositionService> =>
  Layer.succeed(ActiveApplicationCompositionService, Object.freeze({ load }));

const activeApplicationCompositionSnapshotJsonSchema = Schema.fromJsonString(
  ActiveApplicationCompositionSnapshotSchema,
);

const unavailableActiveApplicationComposition = (cause: unknown): ActiveApplicationCompositionUnavailableError =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The active Application Composition snapshot is unavailable or invalid',
  });

const configuredActiveApplicationCompositionSnapshot = encodedActiveApplicationCompositionSnapshot.pipe(
  Effect.flatMap((encoded) =>
    Schema.decodeEffect(activeApplicationCompositionSnapshotJsonSchema, {
      onExcessProperty: 'error',
    })(encoded),
  ),
  Effect.mapError(unavailableActiveApplicationComposition),
);

/**
 * Server runtime adapter. Deployment automation publishes the immutable active snapshot as one atomic
 * value: the Zerops project variable on Node, the Workers KV entry on a placed Worker
 * (`#active-application-composition-source`). Missing, malformed, or expired evidence fails closed in
 * consumers instead of falling back to topology or a last-known-good revision.
 */
export const ActiveApplicationCompositionConfigLive = makeActiveApplicationCompositionLayer(
  configuredActiveApplicationCompositionSnapshot,
);
