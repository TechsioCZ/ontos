import { randomUUID } from 'node:crypto';

import { Cause, Effect, FileSystem, Path, Schema } from 'effect';

const AppIdSchema = Schema.Literals([
  'shell-super-app',
  'party-registry',
  'catalog',
  'commerce-customer-context',
  'commerce-market-catalog',
  'price-group-catalog',
]);
const PhaseSchema = Schema.Literals(['prepare', 'spawn', 'ready_address', 'contract']);
const ExitStatusSchema = Schema.Union([
  Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: -255 })),
  Schema.Literal('UNKNOWN'),
]);
const ClassificationSchema = Schema.Literals([
  'FEDERATION_SHARED_VERSION',
  'IMPORT_META_SYNTAX',
  'MODULE_NOT_FOUND',
  'SPAWN_NOT_FOUND',
  'UNKNOWN',
]);
export const NativeStartupReceiptSchema = Schema.Struct({
  appId: AppIdSchema,
  classification: ClassificationSchema,
  exitStatus: ExitStatusSchema,
  launch: Schema.Literals(['packaged', 'compiled']),
  phase: PhaseSchema,
});

type Identity = Pick<typeof NativeStartupReceiptSchema.Type, 'appId' | 'launch'>;
export interface StartupObservation {
  readonly exited: (status: number) => void;
  readonly line: (line: string) => void;
  readonly phase: (phase: typeof PhaseSchema.Type) => void;
}

const missingExecutable = Schema.Struct({
  reason: Schema.Struct({ _tag: Schema.Literal('NotFound') }),
});
const missingFile = Schema.Struct({ code: Schema.Literal('ENOENT') });

const classifyLine = (raw: string): typeof ClassificationSchema.Type => {
  const line = raw.slice(0, 2048).trim();
  if (
    line.includes('[ Federation Runtime ]:') &&
    line.includes('of shared singleton module ') &&
    line.includes('does not satisfy the requirement of ')
  ) {
    return 'FEDERATION_SHARED_VERSION';
  }
  if (line.startsWith("SyntaxError: Cannot use 'import.meta' outside a module")) {
    return 'IMPORT_META_SYNTAX';
  }
  if (line.startsWith('Error [ERR_MODULE_NOT_FOUND]:') || line.startsWith('Error: Cannot find module ')) {
    return 'MODULE_NOT_FOUND';
  }
  return 'UNKNOWN';
};

// Like the Market native startup receipt, only closed classifications cross this boundary.
// Redacted output is never unwrapped, and raw lines, error messages and configuration are not retained.
export const withNativeStartupReceipt = <Value, Failure, Requirements>(
  identity: Identity,
  start: (observation: StartupObservation) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.suspend(() => {
    let phase: typeof PhaseSchema.Type = 'prepare';
    let exitStatus: typeof ExitStatusSchema.Type = 'UNKNOWN';
    let classification: typeof ClassificationSchema.Type = 'UNKNOWN';
    const observation: StartupObservation = {
      exited: (status) => {
        exitStatus = Schema.is(ExitStatusSchema)(status) ? status : 'UNKNOWN';
      },
      line: (line) => {
        if (classification === 'UNKNOWN') {
          classification = classifyLine(line);
        }
      },
      phase: (next) => {
        phase = next;
      },
    };
    return start(observation).pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* persistClosedStartupFailure() {
          const failure = Cause.squash(cause);
          if (phase === 'spawn' && (Schema.is(missingExecutable)(failure) || Schema.is(missingFile)(failure))) {
            classification = 'SPAWN_NOT_FOUND';
          }
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(NativeStartupReceiptSchema))({
            appId: identity.appId,
            classification,
            exitStatus,
            launch: identity.launch,
            phase,
          });
          const filesystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // Both owner fixtures run from the Shell package; this is not a scoped temporary directory.
          const directory = path.resolve('.cache', 'native-owner-startup');
          yield* filesystem.makeDirectory(directory, { recursive: true });
          const id = yield* Effect.sync(randomUUID);
          yield* filesystem.writeFileString(path.join(directory, `startup-diagnostic-${id}.json`), encoded);
        }).pipe(Effect.uninterruptible, Effect.ignoreCause),
      ),
    );
  });
