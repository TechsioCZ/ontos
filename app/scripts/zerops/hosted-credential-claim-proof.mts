/**
 * The build-time proof that a built unit's credential store copy can really be claimed and filled, run by
 * `owner-entry.mts` for every unit whose API bundle carries a copy. A child process loads the unit's generated entry
 * exactly as the owners process does (`serve-units.mts` imports `dist/zerops-entry.mjs`, which loads the API bundle the
 * unit's server then serves from, so it is the same module instance), claims the copy through the entry's claim, hands
 * it a throwaway key for the unit and one for another module, and reads both back through the copy's own reader (the
 * read the unit's delegated client makes); a second claim must be refused. No real key, no network and no database:
 * the child gets only `PATH` and `NODE_ENV`. A bundle shape that would pass the text check but stop the owners process
 * at boot (an `exports` object the bundle later replaces, a lazy initialiser that never runs) fails the unit's build
 * here instead.
 *
 * It starts a subprocess, so the processes that hold a credential channel never load this module.
 */
import path from 'node:path';

import { Config, Duration, Effect, Option, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

import { HostedCredentialClaimError } from './hosted-credential-claim.mts';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const PROOF_BUDGET = Duration.minutes(2);

const PROOF_PROGRAM = `
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Effect, Option, Redacted } from 'effect';
const [entry, appId] = process.argv.slice(1);
const fail = (step) => {
  console.log(JSON.stringify({ failed: step }));
  process.exit(0);
};
let loaded;
try {
  loaded = await import(pathToFileURL(entry).href);
} catch (error) {
  fail('loading the entry failed: ' + String(error?.message ?? error).split('\\n')[0]);
}
const claim = loaded.claimModuleCredentials;
if (typeof claim !== 'function') fail('the entry exports no claim');
const claimed = await Effect.runPromiseExit(claim([appId]));
if (claimed._tag !== 'Success') fail('the claim failed');
const copy = claimed.value;
if (typeof copy?.accept !== 'function' || typeof copy?.read !== 'function') fail('the claim returned no store copy');
const secret = 'build-proof-' + randomUUID();
const stranger = 'build-proof-stranger';
const answer = await Effect.runPromise(
  copy.accept({
    credentials: { [appId]: Redacted.make(secret), [stranger]: Redacted.make('build-proof-' + randomUUID()) },
    schemaVersion: 1,
    workloads: {},
  }),
);
const own = await Effect.runPromise(copy.read(appId));
const other = await Effect.runPromise(copy.read(stranger));
const second = await Effect.runPromiseExit(claim([appId]));
console.log(JSON.stringify({
  accepted: answer.accepted,
  ownHeld: Option.isSome(own) && Redacted.value(own.value) === secret,
  refused: answer.refused,
  secondClaim: second._tag,
  strangerHeld: Option.isSome(other),
}));
process.exit(0);
`;

const ProofAnswerSchema = Schema.Union([
  Schema.Struct({ failed: Schema.String }),
  Schema.Struct({
    accepted: Schema.Array(Schema.String),
    ownHeld: Schema.Boolean,
    refused: Schema.Array(Schema.String),
    secondClaim: Schema.String,
    strangerHeld: Schema.Boolean,
  }),
]);

/** What went wrong with the round trip, if anything. */
const problemOf = (appId: string, answer: typeof ProofAnswerSchema.Type): Option.Option<string> => {
  if ('failed' in answer) {
    return Option.some(answer.failed);
  }
  if (answer.accepted.length !== 1 || answer.accepted[0] !== appId || answer.refused.length !== 1) {
    return Option.some('the copy did not take exactly its own module and refuse the other');
  }
  if (!answer.ownHeld) {
    return Option.some("the copy's reader does not return the key handed to the module");
  }
  if (answer.strangerHeld) {
    return Option.some("the copy's reader returns a key for another module");
  }
  return answer.secondClaim === 'Failure' ? Option.none() : Option.some('a second claim was not refused');
};

/**
 * Proves the claim of one built unit by a real round trip in a child process. Fails with the unit, the bundle's form
 * and the step that failed.
 */
export const proveUnitClaim = Effect.fn('HostedCredentialClaim.prove')(function* proveUnitClaim(input: {
  readonly appId: string;
  readonly bundleForm: string;
  readonly entry: string;
}) {
  const failure = (step: string) =>
    new HostedCredentialClaimError({
      reason: `${input.appId} (${input.bundleForm}): the built credential claim does not work: ${step}`,
    });
  const pathVariable = yield* Config.String('PATH').pipe(Effect.mapError(() => failure('PATH is not set')));
  const output = yield* Effect.scoped(
    Effect.gen(function* runProof() {
      const handle = yield* ChildProcess.make(
        process.execPath,
        ['--input-type=module', '--eval', PROOF_PROGRAM, input.entry, input.appId],
        {
          cwd: workspaceRoot,
          env: { NODE_ENV: 'production', PATH: pathVariable },
          extendEnv: false,
          stderr: 'ignore',
          stdin: 'ignore',
          stdout: 'pipe',
        },
      );
      const [stdout] = yield* Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
        concurrency: 2,
      });
      return stdout;
    }),
  ).pipe(
    Effect.timeout(PROOF_BUDGET),
    Effect.mapError(() => failure('the proof process could not run to its end')),
  );
  const last = output.trim().split('\n').at(-1) ?? '';
  const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProofAnswerSchema))(last).pipe(
    Effect.mapError(() => failure('the proof process gave no answer')),
  );
  const problem = problemOf(input.appId, answer);
  if (Option.isSome(problem)) {
    return yield* failure(problem.value);
  }
  return yield* Effect.void;
});
