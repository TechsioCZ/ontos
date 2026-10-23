import { randomBytes, randomUUID } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Config, ConfigProvider, DateTime, Effect, FileSystem, Option, Predicate, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActionRuntime,
  makeActionCompositionRevisionResolver,
  makeActionRuntime,
} from '../../packages/core-runtime/src/actions/runtime.ts';
import { ActionAuthorityLive } from '../../packages/core-runtime/src/permissions/action-authority.ts';
import { OAuthFlowLive } from '../../apps/shell-super-app/api/auth/oauth-server/oauth-flow-live.ts';
import { makeReadRuntime } from '../../packages/core-runtime/src/reads/runtime.ts';
import { managedPrincipalsRead } from '../../packages/core-runtime/src/auth/principal-administration-reads.ts';
import { bindManagedApiKeyAction } from '../../packages/core-runtime/src/modules/actions/bind-managed-api-key.action.ts';
import { setManagedApiKeyBindingStatusAction } from '../../packages/core-runtime/src/modules/actions/set-managed-api-key-binding-status.action.ts';
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
  toModuleAccessObjectId,
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
import { apikey, user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { makeApiKeyService } from '../../apps/shell-super-app/api/auth/api-key-service.ts';
import { makeIdentityLifecycleService } from '../../apps/shell-super-app/api/auth/identity-lifecycle.ts';
import { AuthenticationService, makeAuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';
import { makeInstalledModuleCatalogLayer } from '../../apps/shell-super-app/api/modules/installed-module-catalog.ts';
import { runAgentOperatorSetup } from '../demo/setup-agent-operators.mts';
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
        ...companies.map((legalEntityId) =>
          relationship(
            'module_access',
            toModuleAccessObjectId(tenantId, legalEntityId, 'core.identity') ?? '',
            'legal_entity',
            'legal_entity',
            toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
          ),
        ),
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
          [bindManagedApiKeyAction, setManagedApiKeyBindingStatusAction].map((action) => ({
            actionKey: action.descriptor.actionKey,
            tenantId,
          })),
        ),
        ...buildActionAuthorizationRelationships(
          companies.flatMap((legalEntityId) =>
            [configureAgentAction, bindManagedApiKeyAction, setManagedApiKeyBindingStatusAction].map((action) => ({
              actionKey: action.descriptor.actionKey,
              legalEntityId,
              tenantId,
            })),
          ),
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
        // The same native managed lifecycle used by Shell and setup issues one-time provider keys.
        const keys = yield* makeApiKeyService().pipe(
          Effect.provideService(AuthConfig, authConfig),
          Effect.provideService(AuthDatabase, authDatabase),
        );
        const lifecycle = makeIdentityLifecycleService(runtime, keys, resolver);
        const readRuntime = makeReadRuntime(
          database,
          makeModuleEntrypointGateway(gate),
          makeOperationalScopeResolver(makeOperationalScopeRepository(database), access),
          access,
        );
        const adminId = randomUUID();
        const adminEmail = `company-admin-${randomUUID()}@example.org`;
        const adminPassword = randomBytes(32).toString('base64url');
        const adminUserId = yield* authentication.createFixtureUser(
          adminEmail,
          'Real company admin',
          Redacted.make(adminPassword),
        );
        yield* admin.executor.insert(principals).values({
          displayName: 'Real company admin',
          kind: 'human',
          principalId: adminId,
          status: 'active',
          tenantId,
        });
        yield* admin.executor.insert(principalAuthBindings).values({
          authenticationNamespaceId: registration.authenticationNamespaceId,
          principalId: adminId,
          provider: 'better_auth',
          providerSubjectId: adminUserId,
          status: 'active',
          subjectType: 'user',
          tenantId,
        });
        const companyRole = toScopedRoleObjectId({
          legalEntityId: original.legalEntityId,
          roleKey: 'company-admin',
          tenantId,
        });
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                relationship('tenant', tenantId, 'member', 'principal', adminId),
                relationship(
                  'legal_entity',
                  toLegalEntityAccessObjectId(tenantId, original.legalEntityId) ?? '',
                  'member',
                  'principal',
                  adminId,
                ),
                relationship('scoped_role', companyRole, 'member', 'principal', adminId),
                relationship(
                  'legal_entity',
                  toLegalEntityAccessObjectId(tenantId, original.legalEntityId) ?? '',
                  'admin',
                  'scoped_role',
                  companyRole,
                  'member',
                ),
              ].map((row) => ({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship: row })),
            }),
          ),
        );
        const companyOperator = yield* Effect.acquireRelease(
          authenticateAgentProfileOperator.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({
                    ONTOS_AGENT_SETUP_EMAIL: adminEmail,
                    ONTOS_AGENT_SETUP_PASSWORD: adminPassword,
                  }),
                  ConfigProvider.fromEnv(),
                ),
              ),
            ),
          ),
          (session) => session.close.pipe(Effect.ignore),
        );
        const companyPrincipal = { ...companyOperator.principal, legalEntityId: original.legalEntityId };
        const companyAgentScope = 'company-agent' as const;
        const tenantManagedScope = 'tenant-managed' as const;
        const keyInput = {
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          managedPrincipalId: original.principalId,
          managedScope: companyAgentScope,
          name: 'Explicit company agent',
          principal: companyPrincipal,
          requestHeaders: companyOperator.requestHeaders,
        };
        const otherCompany = companies.find((company) => company !== original.legalEntityId);
        if (otherCompany === undefined) {
          return yield* Effect.die('Missing second approved company');
        }
        // A real tenant superadmin still cannot claim another company's agent through the discriminator.
        expect(
          Predicate.isTagged(
            yield* lifecycle
              .issue({
                ...keyInput,
                idempotencyKey: randomUUID(),
                principal: { ...operator.principal, legalEntityId: otherCompany },
              })
              .pipe(Effect.flip),
            'IdentityTargetInvalidError',
          ),
        ).toBe(true);
        const unprofiledId = randomUUID();
        yield* admin.executor.insert(principals).values({
          displayName: 'Unprofiled company agent',
          kind: 'agent',
          principalId: unprofiledId,
          status: 'active',
          tenantId,
        });
        yield* admin.executor.insert(principalCompanyMemberships).values({
          affiliation: null,
          legalEntityId: original.legalEntityId,
          principalId: unprofiledId,
          status: 'active',
          tenantId,
        });
        expect(
          Predicate.isTagged(
            yield* lifecycle
              .issue({
                ...keyInput,
                idempotencyKey: randomUUID(),
                managedPrincipalId: unprofiledId,
              })
              .pipe(Effect.flip),
            'IdentityTargetInvalidError',
          ),
        ).toBe(true);
        const issuedKey = yield* lifecycle.issue(keyInput);
        expect(issuedKey.cleanupPending).toBe(false);
        expect(Object.hasOwn(issuedKey, 'providerKeyId')).toBe(false);
        const verifiedKey = yield* keys.verify(Redacted.value(issuedKey.secret));
        const [storedKey] = yield* authDatabase.executor
          .select({ key: apikey.key })
          .from(apikey)
          .where(eq(apikey.id, verifiedKey.providerKeyId));
        expect(storedKey?.key).not.toBe(Redacted.value(issuedKey.secret));
        const listInput = {
          input: { limit: 100, offset: 0, principalId: original.principalId, scope: companyAgentScope },
          principal: companyPrincipal,
          registration: managedPrincipalsRead,
          transport: { correlationId: randomUUID() },
        };
        const listed = yield* readRuntime.runRead(listInput);
        expect(listed.items.map((item) => Option.getOrNull(item.authBindingId))).toEqual([issuedKey.authBindingId]);
        // The caller cannot select company-agent to acquire a tenant workload key.
        const serviceId = randomUUID();
        yield* admin.executor.insert(principals).values({
          displayName: 'Tenant service',
          kind: 'service',
          principalId: serviceId,
          status: 'active',
          tenantId,
        });
        expect(
          Predicate.isTagged(
            yield* lifecycle
              .issue({ ...keyInput, idempotencyKey: randomUUID(), managedPrincipalId: serviceId })
              .pipe(Effect.flip),
            'IdentityTargetInvalidError',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* lifecycle
              .issue({
                ...keyInput,
                idempotencyKey: randomUUID(),
                managedPrincipalId: serviceId,
                managedScope: tenantManagedScope,
                principal: companyOperator.principal,
              })
              .pipe(Effect.flip),
            'ActionPermissionDenied',
          ),
        ).toBe(true);
        const tenantKey = yield* lifecycle.issue({
          ...keyInput,
          idempotencyKey: randomUUID(),
          managedPrincipalId: serviceId,
          managedScope: tenantManagedScope,
          principal: operator.principal,
          requestHeaders: operator.requestHeaders,
        });
        expect(tenantKey.cleanupPending).toBe(false);
        yield* lifecycle.setStatus({
          authBindingId: tenantKey.authBindingId,
          correlationId: randomUUID(),
          expectedStatus: 'active',
          idempotencyKey: randomUUID(),
          managedPrincipalId: serviceId,
          managedScope: tenantManagedScope,
          newStatus: 'revoked',
          principal: operator.principal,
          reason: 'Tenant service proof cleanup',
        });
        // Native Action execute denies a normal member, including provider reconciliation with a matching status.
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                {
                  operation: v1.RelationshipUpdate_Operation.DELETE,
                  relationship: relationship('scoped_role', companyRole, 'member', 'principal', adminId),
                },
              ],
            }),
          ),
        );
        expect(
          Predicate.isTagged(
            yield* lifecycle.issue({ ...keyInput, idempotencyKey: randomUUID() }).pipe(Effect.flip),
            'ActionPermissionDenied',
          ),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* lifecycle
              .setStatus({
                authBindingId: issuedKey.authBindingId,
                correlationId: randomUUID(),
                expectedStatus: 'active',
                idempotencyKey: randomUUID(),
                managedPrincipalId: original.principalId,
                managedScope: companyAgentScope,
                newStatus: 'active',
                principal: companyPrincipal,
              })
              .pipe(Effect.flip),
            'ActionPermissionDenied',
          ),
        ).toBe(true);
        expect((yield* keys.metadata(verifiedKey.providerKeyId)).enabled).toBe(true);
        yield* Effect.promise(() =>
          graph.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                {
                  operation: v1.RelationshipUpdate_Operation.TOUCH,
                  relationship: relationship('scoped_role', companyRole, 'member', 'principal', adminId),
                },
              ],
            }),
          ),
        );
        const rotated = yield* lifecycle.rotate({
          ...keyInput,
          idempotencyKey: randomUUID(),
          oldAuthBindingId: issuedKey.authBindingId,
          oldManagedPrincipalId: original.principalId,
          reason: 'Real native rotation proof',
        });
        expect((yield* keys.metadata(verifiedKey.providerKeyId)).enabled).toBe(false);
        expect(
          (yield* resolver.loadApiKeyBindingForAdministration({
            authBindingId: issuedKey.authBindingId,
            principalId: original.principalId,
            tenantId,
          })).status,
        ).toBe('revoked');
        const afterRotation = yield* readRuntime.runRead(listInput);
        expect(afterRotation.items.map((item) => Option.getOrNull(item.authBindingId))).toEqual([
          rotated.authBindingId,
        ]);
        const revoked = yield* lifecycle.setStatus({
          authBindingId: rotated.authBindingId,
          correlationId: randomUUID(),
          expectedStatus: 'active',
          idempotencyKey: randomUUID(),
          managedPrincipalId: original.principalId,
          managedScope: companyAgentScope,
          newStatus: 'revoked',
          principal: companyPrincipal,
          reason: 'Real native revocation proof',
        });
        expect(revoked.enabled).toBe(false);
        expect(
          Predicate.isTagged(
            yield* keys.verify(Redacted.value(rotated.secret)).pipe(Effect.flip),
            'ApiKeyCredentialInvalidError',
          ),
        ).toBe(true);
        const operatorInputs = [
          {
            agentPrincipalId: original.principalId,
            legalEntityId: original.legalEntityId,
            operatorPrincipalIds: [adminId],
          },
        ];
        expect((yield* runAgentOperatorSetup(operator.principal, operatorInputs, 'dry-run')).applied).toBe(0);
        expect((yield* runAgentOperatorSetup(operator.principal, operatorInputs, 'apply')).applied).toBe(1);
        const operatorAudits = () =>
          admin.executor
            .select()
            .from(auditEvents)
            .where(
              and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'identity.agent_operators_changed')),
            );
        expect(yield* operatorAudits()).toHaveLength(1);
        expect((yield* runAgentOperatorSetup(operator.principal, operatorInputs, 'apply')).applied).toBe(0);
        yield* runAgentOperatorSetup(operator.principal, operatorInputs, 'verify');
        expect(yield* operatorAudits()).toHaveLength(1);

        return yield* Effect.void;
      }).pipe(
        Effect.provide(ActionAuthorityLive),
        Effect.provide(OAuthFlowLive),
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
