import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import { deriveDeploymentAllowlist } from '../../api/modules/deployment-allowlist.ts';
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

test.each([
  ['missing topology entry', { 'property-registry': validUrls['property-registry'] }],
  ['unknown shell entry', { ...validUrls, 'shell-super-app': validUrls['property-registry'] }],
  [
    'duplicate normalized URL',
    { ...validUrls, 'documents-center': validUrls['property-registry'] },
  ],
  [
    'credentials',
    {
      ...validUrls,
      'property-registry':
        'http://user:secret@localhost:4101/.well-known/ontos-module-manifest.json',
    },
  ],
  ['fragment', { ...validUrls, 'property-registry': `${validUrls['property-registry']}#private` }],
  ['arbitrary path', { ...validUrls, 'property-registry': 'http://localhost:4101/private.json' }],
])('rejects %s configuration without authorizing a fetch', async (_label, manifests) => {
  await expect(
    Effect.runPromise(
      deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay(manifests),
        topology,
      }),
    ),
  ).rejects.toMatchObject({ code: 'deployment_allowlist_invalid' });
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
