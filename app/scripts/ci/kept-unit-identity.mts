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
 * - no built output (`dist/ultramodern-build.json`), a dirty checkout (`workspace`), or a build naming the checkout's
 *   own revision: the identity derived from the checkout, as before;
 * - a build naming another revision: that build's identity, only after proving the claim that makes bundling the
 *   checkout's sources under it honest. Its gates receipt names this unit and exactly this identity and carries these
 *   very `ultramodern-build.json` bytes; the identity is the marker UltraModern derives for this unit's generation
 *   marker at that revision; and the unit's committed-inputs digest at HEAD equals the one the receipt recorded at
 *   build time, so the checkout's sources are byte-equal to the ones the unit was built from. Any doubt refuses.
 * The full byte inventory of the outputs was checked by the shard's `unit-output-cache verify` before it uploaded
 * them; this module checks only what ties the identity to the checkout.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createUltramodernReleaseBuildMarker,
  resolveUltramodernReleaseIdentity,
} from '@modern-js/app-tools-extensions/release-identity';
import { Effect, FileSystem, Schema } from 'effect';

import { readSources, readWorkspace } from '../zerops/delivery-plan-cli.mts';
import { unitIdentity, unitInputGraph } from '../zerops/delivery-plan.mts';
import { CacheReceiptSchema } from './unit-output-receipt.mts';

export class KeptUnitIdentityError extends Schema.TaggedError<KeptUnitIdentityError>()('KeptUnitIdentityError', {
  reason: Schema.String,
}) {}
const refuse = (unitDirectory: string, reason: string) =>
  new KeptUnitIdentityError({ reason: `${unitDirectory}: ${reason}` });

const PROMOTABLE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const BUILD_METADATA = 'dist/ultramodern-build.json';
const RECEIPT = 'dist/.gates-output-cache.json';
const BuiltIdentitySchema = Schema.fromJsonString(
  Schema.Struct({
    deliveryUnit: Schema.Struct({
      appId: Schema.String.pipe(Schema.brand('KeptUnitAppId')),
      buildMarker: Schema.String,
      sourceRevision: Schema.String,
    }),
  }),
);
const HeadInputsSchema = Schema.fromJsonString(Schema.Struct({ inputs: Schema.String, revision: Schema.String }));

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

/**
 * The unit's committed-inputs digest at the checkout's clean HEAD. It is a pure function of that commit, so it is
 * kept beside the installed workspace per commit and unit: every test process of a row reads one computation.
 */
const headInputs = (input: OwnerReleaseIdentityInput, revision: string) =>
  Effect.gen(function* readHeadInputs() {
    const fs = yield* FileSystem.FileSystem;
    const cache = path.join(input.workspaceRoot, 'node_modules/.cache/ontos-kept-unit-inputs');
    const file = path.join(cache, `${revision}-${input.unitDirectory.replaceAll('/', '__')}.json`);
    if (yield* fs.exists(file)) {
      const recorded = yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(HeadInputsSchema)));
      if (recorded.revision === revision) {
        return recorded.inputs;
      }
    }
    const workspace = yield* readWorkspace(revision, input.workspaceRoot);
    const graph = unitInputGraph({ ...workspace, sources: yield* readSources(workspace.entries, input.workspaceRoot) });
    const { files } = yield* unitIdentity(`app/${input.unitDirectory}`, { environment: [], graph });
    yield* fs.makeDirectory(cache, { recursive: true });
    const temporary = yield* fs.makeTempFile({ directory: cache, prefix: 'inputs-' });
    yield* fs.writeFileString(temporary, yield* Schema.encodeEffect(HeadInputsSchema)({ inputs: files, revision }));
    yield* fs.rename(temporary, file);
    return files;
  });

/** See the module comment. */
export const resolveOwnerReleaseIdentity = Effect.fn('KeptUnitIdentity.resolve')(function* resolveOwnerReleaseIdentity(
  input: OwnerReleaseIdentityInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const unitRoot = path.join(input.workspaceRoot, input.unitDirectory);
  const checkout = yield* Effect.try({
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
  const metadataFile = path.join(unitRoot, BUILD_METADATA);
  if (checkout.sourceRevision === 'workspace' || !(yield* fs.exists(metadataFile))) {
    return checkout;
  }
  const metadata = yield* fs.readFile(metadataFile);
  const built = (yield* Schema.decodeEffect(BuiltIdentitySchema)(new TextDecoder().decode(metadata))).deliveryUnit;
  if (built.sourceRevision === checkout.sourceRevision) {
    return checkout;
  }
  if (!PROMOTABLE_REVISION.test(built.sourceRevision)) {
    return yield* refuse(input.unitDirectory, `its build names no promotable revision (${built.sourceRevision})`);
  }
  const receiptFile = path.join(unitRoot, RECEIPT);
  if (!(yield* fs.exists(receiptFile))) {
    return yield* refuse(input.unitDirectory, `built at ${built.sourceRevision} without a gates receipt`);
  }
  const receipt = yield* fs.readFileString(receiptFile).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CacheReceiptSchema))),
    Effect.mapError(() => refuse(input.unitDirectory, 'its gates receipt cannot be read')),
  );
  const recordedMetadata = receipt.files.find((file) => file.path === BUILD_METADATA);
  if (
    receipt.unit !== built.appId ||
    receipt.identity.appId !== built.appId ||
    receipt.identity.buildMarker !== built.buildMarker ||
    receipt.identity.sourceRevision !== built.sourceRevision ||
    recordedMetadata?.sha256 !== createHash('sha256').update(metadata).digest('hex')
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
  if ((yield* headInputs(input, checkout.sourceRevision)) !== receipt.inputs) {
    return yield* refuse(
      input.unitDirectory,
      `built at ${built.sourceRevision} from other sources than the checkout's; rebuild it`,
    );
  }
  return { buildMarker: built.buildMarker, sourceRevision: built.sourceRevision };
});
