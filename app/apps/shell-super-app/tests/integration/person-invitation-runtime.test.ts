import { randomBytes, randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { Config, Context, Crypto, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import {
  ActionAlreadyCommitted,
  ActionPermissionDenied,
} from '../../../../packages/core-runtime/src/actions/errors.ts';
import {
  IdentityLifecycleConflictError,
  IdentityTargetInvalidError,
} from '../../../../packages/core-runtime/src/auth/principal-management-errors.ts';
import { OperationContextDenied } from '../../../../packages/core-runtime/src/operations/errors.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import {
  makeActionCompositionRevisionResolver,
  makeActionRuntime,
} from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../../../packages/core-runtime/src/auth/external-identity/verifier.ts';
import {
  LegalEntityContext,
  makeLegalEntityContext,
} from '../../../../packages/core-runtime/src/auth/legal-entity-context.ts';
import {
  makePrincipalResolver,
  PrincipalResolver,
} from '../../../../packages/core-runtime/src/auth/principal-resolver.ts';
import {
  staffAuthenticationNamespaceRegistration,
  STAFF_AUTHENTICATION_NAMESPACE_ID,
} from '../../../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  applicationCompositionAuthority,
  auditEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  personInvitations,
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { buildActionAuthorizationRelationships } from '../../../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { invitePersonAction } from '../../../../packages/core-runtime/src/modules/actions/invite-person.action.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import {
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from '../../../../packages/core-runtime/src/operations/context.ts';
import {
  corePrincipalLifecycleSubscription,
  CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
} from '../../../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';
import { createSpiceDbPermissionClient } from '../../../../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import {
  ContextAccess,
  makeContextAccess,
  toLegalEntityAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';
import { ActiveApplicationCompositionService } from '../../../../packages/core-runtime/src/modules/active-application-composition.ts';
import { coreSystemOutboxWorkers } from '../../../../packages/core-runtime/src/outbox/core-system-worker-entry.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';
import {
  ActionAuthorizationLifecycle,
  ActionAuthorizationLifecycleLive,
} from '../../../../packages/core-runtime/src/permissions/action-authorization-lifecycle.ts';
import { ScopedRoleMembershipLifecycleLive } from '../../../../packages/core-runtime/src/permissions/scoped-role-membership-lifecycle.ts';
import { makeActionPermissionService } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { toScopedRoleObjectId } from '../../../../packages/core-runtime/src/permissions/scoped-role.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../../../../packages/core-runtime/tests/support/outbox-worker-composition.ts';
import { dispatchEmailBatchWith } from '../../../../packages/email-delivery/src/dispatcher/dispatch.ts';
import { SmtpEmailDeliveryLive } from '../../../../packages/email-delivery/src/smtp.ts';
import type { EmailTransportRuntime } from '../../../../packages/email-delivery/src/transport-runtime.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, BetterAuthNativeAdapterLive, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, user, verification } from '../../api/auth/db/schema.ts';
import { BetterAuthPersonInvitationIdentityProviderLive } from '../../api/auth/db/person-invitation-provider.ts';
import { setInvitationPassword } from '../../api/auth/invitation/transport.ts';
import { BetterAuthFrameworkLive } from '../../api/auth/better-auth-framework.ts';
import { BetterAuthRuntimeLive } from '../../api/auth/better-auth-runtime.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';
import { OAuthCredentialsLive } from '../../api/auth/db/oauth-credentials-live.ts';
import { OAuthEndpointGuardsLive } from '../../api/auth/oauth-server/endpoint-guards.ts';
import { OAuthConnectionHooksLive } from '../../api/oauth-connections/better-auth-hooks.ts';
import { OAuthEndpointGuardDataLive } from '../../api/oauth-connections/grant-store.ts';
import { OAuthAuthenticationAuditLive } from '../../../../packages/core-runtime/src/auth/oauth-authentication-audit.ts';
import { OAuthGrantRegistryLive } from '../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

const CapturedMailSchema = Schema.Struct({ ID: Schema.String, Subject: Schema.String });
const MailSearchSchema = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(CapturedMailSchema) }));
const MailMessageSchema = Schema.fromJsonString(Schema.Struct({ Text: Schema.String }));
const capturedFrom = (mailpitUrl: string, recipient: string) => {
  const query = encodeURIComponent(`to:${recipient}`);
  return Effect.tryPromise(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/search?query=${query}`);
    if (!response.ok) {
      throw new Error('Owned invitation Mailpit search failed');
    }
    return await response.text();
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(MailSearchSchema)),
    Effect.map((result) => result.messages),
  );
};
const readCapturedFrom = (mailpitUrl: string, id: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
    if (!response.ok) {
      throw new Error('Owned invitation Mailpit message read failed');
    }
    return await response.text();
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MailMessageSchema)));
const deleteCapturedFrom = (mailpitUrl: string, message: typeof CapturedMailSchema.Type) =>
  Effect.tryPromise(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/messages`, {
      body: JSON.stringify({ IDs: [message.ID] }),
      headers: { 'content-type': 'application/json' },
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error('Owned invitation Mailpit message cleanup failed');
    }
  });
const deleteRecipientMessagesFrom = (mailpitUrl: string, email: string) =>
  capturedFrom(mailpitUrl, email).pipe(
    Effect.flatMap((messages) =>
      Effect.forEach(messages, (message) => deleteCapturedFrom(mailpitUrl, message), { discard: true }),
    ),
    Effect.ignore,
  );
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

// This proof owns a throwaway DB and isolated SpiceDB schema. Never run against the demo database/graph.
it.live(
  'accepts native invitations atomically with company admission, without granting roles or business authority',
  () =>
    Effect.gen(function* invitationRuntime() {
      const crypto = yield* Crypto.Crypto;
      const mailpitUrl = yield* Config.String('ONTOS_INVITATION_TEST_MAILPIT_URL');
      const smtpPort = yield* Config.Int('ONTOS_INVITATION_TEST_SMTP_PORT');
      expect(new URL(mailpitUrl).hostname).toBe('127.0.0.1');
      const captured = (email: string) => capturedFrom(mailpitUrl, email);
      const readCaptured = (id: string) => readCapturedFrom(mailpitUrl, id);
      const deleteRecipientMessages = (email: string) => deleteRecipientMessagesFrom(mailpitUrl, email);
      const pair = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      expect(pair.runtime.database).toMatch(/^people_model_scratch_20261023_[0-9a-f]+$/u);
      expect(pair.admin.database).toBe(pair.runtime.database);
      const graphConfiguration = yield* loadSpiceDbConfig();
      expect(graphConfiguration.endpoint).toMatch(/^localhost:\d+$/u);
      const database = yield* makeCoreDatabase(pair.runtime);
      const admin = yield* makeCoreDatabase(pair.admin);
      const graph = yield* Effect.acquireRelease(
        Effect.sync(() => newSpiceDbGrpcClient(graphConfiguration)),
        (client) => Effect.sync(() => client.close()),
      );
      yield* Effect.promise(() =>
        graph.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      );
      const composition = makeOutboxWorkerComposition();
      const authority = { load: freshOutboxWorkerCompositionSnapshot(composition) };
      const snapshot = yield* authority.load;
      yield* admin.executor.insert(applicationCompositionAuthority).values({
        authorityKey: 'active',
        phase: 'active',
        revision: composition.revision,
        subscriptionsJson: CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS,
        validUntil: DateTime.toDateUtc(snapshot.validUntil),
      });
      yield* Effect.addFinalizer(() =>
        admin.executor
          .delete(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.revision, composition.revision))
          .pipe(Effect.orDie),
      );
      const tenantId = randomUUID();
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const adminId = randomUUID();
      const ordinaryId = randomUUID();
      const recipient = `people-auth-${randomUUID()}@example.org`;
      const expiredRecipient = `people-auth-expired-${randomUUID()}@example.org`;
      const rollbackRecipient = `people-auth-rollback-${randomUUID()}@example.org`;
      const deniedRecipient = `people-auth-denied-${randomUUID()}@example.org`;
      const recipients = [recipient, expiredRecipient, rollbackRecipient, deniedRecipient];
      // Delete only this proof's Mailpit messages, never empty a shared inbox.
      yield* Effect.addFinalizer(() => Effect.forEach(recipients, deleteRecipientMessages, { discard: true }));
      const registration = yield* staffAuthenticationNamespaceRegistration(['core-runtime-test']);
      const registry = makeAuthenticationNamespaceRegistry([registration]);
      yield* admin.executor.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Owned invitation proof',
        slug: `invitation-${tenantId}`,
        status: 'active',
        tenantId,
      });
      yield* admin.executor.insert(legalEntities).values(
        [companyId, otherCompanyId].map((id) => ({
          legalEntityId: id,
          legalName: 'Vlastní společnost',
          registrationCountry: 'CZ',
          registrationNumber: id,
          status: 'active',
          tenantId,
        })),
      );
      yield* admin.executor.insert(principals).values(
        [adminId, ordinaryId].map((id) => ({
          displayName: 'Owned actor',
          kind: 'human' as const,
          principalId: id,
          status: 'active' as const,
          tenantId,
        })),
      );
      const bindings = [adminId, ordinaryId].map((id) => ({
        authenticationNamespaceId: registration.authenticationNamespaceId,
        principalAuthBindingId: randomUUID(),
        principalId: id,
        provider: 'better_auth',
        providerSubjectId: randomUUID(),
        status: 'active' as const,
        subjectType: 'user' as const,
        tenantId,
      }));
      yield* admin.executor.insert(principalAuthBindings).values(bindings);
      const actor = (id: string, legalEntityId = companyId) => {
        const binding = bindings.find((row) => row.principalId === id);
        if (binding === undefined) {
          expect.unreachable('Missing owned actor binding');
        }
        return {
          authBindingId: binding.principalAuthBindingId,
          authContextRef: `session:${randomUUID()}`,
          authenticationNamespaceId: registration.authenticationNamespaceId,
          authMethod: 'session' as const,
          legalEntityId,
          principalId: id,
          tenantId,
        };
      };
      const companyObject = (id: string) => {
        const objectId = toLegalEntityAccessObjectId(tenantId, id);
        if (objectId === undefined) {
          expect.unreachable('Invalid owned company identifier');
        }
        return objectId;
      };
      const roleId = toScopedRoleObjectId({ legalEntityId: companyId, roleKey: 'company-admin', tenantId });
      const relations = [
        ...[adminId, ordinaryId].map((id) => relationship('tenant', tenantId, 'member', 'principal', id)),
        ...[companyId, otherCompanyId].map((id) =>
          relationship('legal_entity', companyObject(id), 'tenant', 'tenant', tenantId),
        ),
        ...[adminId, ordinaryId].map((id) =>
          relationship('legal_entity', companyObject(companyId), 'member', 'principal', id),
        ),
        relationship('scoped_role', roleId, 'member', 'principal', adminId),
        relationship('legal_entity', companyObject(companyId), 'admin', 'scoped_role', roleId, 'member'),
        ...[companyId, otherCompanyId].flatMap((legalEntityId) =>
          buildActionAuthorizationRelationships([
            { actionKey: invitePersonAction.descriptor.actionKey, legalEntityId, tenantId },
          ]),
        ),
      ];
      yield* Effect.promise(() =>
        graph.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: relations.map((item) => ({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            })),
          }),
        ),
      );
      const permission = createSpiceDbPermissionClient(graphConfiguration, 5000);
      const contextAccess = makeContextAccess(permission);
      const stateGate = makeModuleStateGate(makeTenantModuleStateService(database));
      const operationalScopeResolver = yield* makeOperationalScopeResolver(
        makeOperationalScopeRepository(database, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
        contextAccess,
      );
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(crypto),
        makeActionPermissionService(permission),
        operationalScopeResolver,
        {
          contextAccess,
          databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          moduleEntrypointGateway: makeModuleEntrypointGateway(stateGate),
          moduleStateGate: stateGate,

          resolveCompositionRevision: makeActionCompositionRevisionResolver(authority, composition.shell.deployment),
        },
      );
      const invite = (email: string, id = adminId, key = randomUUID(), legalEntityId = companyId) =>
        runtime
          .runAction({
            payload: { affiliation: 'external', displayName: 'Pozvaný člověk', email },
            principal: actor(id, legalEntityId),
            registration: invitePersonAction,
            transport: { correlationId: randomUUID(), idempotencyKey: key },
          })
          .pipe(
            Effect.provideService(AuthenticationNamespaceRegistry, registry),
            Effect.provide(BetterAuthPersonInvitationIdentityProviderLive),
          );
      const configuration = yield* loadAuthConfig({ envPath: '/dev/null' });
      const authDatabase = yield* makeAuthDatabase({
        connectionString: configuration.connectionString,
        expectedRole: pair.runtime.expectedRole,
      });
      const resolver = makePrincipalResolver(database, {
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      });
      const oauthAuthenticationLayer = Layer.mergeAll(
        BetterAuthRuntimeLive,
        BetterAuthNativeAdapterLive,
        OAuthAuthenticationAuditLive,
        OAuthEndpointGuardDataLive,
        OAuthConnectionHooksLive.pipe(Layer.provide(OAuthGrantRegistryLive)),
      ).pipe(
        Layer.provide(Layer.mergeAll(OAuthGrantRegistryLive, OAuthCredentialsLive)),
        Layer.provide(Layer.mergeAll(Layer.succeed(CoreDatabase, database), Layer.succeed(AuthDatabase, authDatabase))),
      );
      const authenticationFramework = BetterAuthFrameworkLive().pipe(Layer.provideMerge(oauthAuthenticationLayer));
      const authenticationGuards = OAuthEndpointGuardsLive.pipe(Layer.provideMerge(authenticationFramework));
      const authentication = yield* makeAuthenticationService().pipe(
        Effect.provide(authenticationGuards),
        Effect.provideService(AuthConfig, configuration),
        Effect.provideService(AuthDatabase, authDatabase),
        Effect.provideService(PrincipalResolver, resolver),
      );
      const emailSql = yield* PgClient.makeClient({ url: Redacted.make(configuration.connectionString) });
      const transport: EmailTransportRuntime = {
        deliveryLayer: (from) => SmtpEmailDeliveryLive({ from, host: '127.0.0.1', port: smtpPort }),
        kind: 'smtp',
        provider: { configured: true, label: 'Owned Mailpit test capture' },
      };
      const dispatch = dispatchEmailBatchWith(transport, { ONTOS_PUBLIC_URL: 'http://localhost:3020' }).pipe(
        Effect.provideService(PgClient.PgClient, emailSql),
      );
      const key = randomUUID();
      const invited = yield* invite(recipient, adminId, key);
      expect(invited.membership.status).toBe('invited');
      expect(invited.delivery).toBe('pending');
      const [intent] = yield* admin.executor
        .select()
        .from(personInvitations)
        .where(eq(personInvitations.invitationId, invited.invitationId));
      if (intent === undefined) {
        expect.unreachable('Missing committed invitation');
      }
      const [login] = yield* authDatabase.executor.select().from(user).where(eq(user.id, intent.providerSubjectId));
      expect(login?.email).toBe(recipient);
      expect(
        yield* authDatabase.executor.select().from(account).where(eq(account.userId, intent.providerSubjectId)),
      ).toHaveLength(0);
      expect(
        yield* authentication.signIn(recipient, 'not-an-invitation-password', new Headers()).pipe(Effect.flip),
      ).toBeDefined();
      expect(yield* captured(recipient)).toHaveLength(0);
      expect(Schema.is(ActionAlreadyCommitted)(yield* invite(recipient, adminId, key).pipe(Effect.flip))).toBe(true);
      expect(
        yield* admin.executor.select().from(personInvitations).where(eq(personInvitations.tenantId, tenantId)),
      ).toHaveLength(1);
      const committedAudit = yield* admin.executor
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'action.executed')));
      expect(committedAudit).toHaveLength(1);
      expect(yield* admin.executor.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId))).toHaveLength(
        1,
      );
      expect(
        yield* admin.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ).toHaveLength(1);
      expect((yield* dispatch).processed).toBe(1);
      yield* dispatch;
      yield* dispatch;
      const mails = yield* captured(recipient);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.Subject).toBe('Pozvánka do OntOS – Vlastní společnost');
      const [firstMail] = mails;
      if (firstMail === undefined) {
        expect.unreachable('Missing delivered invitation');
      }
      const mail = yield* readCaptured(firstMail.ID);
      expect(mail.Text.includes('Pozvánka sama nepřiděluje žádná oprávnění')).toBe(true);
      const link = /http:\/\/localhost:3020\/cs\/set-password\?token=(?<token>[A-Za-z0-9_-]{43})/u.exec(mail.Text);
      const token = link?.groups?.['token'];
      if (token === undefined) {
        expect.unreachable('Missing set-password token in real email');
      }
      expect(JSON.stringify(committedAudit).includes(token)).toBe(false);
      const endpoint = authentication.oauth;
      if (endpoint === undefined) {
        expect.unreachable('Missing native Better Auth endpoint');
      }
      const password = randomBytes(24).toString('base64url');
      const accept = (secret: string, nextPassword = password) =>
        setInvitationPassword(
          endpoint,
          new Request('http://localhost:3020/shell-super-app-api/invitation/set-password', {
            body: JSON.stringify({ password: nextPassword, token: secret }),
            headers: { 'content-type': 'application/json', origin: 'http://localhost:3020' },
            method: 'POST',
          }),
        );
      expect((yield* accept(token, 'short')).status).toBe(400);
      const [unaccepted] = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(eq(principalCompanyMemberships.principalId, invited.principalRef.principalId));
      expect(unaccepted?.status).toBe('invited');
      expect(
        (yield* contextAccess.legalEntities({
          legalEntityIds: [companyId],
          principalId: invited.principalRef.principalId,
          tenantId,
        }))[0]?.decision,
      ).toBe('denied');
      // Force a real credential-write failure AFTER the consume hook has activated the membership and queued work.
      // This schema constraint belongs only to the guarded throwaway database and is removed before the real acceptance.
      expect(intent.providerSubjectId).toMatch(/^[0-9a-f-]{36}$/u);
      yield* admin.executor.execute(
        sql.raw(
          `ALTER TABLE auth.account ADD CONSTRAINT owned_invitation_credential_failure CHECK (user_id <> '${intent.providerSubjectId}')`,
        ),
        'objects',
      );
      const failedCredential = yield* accept(token).pipe(
        Effect.ensuring(
          admin.executor
            .execute(sql`ALTER TABLE auth.account DROP CONSTRAINT owned_invitation_credential_failure`, 'objects')
            .pipe(Effect.orDie),
        ),
      );
      expect(failedCredential.status).toBeGreaterThanOrEqual(500);
      expect(
        yield* authDatabase.executor.select().from(verification).where(eq(verification.id, intent.verificationId)),
      ).toHaveLength(1);
      expect(
        yield* authDatabase.executor.select().from(account).where(eq(account.userId, intent.providerSubjectId)),
      ).toHaveLength(0);
      const [rolledBackMembership] = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(eq(principalCompanyMemberships.principalId, invited.principalRef.principalId));
      expect(rolledBackMembership).toMatchObject({ revision: 1, status: 'invited' });
      expect(
        yield* admin.executor
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'auth.invitation.accepted'))),
      ).toHaveLength(0);
      expect(
        yield* admin.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ).toHaveLength(1);
      const accepted = yield* Effect.all([accept(token), accept(token)], { concurrency: 2 });
      expect(accepted.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([200, 400]);
      expect((yield* accept(token, randomBytes(24).toString('base64url'))).status).toBe(400);
      expect(
        yield* authDatabase.executor.select().from(verification).where(eq(verification.id, intent.verificationId)),
      ).toHaveLength(0);
      const signedIn = yield* authentication.signIn(recipient, password, new Headers());
      expect(signedIn.identity.principalId).toBe(invited.principalRef.principalId);
      expect(signedIn.setCookieHeaders.length).toBeGreaterThan(0);
      const [membership] = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(eq(principalCompanyMemberships.principalId, invited.principalRef.principalId));
      expect(membership).toMatchObject({ affiliation: 'external', revision: 2, status: 'active' });
      const lifecycleContext = yield* Layer.build(
        ActionAuthorizationLifecycleLive.pipe(
          Layer.provide(ScopedRoleMembershipLifecycleLive),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CoreDatabase, database),
              Layer.succeed(DatabaseConfig, pair.runtime),
              Layer.succeed(SpiceDbConfig, graphConfiguration),
              Layer.succeed(ActiveApplicationCompositionService, authority),
            ),
          ),
        ),
      );
      const lifecycle = Context.get(lifecycleContext, ActionAuthorizationLifecycle);
      const outbox = makeOutboxRuntime(makeOutboxRepository(database.executor, crypto));
      yield* outbox.matchMessages({ compositionRevision: composition.revision });
      const drained = yield* outbox
        .runCycle({
          claimOwner: 'owned-invitation-acceptance',
          compositionRevision: composition.revision,
          maxDeliveries: 10,
          now: yield* DateTime.nowAsDate,
          registrations: coreSystemOutboxWorkers.filter(
            (worker) => worker.descriptor.workerKey === corePrincipalLifecycleSubscription.workerKey,
          ),
          subscriptions: [corePrincipalLifecycleSubscription],
        })
        .pipe(Effect.provideService(ActionAuthorizationLifecycle, lifecycle));
      expect(drained.failed).toBe(0);
      expect(drained.succeeded).toBe(2);
      const nativeCheck = (objectType: string, objectId: string, permissionKey: string) =>
        Effect.promise(() =>
          graph.promises.checkPermission(
            v1.CheckPermissionRequest.create({
              consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
              permission: permissionKey,
              resource: { objectId, objectType },
              subject: { object: { objectId: invited.principalRef.principalId, objectType: 'principal' } },
            }),
          ),
        ).pipe(
          Effect.map((answer) => answer.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION),
        );
      expect(yield* nativeCheck('tenant', tenantId, 'access')).toBe(true);
      expect(yield* nativeCheck('tenant', tenantId, 'manage_identity')).toBe(false);
      expect(yield* nativeCheck('legal_entity', companyObject(companyId), 'manage_people')).toBe(false);
      expect(yield* nativeCheck('legal_entity', companyObject(otherCompanyId), 'access')).toBe(false);
      expect(yield* nativeCheck('scoped_role', roleId, 'member')).toBe(false);
      const acceptedAudit = yield* admin.executor
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.eventType, 'auth.invitation.accepted')));
      expect(acceptedAudit).toHaveLength(1);
      expect(JSON.stringify(acceptedAudit).includes(token)).toBe(false);
      expect(
        (yield* contextAccess.legalEntities({
          legalEntityIds: [companyId],
          principalId: invited.principalRef.principalId,
          tenantId,
        }))[0]?.decision,
      ).toBe('allowed');
      const cookie = signedIn.setCookieHeaders.map((value) => value.split(';')[0]).join('; ');
      const selectedContext = yield* authentication
        .resolveShellContext(new Headers({ cookie }))
        .pipe(
          Effect.provideService(ContextAccess, contextAccess),
          Effect.provideService(LegalEntityContext, makeLegalEntityContext(database)),
        );
      expect(selectedContext).toMatchObject({ identity: { legalEntityId: companyId }, state: 'authenticated' });
      const expired = yield* invite(expiredRecipient);
      const [expiredIntent] = yield* admin.executor
        .select()
        .from(personInvitations)
        .where(eq(personInvitations.invitationId, expired.invitationId));
      if (expiredIntent === undefined) {
        expect.unreachable('Missing expiry fixture');
      }
      const [expiredVerification] = yield* authDatabase.executor
        .select()
        .from(verification)
        .where(eq(verification.id, expiredIntent.verificationId));
      if (expiredVerification === undefined) {
        expect.unreachable('Missing expiry token');
      }
      yield* authDatabase.executor
        .update(verification)
        .set({ expiresAt: new Date(0) })
        .where(eq(verification.id, expiredIntent.verificationId));
      expect((yield* accept(expiredVerification.identifier.slice('reset-password:'.length))).status).toBe(400);
      const [expiredMembership] = yield* admin.executor
        .select()
        .from(principalCompanyMemberships)
        .where(eq(principalCompanyMemberships.principalId, expired.principalRef.principalId));
      expect(expiredMembership).toMatchObject({ revision: 1, status: 'invited' });
      expect(
        yield* authDatabase.executor.select().from(account).where(eq(account.userId, expiredIntent.providerSubjectId)),
      ).toHaveLength(0);
      // A real unique-email failure happens after Core wrote its rows in the transaction; all of them must roll back.
      yield* authDatabase.executor
        .insert(user)
        .values({ email: rollbackRecipient, id: randomUUID(), name: 'Existing login' });
      const before = yield* admin.executor.select().from(principals).where(eq(principals.tenantId, tenantId));
      expect(Schema.is(IdentityLifecycleConflictError)(yield* invite(rollbackRecipient).pipe(Effect.flip))).toBe(true);
      expect(Schema.is(IdentityTargetInvalidError)(yield* invite('not..usable@example.org').pipe(Effect.flip))).toBe(
        true,
      );
      expect(yield* admin.executor.select().from(principals).where(eq(principals.tenantId, tenantId))).toHaveLength(
        before.length,
      );
      expect(
        yield* admin.executor.select().from(personInvitations).where(eq(personInvitations.tenantId, tenantId)),
      ).toHaveLength(2);
      expect(
        yield* admin.executor.select().from(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
      ).toHaveLength(4);
      expect(
        yield* admin.executor
          .select()
          .from(principalCompanyMemberships)
          .where(eq(principalCompanyMemberships.tenantId, tenantId)),
      ).toHaveLength(2);
      expect(Schema.is(ActionPermissionDenied)(yield* invite(deniedRecipient, ordinaryId).pipe(Effect.flip))).toBe(
        true,
      );
      expect(
        Schema.is(OperationContextDenied)(
          yield* invite(deniedRecipient, adminId, randomUUID(), otherCompanyId).pipe(Effect.flip),
        ),
      ).toBe(true);
      yield* dispatch;
      for (const email of [expiredRecipient, rollbackRecipient, deniedRecipient]) {
        expect(yield* captured(email)).toHaveLength(0);
      }
      expect(yield* captured(recipient)).toHaveLength(1);
      expect(
        yield* admin.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ).toHaveLength(3);
    }).pipe(Effect.provide(Layer.merge(Reactivity.layer, NodeCrypto.layer))),
);
