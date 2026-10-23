import { randomBytes, randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Config, ConfigProvider, DateTime, Effect, FileSystem, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActionRuntime,
  makeActionCompositionRevisionResolver,
  makeActionRuntime,
} from '../../packages/core-runtime/src/actions/runtime.ts';
import { makeActionRepository } from '../../packages/core-runtime/src/actions/repository.ts';
import { makePrincipalResolver, PrincipalResolver } from '../../packages/core-runtime/src/auth/principal-resolver.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import { staffAuthenticationNamespaceRegistration } from '../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { makeCoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  legalEntities,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../packages/core-runtime/src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { configureAgentAction } from '../../packages/core-runtime/src/modules/actions/configure-agent.action.ts';
import { makeModuleEntrypointGateway } from '../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../packages/core-runtime/src/operations/context.ts';
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';
import { createSpiceDbPermissionClient } from '../../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import {
  ContextAccess,
  makeContextAccess,
  toLegalEntityAccessObjectId,
} from '../../packages/core-runtime/src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { ActionPermission, makeActionPermissionService } from '../../packages/core-runtime/src/permissions/service.ts';
import { newSpiceDbGrpcClient } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../../packages/core-runtime/tests/support/outbox-worker-composition.ts';
import { AuthConfig, loadAuthConfig } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { AuthenticationService, makeAuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';
import { makeInstalledModuleCatalogLayer } from '../../apps/shell-super-app/api/modules/installed-module-catalog.ts';
import { authenticateAgentProfileOperator } from '../demo/agent-profile-operator.mts';
import {
  AgentProfileReadDatabase,
  AgentProfileSetupError,
  readReviewedAgentProfiles,
  reviewedProfileInputs,
  REVIEWED_AGENT_PROFILES_SHA256,
  runAgentProfileSetup,
} from '../demo/agent-profile-setup.mts';

const relationship = (
  type: string,
  id: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  optionalRelation = '',
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: id, objectType: type },
    subject: { object: { objectId: subjectId, objectType: subjectType }, optionalRelation },
  });

it.live(
  'fingerprints all six rows and replays native audited profiles/scoped grants with read-only modes and idempotence',
  () =>
    Effect.gen(function* reviewedReplayProof() {
      const pair = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      expect(pair.runtime.database).toMatch(/^people_model_scratch_20261023_[0-9a-f]+$/u);
      expect(pair.admin.database).toBe(pair.runtime.database);
      const config = yield* loadSpiceDbConfig();
      expect(config.endpoint).toMatch(/^localhost:\d+$/u);
      const inputFile = yield* Config.String('ONTOS_AGENT_REPLAY_PROOF_INPUT');
      const document = yield* readReviewedAgentProfiles(inputFile, REVIEWED_AGENT_PROFILES_SHA256);
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.makeTempDirectoryScoped();
      const corruptFile = `${tmp}/corrupt-input.json`;
      yield* fs.writeFileString(corruptFile, '{}');
      expect(
        yield* readReviewedAgentProfiles(corruptFile, REVIEWED_AGENT_PROFILES_SHA256).pipe(Effect.flip),
      ).toBeInstanceOf(AgentProfileSetupError);
      expect(yield* readReviewedAgentProfiles(inputFile, '0'.repeat(64)).pipe(Effect.flip)).toBeInstanceOf(
        AgentProfileSetupError,
      );
      const [first] = document.profiles;
      if (first === undefined) {
        return yield* Effect.die('Missing six-row approved input');
      }
      const { tenantId } = first;
      const companies = [...new Set(document.profiles.map((row) => row.legalEntityId))];
      const database = yield* makeCoreDatabase(pair.runtime);
      const admin = yield* makeCoreDatabase(pair.admin);
      const graph = yield* Effect.acquireRelease(
        Effect.sync(() => newSpiceDbGrpcClient(config)),
        (rpc) => Effect.sync(() => rpc.close()),
      );
      yield* Effect.promise(() =>
        graph.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      );
      const moduleIds = [...new Set(document.profiles.flatMap((row) => row.modules.map((module) => module.moduleId)))];
      const composition = makeOutboxWorkerComposition(
        moduleIds.map((moduleId) => ({ appId: moduleId.replaceAll('.', '-'), moduleId })),
      );
      const authority = { load: freshOutboxWorkerCompositionSnapshot(composition) };
      const snapshot = yield* authority.load;
      yield* admin.executor
        .insert(applicationCompositionAuthority)
        .values({
          authorityKey: 'active',
          phase: 'active',
          revision: composition.revision,
          subscriptionsJson: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
          validUntil: DateTime.toDateUtc(snapshot.validUntil),
        })
        .onConflictDoUpdate({
          set: { revision: composition.revision, validUntil: DateTime.toDateUtc(snapshot.validUntil) },
          target: applicationCompositionAuthority.authorityKey,
        });
      yield* admin.executor.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Owned replay proof',
        slug: `replay-${randomUUID()}`,
        status: 'active',
        tenantId,
      });
      yield* admin.executor.insert(legalEntities).values(
        companies.map((legalEntityId) => ({
          legalEntityId,
          legalName: 'Owned company',
          registrationCountry: 'CZ',
          registrationNumber: legalEntityId,
          status: 'active' as const,
          tenantId,
        })),
      );
      const actorId = randomUUID();
      const bindingId = randomUUID();
      const registration = yield* staffAuthenticationNamespaceRegistration(['shell-super-app']);
      const registry = makeAuthenticationNamespaceRegistry([registration]);
      yield* admin.executor.insert(principals).values([
        {
          displayName: 'Real authenticated operator',
          kind: 'human',
          principalId: actorId,
          status: 'active',
          tenantId,
        },
        ...document.profiles.map((row) => ({
          displayName: `Preserved ${row.principalId}`,
          kind: 'agent' as const,
          principalId: row.principalId,
          status: 'active' as const,
          tenantId,
        })),
      ]);
      const authConfig = yield* loadAuthConfig({ envPath: '/dev/null' });
      const authDatabase = yield* makeAuthDatabase(authConfig);
      const resolver = makePrincipalResolver(database, {
        authenticationNamespaceId: registration.authenticationNamespaceId,
      });
      const authentication = yield* makeAuthenticationService({ allowFixtureSignUp: true }).pipe(
        Effect.provideService(AuthConfig, authConfig),
        Effect.provideService(AuthDatabase, authDatabase),
        Effect.provideService(PrincipalResolver, resolver),
      );
      const email = `operator-${randomUUID()}@example.org`;
      const secret = randomBytes(32).toString('base64url');
      const authUserId = yield* authentication.createFixtureUser(email, 'Owned real operator', Redacted.make(secret));
      yield* admin.executor.insert(principalAuthBindings).values({
        authenticationNamespaceId: registration.authenticationNamespaceId,
        principalAuthBindingId: bindingId,
        principalId: actorId,
        provider: 'better_auth',
        providerSubjectId: authUserId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      });
      // Catalog personas are explicit test data, not authority: the graph stores their native role policies.
      const templateEmails = [
        'obchod@demo.ontos',
        'obchodnik@demo.ontos',
        'ucetni@demo.ontos',
        'sklad@demo.ontos',
        'spravce@hanak.demo',
        'vedouci@hanak.demo',
        'obchodnik.a@hanak.demo',
      ];
      const templates = templateEmails.map((templateEmail) => ({
        email: templateEmail,
        principalId: randomUUID(),
        userId: randomUUID(),
      }));
      yield* authDatabase.executor.insert(user).values(
        templates.map((template) => ({
          email: template.email,
          emailVerified: true,
          id: template.userId,
          name: 'Owned role template',
        })),
      );
      yield* admin.executor.insert(principals).values(
        templates.map((template) => ({
          displayName: 'Owned role template',
          kind: 'human' as const,
          principalId: template.principalId,
          status: 'active' as const,
          tenantId,
        })),
      );
      yield* admin.executor.insert(principalAuthBindings).values(
        templates.map((template) => ({
          authenticationNamespaceId: registration.authenticationNamespaceId,
          principalAuthBindingId: randomUUID(),
          principalId: template.principalId,
          provider: 'better_auth',
          providerSubjectId: template.userId,
          status: 'active' as const,
          subjectType: 'user' as const,
          tenantId,
        })),
      );
      yield* admin.executor.insert(principalCompanyMemberships).values(
        document.profiles.map((row) => ({
          affiliation: null,
          legalEntityId: row.legalEntityId,
          principalId: row.principalId,
          status: 'active' as const,
          tenantId,
        })),
      );
      const role = toScopedRoleObjectId({ roleKey: 'tenant-superadmin', tenantId });
      const graphRows = [
        relationship('tenant', tenantId, 'member', 'principal', actorId),
        relationship('scoped_role', role, 'member', 'principal', actorId),
        relationship('tenant', tenantId, 'superadmin', 'scoped_role', role, 'member'),
        ...companies.map((legalEntityId) =>
          relationship(
            'legal_entity',
            toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
            'tenant',
            'tenant',
            tenantId,
          ),
        ),
        ...buildActionAuthorizationRelationships(
          companies.map((legalEntityId) => ({
            actionKey: configureAgentAction.descriptor.actionKey,
            legalEntityId,
            tenantId,
          })),
        ),
      ];
      yield* Effect.promise(() =>
        graph.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: graphRows.map((row) => ({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: row })),
          }),
        ),
      );
      const permissions = createSpiceDbPermissionClient(config, 5000);
      const access = makeContextAccess(permissions);
      const actionPermission = makeActionPermissionService(permissions);
      const gate = makeModuleStateGate(makeTenantModuleStateService(database));
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        actionPermission,
        makeOperationalScopeResolver(makeOperationalScopeRepository(database), access),
        {
          contextAccess: access,
          moduleEntrypointGateway: makeModuleEntrypointGateway(gate),
          moduleStateGate: gate,
          resolveCompositionRevision: makeActionCompositionRevisionResolver(authority, composition.shell.deployment),
        },
      );
      const proof = Effect.gen(function* applyAndVerify() {
        const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
          session.close.pipe(Effect.ignore),
        );
        expect(operator.principal.principalId).toBe(actorId);
        const inputs = yield* reviewedProfileInputs(document);
        const auditCount = () =>
          admin.executor
            .select()
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.tenantId, tenantId),
                eq(auditEvents.eventType, 'action.executed'),
                eq(auditEvents.outcome, 'succeeded'),
              ),
            )
            .pipe(Effect.map((rows) => rows.length));
        const before = yield* auditCount();
        const dryRun = yield* runAgentProfileSetup(
          operator.principal,
          inputs,
          'dry-run',
          REVIEWED_AGENT_PROFILES_SHA256,
        );
        expect(dryRun.applied).toBe(0);
        expect(yield* auditCount()).toBe(before);
        expect(
          yield* runAgentProfileSetup(operator.principal, inputs, 'verify', REVIEWED_AGENT_PROFILES_SHA256).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(AgentProfileSetupError);
        // A bad final row must prevent the first five Actions, not leave a partially applied batch.
        const last = inputs.at(-1);
        if (last === undefined) {
          return yield* Effect.die('Missing final approved input');
        }
        const lastMembership = and(
          eq(principalCompanyMemberships.tenantId, last.tenantId),
          eq(principalCompanyMemberships.legalEntityId, last.legalEntityId),
          eq(principalCompanyMemberships.principalId, last.principalId),
        );
        yield* admin.executor.update(principalCompanyMemberships).set({ status: 'disabled' }).where(lastMembership);
        expect(
          yield* runAgentProfileSetup(operator.principal, inputs, 'apply', REVIEWED_AGENT_PROFILES_SHA256).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(AgentProfileSetupError);
        expect(yield* auditCount()).toBe(before);
        yield* admin.executor.update(principalCompanyMemberships).set({ status: 'active' }).where(lastMembership);
        const applied = yield* runAgentProfileSetup(
          operator.principal,
          inputs,
          'apply',
          REVIEWED_AGENT_PROFILES_SHA256,
        );
        expect(applied.applied).toBe(6);
        expect(yield* auditCount()).toBe(before + 6);
        expect(
          (yield* runAgentProfileSetup(operator.principal, inputs, 'verify', REVIEWED_AGENT_PROFILES_SHA256)).verified,
        ).toBe(true);
        expect(
          (yield* runAgentProfileSetup(operator.principal, inputs, 'apply', REVIEWED_AGENT_PROFILES_SHA256)).applied,
        ).toBe(0);
        expect(yield* auditCount()).toBe(before + 6);
        // A newer admin edit is not overwritten by replaying the old deterministic source key.
        const [original] = inputs;
        if (original === undefined) {
          return yield* Effect.die('Missing approved input');
        }
        yield* runtime.runAction({
          payload: {
            description: original.description,
            displayName: original.displayName,
            modules: [],
            operation: 'configure-agent',
            ownerPrincipalId: original.ownerPrincipalId,
            principalId: original.principalId,
            writePolicy: 'approval',
          },
          principal: { ...operator.principal, legalEntityId: original.legalEntityId },
          registration: configureAgentAction,
          transport: { correlationId: randomUUID(), idempotencyKey: randomUUID() },
        });
        expect(
          yield* runAgentProfileSetup(operator.principal, inputs, 'apply', REVIEWED_AGENT_PROFILES_SHA256).pipe(
            Effect.flip,
          ),
        ).toBeInstanceOf(AgentProfileSetupError);
        expect(yield* auditCount()).toBe(before + 7);
        return yield* Effect.void;
      }).pipe(
        Effect.provideService(ActionRuntime, runtime),
        Effect.provideService(ActionPermission, actionPermission),
        Effect.provideService(AgentProfileReadDatabase, { executor: admin.executor }),
        Effect.provideService(AuthDatabase, authDatabase),
        Effect.provideService(AuthConfig, authConfig),
        Effect.provideService(AuthenticationService, authentication),
        Effect.provideService(ContextAccess, access),
        Effect.provideService(AuthenticationNamespaceRegistry, registry),
        Effect.provide(makeInstalledModuleCatalogLayer(authority.load)),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ ONTOS_AGENT_SETUP_EMAIL: email, ONTOS_AGENT_SETUP_PASSWORD: secret }),
              ConfigProvider.fromEnv(),
            ),
          ),
        ),
      );
      return yield* proof;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  120_000,
);
