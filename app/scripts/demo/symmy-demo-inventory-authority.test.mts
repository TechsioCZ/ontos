import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { Effect, FileSystem, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  OntosModuleDeploymentContractSchema,
} from '../../packages/core-runtime/src/modules/manifest.ts';
import {
  inventoryCandidateContractUrl,
  readSymmyInventoryCandidateContract,
} from './symmy-demo-inventory-authority.mts';

const rejected = (bytes: Uint8Array) =>
  readSymmyInventoryCandidateContract().pipe(
    Effect.provide(FileSystem.layerNoop({ readFile: () => Effect.succeed(bytes) })),
    Effect.result,
  );

it.effect('loads the complete genuine native generator output without dropping any contract fields', () =>
  Effect.gen(function* actualGeneratedContract() {
    // Use the native generator process, not the test bundler's separate opaque-registration registry.
    const generated = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { Effect, Schema } from 'effect';
      import { NodeServices } from '@effect/platform-node';
      import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
      import { OntosModuleDeploymentContractSchema } from './packages/core-runtime/src/modules/manifest.ts';
      const contract = await Effect.runPromise(deriveOntosModuleDeploymentContract({ vertical: 'inventory' })
        .pipe(Effect.provide(NodeServices.layer)));
      process.stdout.write(await Effect.runPromise(
        Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(contract)));
    `,
      ],
      {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf-8',
        env: { NODE_NO_WARNINGS: '1' },
        timeout: 20_000,
      },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const text = generated.stdout;
    const contract = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
      text,
    );
    const loaded = yield* readSymmyInventoryCandidateContract().pipe(
      Effect.provide(
        FileSystem.layerNoop({
          readFile: () => Effect.succeed(new TextEncoder().encode(text)),
        }),
      ),
    );
    expect(loaded).toEqual(contract);
    expect(
      loaded.manifest.systemWorkloads?.some((workloadKey) => workloadKey === 'commerce.inventory.source-provision'),
    ).toBe(true);
  }),
);

it.effect('fails closed when the complete shipped artifact is missing', () =>
  Effect.gen(function* missingArtifact() {
    const result = yield* readSymmyInventoryCandidateContract().pipe(
      Effect.provide(FileSystem.layerNoop({})),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe('The shipped Inventory candidate deployment contract is unavailable');
    }
  }),
);

it.effect('rejects partial or malformed contracts instead of reconstructing enrollment metadata', () =>
  Effect.gen(function* incompleteArtifact() {
    for (const text of ['{', '{}', '{"manifest":{"module":{"id":"commerce.inventory"}}}']) {
      const result = yield* rejected(new TextEncoder().encode(text));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe('The shipped Inventory candidate deployment contract is invalid');
      }
    }
  }),
);

it.effect('rejects invalid UTF-8 and artifacts above the native contract limit', () =>
  Effect.gen(function* artifactBoundary() {
    for (const [bytes, reason] of [
      [new Uint8Array([0xff]), 'The shipped Inventory candidate deployment contract is not UTF-8'],
      [
        new Uint8Array(ONTOS_MODULE_CONTRACT_MAX_BYTES + 1),
        'The shipped Inventory candidate deployment contract exceeds its size limit',
      ],
    ] as const) {
      const result = yield* rejected(bytes);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.reason).toBe(reason);
      }
    }
  }),
);

it('reads the generator output shipped by the actual release recipe, not owner source or a catalog substitute', () => {
  expect(
    inventoryCandidateContractUrl.pathname.endsWith(
      '/verticals/inventory/dist/public/.well-known/ontos-module-manifest.json',
    ),
  ).toBe(true);
  const recipe = readFileSync(new URL('../zerops/app-runtime-paths.txt', import.meta.url), 'utf-8');
  expect(recipe.split('\n')).toContain('app/verticals');
  const generator = readFileSync(new URL('../generate-ontos-module-contract.mts', import.meta.url), 'utf-8');
  expect(generator).toContain("platformPath.join(verticalDirectory, outputRootByTarget[target], 'public')");
  const source = readFileSync(new URL('symmy-demo-inventory-authority.mts', import.meta.url), 'utf-8');
  expect(source).not.toContain('generate-ontos-module-contract');
  expect(source).toContain('Schema.fromJsonString(OntosModuleDeploymentContractSchema)');
});

it('imports the actual native CLI with build-only generator packages unavailable, without DB or network', () => {
  const source = new URL('symmy-demo-inventory-authority.mts', import.meta.url);
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.includes('ultramodern-create') || specifier.includes('generate-ontos-module-contract')) {
        throw new Error('Build-only module is not shipped');
      }
      return nextResolve(specifier, context);
    }});
    const cli = await import(${JSON.stringify(source.href)});
    if (typeof cli.readSymmyInventoryCandidateContract !== 'function') throw new Error('CLI failed to load');
    console.log('PASS native CLI imports without build-only generator');
  `,
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf-8',
      env: { NODE_NO_WARNINGS: '1' },
      timeout: 20_000,
    },
  );
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout.trim()).toBe('PASS native CLI imports without build-only generator');
});
