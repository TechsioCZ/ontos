import { fileURLToPath } from 'node:url';
import {
  bindAccessGate,
  extractVerticalRuntimeSafeDescriptors,
  OntosDeploymentIdentitySchema,
  OntosModuleIdSchema,
  OntosModuleRequirementsSchema,
  OntosOperationContractSchema,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Context, DateTime, Effect, FileSystem, Layer, Path, Predicate, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { catalogRegistration } from '../../vertical.registration.ts';
import { makeCatalogScriptedAccess } from '../support/catalog-scripted-access-seam.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const descriptionSchema = Schema.Struct({
  deployment: OntosDeploymentIdentitySchema,
  moduleId: OntosModuleIdSchema,
  operationContracts: Schema.Array(OntosOperationContractSchema),
  requirements: OntosModuleRequirementsSchema,
});
const tenantId = '11111111-1111-4111-8111-111111111111';
const admittedPrincipalId = '22222222-2222-4222-8222-222222222222';
const deniedPrincipalId = '33333333-3333-4333-8333-333333333333';
const companyId = '44444444-4444-4444-8444-444444444444';
const now = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));
const staffPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:catalog-media-ordering-binding',
  authMethod: 'session',
  principalId: admittedPrincipalId,
  tenantId,
});
const scopeOf = (principalId: string) => ({
  ...staffPrincipal,
  correlationId: 'catalog-media-ordering-binding',
  legalEntityId: LegalEntityIdSchema.make(companyId),
  principalId: PrincipalIdSchema.make(principalId),
});
const questionOf = (principalId: string) => ({
  carrier: { accessDeclaration: createProductAction.descriptor.accessDeclaration },
  legalEntityScope: 'required' as const,
  now,
  scope: scopeOf(principalId),
});
const requirePreparation = <Preparation>(preparation: Preparation | undefined) =>
  preparation === undefined
    ? Effect.die('A binding with persisted currentness must supply preparation')
    : Effect.succeed(preparation);
/** The exact script the media-ordering receiver declares. */
const mediaOrderingAccessScript = {
  deniedPrincipalIds: [deniedPrincipalId],
  spec: { defaultAnswer: { outcome: 'ALLOWED' } },
} as const;

/**
 * The receiver declares its own access seam, and that seam must reach the runner *already bound*: a
 * live authority preparation cannot rebind a double, so re-binding the seam would answer a retryable
 * 503 for every protected entrypoint instead of the scripted answer the fixture declared.
 */
it.effect('binds the receiver scripted access gate once, with its declared refusals intact', () =>
  Effect.gen(function* scriptedReceiverGate() {
    const { bound } = yield* makeCatalogScriptedAccess(mediaOrderingAccessScript);
    // No live preparation contract: the runner takes the scripted decision path, never a preparation
    // this fixture never declared.
    expect(bound.prepare).toBeUndefined();
    expect((yield* bound.decide(questionOf(admittedPrincipalId))).outcome).toBe('ALLOWED');
    // The named principal holds nothing: refused for the capability and selects no company (O28).
    expect((yield* bound.decide(questionOf(deniedPrincipalId))).outcome).toBe('DENIED');
    expect(yield* bound.selectableLegalEntities({ now, scope: scopeOf(admittedPrincipalId) })).toEqual([companyId]);
    expect(yield* bound.selectableLegalEntities({ now, scope: scopeOf(deniedPrincipalId) })).toEqual([]);
  }),
);

/**
 * The production refusal the fixture must not weaken: the live binding supplies persisted currentness,
 * and a scripted seam cannot join it. That stays a typed, retryable refusal and never a denial or an
 * implicit allow.
 */
it.effect('keeps the production refusal for a gate that cannot prepare persisted authority', () =>
  Effect.gen(function* productionPreparationRefusal() {
    const { services } = yield* makeCatalogScriptedAccess(mediaOrderingAccessScript);
    const scripted = Context.get(services, AccessDecisionGate);
    // A gate that really cannot rebind to the caller's transaction: the scripted decisions without `rebind`.
    const unrebindable: AccessDecisionService = {
      decide: scripted.decide,
      decideMany: scripted.decideMany,
      list: scripted.list,
      selectableLegalEntities: scripted.selectableLegalEntities,
    };
    const bound = bindAccessGate(unrebindable, {
      ...inertAccessEnforcementPorts(),
      // A sentinel: the binding must refuse before reading any authority revisions.
      currentness: { read: () => Effect.die('Preparation must refuse before reading revisions') },
    });
    // The live binding supplies preparation; one that does not is not the production binding.
    const { prepare } = bound;
    const prepared = yield* requirePreparation(prepare);
    const failure = yield* Effect.flip(prepared(questionOf(admittedPrincipalId)));
    expect(Predicate.isTagged(failure, 'AccessDecisionUnavailable')).toBe(true);
    expect(failure.reason).toBe('The gate cannot prepare and join current persisted authority');
  }),
);

/**
 * Bundles one receiver the way the native suites do: esbuild with package imports left external. A
 * relative private Core import would inline a second copy of Core's private registration storage, so
 * the bundled Actions would stop being the ones the external `@app/core-runtime` resolves.
 */
const bundleReceiver = (entry: string) =>
  Effect.gen(function* bundleCatalogReceiver() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(appRoot, 'verticals/catalog');
    const parent = path.join(directory, '.cache');
    yield* fs.makeDirectory(parent, { recursive: true });
    const cache = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: 'ontos-1274-binding-' });
    const artifact = path.join(cache, 'receiver.mjs');
    const build = yield* ChildProcess.make(
      path.join(appRoot, 'node_modules/esbuild/bin/esbuild'),
      [
        path.join(directory, entry),
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      {
        cwd: directory,
        env: { APP_ENV_PATH: '/dev/null' },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const [buildExit, buildStderr] = yield* Effect.all(
      [build.exitCode, build.stderr.pipe(Stream.decodeText, Stream.mkString), Stream.runDrain(build.stdout)],
      { concurrency: 3 },
    );
    expect(buildExit, `esbuild exited with ${buildExit}\nstderr:\n${buildStderr}`).toBe(0);
    const source = yield* fs.readFileString(artifact);
    // Core stays external; the private markers below exist only inside Core's own modules.
    expect(source).toContain('@app/core-runtime/testing/actions');
    expect(source).not.toContain('test-action-service-binding');
    expect(source).not.toContain('@app/core-runtime/actions/runtime/ActionRuntime');
    return { artifact, directory };
  });

/**
 * The media-ordering receiver must also describe the owner's own registration through the external
 * Core — a second inlined Core instance could not read it. No database is involved.
 */
it.effect(
  'bundles the media-ordering receiver with one canonical Core instance and its own registration',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeReceiverBundle() {
        const { artifact, directory } = yield* bundleReceiver(
          'tests/support/catalog-media-ordering-receiver.fixture.ts',
        );
        const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe-media-ordering'], {
          cwd: directory,
          env: { APP_ENV_PATH: '/dev/null' },
          extendEnv: false,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        });
        const [describeExit, describeOutput, describeStderr] = yield* Effect.all(
          [
            describe.exitCode,
            describe.stdout.pipe(Stream.decodeText, Stream.mkString),
            describe.stderr.pipe(Stream.decodeText, Stream.mkString),
          ],
          { concurrency: 3 },
        );
        expect(describeExit, `receiver describe exited with ${describeExit}\nstderr:\n${describeStderr}`).toBe(0);
        const described = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(descriptionSchema))(describeOutput);
        const owner = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
        expect(described.deployment.appId).toBe('catalog');
        expect(described.moduleId).toBe(owner.moduleId);
        expect(described.requirements).toEqual(owner.requirements);
        expect(described.operationContracts).toEqual(owner.operationContracts);
      }),
    ).pipe(Effect.provide(nativeServices)),
  { timeout: 120_000 },
);

/** The whole-candidate receiver binds the same seam and must keep the same single Core instance. */
it.effect(
  'bundles the whole-candidate receiver with one canonical Core instance',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeWholeCandidateReceiverBundle() {
        yield* bundleReceiver('tests/support/whole-candidate-catalog-receiver.fixture.ts');
      }),
    ).pipe(Effect.provide(nativeServices)),
  { timeout: 120_000 },
);
