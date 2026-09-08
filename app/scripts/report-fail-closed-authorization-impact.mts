#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Result,
  Schema,
} from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { pathToFileURL } from 'node:url';

const InventoryHashSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const SourceRevisionSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9._-]+$/u),
);
const EntrypointKeySchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[./_-][a-z0-9]+)*$/u),
).pipe(Schema.brand('EntrypointKey'));
const CanonicalTimestampStringSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'timestamp must use canonical UTC ISO 8601 encoding';
  }),
);
const CanonicalTimestampSchema = CanonicalTimestampStringSchema.pipe(
  Schema.decodeTo(Schema.DateTimeUtcFromString),
);

const WouldDenyEvidenceSchema = Schema.Struct({
  denialReason: Schema.Literals([
    'cross_tenant',
    'expired_credential',
    'infrastructure_unavailable',
    'malformed_credential',
    'missing_policy',
    'module_disabled',
    'replayed_credential',
    'wrong_audience',
  ]),
  entrypointKey: EntrypointKeySchema,
  inventoryHash: InventoryHashSchema,
  policyClass: Schema.Literals([
    'action_execution',
    'authenticated_principal',
    'capability_issuance',
    'context_permission',
    'owner_local_background',
    'public',
  ]),
  schemaVersion: Schema.Literal(1),
  sourceRevision: SourceRevisionSchema,
  surface: Schema.Literals(['action', 'capability_issuance', 'route', 'worker']),
  timestamp: CanonicalTimestampSchema,
  type: Schema.Literal('authorization.would_deny'),
}).annotate({
  identifier: 'authorization evidence is malformed or contains prohibited fields',
});

const NonEmptyEvidenceSchema = Schema.NonEmptyArray(WouldDenyEvidenceSchema);
type NonEmptyEvidence = Schema.Schema.Type<typeof NonEmptyEvidenceSchema>;

const EmptyAuthorizationObservationSchema = Schema.Struct({
  endedAt: CanonicalTimestampSchema,
  inventoryHash: InventoryHashSchema,
  sourceRevision: SourceRevisionSchema,
  startedAt: CanonicalTimestampSchema,
});

export type EmptyAuthorizationObservation = (typeof EmptyAuthorizationObservationSchema)['Encoded'];

const AuthorizationImpactAggregateSchema = Schema.Struct({
  count: Schema.Number,
  denialReason: WouldDenyEvidenceSchema.fields.denialReason,
  entrypointKey: EntrypointKeySchema,
  policyClass: WouldDenyEvidenceSchema.fields.policyClass,
  surface: WouldDenyEvidenceSchema.fields.surface,
});

const AuthorizationImpactReportSchema = Schema.Struct({
  aggregates: Schema.Array(AuthorizationImpactAggregateSchema),
  inventoryHash: InventoryHashSchema,
  observation: Schema.Struct({
    endedAt: CanonicalTimestampSchema,
    startedAt: CanonicalTimestampSchema,
  }),
  schemaVersion: Schema.Literal(1),
  sourceRevision: SourceRevisionSchema,
  totalWouldDeny: Schema.Number,
});

export type AuthorizationImpactReport = (typeof AuthorizationImpactReportSchema)['Encoded'];

class AuthorizationImpactValidationError extends Schema.TaggedError<AuthorizationImpactValidationError>()(
  'AuthorizationImpactValidationError',
  { message: Schema.String },
) {}

const validationError = (message: string): AuthorizationImpactValidationError =>
  new AuthorizationImpactValidationError({ message });

type AuthorizationImpactAggregate = AuthorizationImpactReport['aggregates'][number];
const localeStringOrder = Order.make<string>((left, right) => {
  const comparison = left.localeCompare(right);
  if (comparison < 0) {
    return -1;
  }
  return comparison > 0 ? 1 : 0;
});
const aggregateOrder = Order.combineAll<AuthorizationImpactAggregate>([
  Order.mapInput(localeStringOrder, (aggregate: AuthorizationImpactAggregate) => aggregate.surface),
  Order.mapInput(
    localeStringOrder,
    (aggregate: AuthorizationImpactAggregate) => aggregate.entrypointKey,
  ),
  Order.mapInput(
    localeStringOrder,
    (aggregate: AuthorizationImpactAggregate) => aggregate.policyClass,
  ),
  Order.mapInput(
    localeStringOrder,
    (aggregate: AuthorizationImpactAggregate) => aggregate.denialReason,
  ),
]);

const reduceDecodedEvidence = (events: NonEmptyEvidence): AuthorizationImpactReport => {
  const [first] = events;
  if (
    events.some(
      (event) =>
        event.sourceRevision !== first.sourceRevision ||
        event.inventoryHash !== first.inventoryHash,
    )
  ) {
    return Result.getOrThrow(
      Result.fail(
        validationError('authorization evidence mixes source revisions or inventory hashes'),
      ),
    );
  }

  const counts = new Map<string, AuthorizationImpactReport['aggregates'][number]>();
  for (const event of events) {
    const key = [event.surface, event.entrypointKey, event.policyClass, event.denialReason].join(
      '\0',
    );
    const current = counts.get(key);
    counts.set(key, {
      count: (current?.count ?? 0) + 1,
      denialReason: event.denialReason,
      entrypointKey: event.entrypointKey,
      policyClass: event.policyClass,
      surface: event.surface,
    });
  }

  const timestamps = EffectArray.sort(
    events.map((event) => DateTime.formatIso(event.timestamp)),
    Order.String,
  );
  return {
    aggregates: EffectArray.sort([...counts.values()], aggregateOrder),
    inventoryHash: first.inventoryHash,
    observation: {
      endedAt: timestamps.at(-1) ?? '',
      startedAt: timestamps[0] ?? '',
    },
    schemaVersion: 1,
    sourceRevision: first.sourceRevision,
    totalWouldDeny: events.length,
  };
};

export const reduceAuthorizationImpact = (
  rawEvents: readonly object[],
  emptyObservation?: EmptyAuthorizationObservation,
): AuthorizationImpactReport => {
  if (rawEvents.length > 0) {
    const events = Result.getOrThrowWith(
      Schema.decodeUnknownResult(NonEmptyEvidenceSchema, { onExcessProperty: 'error' })(rawEvents),
      () => validationError('authorization evidence is malformed or contains prohibited fields'),
    );
    return reduceDecodedEvidence(events);
  }

  const observation = Result.getOrThrowWith(
    Schema.decodeUnknownResult(EmptyAuthorizationObservationSchema, {
      onExcessProperty: 'preserve',
    })(emptyObservation),
    () => validationError('empty authorization impact requires explicit observation bounds'),
  );
  if (DateTime.toEpochMillis(observation.startedAt) > DateTime.toEpochMillis(observation.endedAt)) {
    return Result.getOrThrow(
      Result.fail(
        validationError('empty authorization impact requires explicit observation bounds'),
      ),
    );
  }
  return {
    aggregates: [],
    inventoryHash: observation.inventoryHash,
    observation: {
      endedAt: DateTime.formatIso(observation.endedAt),
      startedAt: DateTime.formatIso(observation.startedAt),
    },
    schemaVersion: 1,
    sourceRevision: observation.sourceRevision,
    totalWouldDeny: 0,
  };
};

const BoundedEvidenceBatchSchema = Schema.Struct({
  endedAt: CanonicalTimestampSchema,
  events: Schema.Array(WouldDenyEvidenceSchema),
  inventoryHash: InventoryHashSchema,
  sourceRevision: SourceRevisionSchema,
  startedAt: CanonicalTimestampSchema,
});
const EvidenceDocumentSchema = Schema.Union([
  Schema.Array(WouldDenyEvidenceSchema),
  BoundedEvidenceBatchSchema,
]);

const writeAuthorizationImpactReport = Effect.fn('writeAuthorizationImpactReport')(
  function* writeReport(inputPath: Option.Option<string>) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configuredRoot = yield* Config.option(Config.string('ULTRAMODERN_WORKSPACE_ROOT'));
    const root = Option.getOrElse(configuredRoot, () => path.resolve(import.meta.dirname, '..'));
    const input = Option.getOrElse(inputPath, () =>
      path.join(root, '.codex/reports/authorization/would-deny.json'),
    );
    const output = path.join(root, '.codex/reports/authorization/fail-closed-impact.json');
    const source = yield* fileSystem.readFileString(input);
    const document = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(EvidenceDocumentSchema),
      { onExcessProperty: 'error' },
    )(source);

    let report: AuthorizationImpactReport;
    if (Schema.is(Schema.Array(WouldDenyEvidenceSchema))(document)) {
      report = Schema.is(NonEmptyEvidenceSchema)(document)
        ? reduceDecodedEvidence(document)
        : reduceAuthorizationImpact([]);
    } else if (Schema.is(NonEmptyEvidenceSchema)(document.events)) {
      report = reduceDecodedEvidence(document.events);
    } else {
      report = reduceAuthorizationImpact([], {
        endedAt: DateTime.formatIso(document.endedAt),
        inventoryHash: document.inventoryHash,
        sourceRevision: document.sourceRevision,
        startedAt: DateTime.formatIso(document.startedAt),
      });
    }

    const decodedReport = yield* Schema.decodeUnknownEffect(AuthorizationImpactReportSchema)(
      report,
    );
    const outputJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(AuthorizationImpactReportSchema, { space: 2 }),
    )(decodedReport);
    yield* fileSystem.makeDirectory(path.dirname(output), { recursive: true });
    yield* fileSystem.writeFileString(output, `${outputJson}\n`);
    yield* Console.log(output);
  },
);

const command = Command.make(
  'report-fail-closed-authorization-impact',
  { input: Argument.file('input').pipe(Argument.optional) },
  ({ input }) => writeAuthorizationImpactReport(input),
);

const [, invokedPath] = process.argv;
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const mainLayer = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  NodeRuntime.runMain(Effect.scoped(Layer.build(mainLayer)).pipe(Effect.asVoid));
}
