import { NodeServices } from '@effect/platform-node';
import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Schema, Predicate } from 'effect';
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
import { deriveOntosModuleDeploymentContract } from '../generate-ontos-module-contract.mts';
import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';
import {
  discoverCurrentActionKeys,
  formatActionAuthorizationProvisioningFailure,
  runCurrentActionAuthorizationProvisioning,
  selectActionAuthorizationProvisioningTarget,
} from '../provision-current-action-authorization.mts';

const attachPersonEngagementAction = 'party.registry.attach-person-engagement';
const restrictedAction = 'core.identity.restricted';
const testPreSharedKey = 'not-a-real-secret';
const ProvisioningFailureCauseSchema = Schema.Struct({ cause: Schema.Unknown });
const decodeProvisioningFailureCause = Schema.decodeUnknownSync(ProvisioningFailureCauseSchema);

const currentActionKeys = [
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
  'party.registry.archive-organization-engagement',
  'party.registry.archive-party',
  'party.registry.archive-person-engagement',
  'party.registry.attach-organization-engagement',
  attachPersonEngagementAction,
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
  'party.registry.unarchive-organization-engagement',
  'party.registry.unarchive-party',
  'party.registry.unarchive-person-engagement',
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
  preSharedKey: testPreSharedKey,
};

const stageConfiguration: SpiceDbConfigValue = {
  deploymentEnvironment: 'stage',
  endpoint: 'spicedb:50051',
  insecureLocal: true,
  preSharedKey: testPreSharedKey,
};

const response = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckPermissionResponse.create({ permissionship });

const failureOf = async <Value,>(
  effect: Effect.Effect<Value, ActionAuthorizationProvisioningError>,
) => await runEffectTestPromise(Effect.flip(effect));

const rejectionOf = async <Value,>(promise: Promise<Value>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (Predicate.isError(error)) {
      return error;
    }
    return assert.fail('Expected the Promise to reject with an Error');
  }
  return assert.fail('Expected the Promise to reject');
};

void test('selects only exact source-controlled development and stage targets', async () => {
  const development = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  assert.equal(development.environment, 'development');
  assert.deepEqual(development.contexts, [
    {
      principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
      tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
    },
  ]);

  const stage = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(stageConfiguration),
  );
  assert.equal(stage.environment, 'stage');
  assert.equal(stage.contexts.length, 2);

  const { deploymentEnvironment: _environment, ...withoutEnvironment } = developmentConfiguration;
  const implicitDevelopment = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(withoutEnvironment),
  );
  assert.deepEqual(implicitDevelopment.contexts, development.contexts);
  assert.equal(implicitDevelopment.environment, 'development');

  const ipv6Development = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget({
      ...withoutEnvironment,
      endpoint: '[::1]:50051',
    }),
  );
  assert.equal(ipv6Development.environment, 'development');

  await Promise.all(
    [
      { ...developmentConfiguration, deploymentEnvironment: 'production' },
      { ...developmentConfiguration, endpoint: 'spicedb.example.com:50051', insecureLocal: false },
      { ...withoutEnvironment, endpoint: 'spicedb.example.com:50051' },
      { ...withoutEnvironment, endpoint: 'spicedb:50051' },
      { ...stageConfiguration, endpoint: 'localhost:50051' },
      { ...stageConfiguration, insecureLocal: false },
    ].map(async (configuration) => {
      const error = await failureOf(selectActionAuthorizationProvisioningTarget(configuration));
      assert.equal(error.code, 'action_authorization_configuration_invalid');
      assert.doesNotMatch(error.reason, new RegExp(testPreSharedKey, 'u'));
    }),
  );
});

void test('reports expected provisioning failures and sanitizes unexpected Promise rejections', async () => {
  const expected = new ActionAuthorizationProvisioningError({
    code: 'action_authorization_configuration_invalid',
    reason: 'The SpiceDB provisioning configuration is invalid',
  });
  const expectedRejection = await rejectionOf(runEffectTestPromise(Effect.fail(expected)));
  assert.equal(
    formatActionAuthorizationProvisioningFailure(expectedRejection),
    `${expected.code}: ${expected.reason}`,
  );

  const unexpectedMessage =
    'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';
  for (const error of [undefined, null, testPreSharedKey, new Error(testPreSharedKey), {}]) {
    assert.equal(formatActionAuthorizationProvisioningFailure(error), unexpectedMessage);
  }
  const unexpectedRejection = await rejectionOf(
    runEffectTestPromise(
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.void,
        () => Effect.die(new Error(`client.close failed with ${testPreSharedKey}`)),
      ),
    ),
  );
  assert.equal(
    formatActionAuthorizationProvisioningFailure(unexpectedRejection),
    unexpectedMessage,
  );
});

void test('workspace validation rejects both provisioning spellings in every automatic startup path', async () => {
  const source = await readFile(
    new URL('../validate-ultramodern-workspace.mts', import.meta.url),
    'utf-8',
  );
  // Execute the actual validator block with controlled inputs, without loading the full workspace.
  const start = source.indexOf('const actionAuthorizationProvisioningCommand =');
  const end = source.indexOf('if (hasBackendSurfaces)', start);
  assert.ok(start !== -1 && end > start);
  const block = source.slice(start, end);
  const scripts = {
    'authorization:provision-current-actions':
      'node ./scripts/provision-current-action-authorization.mts',
    'local:initialize': 'node ./scripts/initialize-local-development.mts',
  };
  const validationRoot = await mkdtemp(path.join(os.tmpdir(), 'ontos-workspace-validation-'));
  let validationIndex = 0;
  const validate = async (
    sources: Readonly<Record<string, string>>,
    overrides: Readonly<Record<string, string>> = {},
  ): Promise<void> => {
    const modulePath = path.join(validationRoot, `validation-${validationIndex}.mjs`);
    validationIndex += 1;
    await writeFile(
      modulePath,
      [
        "import assert from 'node:assert/strict';",
        `const sources = ${JSON.stringify(sources)};`,
        "const readText = (file) => sources[file] ?? '';",
        `const rootPackage = ${JSON.stringify({ scripts: { ...scripts, ...overrides } })};`,
        "const SHARED_VALIDATOR_STRING_053 = 'authorization:provision-current-actions';",
        "const SHARED_VALIDATOR_STRING_059 = 'cloudflare:build';",
        "const SHARED_VALIDATOR_STRING_060 = 'cloudflare:deploy';",
        "const SHARED_VALIDATOR_STRING_106 = 'provision-current-action-authorization';",
        'const valueForKey = (entries, key) => entries.find(([candidate]) => candidate === key)?.[1];',
        block,
      ].join('\n'),
      'utf-8',
    );
    await import(pathToFileURL(modulePath).href);
  };

  try {
    await validate({});
    const validationPromises: Promise<void>[] = [];
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
        validationPromises.push(
          assert.rejects(validate({ [file]: command }), /must not provision Action authorization/u),
        );
      }
      for (const automaticScript of ['dev', 'build', 'cloudflare:build', 'cloudflare:deploy']) {
        validationPromises.push(
          assert.rejects(
            validate({}, { [automaticScript]: command }),
            /must not invoke Action authorization provisioning/u,
          ),
        );
      }
      validationPromises.push(
        assert.rejects(
          validate(
            {},
            {
              'local:initialize': `${scripts['local:initialize']} && ${command}`,
            },
          ),
          /must not provision Action authorization/u,
        ),
      );
    }
    await Promise.all(validationPromises);
  } finally {
    await rm(validationRoot, { recursive: true });
  }
});

void test('discovers exactly the current generated Core and Party Registry Action baseline', async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  assert.deepEqual(await discoverCurrentActionKeys(workspaceRoot), currentActionKeys);
  assert.equal(new Set(currentActionKeys).size, 38);
  assert.equal(currentActionKeys.filter((key) => key.startsWith('core.')).length, 8);
  assert.equal(currentActionKeys.filter((key) => key.startsWith('party.registry.')).length, 30);
});

void test('builds lossless, deterministic Tenant-membership grants for development and stage', async () => {
  const development = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const stage = await runEffectTestPromise(
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
  assert.ok(
    identifiers.every(
      (identifier, index) => index === 0 || identifiers[index - 1]?.localeCompare(identifier) <= 0,
    ),
  );
  assert.equal(
    Buffer.from(
      toSpiceDbActionObjectId(attachPersonEngagementAction).slice(3),
      'base64url',
    ).toString('utf-8'),
    attachPersonEngagementAction,
  );
  assert.notEqual(
    toSpiceDbActionObjectId(attachPersonEngagementAction),
    toSpiceDbActionObjectId('contacts-core-attach-person-engagement'),
  );
});

interface ProvisioningClientState {
  readonly grants: Set<string>;
  relationshipWriteCount: number;
  schemaWriteCount: number;
  readonly updates: v1.RelationshipUpdate[];
}

interface ProvisioningClientFixture {
  readonly client: ActionAuthorizationProvisioningClient;
  readonly state: ProvisioningClientState;
}

const makeProvisioningClient = (
  contexts: readonly ActionAuthorizationContext[],
): ProvisioningClientFixture => {
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
      checkPermission: (request) =>
        Effect.sync(() => {
          if (request.permission === 'access') {
            return Option.some(
              response(
                principalTenants.get(request.subject?.object?.objectId ?? '') ===
                  request.resource?.objectId
                  ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                  : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
              ),
            );
          }
          const principalId = request.subject?.object?.objectId ?? '';
          const tenantId = principalTenants.get(principalId);
          const tenantGrant = `${request.resource?.objectId ?? ''}:${tenantId ?? ''}`;
          const principalGrant = `${request.resource?.objectId ?? ''}:${principalId}`;
          return Option.some(
            response(
              state.grants.has(principalGrant) ||
                (tenantId !== undefined && state.grants.has(tenantGrant))
                ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
            ),
          );
        }),
      writeRelationships: (request) =>
        Effect.sync(() => {
          state.relationshipWriteCount += 1;
          state.updates.push(...request.updates);
          for (const update of request.updates) {
            const { relationship } = update;
            state.grants.add(
              `${relationship?.resource?.objectId ?? ''}:${relationship?.subject?.object?.objectId ?? ''}`,
            );
          }
          return v1.WriteRelationshipsResponse.create({});
        }),
      writeSchema: () =>
        Effect.sync(() => {
          state.schemaWriteCount += 1;
          return v1.WriteSchemaResponse.create({});
        }),
    },
    state,
  };
};

void test('provisions with TOUCH, verifies both outcomes, and is safe to rerun', async () => {
  const target = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const { client, state } = makeProvisioningClient(target.contexts);
  const input = { actions: currentActions, contexts: target.contexts };

  const first = await runEffectTestPromise(provisionActionAuthorization(client, input));
  const second = await runEffectTestPromise(provisionActionAuthorization(client, input));

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

void test('never grants explicit Actions through Tenant membership and verifies recorded policy outcomes', async () => {
  const target = await runEffectTestPromise(
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
  state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${context.principalId}`);

  const result = await runEffectTestPromise(
    provisionActionAuthorization(client, {
      actions: [
        {
          actionKey: attachPersonEngagementAction,
          provisioning: 'tenant_membership_default',
        },
        { actionKey: restrictedAction, provisioning: 'explicit' },
      ],
      contexts,
      explicitActionAssertions: [
        {
          actionKey: restrictedAction,
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
    toSpiceDbActionObjectId(attachPersonEngagementAction),
  );
});

void test('rejects missing or mismatched explicit Action verification assertions', async () => {
  const target = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  await Promise.all(
    [
      undefined,
      [],
      [
        {
          actionKey: restrictedAction,
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
    ].map(async (explicitActionAssertions) => {
      const { client, state } = makeProvisioningClient(target.contexts);
      const error = await failureOf(
        provisionActionAuthorization(client, {
          actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
          contexts: target.contexts,
          explicitActionAssertions,
        }),
      );
      assert.equal(error.code, 'action_authorization_input_invalid');
      assert.equal(state.schemaWriteCount, 0);
      assert.equal(state.relationshipWriteCount, 0);
    }),
  );
});

void test('fails promotion when an explicit Action policy contradicts a recorded assertion', async () => {
  const target = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const [context] = target.contexts;
  assert.ok(context !== undefined);
  const deniedPrincipalId = ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
  const assertions = [
    { expected: 'allowed' as const, principalId: context.principalId },
    { expected: 'denied' as const, principalId: deniedPrincipalId },
  ];

  await Promise.all(
    [[], [context.principalId, deniedPrincipalId]].map(async (actualAllowedPrincipalIds) => {
      const { client, state } = makeProvisioningClient(target.contexts);
      for (const principalId of actualAllowedPrincipalIds) {
        state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${principalId}`);
      }
      const error = await failureOf(
        provisionActionAuthorization(client, {
          actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
          contexts: target.contexts,
          explicitActionAssertions: [{ actionKey: restrictedAction, assertions }],
        }),
      );
      assert.equal(error.code, 'action_authorization_verification_failed');
      assert.equal(state.updates.length, 0);
    }),
  );
});

void test('rejects invalid input and missing membership before writing grants', async () => {
  const target = await runEffectTestPromise(
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
          actionKey: attachPersonEngagementAction,
          provisioning: 'tenant_membership_default',
        },
        {
          actionKey: attachPersonEngagementAction,
          provisioning: 'tenant_membership_default',
        },
      ],
      contexts: target.contexts,
    }),
  );
  assert.equal(duplicate.code, 'action_authorization_input_invalid');
  assert.equal(state.schemaWriteCount, 1);
});

void test('fails closed when authorization returns no permission response', async () => {
  const target = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const { client } = makeProvisioningClient(target.contexts);
  const noResponseClient: ActionAuthorizationProvisioningClient = {
    ...client,
    checkPermission: () => Effect.succeed(Option.none()),
  };
  const error = await failureOf(
    provisionActionAuthorization(noResponseClient, {
      actions: currentActions,
      contexts: target.contexts,
    }),
  );
  assert.equal(error.code, 'action_authorization_membership_missing');
});

void test('sanitizes authorization service failures', async () => {
  const secret = 'super-secret-credential';
  const upstreamFailure = new Error(secret);
  const target = await runEffectTestPromise(
    selectActionAuthorizationProvisioningTarget(developmentConfiguration),
  );
  const unavailable: ActionAuthorizationProvisioningClient = {
    checkPermission: () =>
      Effect.succeed(
        Option.some(response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)),
      ),
    writeRelationships: () => Effect.succeed(v1.WriteRelationshipsResponse.create({})),
    writeSchema: () => Effect.fail(upstreamFailure),
  };
  const error = await failureOf(
    provisionActionAuthorization(unavailable, {
      actions: currentActions,
      contexts: target.contexts,
    }),
  );
  assert.equal(error.code, 'action_authorization_service_unavailable');
  assert.doesNotMatch(error.reason, new RegExp(secret, 'u'));
  assert.equal(decodeProvisioningFailureCause(error).cause, upstreamFailure);
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

void test('rejects incomplete and duplicate public Action discovery', async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  const currentContract = await runEffectTestPromise(
    deriveOntosModuleDeploymentContract({
      vertical: 'party-registry',
      workspaceRoot,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const [currentPublicAction] = currentContract.manifest.publicSurface.actions;
  assert.ok(currentPublicAction !== undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), 'ontos-action-discovery-'));
  try {
    const vertical = { id: 'example', package: '@app/example', path: 'verticals/example' };
    await writeInventory(root, [vertical]);
    const incomplete: typeof deriveOntosModuleDeploymentContract = () =>
      Effect.succeed({
        ...currentContract,
        deployment: { ...currentContract.deployment, appId: 'example' },
        manifest: {
          ...currentContract.manifest,
          publicSurface: { ...currentContract.manifest.publicSurface, actions: [] },
        },
      });
    const incompleteError = await rejectionOf(discoverCurrentActionKeys(root, incomplete));
    assert.ok(Schema.is(ActionAuthorizationProvisioningError)(incompleteError));
    assert.equal(incompleteError.code, 'action_authorization_discovery_failed');

    const duplicate: typeof deriveOntosModuleDeploymentContract = () =>
      Effect.succeed({
        ...currentContract,
        deployment: { ...currentContract.deployment, appId: 'example' },
        manifest: {
          ...currentContract.manifest,
          publicSurface: {
            ...currentContract.manifest.publicSurface,
            actions: [{ ...currentPublicAction, actionKey: 'core.identity.bind-managed-api-key' }],
          },
        },
      });
    const duplicateError = await rejectionOf(discoverCurrentActionKeys(root, duplicate));
    assert.ok(Schema.is(ActionAuthorizationProvisioningError)(duplicateError));
    assert.equal(duplicateError.code, 'action_authorization_discovery_failed');

    await writeInventory(root, [vertical, vertical]);
    await assert.rejects(
      discoverCurrentActionKeys(root, duplicate),
      ActionAuthorizationProvisioningError,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('the operator entrypoint rejects every command-line argument before loading configuration', async () => {
  const error = await failureOf(
    runCurrentActionAuthorizationProvisioning(path.resolve(import.meta.dirname, '../..'), [
      '--tenant',
      'arbitrary',
    ]),
  );
  assert.equal(error.code, 'action_authorization_configuration_invalid');
  assert.match(error.reason, /no command-line arguments/u);
});
