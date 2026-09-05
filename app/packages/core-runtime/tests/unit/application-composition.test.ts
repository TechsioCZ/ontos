import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import {
  canonicalizeApplicationComposition,
  ApplicationCompositionSchema,
  ApplicationCompositionValidationError,
  validateApplicationCompositionCandidate,
} from '../../src/modules/application-composition.ts';

const sha256 = (character: string) => character.repeat(64);

const assertInvalid = <Value>(
  effect: Effect.Effect<Value, ApplicationCompositionValidationError>,
  reason: RegExp,
): void => assert.match(Effect.runSync(Effect.flip(effect)).reason, reason);

type Candidate = ReturnType<typeof candidate>;
type Evidence = ReturnType<typeof evidence>;

const candidate = () => {
  const dependencies: string[] = [];
  return {
    modules: [
      {
        allowedContributions: ['contacts.core.navigation.contacts', 'contacts.core.page.contacts'],
        contract: {
          sha256: sha256('a'),
          url: 'https://contacts.example/.well-known/ontos-module-manifest.json',
        },
        dependencies,
        deployment: { appId: 'contacts', buildMarker: 'contacts-build-1' },
        federation: {
          execution: 'browser',
          exposes: ['./Navigation', './PageContacts'],
          manifest: {
            sha256: sha256('b'),
            url: 'https://contacts.example/mf-manifest.json',
          },
          remoteName: 'contacts',
        },
        moduleId: 'contacts.core',
        publicContract: {
          id: 'contacts.core',
          sha256: sha256('c'),
          version: '2',
        },
        requiredCoreCapabilities: [
          { id: 'core.authorization', version: '1' },
          { id: 'core.module-state', version: '1' },
        ],
        requiredShellAbi: { id: 'ontos.shell-contributions', version: '1' },
        sharedSingletons: [
          { packageName: 'react', version: '19.2.0' },
          { packageName: 'react-dom', version: '19.2.0' },
        ],
      },
    ],
    revision: sha256('d'),
    schemaVersion: '1',
    shell: {
      contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
      coreCapabilities: [
        { id: 'core.authorization', version: '1' },
        { id: 'core.module-state', version: '1' },
      ],
      sharedSingletons: [
        { packageName: 'react', version: '19.2.0' },
        { packageName: 'react-dom', version: '19.2.0' },
      ],
    },
  };
};

const evidence = () => ({
  contracts: {
    contacts: {
      contractUrl: 'https://contacts.example/.well-known/ontos-module-manifest.json',
      contributionKeys: ['contacts.core.navigation.contacts', 'contacts.core.page.contacts'],
      deployment: { appId: 'contacts', buildMarker: 'contacts-build-1' },
      federationExposes: ['./Navigation', './PageContacts'],
      mfBoundaryId: 'contacts',
      moduleId: 'contacts.core',
      publicContract: { id: 'contacts.core', sha256: sha256('c'), version: '2' },
      sha256: sha256('a'),
    },
  },
  federationManifests: {
    'https://contacts.example/mf-manifest.json': {
      exposes: ['./Navigation', './PageContacts'],
      remoteName: 'contacts',
      sha256: sha256('b'),
      sharedSingletons: candidate().shell.sharedSingletons,
    },
  },
  runtime: candidate().shell,
});

const required = <Value>(value: Value | undefined): Value => {
  assert.ok(value !== undefined, 'invalid test fixture');
  return value;
};

const onlyModule = (input: Candidate) => required(input.modules[0]);

const federationManifest = (observations: Evidence) =>
  required(observations.federationManifests['https://contacts.example/mf-manifest.json']);

test('defaults the validation error code without changing its encoded contract', () => {
  const error = new ApplicationCompositionValidationError({ reason: 'Invalid candidate' });
  assert.deepEqual(Schema.encodeSync(ApplicationCompositionValidationError)(error), {
    _tag: 'ApplicationCompositionValidationError',
    code: 'application_composition_invalid',
    reason: 'Invalid candidate',
  });
});

const addModuleCopy = (
  input: Candidate,
  overrides: Partial<ReturnType<typeof onlyModule>>,
): number => {
  const module = onlyModule(input);
  return input.modules.push({
    ...structuredClone(module),
    contract: {
      ...module.contract,
      url: 'https://inventory.example/.well-known/ontos-module-manifest.json',
    },
    deployment: { appId: 'inventory', buildMarker: 'inventory-build-1' },
    federation: {
      ...module.federation,
      manifest: {
        ...module.federation.manifest,
        url: 'https://inventory.example/mf-manifest.json',
      },
      remoteName: 'inventory',
    },
    ...overrides,
  });
};

test('accepts one provider-neutral composition and produces deterministic canonical JSON', () => {
  const input = candidate();
  const composition = Effect.runSync(validateApplicationCompositionCandidate(input, evidence()));

  assert.deepEqual(composition, input);
  assert.equal(Object.isFrozen(composition), true);
  assert.equal(Object.isFrozen(required(composition.modules[0]).federation.exposes), true);
  assert.equal(Object.isFrozen(input), false);
  assertInvalid(
    validateApplicationCompositionCandidate({ ...input, provider: 'zephyr' }, evidence()),
    /supported .* schema/u,
  );

  const reordered = structuredClone(composition);
  const reorderedModule = required(reordered.modules[0]);
  reorderedModule.allowedContributions.reverse();
  reorderedModule.federation.exposes.reverse();
  reorderedModule.requiredCoreCapabilities.reverse();
  reorderedModule.sharedSingletons.reverse();
  reordered.shell.coreCapabilities.reverse();
  reordered.shell.sharedSingletons.reverse();
  /* oxlint-disable perfectionist/sort-objects -- Deliberately reorder nested fields to test canonical encoding. */
  reordered.shell.coreCapabilities = reordered.shell.coreCapabilities.map(({ id, version }) => ({
    version,
    id,
  }));
  reorderedModule.sharedSingletons = reorderedModule.sharedSingletons.map(
    ({ packageName, version }) => ({ version, packageName }),
  );
  reorderedModule.contract = {
    url: reorderedModule.contract.url,
    sha256: reorderedModule.contract.sha256,
  };
  /* oxlint-enable perfectionist/sort-objects */
  assert.equal(
    canonicalizeApplicationComposition(reordered),
    canonicalizeApplicationComposition(composition),
  );
  assert.deepEqual(
    Schema.decodeSync(Schema.fromJsonString(ApplicationCompositionSchema))(
      canonicalizeApplicationComposition(composition),
    ),
    composition,
  );
});

test('allows loopback HTTP only with trusted development evidence', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'contacts.localhost']) {
    for (const artifact of ['contract', 'federation']) {
      const input = candidate();
      const observations = evidence();
      const module = onlyModule(input);
      if (artifact === 'contract') {
        module.contract.url = `http://${host}/ontos-module-manifest.json`;
        observations.contracts.contacts.contractUrl = module.contract.url;
      } else {
        module.federation.manifest.url = `http://${host}/mf-manifest.json`;
      }
      const observed = {
        ...observations,
        federationManifests: {
          [module.federation.manifest.url]: federationManifest(observations),
        },
      };
      for (const environment of [{}, { environment: 'stage' }, { environment: 'production' }]) {
        assertInvalid(
          validateApplicationCompositionCandidate(input, { ...observed, ...environment }),
          /HTTPS outside development/u,
        );
      }
      assert.deepEqual(
        Effect.runSync(
          validateApplicationCompositionCandidate(input, {
            ...observed,
            environment: 'development',
          }),
        ),
        input,
      );
    }
  }
  const input = candidate();
  onlyModule(input).contract.url = 'http://contacts.example/manifest.json';
  assertInvalid(
    validateApplicationCompositionCandidate(input, { ...evidence(), environment: 'development' }),
    /supported .* schema/u,
  );
});

test('rejects candidate-wide ownership and compatibility contradictions', () => {
  const cases: readonly [
    mutate: (input: Candidate, observations: Evidence) => number | readonly string[] | string,
    reason: RegExp,
  ][] = [
    [
      (input) => (onlyModule(input).federation.remoteName = 'anotherRemote'),
      /observed deployment contract/u,
    ],
    [
      (_input, observations) => (observations.contracts.contacts.mfBoundaryId = 'anotherRemote'),
      /observed deployment contract/u,
    ],
    [
      (_input, observations) => (federationManifest(observations).remoteName = 'anotherRemote'),
      /Module Federation manifest/u,
    ],
    [
      (_input, observations) => (observations.contracts.contacts.contractUrl = 'invalid-url'),
      /observation schema/u,
    ],
    [(input) => onlyModule(input).dependencies.push('billing.core'), /dependency billing\.core/u],
    [(input) => onlyModule(input).dependencies.push('contacts.core'), /dependency cycle/u],
    [
      (input) => onlyModule(input).dependencies.push('contacts.core', 'contacts.core'),
      /duplicate dependency/u,
    ],
    [
      (input) => addModuleCopy(input, { moduleId: 'inventory.stock' }),
      /duplicate Shell contribution/u,
    ],
    [
      (input) => addModuleCopy(input, { allowedContributions: [] }),
      /duplicate module ID contacts\.core/u,
    ],
    [
      (input) => (onlyModule(input).allowedContributions = ['contacts.core.page.contacts']),
      /observed deployment contract/u,
    ],
    [
      (input) => (onlyModule(input).federation.exposes = ['./Navigation']),
      /observed deployment contract/u,
    ],
    [
      (input) => {
        const module = onlyModule(input);
        return addModuleCopy(input, {
          allowedContributions: [],
          contract: {
            ...module.contract,
            url: 'https://contacts.example:443/.well-known/ontos-module-manifest.json',
          },
          moduleId: 'inventory.stock',
          publicContract: { ...module.publicContract, id: 'inventory.stock' },
        });
      },
      /duplicate artifact URL/u,
    ],
    [
      (input) => {
        const module = onlyModule(input);
        return addModuleCopy(input, {
          allowedContributions: [],
          contract: {
            ...module.contract,
            url: 'https://inventory.example/.well-known/ontos-module-manifest.json',
          },
          federation: {
            ...module.federation,
            manifest: {
              ...module.federation.manifest,
              url: 'https://contacts.example/artifacts/../mf-manifest.json',
            },
            remoteName: 'inventory',
          },
          moduleId: 'inventory.stock',
          publicContract: { ...module.publicContract, id: 'inventory.stock' },
        });
      },
      /duplicate artifact URL/u,
    ],
    [
      (input) => {
        onlyModule(input).requiredShellAbi.version = '2';
        input.shell.contributionAbi.version = '2';
        return input.shell.contributionAbi.version;
      },
      /observed runtime contract/u,
    ],
    [
      (input, observations) => {
        const moduleSingleton = required(onlyModule(input).sharedSingletons[0]);
        const runtimeSingleton = required(observations.runtime.sharedSingletons[0]);
        const shellSingleton = required(input.shell.sharedSingletons[0]);
        shellSingleton.packageName = 'foo';
        shellSingleton.version = 'bar@baz';
        runtimeSingleton.packageName = 'foo';
        runtimeSingleton.version = 'bar@baz';
        moduleSingleton.packageName = 'foo@bar';
        moduleSingleton.version = 'baz';
        return moduleSingleton.version;
      },
      /incompatible shared singleton foo@bar/u,
    ],
    [(input) => (onlyModule(input).requiredShellAbi.version = '2'), /Shell contribution ABI/u],
    [
      (input) => (required(onlyModule(input).requiredCoreCapabilities[0]).version = '2'),
      /Core capability core\.authorization/u,
    ],
    [
      (input) => input.shell.sharedSingletons.push({ packageName: 'react', version: '18.3.1' }),
      /shared singleton react/u,
    ],
    [(input) => (onlyModule(input).federation.execution = 'server'), /supported .* schema/u],
    [
      (input) =>
        (onlyModule(input).contract.url = 'https://contacts.example/manifest.json?tag=live'),
      /supported .* schema/u,
    ],
    [
      (_input, observations) => (federationManifest(observations).exposes = []),
      /Module Federation manifest/u,
    ],
    [
      (_input, observations) => {
        const singleton = required(federationManifest(observations).sharedSingletons[0]);
        singleton.version = '18.3.1';
        return singleton.version;
      },
      /Module Federation manifest/u,
    ],
  ];

  for (const [mutate, reason] of cases) {
    const input = candidate();
    const observations = evidence();
    mutate(input, observations);
    assertInvalid(validateApplicationCompositionCandidate(input, observations), reason);
  }
});
