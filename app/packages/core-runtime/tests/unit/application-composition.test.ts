import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import type { ApplicationCompositionValidationError } from '../../src/modules/application-composition.ts';
import {
  canonicalizeApplicationComposition,
  validateApplicationCompositionCandidate,
} from '../../src/modules/application-composition.ts';

const sha256 = (character: string) => character.repeat(64);
const strings = (...values: string[]): string[] => values;

const assertInvalid = <Value>(
  effect: Effect.Effect<Value, ApplicationCompositionValidationError>,
  reason: RegExp,
): void => assert.match(Effect.runSync(Effect.flip(effect)).reason, reason);

type Candidate = ReturnType<typeof candidate>;
type Evidence = ReturnType<typeof evidence>;

const candidate = () => ({
  modules: [
    {
      allowedContributions: ['contacts.core.navigation.contacts', 'contacts.core.page.contacts'],
      contract: {
        sha256: sha256('a'),
        url: 'https://contacts.example/.well-known/ontos-module-manifest.json',
      },
      dependencies: strings(),
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
});

const evidence = () => ({
  contracts: {
    contacts: {
      contractUrl: 'https://contacts.example/.well-known/ontos-module-manifest.json',
      contributionKeys: ['contacts.core.navigation.contacts', 'contacts.core.page.contacts'],
      deployment: { appId: 'contacts', buildMarker: 'contacts-build-1' },
      federationExposes: ['./Navigation', './PageContacts'],
      moduleId: 'contacts.core',
      publicContract: { id: 'contacts.core', sha256: sha256('c'), version: '2' },
      sha256: sha256('a'),
    },
  },
  federationManifests: {
    'https://contacts.example/mf-manifest.json': {
      exposes: ['./Navigation', './PageContacts'],
      sha256: sha256('b'),
    },
  },
  runtime: structuredClone(candidate().shell),
});

const required = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error('invalid test fixture');
  }
  return value;
};

const onlyModule = (input: Candidate) => required(input.modules[0]);

const federationManifest = (observations: Evidence) =>
  required(observations.federationManifests['https://contacts.example/mf-manifest.json']);

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
  assert.equal(
    canonicalizeApplicationComposition(composition),
    canonicalizeApplicationComposition({
      modules: composition.modules,
      revision: composition.revision,
      schemaVersion: composition.schemaVersion,
      shell: composition.shell,
    }),
  );
  assert.doesNotMatch(
    canonicalizeApplicationComposition(composition),
    /cloudflare|zephyr|credential|provider/iu,
  );

  const reordered = structuredClone(composition);
  const reorderedModule = required(reordered.modules[0]);
  reorderedModule.allowedContributions.reverse();
  reorderedModule.federation.exposes.reverse();
  reorderedModule.requiredCoreCapabilities.reverse();
  reorderedModule.sharedSingletons.reverse();
  reordered.shell.coreCapabilities.reverse();
  reordered.shell.sharedSingletons.reverse();
  assert.equal(
    canonicalizeApplicationComposition(reordered),
    canonicalizeApplicationComposition(composition),
  );
});

test('rejects candidate-wide ownership and compatibility contradictions', () => {
  const cases: readonly [
    mutate: (input: Candidate, observations: Evidence) => number | readonly string[] | string,
    reason: RegExp,
  ][] = [
    [(input) => onlyModule(input).dependencies.push('billing.core'), /dependency billing\.core/u],
    [(input) => onlyModule(input).dependencies.push('contacts.core'), /dependency cycle/u],
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
  ];

  for (const [mutate, reason] of cases) {
    const input = candidate();
    const observations = evidence();
    mutate(input, observations);
    assertInvalid(validateApplicationCompositionCandidate(input, observations), reason);
  }
});
