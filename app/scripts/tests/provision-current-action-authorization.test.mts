import type { deriveOntosModuleDeploymentContract as DeriveModuleContract } from '../generate-ontos-module-contract.mts';

import { expect, it } from 'effect-rstest';
import { NodeServices } from '@effect/platform-node';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { Cause, Effect, Option, Schema } from 'effect';
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

import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';
import {
  formatActionAuthorizationProvisioningFailure,
  runCurrentActionAuthorizationProvisioning,
  selectActionAuthorizationProvisioningTarget,
} from '../provision-current-action-authorization.mts';
import type { discoverCurrentActionKeys as DiscoverCurrentActionKeys } from '../provision-current-action-authorization.mts';

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

const failureOf = <Value,>(effect: Effect.Effect<Value, ActionAuthorizationProvisioningError>) =>
  Effect.gen(function* testEffect1() {
    return yield* Effect.flip(effect);
  });

const rejectionOf = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
) =>
  effect.pipe(
    Effect.matchCause({
      onFailure: Cause.squash,
      onSuccess: () => {
        throw new Error('Expected the Effect to fail');
      },
    }),
  );

it.effect(
  'selects only exact source-controlled development and stage targets',
  Effect.fn(function* testEffect2() {
    const development =
      yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    expect(development.environment).toBe('development');
    expect(development.contexts).toEqual([
      {
        principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
        tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
      },
    ]);

    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration);
    expect(stage.environment).toBe('stage');
    expect(stage.contexts.length).toBe(2);

    const { deploymentEnvironment: _environment, ...withoutEnvironment } = developmentConfiguration;
    const implicitDevelopment =
      yield* selectActionAuthorizationProvisioningTarget(withoutEnvironment);
    expect(implicitDevelopment.contexts).toEqual(development.contexts);
    expect(implicitDevelopment.environment).toBe('development');

    const ipv6Development = yield* selectActionAuthorizationProvisioningTarget({
      ...withoutEnvironment,
      endpoint: '[::1]:50051',
    });
    expect(ipv6Development.environment).toBe('development');

    yield* Effect.all(
      [
        { ...developmentConfiguration, deploymentEnvironment: 'production' },
        {
          ...developmentConfiguration,
          endpoint: 'spicedb.example.com:50051',
          insecureLocal: false,
        },
        { ...withoutEnvironment, endpoint: 'spicedb.example.com:50051' },
        { ...withoutEnvironment, endpoint: 'spicedb:50051' },
        { ...stageConfiguration, endpoint: 'localhost:50051' },
        { ...stageConfiguration, insecureLocal: false },
      ].map((configuration) =>
        Effect.gen(function* testEffect3() {
          const error = yield* failureOf(
            selectActionAuthorizationProvisioningTarget(configuration),
          );
          expect(error.code).toBe('action_authorization_configuration_invalid');
          expect(error.reason).not.toMatch(new RegExp(testPreSharedKey, 'u'));
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'reports expected provisioning failures and sanitizes unexpected Promise rejections',
  Effect.fn(function* testEffect4() {
    const expected = new ActionAuthorizationProvisioningError({
      code: 'action_authorization_configuration_invalid',
      reason: 'The SpiceDB provisioning configuration is invalid',
    });
    const expectedRejection = yield* rejectionOf(Effect.fail(expected));
    expect(formatActionAuthorizationProvisioningFailure(expectedRejection)).toBe(
      `${expected.code}: ${expected.reason}`,
    );

    const unexpectedMessage =
      'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';
    for (const error of [undefined, null, testPreSharedKey, new Error(testPreSharedKey), {}]) {
      expect(formatActionAuthorizationProvisioningFailure(error)).toBe(unexpectedMessage);
    }
    const unexpectedRejection = yield* rejectionOf(
      Effect.acquireUseRelease(
        Effect.void,
        () => Effect.void,
        () => Effect.die(new Error(`client.close failed with ${testPreSharedKey}`)),
      ),
    );
    expect(formatActionAuthorizationProvisioningFailure(unexpectedRejection)).toBe(
      unexpectedMessage,
    );
  }),
);

it.effect(
  'workspace validation rejects both provisioning spellings in every automatic startup path',
  Effect.fn(function* testEffect5() {
    const source = yield* Effect.tryPromise(() =>
      readFile(new URL('../validate-ultramodern-workspace.mts', import.meta.url), 'utf-8'),
    );
    // Execute the actual validator block with controlled inputs, without loading the full workspace.
    const start = source.indexOf('const actionAuthorizationProvisioningCommand =');
    const end = source.indexOf('if (hasBackendSurfaces)', start);
    expect(start !== -1 && end > start).toBe(true);
    const block = source.slice(start, end);
    const scripts = {
      'authorization:provision-current-actions':
        'node ./scripts/provision-current-action-authorization.mts',
      'local:initialize': 'node ./scripts/initialize-local-development.mts',
    };
    const validationRoot = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-workspace-validation-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    let validationIndex = 0;
    const validate = (
      sources: Readonly<Record<string, string>>,
      overrides: Readonly<Record<string, string>> = {},
    ) =>
      Effect.gen(function* testEffect6() {
        const modulePath = path.join(validationRoot, `validation-${validationIndex}.mjs`);
        validationIndex += 1;
        yield* Effect.tryPromise(() =>
          writeFile(
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
          ),
        );
        yield* Effect.tryPromise(() => import(pathToFileURL(modulePath).href));
      });

    yield* validate({});
    const validations: Effect.Effect<void, void>[] = [];
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
        validations.push(
          validate({ [file]: command }).pipe(
            Effect.flip,
            Effect.map((error) =>
              expect(() => {
                throw error.cause;
              }).toThrow(/must not provision Action authorization/u),
            ),
          ),
        );
      }
      for (const automaticScript of ['dev', 'build', 'cloudflare:build', 'cloudflare:deploy']) {
        validations.push(
          validate({}, { [automaticScript]: command }).pipe(
            Effect.flip,
            Effect.map((error) =>
              expect(() => {
                throw error.cause;
              }).toThrow(/must not invoke Action authorization provisioning/u),
            ),
          ),
        );
      }
      validations.push(
        validate(
          {},
          {
            'local:initialize': `${scripts['local:initialize']} && ${command}`,
          },
        ).pipe(
          Effect.flip,
          Effect.map((error) =>
            expect(() => {
              throw error.cause;
            }).toThrow(/must not provision Action authorization/u),
          ),
        ),
      );
    }
    yield* Effect.all(validations, { concurrency: 'unbounded' });
  }),
);

it.effect(
  'discovers exactly the current generated Core and Party Registry Action baseline',
  Effect.fn(function* testEffect7() {
    const workspaceRoot = path.resolve(import.meta.dirname, '../..');
    const { discoverCurrentActionKeys } = yield* Effect.promise(
      (): Promise<{ readonly discoverCurrentActionKeys: typeof DiscoverCurrentActionKeys }> =>
        import(
          pathToFileURL(
            path.resolve(import.meta.dirname, '../provision-current-action-authorization.mts'),
          ).href
        ),
    );
    expect(
      yield* discoverCurrentActionKeys(workspaceRoot).pipe(Effect.provide(NodeServices.layer)),
    ).toEqual(currentActionKeys);
    expect(new Set(currentActionKeys).size).toBe(38);
    expect(currentActionKeys.filter((key) => key.startsWith('core.')).length).toBe(8);
    expect(currentActionKeys.filter((key) => key.startsWith('party.registry.')).length).toBe(30);
  }),
);

it.effect(
  'builds lossless, deterministic Tenant-membership grants for development and stage',
  Effect.fn(function* testEffect8() {
    const development =
      yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const stage = yield* selectActionAuthorizationProvisioningTarget(stageConfiguration);
    const developmentRelationships = buildActionAuthorizationRelationships(
      currentActionKeys,
      development.contexts,
    );
    const stageRelationships = buildActionAuthorizationRelationships(
      currentActionKeys,
      stage.contexts,
    );

    expect(developmentRelationships.length).toBe(38);
    expect(stageRelationships.length).toBe(76);
    for (const relationship of [...developmentRelationships, ...stageRelationships]) {
      expect(relationship.relation).toBe('executor');
      expect(relationship.resource?.objectType).toBe('action');
      expect(relationship.subject?.object?.objectType).toBe('tenant');
      expect(relationship.subject?.optionalRelation).toBe('member');
    }
    const identifiers = stageRelationships.map(
      ({ resource, subject }) => `${resource?.objectId}:${subject?.object?.objectId}`,
    );
    expect(
      identifiers.every(
        (identifier, index) =>
          index === 0 || identifiers[index - 1]?.localeCompare(identifier) <= 0,
      ),
    ).toBe(true);
    expect(
      Buffer.from(
        toSpiceDbActionObjectId(attachPersonEngagementAction).slice(3),
        'base64url',
      ).toString('utf-8'),
    ).toBe(attachPersonEngagementAction);
    expect(toSpiceDbActionObjectId(attachPersonEngagementAction)).not.toBe(
      toSpiceDbActionObjectId('contacts-core-attach-person-engagement'),
    );
  }),
);

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

const permissionResponse = (hasPermission: boolean) =>
  Option.some(
    response(
      hasPermission
        ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
        : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
    ),
  );

const hasActionGrant = (
  grants: ReadonlySet<string>,
  resourceId: string,
  principalId: string,
  tenantId: string | undefined,
): boolean =>
  grants.has(`${resourceId}:${principalId}`) ||
  (tenantId !== undefined && grants.has(`${resourceId}:${tenantId}`));

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
          const principalId = request.subject?.object?.objectId ?? '';
          const tenantId = principalTenants.get(principalId);
          if (request.permission === 'access') {
            return permissionResponse(tenantId === request.resource?.objectId);
          }
          return permissionResponse(
            hasActionGrant(state.grants, request.resource?.objectId ?? '', principalId, tenantId),
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

it.effect(
  'provisions with TOUCH, verifies both outcomes, and is safe to rerun',
  Effect.fn(function* testEffect9() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client, state } = makeProvisioningClient(target.contexts);
    const input = { actions: currentActions, contexts: target.contexts };

    const first = yield* provisionActionAuthorization(client, input);
    const second = yield* provisionActionAuthorization(client, input);

    expect(first).toEqual({ actionCount: 38, grantCount: 38, tenantCount: 1 });
    expect(second).toEqual(first);
    expect(state.schemaWriteCount).toBe(2);
    expect(state.relationshipWriteCount).toBe(2);
    expect(state.grants.size).toBe(38);
    expect(state.updates.length).toBe(76);
    expect(
      state.updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH),
    ).toBe(true);
    expect(
      ![...state.grants].some((grant) => grant.includes(ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID)),
    ).toBe(true);
  }),
);

it.effect(
  'never grants explicit Actions through Tenant membership and verifies recorded policy outcomes',
  Effect.fn(function* testEffect10() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const [context] = target.contexts;
    expect(context !== undefined).toBe(true);
    const deniedContext = {
      principalId: '00000000-0000-4000-8000-000000000020',
      tenantId: '00000000-0000-4000-8000-000000000021',
    };
    const contexts = [...target.contexts, deniedContext];
    const { client, state } = makeProvisioningClient(contexts);
    state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${context.principalId}`);

    const result = yield* provisionActionAuthorization(client, {
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
    });

    expect(result).toEqual({ actionCount: 2, grantCount: 2, tenantCount: 2 });
    expect(state.updates.length).toBe(2);
    expect(state.updates[0]?.relationship?.resource?.objectId).toBe(
      toSpiceDbActionObjectId(attachPersonEngagementAction),
    );
  }),
);

it.effect(
  'rejects missing or mismatched explicit Action verification assertions',
  Effect.fn(function* testEffect11() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    yield* Effect.all(
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
              {
                expected: 'denied' as const,
                principalId: ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID,
              },
            ],
          },
        ],
      ].map((explicitActionAssertions) =>
        Effect.gen(function* testEffect12() {
          const { client, state } = makeProvisioningClient(target.contexts);
          const error = yield* failureOf(
            provisionActionAuthorization(client, {
              actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
              contexts: target.contexts,
              explicitActionAssertions,
            }),
          );
          expect(error.code).toBe('action_authorization_input_invalid');
          expect(state.schemaWriteCount).toBe(0);
          expect(state.relationshipWriteCount).toBe(0);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'fails promotion when an explicit Action policy contradicts a recorded assertion',
  Effect.fn(function* testEffect13() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const [context] = target.contexts;
    expect(context !== undefined).toBe(true);
    const deniedPrincipalId = ACTION_AUTHORIZATION_DENIED_PRINCIPAL_ID;
    const assertions = [
      { expected: 'allowed' as const, principalId: context.principalId },
      { expected: 'denied' as const, principalId: deniedPrincipalId },
    ];

    yield* Effect.all(
      [[], [context.principalId, deniedPrincipalId]].map((actualAllowedPrincipalIds) =>
        Effect.gen(function* testEffect14() {
          const { client, state } = makeProvisioningClient(target.contexts);
          for (const principalId of actualAllowedPrincipalIds) {
            state.grants.add(`${toSpiceDbActionObjectId(restrictedAction)}:${principalId}`);
          }
          const error = yield* failureOf(
            provisionActionAuthorization(client, {
              actions: [{ actionKey: restrictedAction, provisioning: 'explicit' }],
              contexts: target.contexts,
              explicitActionAssertions: [{ actionKey: restrictedAction, assertions }],
            }),
          );
          expect(error.code).toBe('action_authorization_verification_failed');
          expect(state.updates.length).toBe(0);
        }),
      ),
      { concurrency: 'unbounded' },
    );
  }),
);

it.effect(
  'rejects invalid input and missing membership before writing grants',
  Effect.fn(function* testEffect15() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client, state } = makeProvisioningClient([]);
    const missingMembership = yield* failureOf(
      provisionActionAuthorization(client, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(missingMembership.code).toBe('action_authorization_membership_missing');
    expect(state.schemaWriteCount).toBe(1);
    expect(state.relationshipWriteCount).toBe(0);

    const duplicate = yield* failureOf(
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
    expect(duplicate.code).toBe('action_authorization_input_invalid');
    expect(state.schemaWriteCount).toBe(1);
  }),
);

it.effect(
  'fails closed when authorization returns no permission response',
  Effect.fn(function* testEffect16() {
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const { client } = makeProvisioningClient(target.contexts);
    const noResponseClient: ActionAuthorizationProvisioningClient = {
      ...client,
      checkPermission: () => Effect.succeed(Option.none()),
    };
    const error = yield* failureOf(
      provisionActionAuthorization(noResponseClient, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(error.code).toBe('action_authorization_membership_missing');
  }),
);

it.effect(
  'sanitizes authorization service failures',
  Effect.fn(function* testEffect17() {
    const secret = 'super-secret-credential';
    const upstreamFailure = new Error(secret);
    const target = yield* selectActionAuthorizationProvisioningTarget(developmentConfiguration);
    const unavailable: ActionAuthorizationProvisioningClient = {
      checkPermission: () =>
        Effect.succeed(
          Option.some(response(v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION)),
        ),
      writeRelationships: () => Effect.succeed(v1.WriteRelationshipsResponse.create({})),
      writeSchema: () => Effect.fail(upstreamFailure),
    };
    const error = yield* failureOf(
      provisionActionAuthorization(unavailable, {
        actions: currentActions,
        contexts: target.contexts,
      }),
    );
    expect(error.code).toBe('action_authorization_service_unavailable');
    expect(error.reason).not.toMatch(new RegExp(secret, 'u'));
    expect(decodeProvisioningFailureCause(error).cause).toBe(upstreamFailure);
  }),
);

const writeInventory = (
  root: string,
  verticals: readonly { readonly id: string; readonly package: string; readonly path: string }[],
) =>
  Effect.gen(function* testEffect18() {
    yield* Effect.tryPromise(() => mkdir(path.join(root, 'topology'), { recursive: true }));
    yield* Effect.all(
      [
        Effect.promise(() =>
          writeFile(
            path.join(root, 'topology/reference-topology.json'),
            JSON.stringify({ verticals }),
          ),
        ),
        Effect.promise(() =>
          writeFile(
            path.join(root, 'topology/ownership.json'),
            JSON.stringify({ owners: verticals }),
          ),
        ),
      ],
      { concurrency: 'unbounded' },
    );
  });

it.effect(
  'rejects incomplete and duplicate public Action discovery',
  Effect.fn(function* testEffect19() {
    const workspaceRoot = path.resolve(import.meta.dirname, '../..');
    // Native discovery imports registrations dynamically; keep its private registry in one module instance.
    const { discoverCurrentActionKeys } = yield* Effect.promise(
      (): Promise<{ readonly discoverCurrentActionKeys: typeof DiscoverCurrentActionKeys }> =>
        import(
          pathToFileURL(
            path.resolve(import.meta.dirname, '../provision-current-action-authorization.mts'),
          ).href
        ),
    );
    const { deriveOntosModuleDeploymentContract } = yield* Effect.promise(
      (): Promise<{ readonly deriveOntosModuleDeploymentContract: typeof DeriveModuleContract }> =>
        import(
          pathToFileURL(path.resolve(import.meta.dirname, '../generate-ontos-module-contract.mts'))
            .href
        ),
    );
    const { ActionAuthorizationProvisioningError: NativeProvisioningError } = yield* Effect.promise(
      (): Promise<{
        readonly ActionAuthorizationProvisioningError: typeof ActionAuthorizationProvisioningError;
      }> =>
        import(
          pathToFileURL(
            path.resolve(
              import.meta.dirname,
              '../../packages/core-runtime/src/install/action-authorization-provisioning.ts',
            ),
          ).href
        ),
    );
    const currentContract = yield* deriveOntosModuleDeploymentContract({
      vertical: 'party-registry',
      workspaceRoot,
    }).pipe(Effect.provide(NodeServices.layer));
    const [currentPublicAction] = currentContract.manifest.publicSurface.actions;
    expect(currentPublicAction !== undefined).toBe(true);
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-action-discovery-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const vertical = { id: 'example', package: '@app/example', path: 'verticals/example' };
    yield* writeInventory(root, [vertical]);
    const incomplete: typeof deriveOntosModuleDeploymentContract = () =>
      Effect.succeed({
        ...currentContract,
        deployment: { ...currentContract.deployment, appId: 'example' },
        manifest: {
          ...currentContract.manifest,
          publicSurface: { ...currentContract.manifest.publicSurface, actions: [] },
        },
      });
    const incompleteError = yield* rejectionOf(
      discoverCurrentActionKeys(root, incomplete).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Schema.is(NativeProvisioningError)(incompleteError)).toBe(true);
    expect(Schema.decodeUnknownSync(NativeProvisioningError)(incompleteError).code).toBe(
      'action_authorization_discovery_failed',
    );

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
    const duplicateError = yield* rejectionOf(
      discoverCurrentActionKeys(root, duplicate).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Schema.is(NativeProvisioningError)(duplicateError)).toBe(true);
    expect(Schema.decodeUnknownSync(NativeProvisioningError)(duplicateError).code).toBe(
      'action_authorization_discovery_failed',
    );

    yield* writeInventory(root, [vertical, vertical]);
    const duplicateInventoryError = yield* discoverCurrentActionKeys(root, duplicate).pipe(
      Effect.provide(NodeServices.layer),
      Effect.flip,
    );
    expect(Schema.is(NativeProvisioningError)(duplicateInventoryError)).toBe(true);
    expect(duplicateInventoryError.code).toBe('action_authorization_discovery_failed');
  }),
);

it.effect(
  'the operator entrypoint rejects every command-line argument before loading configuration',
  Effect.fn(function* testEffect20() {
    const error = yield* failureOf(
      runCurrentActionAuthorizationProvisioning(path.resolve(import.meta.dirname, '../..'), [
        '--tenant',
        'arbitrary',
      ]),
    );
    expect(error.code).toBe('action_authorization_configuration_invalid');
    expect(error.reason).toMatch(/no command-line arguments/u);
  }),
);
