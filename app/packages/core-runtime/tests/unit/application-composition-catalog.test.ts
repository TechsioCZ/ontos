import { createHash } from 'node:crypto';

import { Effect, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import { moduleReleaseWorkerName } from '../../src/http/module-release-identity.ts';
import { buildApplicationCompositionCatalog } from '../../src/modules/application-composition-catalog.ts';
import {
  ApplicationCompositionCloudflareWorkerBackendSchema,
  ApplicationCompositionSchema,
  ApplicationCompositionValidationError,
  canonicalizeApplicationComposition,
  ONTOS_APPLICATION_COMPOSITION_MAX_CONTRACT_BYTES,
  ONTOS_APPLICATION_COMPOSITION_MAX_MODULES,
  ONTOS_SHELL_CONTRIBUTION_ABI,
} from '../../src/modules/application-composition.ts';
import type {
  ApplicationComposition,
  ApplicationCompositionModule,
} from '../../src/modules/application-composition.ts';
import { ONTOS_MODULE_CONTRACT_MAX_BYTES, OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import type { OntosModuleDeploymentContract, OntosOutboxSubscriptionContract } from '../../src/modules/manifest.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';

const digest = (document: string): string => createHash('sha256').update(document, 'utf-8').digest('hex');
const workerVersionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const anotherWorkerVersionId = 'a38f1f86-7c38-4507-b592-48e03025baaf';
const workerVersionSchema = ApplicationCompositionCloudflareWorkerBackendSchema.fields.versionId;
const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema, { onExcessProperty: 'error' });
const contractJsonSchema = Schema.fromJsonString(OntosModuleDeploymentContractSchema);
const encodeContract = Schema.encodeSync(contractJsonSchema);

const contract = (
  appId = 'unregistered-service',
  moduleId = 'unregistered.module',
  outboxSubscriptions: readonly OntosOutboxSubscriptionContract[] = [],
) => decodeContract(makeModuleContractFixture({ appId, moduleId, outboxSubscriptions }));

const moduleFromContract = (
  document: OntosModuleDeploymentContract,
  contractDocument = encodeContract(document),
): ApplicationCompositionModule => ({
  allowedContributions: [],
  backend: { baseUrl: `https://${document.deployment.appId}.backend.example/`, transport: 'node-http' },
  contract: {
    sha256: digest(contractDocument),
    url: `https://${document.deployment.appId}.example/.well-known/ontos-module-manifest.json`,
  },
  contractDocument,
  dependencies: [],
  deployment: document.deployment,
  federation: { execution: 'server' },
  moduleId: document.manifest.module.id,
  publicContract: {
    id: document.manifest.module.id,
    sha256: digest(contractDocument),
    version: document.schemaVersion,
  },
  requiredCoreCapabilities: [],
  requiredShellAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
  sharedSingletons: [],
});

const composition = (modules: readonly ApplicationCompositionModule[] = []): ApplicationComposition => {
  const input: ApplicationComposition = {
    modules,
    revision: '0'.repeat(64),
    schemaVersion: '2',
    shell: {
      contributionAbi: ONTOS_SHELL_CONTRIBUTION_ABI,
      coreCapabilities: [],
      deployment: { appId: 'shell-super-app', buildMarker: 'shell-build-1' },
      federationManifest: {
        sha256: 'b'.repeat(64),
        url: 'https://shell.example/artifacts/shell-build-1/mf-manifest.json',
      },
      runtimeContract: {
        sha256: 'c'.repeat(64),
        url: 'https://shell.example/artifacts/shell-build-1/runtime-contract.json',
      },
      sharedSingletons: [],
    },
  };
  return { ...input, revision: digest(canonicalizeApplicationComposition(input)) };
};

const assertInvalid = Effect.fn(function* assertInvalid(input: ApplicationComposition, reason: RegExp) {
  const error = yield* Effect.flip(buildApplicationCompositionCatalog(input));
  expect(error).toBeInstanceOf(ApplicationCompositionValidationError);
  expect(error.reason).toMatch(reason);
});

const browserModule = (
  routePaths: readonly string[] = ['/new-page'],
  ownerName = 'new',
): ApplicationCompositionModule => {
  const moduleId = `${ownerName}.browser`;
  const remoteName = `${ownerName}Browser`;
  const base = contract(`${ownerName}-browser-service`, moduleId);
  const components = routePaths.map((_routePath, index) => ({
    expose: index === 0 ? './NewPage' : `./NewPage${index}`,
    key: index === 0 ? `${moduleId}.new-page` : `${moduleId}.new-page-${index}`,
    mfBoundaryId: remoteName,
  }));
  const pages = routePaths.map((routePath, index) => {
    const contributionKey = index === 0 ? `${moduleId}.page.new-page` : `${moduleId}.page.new-page-${index}`;
    return {
      componentKey: index === 0 ? `${moduleId}.new-page` : `${moduleId}.new-page-${index}`,
      contributionKey,
      entrypoint: {
        access: 'read',
        authorization: { kind: 'authenticated_principal' },
        entrypointKey: contributionKey,
        moduleKey: moduleId,
        role: 'page',
        scope: 'tenant',
      },
      expose: index === 0 ? './NewPage' : `./NewPage${index}`,
      routePath,
    };
  });
  const browserContract = decodeContract({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        components,
        shellContributions: {
          ...base.manifest.publicSurface.shellContributions,
          pages,
        },
      },
    },
  });
  return {
    ...moduleFromContract(browserContract),
    allowedContributions: browserContract.manifest.publicSurface.shellContributions.pages.map(
      ({ contributionKey }) => contributionKey,
    ),
    federation: {
      execution: 'browser',
      exposes: components.map(({ expose }) => expose),
      manifest: { sha256: 'a'.repeat(64), url: `https://${ownerName}-browser-service.example/mf-manifest.json` },
      remoteName,
    },
  };
};

it.effect('accepts an intentionally empty approved inventory', () =>
  Effect.gen(function* emptyInventory() {
    const catalog = yield* buildApplicationCompositionCatalog(composition());
    expect(catalog.contracts).toEqual([]);
    expect(catalog.deploymentAppIds).toEqual([]);
    expect(catalog.moduleIds).toEqual([]);
    expect(catalog.outboxSubscriptions).toEqual([]);
  }),
);

it.effect('installs previously unknown module identities without a topology allowlist or remote fetch', () =>
  Effect.gen(function* newIdentities() {
    const catalog = yield* buildApplicationCompositionCatalog(
      composition([moduleFromContract(contract()), moduleFromContract(contract('another-service', 'another.module'))]),
    );
    expect(catalog.moduleIds).toEqual(['another.module', 'unregistered.module']);
    expect(catalog.getByModuleId('unregistered.module')?.deployment.appId).toBe('unregistered-service');
    expect(catalog.getByDeploymentAppId('another-service')?.manifest.module.id).toBe('another.module');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.contracts)).toBe(true);
    const installed = catalog.getByModuleId('unregistered.module');
    expect(Object.isFrozen(installed)).toBe(true);
    expect(Object.isFrozen(installed?.deployment)).toBe(true);
    expect(Object.isFrozen(installed?.manifest.publicSurface.shellContributions)).toBe(true);
    expect(Object.isFrozen(installed?.manifest.publicSurface.shellContributions.pages)).toBe(true);
  }),
);

it.effect('verifies exact UTF-8 documents without normalizing insignificant JSON whitespace', () =>
  Effect.gen(function* exactDocuments() {
    const document = {
      ...contract(),
      manifest: {
        ...contract().manifest,
        module: {
          ...contract().manifest.module,
          description: 'Příliš žluťoučký kůň',
        },
      },
    };
    const compactDocument = yield* Schema.encodeEffect(contractJsonSchema)(document);
    const prettyDocument = ` \n${compactDocument}\n `;
    const module = moduleFromContract(document, prettyDocument);
    const catalog = yield* buildApplicationCompositionCatalog(composition([module]));
    expect(catalog.getByModuleId(module.moduleId)?.manifest.module.description).toBe('Příliš žluťoučký kůň');
    yield* assertInvalid(composition([{ ...module, contractDocument: compactDocument }]), /digest/u);
  }),
);

it.effect('rejects an unrepresentable UTF-8 source even when its lossy encoded bytes are pinned', () =>
  Effect.gen(function* invalidUtf8() {
    const module = moduleFromContract(contract());
    const contractDocument = `${module.contractDocument}\uD800`;
    yield* assertInvalid(
      composition([
        {
          ...module,
          contract: { ...module.contract, sha256: digest(contractDocument) },
          contractDocument,
          publicContract: { ...module.publicContract, sha256: digest(contractDocument) },
        },
      ]),
      /UTF-8/u,
    );
  }),
);

it.effect('rejects invalid JSON, excess contract properties, and unsupported embedded contract schemas', () =>
  Effect.gen(function* invalidDocuments() {
    const base = contract();
    for (const contractDocument of [
      '{',
      encodeContract(base).replace('"schemaVersion":"2"', '"schemaVersion":"0"'),
      encodeContract(base).replace('"schemaVersion":"2"', '"schemaVersion":"2","legacy":true'),
    ]) {
      yield* assertInvalid(composition([moduleFromContract(base, contractDocument)]), /invalid or unsupported/u);
    }
  }),
);

it.effect('requires both artifact claims to pin the same exact contract bytes', () =>
  Effect.gen(function* independentDigestClaims() {
    const module = moduleFromContract(contract());
    for (const modified of [
      { ...module, contract: { ...module.contract, sha256: 'b'.repeat(64) } },
      { ...module, publicContract: { ...module.publicContract, sha256: 'b'.repeat(64) } },
    ]) {
      yield* assertInvalid(composition([modified]), /digest/u);
    }
  }),
);

it.effect('rejects module, deployment, build marker, and public contract identity contradictions', () =>
  Effect.gen(function* identityClaims() {
    const module = moduleFromContract(contract());
    for (const modified of [
      { ...module, moduleId: 'another.module' },
      { ...module, deployment: { ...module.deployment, appId: 'another-service' } },
      { ...module, deployment: { ...module.deployment, buildMarker: 'another-build' } },
      { ...module, publicContract: { ...module.publicContract, id: 'another.module' } },
      { ...module, publicContract: { ...module.publicContract, version: '3' } },
    ]) {
      yield* assertInvalid(composition([modified]), /observed deployment contract/u);
    }
  }),
);

it.effect('rejects deployment markers that cannot be carried by signed Gateway credentials', () =>
  Effect.gen(function* boundedMarkers() {
    const base = contract();
    for (const buildMarker of [' padded-build', 'padded-build ', 'x'.repeat(201), '.', '..', '\uD800', '\uDC00']) {
      const jsonMarker = buildMarker.replaceAll('\uD800', String.raw`\uD800`).replaceAll('\uDC00', String.raw`\uDC00`);
      const contractDocument = encodeContract(base).replace(base.deployment.buildMarker, jsonMarker);
      yield* assertInvalid(composition([moduleFromContract(base, contractDocument)]), /invalid or unsupported/u);
      const module = moduleFromContract(base);
      yield* assertInvalid(
        { ...composition([module]), modules: [{ ...module, deployment: { ...module.deployment, buildMarker } }] },
        /supported schema/u,
      );
      const input = composition();
      yield* assertInvalid(
        { ...input, shell: { ...input.shell, deployment: { ...input.shell.deployment, buildMarker } } },
        /supported schema/u,
      );
    }
  }),
);

it.effect('accepts approved browser contributions with their declared native Federation expose', () =>
  Effect.gen(function* browserInventory() {
    const catalog = yield* buildApplicationCompositionCatalog(composition([browserModule()]));
    expect(catalog.getByModuleId('new.browser')?.manifest.publicSurface.shellContributions.pages).toHaveLength(1);
  }),
);

it.effect('rejects identical or parameter-equivalent Shell page routes across module owners', () =>
  Effect.gen(function* conflictingOwnerRoutes() {
    for (const [firstRoute, secondRoute] of [
      ['/future/orders', '/future/orders'],
      ['/future/orders/:orderId', '/future/orders/:recordId'],
      ['/future/:accountId/orders/:orderId', '/future/:customerId/orders/:recordId'],
    ]) {
      if (firstRoute === undefined || secondRoute === undefined) {
        return yield* Effect.die('invalid conflicting route fixture');
      }
      yield* assertInvalid(
        composition([browserModule([firstRoute]), browserModule([secondRoute], 'other')]),
        /ambiguous Shell page routes/u,
      );
    }
    return yield* Effect.void;
  }),
);

it.effect('rejects duplicate and parameter-equivalent routes within one module owner', () =>
  Effect.gen(function* conflictingLocalRoutes() {
    for (const routePaths of [
      ['/future/orders', '/future/orders'],
      ['/future/orders/:orderId', '/future/orders/:recordId'],
    ]) {
      yield* assertInvalid(composition([browserModule(routePaths)]), /ambiguous Shell page routes/u);
    }
  }),
);

it.effect('rejects module pages claiming Shell roots or any route below them', () =>
  Effect.gen(function* reservedShellRoutes() {
    for (const root of [
      'login',
      'sign-in',
      'sign-out',
      'settings',
      'modules',
      'resources',
      'search',
      'api',
      'assets',
      'bundles',
      'locales',
      'shell-super-app-api',
      'module-api',
      'static',
    ]) {
      for (const routePath of [`/${root}`, `/${root}/future`, `/${root}/:recordId`]) {
        yield* assertInvalid(composition([browserModule([routePath])]), /reserved Shell route/u);
      }
    }
    for (const routePath of ['/:root', '/:root/future', '/:root/orders/:orderId']) {
      yield* assertInvalid(composition([browserModule([routePath])]), /reserved Shell route/u);
    }
  }),
);

it.effect('rejects encoded, noncanonical, and unsafe route templates from the exact admitted contract bytes', () =>
  Effect.gen(function* noncanonicalRoutes() {
    const module = browserModule(['/future/orders']);
    for (const routePath of [
      '/',
      '/.well-known',
      '/%6cogin',
      '/future/%6frders',
      '/future/orders/%3AorderId',
      '/future/orders/:orderId%2fother',
      '/future/orders/:orderId/:orderId',
      '/future/orders/:constructor',
      '/future/orders/:prototype',
      '/future/orders/:__proto__',
      '/future//orders',
      '/future/orders/',
      '/future/..',
    ]) {
      const contractDocument = module.contractDocument.replace(
        '"routePath":"/future/orders"',
        `"routePath":"${routePath}"`,
      );
      expect(contractDocument).not.toBe(module.contractDocument);
      yield* assertInvalid(
        composition([
          {
            ...module,
            contract: { ...module.contract, sha256: digest(contractDocument) },
            contractDocument,
            publicContract: { ...module.publicContract, sha256: digest(contractDocument) },
          },
        ]),
        /invalid or unsupported/u,
      );
    }
  }),
);

it.effect('admits overlapping routes with native static precedence across distinct owners', () =>
  Effect.gen(function* staticallyRankedRoutes() {
    const catalog = yield* buildApplicationCompositionCatalog(
      composition([
        browserModule(['/future/orders/create', '/future/orders/:orderId']),
        browserModule(['/future/:section/create', '/future/:section/:recordId', '/future/order-history'], 'other'),
      ]),
    );
    expect(catalog.moduleIds).toEqual(['new.browser', 'other.browser']);
    expect(catalog.getByModuleId('new.browser')?.manifest.publicSurface.shellContributions.pages).toHaveLength(2);
    expect(catalog.getByModuleId('other.browser')?.manifest.publicSurface.shellContributions.pages).toHaveLength(3);
  }),
);

it.effect('rejects contribution, component boundary, and expose claims absent from the embedded contract', () =>
  Effect.gen(function* browserClaims() {
    const module = browserModule();
    if (module.federation.execution !== 'browser') {
      return yield* Effect.die('invalid browser fixture');
    }
    for (const modified of [
      { ...module, allowedContributions: [] },
      { ...module, allowedContributions: ['new.browser.page.other'] },
      { ...module, federation: { ...module.federation, remoteName: 'anotherBoundary' } },
      { ...module, federation: { ...module.federation, exposes: [] } },
      { ...module, federation: { execution: 'server' as const } },
    ]) {
      yield* assertInvalid(composition([modified]), /observed deployment contract/u);
    }
    return yield* Effect.void;
  }),
);

it.effect('rejects a page referencing an undeclared component even when its artifact claims agree', () =>
  Effect.gen(function* componentReferences() {
    const original = browserModule();
    const document = yield* Schema.decodeEffect(contractJsonSchema)(original.contractDocument);
    const modified = moduleFromContract({
      ...document,
      manifest: {
        ...document.manifest,
        publicSurface: {
          ...document.manifest.publicSurface,
          components: document.manifest.publicSurface.components.map((component) => ({
            ...component,
            key: 'new.browser.undeclared-page',
          })),
        },
      },
    });
    yield* assertInvalid(
      composition([
        {
          ...modified,
          allowedContributions: original.allowedContributions,
          federation: original.federation,
        },
      ]),
      /component expose/u,
    );
  }),
);

it.effect('rejects a contribution selecting an expose that differs from its declared component', () =>
  Effect.gen(function* contributionExpose() {
    const original = browserModule();
    const document = yield* Schema.decodeEffect(contractJsonSchema)(original.contractDocument);
    const modified = moduleFromContract({
      ...document,
      manifest: {
        ...document.manifest,
        publicSurface: {
          ...document.manifest.publicSurface,
          shellContributions: {
            ...document.manifest.publicSurface.shellContributions,
            pages: document.manifest.publicSurface.shellContributions.pages.map((page) => ({
              ...page,
              expose: './AnotherPage',
            })),
          },
        },
      },
    });
    yield* assertInvalid(
      composition([
        {
          ...modified,
          allowedContributions: original.allowedContributions,
          federation: original.federation,
        },
      ]),
      /component expose/u,
    );
  }),
);

it.effect('rejects the complete inventory when one embedded contract is invalid', () =>
  assertInvalid(
    composition([
      moduleFromContract(contract('healthy-service', 'healthy.module')),
      moduleFromContract(contract('broken-service', 'broken.module'), '{}'),
    ]),
    /invalid or unsupported/u,
  ),
);

const subscription = (moduleId: string): OntosOutboxSubscriptionContract => ({
  consumerModuleKey: moduleId,
  entrypoint: {
    access: 'background',
    authorization: { kind: 'owner_local_background' },
    entrypointKey: 'shared.projector',
    moduleKey: moduleId,
    role: 'worker',
    scope: 'tenant',
  },
  producerModuleKey: 'external.events',
  topic: 'external.events.created',
  workerKey: 'shared.projector',
});

it.effect('rejects duplicate worker subscriptions across otherwise valid modules', () =>
  assertInvalid(
    composition([
      moduleFromContract(contract('first-consumer', 'first.consumer', [subscription('first.consumer')])),
      moduleFromContract(contract('second-consumer', 'second.consumer', [subscription('second.consumer')])),
    ]),
    /complete installed catalog/u,
  ),
);

it.effect('rejects a revision that does not address the complete immutable bundle', () =>
  Effect.gen(function* revisionClaims() {
    const input = composition([moduleFromContract(contract())]);
    yield* assertInvalid({ ...input, revision: 'f'.repeat(64) }, /revision.*immutable content/u);
    const changed = { ...input, modules: [moduleFromContract(contract('another-service', 'another.module'))] };
    yield* assertInvalid(changed, /revision.*immutable content/u);
  }),
);

it.effect('accepts a standard Worker pinned to the exact approved deployment release', () =>
  Effect.gen(function* nativeWorkerPlacement() {
    const module = moduleFromContract(contract());
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    const catalog = yield* buildApplicationCompositionCatalog(
      composition([
        {
          ...module,
          backend: {
            baseUrl: `https://${workerName}.fixture.workers.dev/`,
            transport: 'cloudflare-worker',
            versionId: yield* Schema.decodeEffect(workerVersionSchema)(workerVersionId),
            workerName,
          },
        },
      ]),
    );
    expect(catalog.moduleIds).toEqual([module.moduleId]);
  }),
);

it.effect('rejects unsafe or noncanonical Node transport destinations before catalog admission', () =>
  Effect.gen(function* unsafeNodePlacement() {
    const module = moduleFromContract(contract());
    const base = composition([module]);
    for (const baseUrl of [
      'http://backend.example/',
      'https://user:password@backend.example/',
      'https://backend.example/?release=latest',
      'https://backend.example/#release',
      'https://backend.example/private-api',
      'https://BACKEND.example/',
      'https://backend.example:443/',
      'https://backend.example',
    ]) {
      yield* assertInvalid(
        {
          ...base,
          modules: [{ ...module, backend: { baseUrl, transport: 'node-http' } }],
        },
        /supported schema/u,
      );
    }
    const unsupportedBackend = {
      baseUrl: 'https://backend.example/',
      deployment: module.deployment,
      transport: 'node-http' as const,
    };
    yield* assertInvalid(
      {
        ...base,
        modules: [{ ...module, backend: unsupportedBackend }],
      },
      /supported schema/u,
    );
  }),
);

it.effect('allows an explicit canonical loopback Node transport for an isolated local deployment', () =>
  Effect.gen(function* localNodePlacement() {
    const module = moduleFromContract(contract());
    const catalog = yield* buildApplicationCompositionCatalog(
      composition([
        {
          ...module,
          backend: { baseUrl: 'http://127.0.0.1:4109/', transport: 'node-http' },
        },
      ]),
    );
    expect(catalog.moduleIds).toEqual([module.moduleId]);
  }),
);

it.effect('rejects standard Worker identities for another deployment or build marker', () =>
  Effect.gen(function* incorrectWorkerPlacement() {
    const module = moduleFromContract(contract());
    for (const workerName of [
      yield* moduleReleaseWorkerName('another-service', module.deployment.buildMarker),
      yield* moduleReleaseWorkerName(module.deployment.appId, 'another-build'),
    ]) {
      yield* assertInvalid(
        composition([
          {
            ...module,
            backend: {
              baseUrl: `https://${workerName}.fixture.workers.dev/`,
              transport: 'cloudflare-worker',
              versionId: yield* Schema.decodeEffect(workerVersionSchema)(workerVersionId),
              workerName,
            },
          },
        ]),
        /backend|release|script/u,
      );
    }
  }),
);

it.effect('rejects unsafe Worker origins and removed dispatch fields without a fallback', () =>
  Effect.gen(function* standardWorkerOrigins() {
    const module = moduleFromContract(contract());
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    const backend = {
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker' as const,
      versionId: yield* Schema.decodeEffect(workerVersionSchema)(workerVersionId),
      workerName,
    };
    const input = composition([{ ...module, backend }]);
    for (const baseUrl of [
      `http://${workerName}.fixture.workers.dev/`,
      `https://${workerName}.fixture.example/`,
      'https://another-worker.fixture.workers.dev/',
      `https://${workerName}.fixture.workers.dev:8443/`,
      `https://user:password@${workerName}.fixture.workers.dev/`,
      `https://${workerName}.fixture.workers.dev/path`,
      `https://${workerName}.fixture.workers.dev/?release=current`,
      `https://${workerName}.fixture.workers.dev/#release`,
    ]) {
      yield* assertInvalid(
        { ...input, modules: [{ ...module, backend: { ...backend, baseUrl } }] },
        /supported schema|exact deployment release/u,
      );
    }
    for (const removedFields of [{ namespace: 'ontos-stage' }, { scriptName: workerName }]) {
      const incompatibleBackend = { ...backend, ...removedFields };
      yield* assertInvalid({ ...input, modules: [{ ...module, backend: incompatibleBackend }] }, /supported schema/u);
    }
    const oldDispatchBackend = {
      namespace: 'ontos-stage',
      scriptName: workerName,
      transport: 'cloudflare-dispatch' as const,
    };
    const invalidDispatchSchema = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema, {
      onExcessProperty: 'error',
    })({
      ...input,
      modules: [{ ...module, backend: oldDispatchBackend }],
    }).pipe(
      Effect.as(false),
      Effect.catchTag('SchemaError', () => Effect.succeed(true)),
    );
    expect(invalidDispatchSchema).toBe(true);
  }),
);

it.effect('requires an explicit native Worker version UUID before catalog admission', () =>
  Effect.gen(function* standardWorkerVersion() {
    const module = moduleFromContract(contract());
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    const backend = {
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker' as const,
      versionId: yield* Schema.decodeEffect(workerVersionSchema)(workerVersionId),
      workerName,
    };
    const input = composition([{ ...module, backend }]);
    for (const versionId of ['', 'not-a-cloudflare-version', '023e105f2a424f8ba1c173f6a2a30c0f']) {
      const malformedVersionRejected = yield* Schema.decodeEffect(ApplicationCompositionSchema, {
        onExcessProperty: 'error',
      })({ ...input, modules: [{ ...module, backend: { ...backend, versionId } }] }).pipe(
        Effect.as(false),
        Effect.catchTag('SchemaError', () => Effect.succeed(true)),
      );
      expect(malformedVersionRejected).toBe(true);
    }
    const missingVersionRejected = yield* Schema.decodeUnknownEffect(ApplicationCompositionSchema, {
      onExcessProperty: 'error',
    })({ ...input, modules: [{ ...module, backend: Struct.omit(backend, ['versionId']) }] }).pipe(
      Effect.as(false),
      Effect.catchTag('SchemaError', () => Effect.succeed(true)),
    );
    expect(missingVersionRejected).toBe(true);
  }),
);

it.effect('pins the exact native Worker version UUID in the composition revision', () =>
  Effect.gen(function* nativeWorkerVersionRevision() {
    const module = moduleFromContract(contract());
    const workerName = yield* moduleReleaseWorkerName(module.deployment.appId, module.deployment.buildMarker);
    const backend = {
      baseUrl: `https://${workerName}.fixture.workers.dev/`,
      transport: 'cloudflare-worker' as const,
      versionId: yield* Schema.decodeEffect(workerVersionSchema)(workerVersionId),
      workerName,
    };
    const input = composition([{ ...module, backend }]);
    for (const rawVersionId of [anotherWorkerVersionId, workerVersionId.toUpperCase()]) {
      const versionId = yield* Schema.decodeEffect(workerVersionSchema)(rawVersionId);
      const modified = { ...module, backend: { ...backend, versionId } };
      yield* assertInvalid({ ...input, modules: [modified] }, /revision.*immutable content/u);
      const repinned = composition([modified]);
      expect(repinned.revision).not.toBe(input.revision);
      expect(canonicalizeApplicationComposition(repinned)).toContain(versionId);
      expect((yield* buildApplicationCompositionCatalog(repinned)).moduleIds).toEqual([module.moduleId]);
    }
  }),
);

it.effect('addresses backend placement in the immutable composition revision', () => {
  const module = moduleFromContract(contract());
  const base = composition([module]);
  return assertInvalid(
    {
      ...base,
      modules: [{ ...module, backend: { baseUrl: 'https://another.backend.example/', transport: 'node-http' } }],
    },
    /revision.*immutable content/u,
  );
});

it.effect('addresses both exact Shell artifact references in the immutable composition revision', () =>
  Effect.gen(function* pinnedShellArtifacts() {
    const input = composition();
    yield* assertInvalid(
      {
        ...input,
        shell: { ...input.shell, federationManifest: { ...input.shell.federationManifest, sha256: 'd'.repeat(64) } },
      },
      /revision.*immutable content/u,
    );
    yield* assertInvalid(
      {
        ...input,
        shell: { ...input.shell, runtimeContract: { ...input.shell.runtimeContract, sha256: 'e'.repeat(64) } },
      },
      /revision.*immutable content/u,
    );
  }),
);

it.effect('rejects separate modules claiming the same native Node backend destination', () => {
  const first = moduleFromContract(contract('first-backend', 'first.backend'));
  const second = moduleFromContract(contract('second-backend', 'second.backend'));
  return assertInvalid(
    composition([first, { ...second, backend: first.backend }]),
    /duplicate.*backend|backend.*duplicate/u,
  );
});

it.effect('rejects inventory counts above the approved module bound', () =>
  Effect.gen(function* moduleBound() {
    const modules = Array.from({ length: ONTOS_APPLICATION_COMPOSITION_MAX_MODULES + 1 }, (_, index) =>
      moduleFromContract(contract(`service-${index}`, `module${index}.core`)),
    );
    yield* assertInvalid({ ...composition(), modules }, /supported schema/u);
  }),
);

it.effect('bounds aggregate embedded contract bytes while each individual document fits', () =>
  Effect.gen(function* aggregateBytes() {
    const description = 'x'.repeat(900_000);
    const modules = Array.from({ length: 5 }, (_, index) => {
      const base = contract(`service-${index}`, `module${index}.core`);
      return moduleFromContract({
        ...base,
        manifest: { ...base.manifest, module: { ...base.manifest.module, description } },
      });
    });
    expect(
      modules.reduce((sum, module) => sum + Buffer.byteLength(module.contractDocument, 'utf-8'), 0),
    ).toBeGreaterThan(ONTOS_APPLICATION_COMPOSITION_MAX_CONTRACT_BYTES);
    yield* assertInvalid(composition(modules), /complete contract byte budget/u);
  }),
);

it.effect('rejects an oversized individual contract before catalog admission', () => {
  const base = contract();
  return assertInvalid(
    composition([
      moduleFromContract({
        ...base,
        manifest: {
          ...base.manifest,
          module: { ...base.manifest.module, description: 'x'.repeat(ONTOS_MODULE_CONTRACT_MAX_BYTES) },
        },
      }),
    ]),
    /complete contract byte budget/u,
  );
});
