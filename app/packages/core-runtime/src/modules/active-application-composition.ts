import { Clock, DateTime, Effect, Layer, Option, Ref, Schema, Semaphore, pipe } from 'effect';

import {
  ApplicationCompositionSchema,
  freezeApplicationCompositionArtifact,
  ONTOS_APPLICATION_COMPOSITION_MAX_BYTES,
} from './application-composition.ts';
import {
  buildApplicationCompositionCatalog,
  validatedApplicationCompositionCatalog,
} from './application-composition-catalog.ts';
import { ActiveApplicationCompositionUnavailableError } from './active-application-composition-errors.ts';
import { InstalledModuleCatalogService } from './catalog.ts';
import type { InstalledModuleCatalog, InstalledModuleCatalogServiceContract } from './catalog.ts';
import { TenantModuleStateValidationUnavailableError } from './tenant-module-state-errors.ts';
import { ActiveApplicationCompositionSource } from './active-application-composition-source-service.ts';
import { ActiveApplicationCompositionService } from './active-application-composition-service.ts';
import { ProcessCompositionValidation } from './process-composition-validation.ts';
import type { ProcessCompositionValidationRegistry } from './process-composition-validation.ts';

export { ActiveApplicationCompositionService } from './active-application-composition-service.ts';

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

/** A snapshot that passed the complete check, with the installed catalog that check built from it. */
export interface CheckedActiveApplicationComposition {
  readonly catalog: InstalledModuleCatalog;
  readonly snapshot: ActiveApplicationCompositionSnapshot;
}

/** A read of the active snapshot, before or after the complete check, depending on who provides it. */
export type ActiveApplicationCompositionLoad = Effect.Effect<
  ActiveApplicationCompositionSnapshot,
  ActiveApplicationCompositionUnavailableError
>;

type CheckedRead = Effect.Effect<CheckedActiveApplicationComposition, ActiveApplicationCompositionUnavailableError>;

const activeApplicationCompositionSnapshotJsonSchema = Schema.fromJsonString(
  ActiveApplicationCompositionSnapshotSchema,
);
const encodeComposition = Schema.encodeEffect(Schema.fromJsonString(ApplicationCompositionSchema));

const unavailableActiveApplicationComposition = (cause: unknown): ActiveApplicationCompositionUnavailableError =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The active Application Composition snapshot is unavailable or invalid',
  });

/**
 * The lease is live only from its observation until, excluding, its end; checked against the current time. This is
 * the lease check alone: use it only on a snapshot a service of this module already returned, whose content passed the
 * complete check.
 */
export const requireLiveActiveApplicationCompositionLease = Effect.fnUntraced(function* requireLiveLease({
  observedAt,
  validUntil,
}: Pick<ActiveApplicationCompositionSnapshot, 'observedAt' | 'validUntil'>) {
  const now = yield* Clock.currentTimeMillis;
  if (DateTime.toEpochMillis(observedAt) > now || DateTime.toEpochMillis(validUntil) <= now) {
    return yield* unavailableActiveApplicationComposition(
      'Application Composition authority is expired or not yet valid',
    );
  }
  return yield* Effect.void;
});

// Only immutable values minted by this check are reusable, keyed by their identity. Never retain request-owned I/O,
// promises, or failures: a Worker builds a new scoped runtime for each request.
const checkedSnapshots = Ref.makeUnsafe(
  new WeakMap<ActiveApplicationCompositionSnapshot, CheckedActiveApplicationComposition>(),
);
const decodeSnapshot = Schema.decodeEffect(Schema.toType(ActiveApplicationCompositionSnapshotSchema), {
  onExcessProperty: 'error',
});

/**
 * Admits one decoded snapshot: lease, then the complete catalog of the frozen composition. Building the catalog
 * from the frozen value retains it, so every consumer of this composition value reuses the same verified catalog.
 */
const approveDecodedSnapshot = Effect.fn('ActiveApplicationComposition.approveDecodedSnapshot')(function* approve(
  decoded: ActiveApplicationCompositionSnapshot,
) {
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
  yield* requireLiveActiveApplicationCompositionLease({ observedAt: observed, validUntil: expires });
  const composition = freezeApplicationCompositionArtifact(decoded.composition);
  const catalog = yield* buildApplicationCompositionCatalog(composition).pipe(
    Effect.mapError(unavailableActiveApplicationComposition),
  );
  const validatedAt = yield* Clock.currentTimeMillis;
  if (DateTime.toEpochMillis(expires) <= validatedAt) {
    return yield* unavailableActiveApplicationComposition(
      'Application Composition authority expired during validation',
    );
  }
  if (DateTime.toEpochMillis(observed) > validatedAt) {
    return yield* unavailableActiveApplicationComposition(
      'Application Composition authority is not yet valid after validation',
    );
  }
  const checked: CheckedActiveApplicationComposition = Object.freeze({
    catalog,
    snapshot: Object.freeze({ ...decoded, composition, observedAt: observed, validUntil: expires }),
  });
  yield* Ref.update(checkedSnapshots, (snapshots) => snapshots.set(checked.snapshot, checked));
  return checked;
});

const checkSnapshotLocally = Effect.fn('ActiveApplicationComposition.checkSnapshot')(function* checkSnapshot(
  snapshot: ActiveApplicationCompositionSnapshot,
) {
  const minted = (yield* Ref.get(checkedSnapshots)).get(snapshot);
  if (minted !== undefined) {
    yield* requireLiveActiveApplicationCompositionLease(minted.snapshot);
    return minted;
  }
  const decoded = yield* decodeSnapshot(snapshot).pipe(Effect.mapError(unavailableActiveApplicationComposition));
  return yield* approveDecodedSnapshot(decoded);
});

/**
 * Every injected/runtime source is checked in full; expiry never selects an old revision. Only a snapshot this check
 * minted, recognised by identity, skips to the lease check against the current time.
 */
export const checkActiveApplicationCompositionSnapshot = (
  snapshot: ActiveApplicationCompositionSnapshot,
): CheckedRead => globalThis.ontosProcessCompositionValidation?.validate(snapshot) ?? checkSnapshotLocally(snapshot);

export const validateActiveApplicationCompositionSnapshot = (snapshot: ActiveApplicationCompositionSnapshot) =>
  checkActiveApplicationCompositionSnapshot(snapshot).pipe(Effect.map((checked) => checked.snapshot));

interface AcceptedText {
  readonly checked: CheckedActiveApplicationComposition;
  readonly encoded: string;
}

const decodeConfiguredText = (encoded: string) => {
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
  })(encoded).pipe(Effect.mapError(unavailableActiveApplicationComposition));
};

/** The complete check of one configured snapshot text, with nothing kept between calls. */
const checkConfiguredText = (encoded: string): CheckedRead =>
  decodeConfiguredText(encoded).pipe(Effect.flatMap(approveDecodedSnapshot));

interface ProcessAcceptedText extends AcceptedText {
  readonly compositionEncoded: string;
}

/**
 * The process registry's check of one configured snapshot text, bounded to its one last successful text. Exact text,
 * not a claimed revision, identifies the entry, and its reuse still checks the lease against the current time.
 * Publication renews the observation lease without changing the immutable deployment: a new text whose composition
 * encodes to exactly the kept composition reuses that frozen composition value and its catalog, while its own
 * envelope is decoded and its own lease checked. A same-revision edit still passes the complete check.
 */
const checkProcessText = Effect.fn('ActiveApplicationComposition.checkProcessText')(function* checkProcessText(
  kept: Ref.Ref<ProcessAcceptedText | null>,
  encoded: string,
) {
  const cached = yield* Ref.get(kept);
  if (cached?.encoded === encoded) {
    yield* requireLiveActiveApplicationCompositionLease(cached.checked.snapshot);
    return cached.checked;
  }
  const decoded = yield* decodeConfiguredText(encoded);
  const compositionEncoded = yield* encodeComposition(decoded.composition).pipe(
    Effect.mapError(unavailableActiveApplicationComposition),
  );
  const composition =
    cached?.compositionEncoded === compositionEncoded ? cached.checked.snapshot.composition : decoded.composition;
  const checked = yield* approveDecodedSnapshot({ ...decoded, composition });
  yield* Ref.set(kept, { checked, compositionEncoded, encoded });
  return checked;
});

/**
 * Native hosts initialize this before importing owners. The permit coalesces concurrent first checks of the same
 * exact text, including calls from distinct bundles. It never wraps source I/O. Only one successful text and weakly
 * held immutable artifacts survive a call; failures, services and principal decisions do not.
 */
export const ProcessCompositionValidationLive = Layer.effect(
  ProcessCompositionValidation,
  Effect.gen(function* makeProcessValidation() {
    const permit = yield* Semaphore.make(1);
    const kept = yield* Ref.make<ProcessAcceptedText | null>(null);
    return Object.freeze({
      catalog: validatedApplicationCompositionCatalog,
      decode: (encoded: string) => permit.withPermit(checkProcessText(kept, encoded)),
      validate: checkSnapshotLocally,
    } satisfies ProcessCompositionValidationRegistry);
  }),
);

/**
 * The checked read behind `ActiveApplicationCompositionServiceContract.admittingText`, with its one entry. Only a
 * successful check is shared: callers presenting the same invalid text each run their own check, one after another,
 * each bounded by the check's own time budget.
 */
const admitEachTextOnce = Effect.fn('ActiveApplicationComposition.admitEachTextOnce')(function* admitEachTextOnce<
  Service,
>(
  readText: Effect.Effect<string, ActiveApplicationCompositionUnavailableError>,
  serve: (loadChecked: CheckedRead) => Service,
) {
  const accepted = yield* Ref.make(Option.none<AcceptedText>());
  const admission = yield* Semaphore.make(1);
  const dropIfKept = (kept: AcceptedText) =>
    Ref.update(accepted, (current) => (Option.isSome(current) && current.value === kept ? Option.none() : current));
  const reuse = (kept: AcceptedText) =>
    requireLiveActiveApplicationCompositionLease(kept.checked.snapshot).pipe(
      Effect.tapError(() => dropIfKept(kept)),
      Effect.as(kept.checked),
    );
  const keptFor = (encoded: string) =>
    Ref.get(accepted).pipe(Effect.map(Option.filter((kept) => kept.encoded === encoded)));
  const admitAlone = Effect.fnUntraced(function* admitAlone(encoded: string) {
    const settled = yield* keptFor(encoded);
    if (Option.isSome(settled)) {
      return yield* reuse(settled.value);
    }
    yield* Ref.set(accepted, Option.none());
    const checked = yield* (
      globalThis.ontosProcessCompositionValidation?.decode(encoded) ?? checkConfiguredText(encoded)
    );
    yield* Ref.set(accepted, Option.some({ checked, encoded }));
    return checked;
  });
  const admit = Effect.fnUntraced(function* admit(encoded: string) {
    const kept = yield* keptFor(encoded);
    return Option.isSome(kept) ? yield* reuse(kept.value) : yield* admission.withPermit(admitAlone(encoded));
  });
  return serve(pipe(readText, Effect.flatMap(admit)));
});

/** Held only by this module: a service constructed without it fails every read. */
const buildToken: unique symbol = Symbol('ActiveApplicationCompositionServiceContract.buildToken');
/**
 * Keys the brand member, a type-level barrier only: code outside this module cannot name this symbol, so a mock of the
 * service type does not type-check without copying it from a built service. A spread or `Object.assign` copy does
 * carry it, so it grants nothing at run time; only the private field the constructor sets does.
 */
const builtByThisModule: unique symbol = Symbol('ActiveApplicationCompositionServiceContract.builtByThisModule');
const refusedConstruction = Effect.die('Only the Active Application Composition module builds this service');
const notBuiltByThisModule = (): CheckedRead =>
  Effect.fail(
    unavailableActiveApplicationComposition('The service was not built by the Active Application Composition module'),
  );
type NarrowingCondition = (
  checked: CheckedActiveApplicationComposition,
) => Effect.Effect<void, ActiveApplicationCompositionUnavailableError>;
type NarrowingFailureObserver = (error: ActiveApplicationCompositionUnavailableError) => Effect.Effect<void>;

/**
 * Only this module builds one, through the three static constructors, and each of them checks: `checkingEveryRead`
 * checks an injected load in full on every read, `admittingText` checks each new text of a configured source in full
 * once, and `narrowing` adds conditions to a read that is already checked. Consumers do not check what they are handed
 * again, so they use it only through this module's functions `loadCheckedActiveApplicationComposition`,
 * `loadActiveApplicationComposition` and `narrowActiveApplicationComposition`, which take the read the constructor
 * stored in that very instance's private field. An instance has no method or readable member of its own, so nothing
 * is ever dispatched through an object a consumer was handed. The private field and the brand member keep an object
 * literal or a spread copy from type-checking as this service; a mock, proxy or `Object.assign` copy that does
 * type-check has no such field and fails closed. So does a service built by a second loaded copy of this module: a
 * process must build and read its service through one copy. A construction without this module's token stores a read
 * that dies. The class and its prototype are frozen.
 */
export class ActiveApplicationCompositionServiceContract {
  readonly #checkedRead: CheckedRead;
  readonly [builtByThisModule]: typeof builtByThisModule;

  private constructor(token: typeof buildToken, loadChecked: CheckedRead) {
    this.#checkedRead = token === buildToken ? loadChecked : refusedConstruction;
    this[builtByThisModule] = builtByThisModule;
    Object.freeze(this);
  }

  /**
   * The checked read the constructor stored in `service`'s private field. The language gives that field only to an
   * instance this class constructed, never to a copy, spread, mock or proxy of one, so anything else fails closed.
   * Each call returns an Effect of its own around the stored read, and each refusal is made anew, so no caller is
   * handed an object another caller holds. Consumers use `loadCheckedActiveApplicationComposition`, which is this.
   */
  static checkedReadOf(service: ActiveApplicationCompositionServiceContract): CheckedRead {
    const stored = #checkedRead in service ? service.#checkedRead : undefined;
    return Effect.suspend(() => stored ?? notBuiltByThisModule());
  }

  /** A service over an injected load: everything it presents is checked in full on every read. */
  static checkingEveryRead(
    load: Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>,
  ): ActiveApplicationCompositionServiceContract {
    return new ActiveApplicationCompositionServiceContract(
      buildToken,
      pipe(load, Effect.flatMap(checkActiveApplicationCompositionSnapshot)),
    );
  }

  /**
   * A service over the encoded snapshot text a source returns, with one entry per built service: the last text that
   * passed the complete check, with that result. Text equal to it, compared as the decoded string the source returns,
   * reuses the result after a lease check against the current time; an entry whose lease check fails is dropped, and
   * the next read of that text is checked in full again. Other text clears the entry and replaces it only after
   * passing the complete check itself. A failed source read touches nothing: it fails closed, and a later read of the
   * kept text reuses its entry. Admission runs one at a time, and the entry is read again under the permit: callers
   * presenting the same new text share one check when it succeeds, and an older text's check never overwrites the
   * decision about a newer text admitted after it.
   */
  static admittingText(
    readText: Effect.Effect<string, ActiveApplicationCompositionUnavailableError>,
  ): Effect.Effect<ActiveApplicationCompositionServiceContract> {
    return admitEachTextOnce(
      readText,
      (loadChecked) => new ActiveApplicationCompositionServiceContract(buildToken, loadChecked),
    );
  }

  /**
   * `service` with more conditions on every read. Every read runs the checked read stored in `service`'s private
   * field, then `condition` on its result, then a lease check against the current time, and returns that same checked
   * value. `condition` can only fail the read: what it returns is discarded, so it can neither make a checked value
   * nor skip the read. `observeFailure` runs on every failure of the narrowed read and can never turn it into a
   * success or change its error; but if `observeFailure` dies, the read ends with that defect, and if it never
   * completes, the read hangs. Narrowing anything this module did not build gives a service whose every read fails
   * closed. Consumers use `narrowActiveApplicationComposition`, which is this.
   */
  static narrowing(
    service: ActiveApplicationCompositionServiceContract,
    condition: NarrowingCondition,
    observeFailure: NarrowingFailureObserver,
  ): ActiveApplicationCompositionServiceContract {
    const checkedRead = ActiveApplicationCompositionServiceContract.checkedReadOf(service);
    return new ActiveApplicationCompositionServiceContract(
      buildToken,
      Effect.gen(function* narrowedRead() {
        const checked = yield* checkedRead;
        yield* condition(checked);
        yield* requireLiveActiveApplicationCompositionLease(checked.snapshot);
        return checked;
      }).pipe(Effect.tapError(observeFailure)),
    );
  }
}
Object.freeze(ActiveApplicationCompositionServiceContract.prototype);
Object.freeze(ActiveApplicationCompositionServiceContract);

/**
 * The trusted checked read of `service`: the read its constructor stored in the instance's private field. Anything
 * this module did not build, however it was copied or wrapped, fails closed with
 * `ActiveApplicationCompositionUnavailableError`. The read fails unless the snapshot passed the complete check and
 * its lease is live at the time of the call.
 */
export const loadCheckedActiveApplicationComposition = (
  service: ActiveApplicationCompositionServiceContract,
): CheckedRead => ActiveApplicationCompositionServiceContract.checkedReadOf(service);

/** The snapshot of `loadCheckedActiveApplicationComposition`, with the same checks. */
export const loadActiveApplicationComposition = (
  service: ActiveApplicationCompositionServiceContract,
): ActiveApplicationCompositionLoad =>
  loadCheckedActiveApplicationComposition(service).pipe(Effect.map((checked) => checked.snapshot));

/**
 * `service` with more conditions on every read, as `ActiveApplicationCompositionServiceContract.narrowing` describes.
 * A function of this module, not a method of `service`, so a copy or proxy of a service cannot answer for it: the
 * narrowed service reads the private field of `service` itself and fails closed when there is none.
 */
export const narrowActiveApplicationComposition = (
  service: ActiveApplicationCompositionServiceContract,
  condition: NarrowingCondition,
  observeFailure: NarrowingFailureObserver = () => Effect.void,
): ActiveApplicationCompositionServiceContract =>
  ActiveApplicationCompositionServiceContract.narrowing(service, condition, observeFailure);

/** A service over an injected load: everything it presents is checked in full on every read. */
export const makeActiveApplicationCompositionService = (
  load: Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>,
): ActiveApplicationCompositionServiceContract => ActiveApplicationCompositionServiceContract.checkingEveryRead(load);

export const makeActiveApplicationCompositionLayer = (
  load: Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>,
): Layer.Layer<ActiveApplicationCompositionService> =>
  Layer.succeed(ActiveApplicationCompositionService, makeActiveApplicationCompositionService(load));

/**
 * Server runtime adapter. Deployment automation publishes the immutable active snapshot as one atomic
 * value: the trusted authority URL on Node, the Workers KV entry on a placed Worker
 * (`@app/core-runtime/modules/active-application-composition-source`). Missing, malformed, or expired evidence fails closed in
 * consumers instead of falling back to topology or a last-known-good revision.
 */
export const ActiveApplicationCompositionConfigLive = Layer.effect(ActiveApplicationCompositionService)(
  ActiveApplicationCompositionSource.pipe(
    Effect.flatMap((source) =>
      ActiveApplicationCompositionServiceContract.admittingText(
        source.load.pipe(Effect.mapError(unavailableActiveApplicationComposition)),
      ),
    ),
  ),
);

const moduleStateCatalogUnavailable = (cause?: unknown) => {
  const error = new TenantModuleStateValidationUnavailableError({
    code: 'tenant_module_state_validation_unavailable',
    reason: 'Tenant module transition validation is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

/** The bounded revision load operation, shared without constructing a contextual service in callers. */
export const loadInstalledModuleCatalogForRevision = Effect.fn('InstalledModuleCatalog.loadForRevision')(
  function* loadForRevision(authority: ActiveApplicationCompositionServiceContract, compositionRevision: string) {
    const { catalog, snapshot } = yield* loadCheckedActiveApplicationComposition(authority).pipe(
      Effect.mapError(moduleStateCatalogUnavailable),
    );
    if (snapshot.composition.revision !== compositionRevision) {
      return yield* moduleStateCatalogUnavailable();
    }
    yield* requireLiveActiveApplicationCompositionLease(snapshot).pipe(Effect.mapError(moduleStateCatalogUnavailable));
    return catalog;
  },
);
export const makeInstalledModuleCatalogService = (
  authority: ActiveApplicationCompositionServiceContract,
): InstalledModuleCatalogServiceContract =>
  Object.freeze({ loadForRevision: (revision: string) => loadInstalledModuleCatalogForRevision(authority, revision) });

/** Lazy Core catalog binding: constructing the runtime never reads the composition source. */
export const InstalledModuleCatalogServiceLive = Layer.effect(InstalledModuleCatalogService)(
  ActiveApplicationCompositionService.pipe(Effect.map(makeInstalledModuleCatalogService)),
);
