import { expect, rs, test } from '@rstest/core';
import { Effect, Exit } from 'effect';
import {
  DeploymentAllowlistConfigurationError,
  deriveDeploymentAllowlist,
} from '../../api/modules/deployment-allowlist.ts';
import { createModuleDeploymentAllowlistBuildInput } from '../../module-deployment-allowlist.config.ts';

const topology = {
  verticals: [
    { id: 'documents-center', kind: 'vertical' },
    { id: 'property-registry', kind: 'vertical' },
  ],
};

const overlay = (
  ontosModuleManifests: Readonly<Record<string, string>>,
  environment = 'development',
) => ({
  environment,
  ontosModuleManifests,
  schemaVersion: 1,
});

const validUrls = {
  'documents-center': 'http://localhost:4102/.well-known/ontos-module-manifest.json',
  'property-registry': 'http://127.0.0.1:4101/.well-known/ontos-module-manifest.json',
};

const PUBLIC_INVALID_REASON = 'The generated module deployment allowlist is invalid';

test('derives an immutable, topology-authorized and deterministically ordered allowlist', async () => {
  const allowlist = await Effect.runPromise(
    deriveDeploymentAllowlist({
      environment: 'development',
      overlay: overlay(validUrls),
      topology,
    }),
  );
  expect(allowlist.entries.map(({ appId }) => appId)).toEqual([
    'documents-center',
    'property-registry',
  ]);
  expect(Object.isFrozen(allowlist)).toBe(true);
  expect(Object.isFrozen(allowlist.entries)).toBe(true);
});

test('decodes a malformed injected object as a typed configuration error', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay(validUrls),
        topology: null,
      }),
    ),
  );

  expect(error).toBeInstanceOf(DeploymentAllowlistConfigurationError);
  expect(error).toMatchObject({
    code: 'deployment_allowlist_invalid',
    reason: PUBLIC_INVALID_REASON,
  });
});

test('decodes a missing injected member as a typed configuration error', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: { environment: 'development', schemaVersion: 1 },
        topology,
      }),
    ),
  );

  expect(error).toBeInstanceOf(DeploymentAllowlistConfigurationError);
  expect(error).toMatchObject({
    code: 'deployment_allowlist_invalid',
    reason: PUBLIC_INVALID_REASON,
  });
});

test('reports an invalid URL as a typed error with a safe reason', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay({ ...validUrls, 'documents-center': 'http://secret:private@[invalid' }),
        topology,
      }),
    ),
  );

  expect(error).toBeInstanceOf(DeploymentAllowlistConfigurationError);
  expect(error).toMatchObject({
    code: 'deployment_allowlist_invalid',
    reason: PUBLIC_INVALID_REASON,
  });
  expect(error.getOriginalFailure()).toBe('Invalid URL');
  expect(JSON.stringify(error)).not.toContain('Invalid URL');
  expect(String(error)).not.toContain('Invalid URL');
});

test.each([
  new Error('unexpected URL runtime failure'),
  new TypeError('unexpected URL type failure'),
])('defers URL parsing and preserves runtime defects: %s', async (defect) => {
  const parse = rs.spyOn(URL, 'parse').mockImplementation(() => {
    throw defect;
  });
  try {
    const effect = deriveDeploymentAllowlist({
      environment: 'development',
      overlay: overlay(validUrls),
      topology,
    });
    expect(parse).not.toHaveBeenCalled();
    expect(await Effect.runPromiseExit(effect)).toEqual(Exit.die(defect));
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

test('defers input accessor evaluation and preserves its defect', async () => {
  const defect = new TypeError('unexpected environment accessor failure');
  let reads = 0;
  const effect = deriveDeploymentAllowlist({
    get environment(): never {
      reads += 1;
      throw defect;
    },
    overlay: overlay(validUrls),
    topology,
  });

  expect(reads).toBe(0);
  expect(await Effect.runPromiseExit(effect)).toEqual(Exit.die(defect));
  expect(reads).toBe(1);
});

test.each([
  [
    'missing topology entry',
    { 'property-registry': validUrls['property-registry'] },
    'allowlist keys do not exactly match topology verticals',
  ],
  [
    'unknown shell entry',
    { ...validUrls, 'shell-super-app': validUrls['property-registry'] },
    'allowlist keys do not exactly match topology verticals',
  ],
  [
    'duplicate normalized URL',
    { ...validUrls, 'documents-center': validUrls['property-registry'] },
    'allowlist contains duplicate normalized URLs',
  ],
  [
    'credentials',
    {
      ...validUrls,
      'property-registry':
        'http://user:secret@localhost:4101/.well-known/ontos-module-manifest.json',
    },
    'contract URL contains unsupported authority or path data',
  ],
  [
    'fragment',
    { ...validUrls, 'property-registry': `${validUrls['property-registry']}#private` },
    'contract URL contains unsupported authority or path data',
  ],
  [
    'arbitrary path',
    { ...validUrls, 'property-registry': 'http://localhost:4101/private.json' },
    'contract URL contains unsupported authority or path data',
  ],
])('rejects %s configuration without authorizing a fetch', async (_label, manifests, detail) => {
  const error = await Effect.runPromise(
    Effect.flip(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay(manifests),
        topology,
      }),
    ),
  );
  expect(error).toMatchObject({
    code: 'deployment_allowlist_invalid',
    reason: PUBLIC_INVALID_REASON,
  });
  expect(error.getOriginalFailure()).toBe(detail);
  expect(JSON.stringify(error)).not.toContain(detail);
  expect(String(error)).not.toContain(detail);
});

test('retains schema decode details privately', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay(validUrls),
        topology: {
          verticals: [{ id: 'secret invalid app id', kind: 'vertical' }],
        },
      }),
    ),
  );
  const detail = error.getOriginalFailure();
  expect(error.reason).toBe(PUBLIC_INVALID_REASON);
  expect(detail).toEqual(expect.any(String));
  expect(JSON.stringify(error)).not.toContain(detail as string);
  expect(String(error)).not.toContain(detail as string);
});

test('requires HTTPS outside loopback development', async () => {
  const productionUrls = {
    'documents-center': 'https://documents.example.test/.well-known/ontos-module-manifest.json',
    'property-registry': 'https://property.example.test/.well-known/ontos-module-manifest.json',
  };
  await expect(
    Effect.runPromise(
      deriveDeploymentAllowlist({
        environment: 'production',
        overlay: overlay(
          {
            ...productionUrls,
            'property-registry': validUrls['property-registry'],
          },
          'production',
        ),
        topology,
      }),
    ),
  ).rejects.toMatchObject({ code: 'deployment_allowlist_invalid' });
  await expect(
    Effect.runPromise(
      deriveDeploymentAllowlist({
        environment: 'production',
        overlay: overlay(productionUrls, 'production'),
        topology,
      }),
    ),
  ).resolves.toMatchObject({ entries: expect.any(Array) });
});

test('builds production discovery from deployment URL configuration, never the development overlay', () => {
  const productionTopology = {
    verticals: [
      {
        cloudflare: { publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY' },
        id: 'property-registry',
        kind: 'vertical',
      },
    ],
  };
  const configured = createModuleDeploymentAllowlistBuildInput({
    cloudflareDeployEnabled: true,
    developmentOverlay: overlay({
      'property-registry': 'http://localhost:4101/.well-known/ontos-module-manifest.json',
    }),
    readEnvironment: (name) =>
      name === 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY'
        ? 'https://property.example.test'
        : undefined,
    topology: productionTopology,
  });

  expect(configured.environment).toBe('production');
  expect(configured.overlay).toEqual({
    environment: 'production',
    ontosModuleManifests: {
      'property-registry': 'https://property.example.test/.well-known/ontos-module-manifest.json',
    },
    schemaVersion: 1,
  });
  expect(() =>
    createModuleDeploymentAllowlistBuildInput({
      cloudflareDeployEnabled: true,
      developmentOverlay: overlay({}),
      readEnvironment: () => 'http://localhost:4101',
      topology: productionTopology,
    }),
  ).toThrow(/credential-free HTTPS origin/u);
});
