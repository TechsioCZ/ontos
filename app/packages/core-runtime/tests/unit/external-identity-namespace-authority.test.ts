import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  authorizeProvisioningNamespace,
  authorizeReadNamespace,
} from '../../src/auth/external-identity/namespace-authority.ts';
import type {
  GrantedProvisioningNamespacesService,
  NamespaceAuthorityInput,
} from '../../src/auth/external-identity/namespace-authority.ts';

type NamespaceScope = NamespaceAuthorityInput['scope'];

const scope = (authMethod: NamespaceScope['authMethod'], authenticationNamespaceId?: string): NamespaceScope =>
  authenticationNamespaceId === undefined ? { authMethod } : { authenticationNamespaceId, authMethod };
const ungranted = Option.none<GrantedProvisioningNamespacesService>();
const granted = (...authenticationNamespaceIds: readonly string[]) =>
  Option.some<GrantedProvisioningNamespacesService>({ authenticationNamespaceIds });

it.effect('qualifies a provisioning workload by the namespace it authenticated in', () =>
  Effect.gen(function* provisioningNamespaceScenario() {
    // A trusted system job carries no namespace of its own: its registration is deployment data
    // revalidated against Core's own rows (O29, O36, O59).
    yield* authorizeProvisioningNamespace({
      authenticationNamespaceId: 'namespace-a',
      granted: ungranted,
      scope: scope('system'),
    });

    // A namespace-bound workload may provision only the namespace it authenticated in.
    yield* authorizeProvisioningNamespace({
      authenticationNamespaceId: 'namespace-a',
      granted: ungranted,
      scope: scope('api_key', 'namespace-a'),
    });
    const foreignNamespace = yield* Effect.flip(
      authorizeProvisioningNamespace({
        authenticationNamespaceId: 'namespace-b',
        granted: ungranted,
        scope: scope('api_key', 'namespace-a'),
      }),
    );
    expect(foreignNamespace.code).toBe('identity_forbidden');

    // A person is never admitted on a workload carrier: the gate refuses them and the owner rule
    // refuses again rather than inventing a namespace (O59, O71).
    const person = yield* Effect.flip(
      authorizeProvisioningNamespace({
        authenticationNamespaceId: 'namespace-a',
        granted: ungranted,
        scope: scope('session'),
      }),
    );
    expect(person.code).toBe('identity_forbidden');
  }),
);

it.effect('lets a person reach the dual read while a workload stays in its own namespace', () =>
  Effect.gen(function* readNamespaceScenario() {
    // The read's declaration is the human path (O67-Q4, O72): the gate already decided the person, so
    // the owner only qualifies the namespace of a machine actor (classification: exact namespace
    // provision OR tenant administration).
    yield* authorizeReadNamespace({
      authenticationNamespaceId: 'namespace-b',
      granted: ungranted,
      scope: scope('session'),
    });
    yield* authorizeReadNamespace({
      authenticationNamespaceId: 'namespace-b',
      granted: ungranted,
      scope: scope('support_impersonation', 'namespace-a'),
    });

    // A machine actor still reads only its own namespace, exactly like the provisioning path.
    yield* authorizeReadNamespace({
      authenticationNamespaceId: 'namespace-a',
      granted: ungranted,
      scope: scope('api_key', 'namespace-a'),
    });
    const foreignNamespace = yield* Effect.flip(
      authorizeReadNamespace({
        authenticationNamespaceId: 'namespace-b',
        granted: ungranted,
        scope: scope('api_key', 'namespace-a'),
      }),
    );
    expect(foreignNamespace.code).toBe('identity_forbidden');
  }),
);

it.effect('lets a workload act only in the exact namespace its trusted composition granted', () =>
  Effect.gen(function* grantedNamespaceScenario() {
    // The Shell's staff-namespace workload provisions Commerce bindings through a deployment grant;
    // the Shell provides the granted namespace only after that grant matched (O29, O59, O67-Q4).
    yield* authorizeProvisioningNamespace({
      authenticationNamespaceId: 'namespace-b',
      granted: granted('namespace-b'),
      scope: scope('api_key', 'namespace-a'),
    });
    yield* authorizeReadNamespace({
      authenticationNamespaceId: 'namespace-b',
      granted: granted('namespace-b'),
      scope: scope('api_key', 'namespace-a'),
    });

    // A grant for one namespace never opens another.
    const otherGrant = yield* Effect.flip(
      authorizeProvisioningNamespace({
        authenticationNamespaceId: 'namespace-c',
        granted: granted('namespace-b'),
        scope: scope('api_key', 'namespace-a'),
      }),
    );
    expect(otherGrant.code).toBe('identity_forbidden');
    const otherReadGrant = yield* Effect.flip(
      authorizeReadNamespace({
        authenticationNamespaceId: 'namespace-c',
        granted: granted('namespace-b'),
        scope: scope('api_key', 'namespace-a'),
      }),
    );
    expect(otherReadGrant.code).toBe('identity_forbidden');

    // Without a grant, a foreign namespace stays closed.
    const ungrantedNamespace = yield* Effect.flip(
      authorizeProvisioningNamespace({
        authenticationNamespaceId: 'namespace-b',
        granted: ungranted,
        scope: scope('api_key', 'namespace-a'),
      }),
    );
    expect(ungrantedNamespace.code).toBe('identity_forbidden');

    // A grant qualifies an API-key workload only; it never admits a person on the workload carrier.
    const grantedPerson = yield* Effect.flip(
      authorizeProvisioningNamespace({
        authenticationNamespaceId: 'namespace-b',
        granted: granted('namespace-b'),
        scope: scope('session', 'namespace-a'),
      }),
    );
    expect(grantedPerson.code).toBe('identity_forbidden');
  }),
);
