import { Cause, Clock, Console, DateTime, Effect, FileSystem, Match, Option, Schema } from 'effect';

const StepResultSchema = Schema.Struct({
  detail: Schema.String,
  ms: Schema.Number,
  name: Schema.String,
  pass: Schema.Boolean,
  variant: Schema.String,
});

export type StepResult = typeof StepResultSchema.Type;

const GrantIdSchema = Schema.String.pipe(Schema.brand('OAuthProofGrantId'));
const ProfileIdSchema = Schema.String.pipe(Schema.brand('OAuthProofProfileId'));
const RunIdSchema = Schema.String.pipe(Schema.brand('OAuthProofRunId'));

const VariantSummarySchema = Schema.Struct({
  grantId: Schema.OptionFromNullOr(GrantIdSchema),
  key: Schema.String,
  label: Schema.String,
  profileId: Schema.OptionFromNullOr(ProfileIdSchema),
});

const ReportMetadataSchema = Schema.Struct({
  agentName: Schema.optional(Schema.String),
  grantId: Schema.optional(Schema.OptionFromNullOr(GrantIdSchema)),
  issuer: Schema.optional(Schema.String),
  mcpUrl: Schema.String,
  policy: Schema.optional(Schema.Literals(['approval', 'direct'])),
  runId: RunIdSchema,
  shellUrl: Schema.optional(Schema.String),
  variants: Schema.optional(Schema.Array(VariantSummarySchema)),
});

export type ReportMetadata = Schema.Codec.Encoded<typeof ReportMetadataSchema>;

const ReportSchema = Schema.Struct({
  ...ReportMetadataSchema.fields,
  finishedAt: Schema.DateTimeUtcFromString,
  pass: Schema.Boolean,
  steps: Schema.Array(StepResultSchema),
});

interface StepOutcome<A> {
  readonly detail: string;
  readonly pass: boolean;
  readonly value?: A;
}

/**
 * What happened to the rotated-out refresh token. `NotReplayed` means the rotation was never recorded, so the old
 * token was never presented; that is a failed check, not evidence that the server accepted it.
 */
const OldRefreshReplaySchema = Schema.Union([
  Schema.TaggedStruct('Accepted', {}),
  Schema.TaggedStruct('NotReplayed', {}),
  Schema.TaggedStruct('Rejected', {}),
]);
export type OldRefreshReplay = typeof OldRefreshReplaySchema.Type;

/** Verdict of a step that must prove the old refresh token is rejected. Only a real rejection passes. */
export const oldRefreshVerdict = (replay: OldRefreshReplay): { readonly detail: string; readonly pass: boolean } =>
  Match.value(replay).pipe(
    Match.tag('Accepted', () => ({ detail: 'starý refresh token prošel', pass: false })),
    Match.tag('NotReplayed', () => ({
      detail: 'rotace selhala, replay starého refresh tokenu neproveden',
      pass: false,
    })),
    Match.tag('Rejected', () => ({ detail: 'invalid_grant', pass: true })),
    Match.exhaustive,
  );

export class Recorder {
  readonly steps: StepResult[] = [];
  readonly lines: string[] = [];

  log(line: string) {
    return Effect.sync(() => {
      this.lines.push(line);
    }).pipe(Effect.andThen(Console.log(line)));
  }

  /** Records the typed check outcome; failures become failed steps. */
  stepEffect<A, E, R>(variant: string, name: string, body: Effect.Effect<StepOutcome<A>, E, R>) {
    return Effect.gen({ self: this }, function* recordStep() {
      const started = yield* Clock.monotonicTimeNanos;
      const outcome: StepOutcome<A> = yield* body.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ detail: Cause.pretty(cause), pass: false }),
        ),
      );
      const ms = Number(((yield* Clock.monotonicTimeNanos) - started) / 1_000_000n);
      const { detail, pass, value } = outcome;
      this.steps.push({ detail, ms, name, pass, variant });
      yield* this.log(`${pass ? 'PASS' : 'FAIL'} [${variant}] ${name} — ${detail} (${ms} ms)`);
      return Option.fromUndefinedOr(value);
    });
  }

  get pass(): boolean {
    return this.steps.length > 0 && this.steps.every((step) => step.pass);
  }

  writeEffect(outDir: string, baseName: string, meta: ReportMetadata) {
    return Effect.gen({ self: this }, function* writeReport() {
      const fs = yield* FileSystem.FileSystem;
      const metadata = yield* Schema.decodeUnknownEffect(ReportMetadataSchema)(meta);
      yield* fs.makeDirectory(outDir, { recursive: true });
      const finishedAt = yield* DateTime.now;
      const report = { ...metadata, finishedAt, pass: this.pass, steps: this.steps };
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(ReportSchema, { space: 2 }))(report);
      yield* fs.writeFileString(`${outDir}/${baseName}.json`, json);
      yield* fs.writeFileString(`${outDir}/${baseName}.log`, `${this.lines.join('\n')}\n`);
    });
  }
}
