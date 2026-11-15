/**
 * The release identity a native test must run an owner's (or the Shell's) code under: the identity of the unit whose
 * built outputs the test's Application Composition is made from.
 *
 * A gates build shard keeps a unit whose committed inputs are unchanged, with the identity (source revision and build
 * marker) of the commit it was built at (scripts/ci/unit-output-cache.mts). A fixture that bundles the checkout's
 * sources and stamps them with an identity derived from the checkout would then claim a release the composition does
 * not name, and every honest comparison (composition marker = running process marker) refuses.
 *
 * So, for a unit directory:
 * - a dirty checkout (`workspace`) or no built output (`dist/ultramodern-build.json`): the identity derived from the
 *   checkout, as before;
 * - otherwise the checkout's revision must be its Git HEAD (read from Git, never only from ULTRAMODERN_SOURCE_REVISION);
 *   a build naming that revision: the checkout's identity;
 * - a build naming another revision: that build's identity, only after proving the claim that makes bundling the
 *   checkout's sources under it honest. (a) The revision is a full commit hash; (b) the gates receipt names this unit,
 *   exactly this identity and these very `ultramodern-build.json` bytes; (c) the marker is the one UltraModern derives
 *   for this unit's generation marker at that revision; (d) the keep proof the gates plan wrote names this unit and
 *   this HEAD, and the committed inputs it proved for HEAD are the ones the receipt recorded at build time, so the
 *   checkout's sources are byte-equal to the ones the unit was built from. Any doubt refuses.
 * The full byte inventory of the outputs was checked by the shard's `unit-output-cache verify` before it uploaded
 * them; `readBuiltDocument` ties a document a fixture reads from such a unit to that inventory.
 *
 * This module imports only the receipt schemas: a fixture in a unit's own folder imports it, and the unit's identity
 * then covers what it reaches.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createUltramodernReleaseBuildMarker,
  resolveUltramodernReleaseIdentity,
} from '@modern-js/app-tools-extensions/release-identity';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { CacheReceiptSchema, KEEP_PROOF, KeepProofSchema, RECEIPT } from './unit-output-receipt.mts';

export class KeptUnitIdentityError extends Schema.TaggedError<KeptUnitIdentityError>()('KeptUnitIdentityError', {
  reason: Schema.String,
}) {}
const refuse = (unitDirectory: string, reason: string) =>
  new KeptUnitIdentityError({ reason: `${unitDirectory}: ${reason}` });

const PROMOTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BUILD_METADATA = 'dist/ultramodern-build.json';
const BuiltIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    deliveryUnit: Schema.Struct({
      appId: Schema.String.pipe(Schema.brand('KeptUnitAppId')),
      buildMarker: Schema.String,
      sourceRevision: Schema.String,
    }),
  }),
);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export interface OwnerReleaseIdentityInput {
  /** The environment UltraModern reads ULTRAMODERN_SOURCE_REVISION from; this process's when omitted. */
  readonly environment?: Parameters<typeof resolveUltramodernReleaseIdentity>[0]['environment'];
  /** The unit's generation marker (its `shared/ultramodern-build.json` or its topology entry). */
  readonly generationBuildMarker: string;
  /** The unit's directory below the app root, for example `apps/shell-super-app` or `verticals/catalog`. */
  readonly unitDirectory: string;
  readonly unitId: string;
  /** The app root (`app/`). */
  readonly workspaceRoot: string;
}
export interface OwnerReleaseIdentity {
  readonly buildMarker: string;
  readonly sourceRevision: string;
}

/** The checkout's Git HEAD; any Git failure refuses, so a revision taken only from the environment never passes. */
const gitHead = (input: OwnerReleaseIdentityInput) =>
  Effect.gen(function* readGitHead() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make('git', ['-C', input.workspaceRoot, 'rev-parse', 'HEAD']));
    const [stdout, , code] = yield* Effect.all(
      [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), Stream.runDrain(handle.stderr), handle.exitCode],
      { concurrency: 'unbounded' },
    );
    return Number(code) === 0 ? stdout.trim() : yield* refuse(input.unitDirectory, 'its checkout has no Git HEAD');
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      Schema.is(KeptUnitIdentityError)(cause) ? cause : refuse(input.unitDirectory, 'Git cannot be run'),
    ),
  );

const checkoutIdentity = (input: OwnerReleaseIdentityInput) =>
  Effect.try({
    catch: (cause) => refuse(input.unitDirectory, `no release identity from the checkout: ${String(cause)}`),
    try: () => {
      const unit = {
        generationBuildMarker: input.generationBuildMarker,
        unitId: input.unitId,
        workspaceRoot: input.workspaceRoot,
      };
      // An omitted environment is UltraModern's default: this process's.
      return input.environment === undefined
        ? resolveUltramodernReleaseIdentity(unit)
        : resolveUltramodernReleaseIdentity({ ...unit, environment: input.environment });
    },
  });

// A function expression, not a generic arrow: every package's test bundler (SWC) refuses `<A,>() =>` in .mts files.
const decodeFile = function decodeFile<A, I>(
  file: string,
  schema: Schema.Codec<A, I>,
  onFailure: () => KeptUnitIdentityError,
) {
  return Effect.gen(function* decodeJsonFile() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
  }).pipe(Effect.mapError(onFailure));
};

/** See the module comment. */
export const resolveOwnerReleaseIdentity = Effect.fn('KeptUnitIdentity.resolve')(function* resolveOwnerReleaseIdentity(
  input: OwnerReleaseIdentityInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const unitRoot = path.join(input.workspaceRoot, input.unitDirectory);
  const checkout = yield* checkoutIdentity(input);
  const metadataFile = path.join(unitRoot, BUILD_METADATA);
  if (checkout.sourceRevision === 'workspace' || !(yield* fs.exists(metadataFile))) {
    return checkout;
  }
  const head = yield* gitHead(input);
  if (head !== checkout.sourceRevision) {
    return yield* refuse(
      input.unitDirectory,
      `the checkout names ${checkout.sourceRevision} but its Git HEAD is ${head}`,
    );
  }
  const metadata = yield* fs
    .readFile(metadataFile)
    .pipe(Effect.mapError(() => refuse(input.unitDirectory, `${BUILD_METADATA} cannot be read`)));
  const built = (yield* Schema.decodeEffect(BuiltIdentitySchema)(new TextDecoder().decode(metadata)).pipe(
    Effect.mapError(() => refuse(input.unitDirectory, `${BUILD_METADATA} is not a build identity`)),
  )).deliveryUnit;
  if (built.sourceRevision === head) {
    return checkout;
  }
  if (!PROMOTABLE_REVISION.test(built.sourceRevision)) {
    return yield* refuse(input.unitDirectory, `its build names no full commit hash (${built.sourceRevision})`);
  }
  const receiptFile = path.join(unitRoot, RECEIPT);
  if (!(yield* fs.exists(receiptFile))) {
    // A local build: nothing proves which sources these outputs came from, so using them would test stale code.
    return yield* refuse(
      input.unitDirectory,
      `${path.join(unitRoot, 'dist')} was built at ${built.sourceRevision}, not at this checkout (${head}); rebuild ` +
        `the unit, or delete ${path.join(unitRoot, 'dist')} and ${path.join(unitRoot, '.output')}`,
    );
  }
  const receipt = yield* decodeFile(receiptFile, CacheReceiptSchema, () =>
    refuse(input.unitDirectory, 'its gates receipt cannot be read'),
  );
  if (
    receipt.unit !== built.appId ||
    receipt.identity.appId !== built.appId ||
    receipt.identity.buildMarker !== built.buildMarker ||
    receipt.identity.sourceRevision !== built.sourceRevision ||
    receipt.files.find((file) => file.path === BUILD_METADATA)?.sha256 !== sha256(metadata)
  ) {
    return yield* refuse(input.unitDirectory, 'its gates receipt does not describe this build');
  }
  const marker = createUltramodernReleaseBuildMarker({
    generationBuildMarker: input.generationBuildMarker,
    sourceRevision: built.sourceRevision,
    unitId: input.unitId,
  });
  if (marker !== built.buildMarker) {
    return yield* refuse(input.unitDirectory, `its build marker is not this unit's marker at ${built.sourceRevision}`);
  }
  const proofFile = path.join(unitRoot, KEEP_PROOF);
  if (!(yield* fs.exists(proofFile))) {
    return yield* refuse(input.unitDirectory, `built at ${built.sourceRevision} but no gates plan kept it for ${head}`);
  }
  const proof = yield* decodeFile(proofFile, KeepProofSchema, () =>
    refuse(input.unitDirectory, 'its gates keep proof cannot be read'),
  );
  if (proof.unit !== built.appId || proof.revision !== head || proof.inputs !== receipt.inputs) {
    return yield* refuse(
      input.unitDirectory,
      `built at ${built.sourceRevision} from other sources than this checkout's; rebuild it`,
    );
  }
  return { buildMarker: built.buildMarker, sourceRevision: built.sourceRevision };
});

/**
 * A document from a unit's built outputs (`dist/…` or `.output/…`), tied to its gates receipt when it has one: the
 * bytes must be the ones the receipt inventoried, so a fixture never reads a document someone rewrote after the
 * shard verified the unit. Without a receipt (a local build) the document is read as it is.
 */
export const readBuiltDocument = Effect.fn('KeptUnitIdentity.readBuiltDocument')(function* readBuiltDocument(input: {
  readonly document: string;
  readonly unitDirectory: string;
  readonly workspaceRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const unitRoot = path.join(input.workspaceRoot, input.unitDirectory);
  const bytes = yield* fs
    .readFile(path.join(unitRoot, input.document))
    .pipe(Effect.mapError(() => refuse(input.unitDirectory, `${input.document} cannot be read`)));
  const receiptFile = path.join(unitRoot, RECEIPT);
  if (yield* fs.exists(receiptFile)) {
    const receipt = yield* decodeFile(receiptFile, CacheReceiptSchema, () =>
      refuse(input.unitDirectory, 'its gates receipt cannot be read'),
    );
    if (receipt.files.find((file) => file.path === input.document)?.sha256 !== sha256(bytes)) {
      return yield* refuse(input.unitDirectory, `${input.document} is not the document its build verified`);
    }
  }
  return new TextDecoder().decode(bytes);
});
