import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { v1 } from '@authzed/authzed-node';
import { Effect, Redacted } from 'effect';
import {
  ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
  ActionAuthorizationProvisioningError,
  buildActionAuthorizationRelationships,
  provisionActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationContext,
  ActionAuthorizationProvisioningClient,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import type { deriveOntosModuleDeploymentContract } from '../generate-ontos-module-contract.mts';
import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';
import {
  discoverCurrentActionKeys,
  formatActionAuthorizationProvisioningFailure,
  runCurrentActionAuthorizationProvisioning,
  selectActionAuthorizationProvisioningTarget,
} from '../provision-current-action-authorization.mts';

const currentActionKeys = [
  'contacts.core.archive-organization-engagement',
  'contacts.core.archive-person-engagement',
  'contacts.core.attach-organization-engagement',
  'contacts.core.attach-person-engagement',
  'contacts.core.unarchive-organization-engagement',
  'contacts.core.unarchive-person-engagement',
  'core.identity.bind-managed-api-key',
  'core.identity.bind-self-api-key',
  'core.identity.change-principal-status',
  'core.identity.create-non-human-principal',
  'core.identity.record-support-impersonation',
  'core.identity.set-managed-api-key-binding-status',
  'core.identity.set-self-api-key-binding-status',
  'core.modules.change-tenant-module-state',
  'party.registry.add-contact-point',
  'party.registry.add-party-official-identifier',
  'party.registry.archive-party',
  'party.registry.confirm-duplicate-parties',
  'party.registry.correct-party-fact',
  'party.registry.counterparty-create',
  'party.registry.counterparty-role-add',
  'party.registry.counterparty-role-end',
  'party.registry.create-party',
  'party.registry.create-party-relationship',
  'party.registry.dismiss-duplicate-candidate',
  'party.registry.end-contact-point',
  'party.registry.end-party-official-identifier',
  'party.registry.end-party-relationship',
  'party.registry.mark-duplicate-candidate-needs-evidence',
  'party.registry.match-party',
  'party.registry.request-search-rebuild',
  'party.registry.resolve-duplicate-candidate-create',
  'party.registry.resolve-duplicate-candidate-match',
  'party.registry.unarchive-party',
  'party.registry.update-contact-point',
  'party.registry.update-party',
  'party.registry.update-party-official-identifier',
  'party.registry.update-party-relationship',
] as const;

const currentActions = currentActionKeys.map((actionKey) => ({
  actionKey,
  provisioning: 'tenant_membership_default' as const,
}));

const developmentConfiguration: SpiceDbConfigValue = {
  deploymentEnvironment: 'development',
  endpoint: 'localhost:50051',
  insecureLocal: true,
  preSharedKey: Redacted.make('not-a-real-secret'),
};

const stageConfiguration: SpiceDbConfigValue = {
  deploymentEnvironment: 'stage',
  endpoint: 'spicedb:50051',
  insecureLocal: true,
  preSharedKey: Redacted.make('not-a-real-secret'),
};

const response = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckPermissionResponse.create({ permissionship });

const failureOf = async <Value,>(
  effect: Effect.Effect<Value, ActionAuthorizationProvisioningError>,
) => Effect.runPromise(Effect.flip(effect));

test('selects only exact source-controlled development and stage targets', async () => {
  const development = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  assert.equal(development.environment, 'development');
  assert.deepEqual(development.contexts, [
    {
      principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    },
  ]);

  const stage = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(stageConfiguration),
  );
  assert.equal(stage.environment, 'stage');
  assert.equal(stage.contexts.length, 2);

  const { deploymentEnvironment: _environment, ...withoutEnvironment } = developmentConfiguration;
  const implicitDevelopment = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(withoutEnvironment),
  );
  assert.deepEqual(implicitDevelopment.contexts, development.contexts);
  assert.equal(implicitDevelopment.environment, 'development');

  const ipv6Development = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget({
      ...withoutEnvironment,
      endpoint: '[::1]:50051',
    }),
  );
  assert.equal(ipv6Development.environment, 'development');

  for (const configuration of [
    { ...developmentConfiguration, deploymentEnvironment: 'production' },
    { ...developmentConfiguration, endpoint: 'spicedb.example.com:50051', insecureLocal: false },
    { ...withoutEnvironment, endpoint: 'spicedb.example.com:50051' },
    { ...withoutEnvironment, endpoint: 'spicedb:50051' },
    { ...stageConfiguration, endpoint: 'localhost:50051' },
    { ...stageConfiguration, insecureLocal: false },
  ]) {
    const error = await failureOf(selectActionAuthorizationProvisioningTarget(configuration));
    assert.equal(error.code, 'action_authorization_configuration_invalid');
    assert.doesNotMatch(error.reason, /not-a-real-secret/);
  }
});

test('reports expected provisioning failures and sanitizes unexpected Promise rejections', async () => {
  const expected = new ActionAuthorizationProvisioningError({
    code: 'action_authorization_configuration_invalid',
    reason: 'The SpiceDB provisioning configuration is invalid',
  });
  await assert.rejects(Effect.runPromise(Effect.fail(expected)), (error: unknown) => {
    assert.equal(
      formatActionAuthorizationProvisioningFailure(error),
      `${expected.code}: ${expected.reason}`,
    );
    return true;
  });

  const unexpectedMessage =
    'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';
  for (const error of [undefined, null, 'not-a-real-secret', new Error('not-a-real-secret'), {}]) {
    assert.equal(formatActionAuthorizationProvisioningFailure(error), unexpectedMessage);
  }
  await assert.rejects(
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.void,
        () => Effect.die(new Error('client.close failed with not-a-real-secret')),
      ),
    ),
    (error: unknown) => {
      assert.equal(formatActionAuthorizationProvisioningFailure(error), unexpectedMessage);
      return true;
    },
  );
});

test('workspace validation rejects both provisioning spellings in every automatic startup path', async () => {
  const source = await readFile(
    new URL('../validate-ultramodern-workspace.mts', import.meta.url),
    'utf-8',
  );
  // Execute the actual validator block with controlled inputs, without loading the full workspace.
  const start = source.indexOf('const actionAuthorizationProvisioningCommand =');
  const end = source.indexOf('if (hasBackendSurfaces)', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const scripts = {
    'authorization:provision-current-actions':
      'node ./scripts/provision-current-action-authorization.mts',
    'local:initialize': 'node ./scripts/initialize-local-development.mts',
  };
  const validate = (sources: Readonly<Record<string, string>>, overrides = {}) =>
    runInNewContext(block, {
      assert,
      readText: (file: string) => sources[file] ?? '',
      rootPackage: { scripts: { ...scripts, ...overrides } },
    });

  validate({});
  for (const command of [
    'node ./scripts/provision-current-action-authorization.mts',
    'pnpm authorization:provision-current-actions',
  ]) {
    for (const file of [
      'scripts/initialize-local-development.mts',
      'scripts/locki-feature.sh',
      'docker-compose.yml',
      'scripts/run-zerops-spicedb.sh',
    ]) {
      assert.throws(
        () => validate({ [file]: command }),
        /must not provision Action authorization/u,
      );
    }
    for (const automaticScript of ['dev', 'build', 'cloudflare:build', 'cloudflare:deploy']) {
      assert.throws(
        () => validate({}, { [automaticScript]: command }),
        /must not invoke Action authorization provisioning/u,
      );
    }
    assert.throws(
      () => validate({}, { 'local:initialize': `${scripts['local:initialize']} && ${command}` }),
      /must not provision Action authorization/u,
    );
  }
});

test('discovers exactly the current generated Core and Contacts Action baseline', async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  assert.deepEqual(await discoverCurrentActionKeys(workspaceRoot), currentActionKeys);
  assert.equal(new Set(currentActionKeys).size, 38);
  assert.equal(currentActionKeys.filter((key) => key.startsWith('core.')).length, 8);
  assert.equal(currentActionKeys.filter((key) => key.startsWith('contacts.core.')).length, 6);
  assert.equal(currentActionKeys.filter((key) => key.startsWith('party.registry.')).length, 24);
});

test('builds lossless, deterministic Tenant-membership grants for development and stage', async () => {
  const development = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const stage = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(stageConfiguration),
  );
  const developmentRelationships = buildActionAuthorizationRelationships(
    currentActionKeys,
    development.contexts,
  );
  const stageRelationships = buildActionAuthorizationRelationships(
    currentActionKeys,
    stage.contexts,
  );

  assert.equal(developmentRelationships.length, 38);
  assert.equal(stageRelationships.length, 76);
  for (const relationship of [...developmentRelationships, ...stageRelationships]) {
    assert.equal(relationship.relation, 'executor');
    assert.equal(relationship.resource?.objectType, 'action');
    assert.equal(relationship.subject?.object?.objectType, 'tenant');
    assert.equal(relationship.subject?.optionalRelation, 'member');
  }
  const identifiers = stageRelationships.map(
    ({ resource, subject }) => `${resource?.objectId}:${subject?.object?.objectId}`,
  );
  assert.deepEqual(
    identifiers,
    identifiers.toSorted((left, right) => left.localeCompare(right)),
  );
  assert.equal(
    Buffer.from(
      toSpiceDbActionObjectId('contacts.core.attach-person-engagement').slice(3),
      'base64url',
    ).toString('utf-8'),
    'contacts.core.attach-person-engagement',
  );
  assert.notEqual(
    toSpiceDbActionObjectId('contacts.core.attach-person-engagement'),
    toSpiceDbActionObjectId('contacts-core-attach-person-engagement'),
  );
});

interface ProvisioningClientState {
  readonly grants: Set<string>;
  relationshipWriteCount: number;
  schemaWriteCount: number;
  readonly updates: v1.RelationshipUpdate[];
}

const makeProvisioningClient = (
  contexts: readonly ActionAuthorizationContext[],
): {
  readonly client: ActionAuthorizationProvisioningClient;
  readonly state: ProvisioningClientState;
} => {
  const principalTenants = new Map(
    contexts.map(({ principalId, tenantId }) => [principalId, tenantId]),
  );
  const state: ProvisioningClientState = {
    grants: new Set(),
    relationshipWriteCount: 0,
    schemaWriteCount: 0,
    updates: [],
  };
  return {
    client: {
      checkPermission: async (request) => {
        if (request.permission === 'access') {
          return response(
            principalTenants.get(request.subject?.object?.objectId ?? '') ===
              request.resource?.objectId
              ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
              : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          );
        }
        const principalId = request.subject?.object?.objectId ?? '';
        const tenantId = principalTenants.get(principalId);
        const tenantGrant = `${request.resource?.objectId ?? ''}:${tenantId ?? ''}`;
        const principalGrant = `${request.resource?.objectId ?? ''}:${principalId}`;
        return response(
          state.grants.has(principalGrant) ||
            (tenantId !== undefined && state.grants.has(tenantGrant))
            ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        );
      },
      writeRelationships: async (request) => {
        state.relationshipWriteCount += 1;
        state.updates.push(...request.updates);
        for (const update of request.updates) {
          const relationship = update.relationship;
          state.grants.add(
            `${relationship?.resource?.objectId ?? ''}:${relationship?.subject?.object?.objectId ?? ''}`,
          );
        }
        return v1.WriteRelationshipsResponse.create({});
      },
      writeSchema: async () => {
        state.schemaWriteCount += 1;
        return v1.WriteSchemaResponse.create({});
      },
    },
    state,
  };
};

test('provisions with TOUCH, verifies both outcomes, and is safe to rerun', async () => {
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const { client, state } = makeProvisioningClient(target.contexts);
  const input = { actions: currentActions, contexts: target.contexts };

  const first = await Effect.runPromise(provisionActionAuthorization(client, input));
  const second = await Effect.runPromise(provisionActionAuthorization(client, input));

  assert.deepEqual(first, { actionCount: 38, grantCount: 38, tenantCount: 1 });
  assert.deepEqual(second, first);
  assert.equal(state.schemaWriteCount, 2);
  assert.equal(state.relationshipWriteCount, 2);
  assert.equal(state.grants.size, 38);
  assert.equal(state.updates.length, 76);
  assert.ok(
    state.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH),
  );
  assert.ok(
    ![...state.grants].some((grant) => grant.includes(ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID)),
  );
});

test('never grants explicit Actions through Tenant membership and verifies recorded policy outcomes', async () => {
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const [context] = target.contexts;
  assert.ok(context !== undefined);
  const deniedContext = {
    principalId: '00000000-0000-4000-8000-000000000020',
    tenantId: '00000000-0000-4000-8000-000000000021',
  };
  const contexts = [...target.contexts, deniedContext];
  const { client, state } = makeProvisioningClient(contexts);
  state.grants.add(`${toSpiceDbActionObjectId('core.identity.restricted')}:${context.principalId}`);

  const result = await Effect.runPromise(
    provisionActionAuthorization(client, {
      actions: [
        {
          actionKey: 'contacts.core.attach-person-engagement',
          provisioning: 'tenant_membership_default',
        },
        { actionKey: 'core.identity.restricted', provisioning: 'explicit' },
      ],
      contexts,
      explicitActionAssertions: [
        {
          actionKey: 'core.identity.restricted',
          assertions: [
            { expected: 'allowed', principalId: context.principalId },
            { expected: 'denied', principalId: deniedContext.principalId },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(result, { actionCount: 2, grantCount: 2, tenantCount: 2 });
  assert.equal(state.updates.length, 2);
  assert.equal(
    state.updates[0]?.relationship?.resource?.objectId,
    toSpiceDbActionObjectId('contacts.core.attach-person-engagement'),
  );
});

test('rejects missing or mismatched explicit Action verification assertions', async () => {
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  for (const explicitActionAssertions of [
    undefined,
    [],
    [
      {
        actionKey: 'core.identity.restricted',
        assertions: [
          { expected: 'allowed' as const, principalId: target.contexts[0]?.principalId ?? '' },
        ],
      },
    ],
    [
      {
        actionKey: 'core.identity.unknown',
        assertions: [
          { expected: 'allowed' as const, principalId: target.contexts[0]?.principalId ?? '' },
          { expected: 'denied' as const, principalId: ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID },
        ],
      },
    ],
  ]) {
    const { client, state } = makeProvisioningClient(target.contexts);
    const error = await failureOf(
      provisionActionAuthorization(client, {
        actions: [{ actionKey: 'core.identity.restricted', provisioning: 'explicit' }],
        contexts: target.contexts,
        explicitActionAssertions,
      }),
    );
    assert.equal(error.code, 'action_authorization_input_invalid');
    assert.equal(state.schemaWriteCount, 0);
    assert.equal(state.relationshipWriteCount, 0);
  }
});

test('fails promotion when an explicit Action policy contradicts a recorded assertion', async () => {
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const [context] = target.contexts;
  assert.ok(context !== undefined);
  const deniedPrincipalId = ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
  const assertions = [
    { expected: 'allowed' as const, principalId: context.principalId },
    { expected: 'denied' as const, principalId: deniedPrincipalId },
  ];

  for (const actualAllowedPrincipalIds of [[], [context.principalId, deniedPrincipalId]]) {
    const { client, state } = makeProvisioningClient(target.contexts);
    for (const principalId of actualAllowedPrincipalIds) {
      state.grants.add(`${toSpiceDbActionObjectId('core.identity.restricted')}:${principalId}`);
    }
    const error = await failureOf(
      provisionActionAuthorization(client, {
        actions: [{ actionKey: 'core.identity.restricted', provisioning: 'explicit' }],
        contexts: target.contexts,
        explicitActionAssertions: [{ actionKey: 'core.identity.restricted', assertions }],
      }),
    );
    assert.equal(error.code, 'action_authorization_verification_failed');
    assert.equal(state.updates.length, 0);
  }
});

test('rejects invalid input and missing membership before writing grants', async () => {
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const { client, state } = makeProvisioningClient([]);
  const missingMembership = await failureOf(
    provisionActionAuthorization(client, {
      actions: currentActions,
      contexts: target.contexts,
    }),
  );
  assert.equal(missingMembership.code, 'action_authorization_membership_missing');
  assert.equal(state.schemaWriteCount, 1);
  assert.equal(state.relationshipWriteCount, 0);

  const duplicate = await failureOf(
    provisionActionAuthorization(client, {
      actions: [
        {
          actionKey: 'contacts.core.attach-person-engagement',
          provisioning: 'tenant_membership_default',
        },
        {
          actionKey: 'contacts.core.attach-person-engagement',
          provisioning: 'tenant_membership_default',
        },
      ],
      contexts: target.contexts,
    }),
  );
  assert.equal(duplicate.code, 'action_authorization_input_invalid');
  assert.equal(state.schemaWriteCount, 1);
});

test('sanitizes authorization service failures', async () => {
  const secret = 'super-secret-credential';
  const target = await Effect.runPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const unavailable: ActionAuthorizationProvisioningClient = {
    checkPermission: async () => response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
    writeRelationships: async () => v1.WriteRelationshipsResponse.create({}),
    writeSchema: async () => {
      throw new Error(secret);
    },
  };
  const error = await failureOf(
    provisionActionAuthorization(unavailable, {
      actions: currentActions,
      contexts: target.contexts,
    }),
  );
  assert.equal(error.code, 'action_authorization_service_unavailable');
  assert.doesNotMatch(error.reason, new RegExp(secret));
});

const writeInventory = async (
  root: string,
  verticals: readonly { readonly id: string; readonly package: string; readonly path: string }[],
) => {
  await mkdir(path.join(root, 'topology'), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'topology/reference-topology.json'), JSON.stringify({ verticals })),
    writeFile(path.join(root, 'topology/ownership.json'), JSON.stringify({ owners: verticals })),
  ]);
};

test('rejects incomplete and duplicate public Action discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-action-discovery-'));
  try {
    const vertical = { id: 'example', package: '@app/example', path: 'verticals/example' };
    await writeInventory(root, [vertical]);
    const incomplete = (async () => ({
      deployment: { appId: 'example' },
      manifest: { publicSurface: { actions: [] } },
    })) as unknown as typeof deriveOntosModuleDeploymentContract;
    await assert.rejects(discoverCurrentActionKeys(root, incomplete), (error) => {
      assert.ok(error instanceof ActionAuthorizationProvisioningError);
      return error.code === 'action_authorization_discovery_failed';
    });

    const duplicate = (async () => ({
      deployment: { appId: 'example' },
      manifest: {
        publicSurface: { actions: [{ actionKey: 'core.identity.bind-managed-api-key' }] },
      },
    })) as unknown as typeof deriveOntosModuleDeploymentContract;
    await assert.rejects(discoverCurrentActionKeys(root, duplicate), (error) => {
      assert.ok(error instanceof ActionAuthorizationProvisioningError);
      return error.code === 'action_authorization_discovery_failed';
    });

    await writeInventory(root, [vertical, vertical]);
    await assert.rejects(
      discoverCurrentActionKeys(root, duplicate),
      ActionAuthorizationProvisioningError,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the operator entrypoint rejects every command-line argument before loading configuration', async () => {
  const error = await failureOf(
    runCurrentActionAuthorizationProvisioning(path.resolve(import.meta.dirname, '../..'), [
      '--tenant',
      'arbitrary',
    ]),
  );
  assert.equal(error.code, 'action_authorization_configuration_invalid');
  assert.match(error.reason, /no command-line arguments/);
});
