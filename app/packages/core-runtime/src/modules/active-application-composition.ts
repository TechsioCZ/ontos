import { Clock, Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import {
  ApplicationCompositionSchema,
  freezeApplicationCompositionArtifact,
  ONTOS_APPLICATION_COMPOSITION_MAX_BYTES,
} from './application-composition.ts';
import { buildApplicationCompositionCatalog } from './application-composition-catalog.ts';
import { ActiveApplicationCompositionUnavailableError } from './active-application-composition-errors.ts';
import { ActiveApplicationCompositionSource } from './active-application-composition-source-service.ts';

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

/** Every injected/runtime source is checked at the operation edge; expiry never selects an old revision. */
export const validateActiveApplicationCompositionSnapshot = Effect.fn('ActiveApplicationComposition.validateSnapshot')(
  function* validateSnapshot(snapshot: ActiveApplicationCompositionSnapshot) {
    const decoded = yield* Schema.decodeEffect(Schema.toType(ActiveApplicationCompositionSnapshotSchema), {
      onExcessProperty: 'error',
    })(snapshot).pipe(Effect.mapError(unavailableActiveApplicationComposition));
    const observedAt = DateTime.make(DateTime.toEpochMillis(decoded.observedAt));
    const validUntil = DateTime.make(DateTime.toEpochMillis(decoded.validUntil));
    if (Option.isNone(observedAt) || Option.isNone(validUntil)) {
      return yield* unavailableActiveApplicationComposition('Application Composition authority dates are invalid');
    }
    // Utc values have one lazy parts cache. Hydrate it before freezing a private copy so native
    // DateTime operations remain usable and caller-owned values cannot extend a validated lease.
    Object.freeze(DateTime.toPartsUtc(observedAt.value));
    Object.freeze(DateTime.toPartsUtc(validUntil.value));
    const observed = Object.freeze(observedAt.value);
    const expires = Object.freeze(validUntil.value);
    const now = yield* Clock.currentTimeMillis;
    if (DateTime.toEpochMillis(observed) > now || DateTime.toEpochMillis(expires) <= now) {
      return yield* unavailableActiveApplicationComposition(
        'Application Composition authority is expired or not yet valid',
      );
    }
    yield* buildApplicationCompositionCatalog(decoded.composition).pipe(
      Effect.mapError(unavailableActiveApplicationComposition),
    );
    if (DateTime.toEpochMillis(expires) <= (yield* Clock.currentTimeMillis)) {
      return yield* unavailableActiveApplicationComposition(
        'Application Composition authority expired during validation',
      );
    }
    return Object.freeze({
      ...decoded,
      composition: freezeApplicationCompositionArtifact(decoded.composition),
      observedAt: observed,
      validUntil: expires,
    });
  },
);

const configuredActiveApplicationCompositionSnapshot = (encoded: string) => {
  if (
    encoded.length > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES ||
    new TextEncoder().encode(encoded).byteLength > ONTOS_APPLICATION_COMPOSITION_MAX_BYTES
  ) {
    return Effect.fail(
      unavailableActiveApplicationComposition('Application Composition snapshot exceeds its byte budget'),
    );
  }
  return Schema.decodeEffect(activeApplicationCompositionSnapshotJsonSchema, {
    onExcessProperty: 'error',
  })(encoded).pipe(
    Effect.mapError(unavailableActiveApplicationComposition),
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
  );
};

/**
 * Server runtime adapter. Deployment automation publishes the immutable active snapshot as one atomic
 * value: the trusted authority URL on Node, the Workers KV entry on a placed Worker
 * (`@app/core-runtime/modules/active-application-composition-source`). Missing, malformed, or expired evidence fails closed in
 * consumers instead of falling back to topology or a last-known-good revision.
 */
export const ActiveApplicationCompositionConfigLive = Layer.effect(ActiveApplicationCompositionService)(
  Effect.gen(function* activeCompositionLayer() {
    const source = yield* ActiveApplicationCompositionSource;
    return Object.freeze({
      load: source.load.pipe(
        Effect.mapError(unavailableActiveApplicationComposition),
        Effect.flatMap(configuredActiveApplicationCompositionSnapshot),
      ),
    });
  }),
);
