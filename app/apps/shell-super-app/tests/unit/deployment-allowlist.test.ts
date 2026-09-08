import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

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
  environment = 'development'
) => ({
  environment,
  ontosModuleManifests,
  schemaVersion: 1,
});

const validUrls = {
  'documents-center':
    'http://localhost:4102/.well-known/ontos-module-manifest.json',
  'property-registry':
    'http://127.0.0.1:4101/.well-known/ontos-module-manifest.json',
};

it.effect(
  'derives an immutable, topology-authorized and deterministically ordered allowlist',
  () =>
    Effect.gen(function* testProgram1() {
      const allowlist = yield* deriveDeploymentAllowlist({
        environment: 'development',
        overlay: overlay(validUrls),
        topology,
      });
      expect(allowlist.entries.map(({ appId }) => appId)).toEqual([
        'documents-center',
        'property-registry',
      ]);
      expect(Object.isFrozen(allowlist)).toBe(true);
      expect(Object.isFrozen(allowlist.entries)).toBe(true);
    })
);

it.effect.each([
  [
    'missing topology entry',
    { 'property-registry': validUrls['property-registry'] },
  ],
  [
    'unknown shell entry',
    { ...validUrls, 'shell-super-app': validUrls['property-registry'] },
  ],
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
  [
    'fragment',
    {
      ...validUrls,
      'property-registry': `${validUrls['property-registry']}#private`,
    },
  ],
  [
    'arbitrary path',
    { ...validUrls, 'property-registry': 'http://localhost:4101/private.json' },
  ],
] as const)(
  'rejects %s configuration without authorizing a fetch',
  ([_label, manifests]) =>
    Effect.gen(function* testProgram2() {
      expect(
        yield* Effect.flip(
          deriveDeploymentAllowlist({
            environment: 'development',
            overlay: overlay(manifests),
            topology,
          })
        )
      ).toMatchObject({ code: 'deployment_allowlist_invalid' });
    })
);

it.effect('requires HTTPS outside loopback development', () =>
  Effect.gen(function* testProgram3() {
    const productionUrls = {
      'documents-center':
        'https://documents.example.test/.well-known/ontos-module-manifest.json',
      'property-registry':
        'https://property.example.test/.well-known/ontos-module-manifest.json',
    };
    expect(
      yield* Effect.flip(
        deriveDeploymentAllowlist({
          environment: 'production',
          overlay: overlay(
            {
              ...productionUrls,
              'property-registry': validUrls['property-registry'],
            },
            'production'
          ),
          topology,
        })
      )
    ).toMatchObject({ code: 'deployment_allowlist_invalid' });
    expect(
      yield* deriveDeploymentAllowlist({
        environment: 'production',
        overlay: overlay(productionUrls, 'production'),
        topology,
      })
    ).toMatchObject({ entries: expect.any(Array) });
  })
);

it('builds production discovery from deployment URL configuration, never the development overlay', () => {
  const productionTopology = {
    verticals: [
      {
        cloudflare: {
          publicUrlEnv: 'ULTRAMODERN_PUBLIC_URL_PROPERTY_REGISTRY',
        },
        id: 'property-registry',
        kind: 'vertical',
      },
    ],
  };
  const configured = createModuleDeploymentAllowlistBuildInput({
    cloudflareDeployEnabled: true,
    developmentOverlay: overlay({
      'property-registry':
        'http://localhost:4101/.well-known/ontos-module-manifest.json',
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
      'property-registry':
        'https://property.example.test/.well-known/ontos-module-manifest.json',
    },
    schemaVersion: 1,
  });
  expect(() =>
    createModuleDeploymentAllowlistBuildInput({
      cloudflareDeployEnabled: true,
      developmentOverlay: overlay({}),
      readEnvironment: () => 'http://localhost:4101',
      topology: productionTopology,
    })
  ).toThrow(/credential-free HTTPS origin/u);
});
