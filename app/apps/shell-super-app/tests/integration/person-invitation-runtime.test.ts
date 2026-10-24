import { randomBytes, randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
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
  makePrincipalResolver,
  PrincipalResolver,
} from '../../../../packages/core-runtime/src/auth/principal-resolver.ts';
import {
  staffAuthenticationNamespaceRegistration,
  STAFF_AUTHENTICATION_NAMESPACE_ID,
} from '../../../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
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
import { CORE_SYSTEM_OUTBOX_SUBSCRIPTIONS } from '../../../../packages/core-runtime/src/outbox/core-system-subscriptions.ts';
import { createSpiceDbPermissionClient } from '../../../../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import {
  makeContextAccess,
  toLegalEntityAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';
import { makeActionPermissionService } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { toScopedRoleObjectId } from '../../../../packages/core-runtime/src/permissions/scoped-role.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../../../../packages/core-runtime/tests/support/outbox-worker-composition.ts';
import { dispatchEmailBatchWith } from '../../../../packages/email-delivery/src/dispatcher/dispatch.ts';
import { makeSmtpEmailDelivery } from '../../../../packages/email-delivery/src/smtp.ts';
import type { EmailTransportRuntime } from '../../../../packages/email-delivery/src/transport-runtime.ts';
import { AuthConfig, loadAuthConfig } from '../../api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../api/auth/db/client.ts';
import { account, user, verification } from '../../api/auth/db/schema.ts';
import { BetterAuthPersonInvitationIdentityProviderLive } from '../../api/auth/invitation/provider.ts';
import { setInvitationPassword } from '../../api/auth/invitation/transport.ts';
import { makeAuthenticationService } from '../../api/auth/service.ts';

const mailpitUrl = 'http://127.0.0.1:8026';
const CapturedMailSchema = Schema.Struct({ ID: Schema.String, Subject: Schema.String });
const MailSearchSchema = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(CapturedMailSchema) }));
const MailMessageSchema = Schema.fromJsonString(Schema.Struct({ Text: Schema.String }));
const captured = (recipient: string) => {
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
const readCaptured = (id: string) =>
  Effect.tryPromise(async () => {
    const response = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
    if (!response.ok) {
      throw new Error('Owned invitation Mailpit message read failed');
    }
    return await response.text();
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MailMessageSchema)));
const deleteCaptured = (message: typeof CapturedMailSchema.Type) =>
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
const deleteRecipientMessages = (email: string) =>
  captured(email).pipe(
    Effect.flatMap((messages) => Effect.forEach(messages, deleteCaptured, { discard: true })),
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
  'invites atomically, dispatches once after commit, accepts an expiring one-use native token and logs in without granting rights',
  () =>
    Effect.gen(function* invitationRuntime() {
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
      const runtime = makeActionRuntime(
        database,
        makeActionRepository(),
        makeActionPermissionService(permission),
        makeOperationalScopeResolver(makeOperationalScopeRepository(database), contextAccess),
        {
          contextAccess,
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
      const authDatabase = yield* makeAuthDatabase(configuration);
      const resolver = makePrincipalResolver(database, {
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      });
      const authentication = yield* makeAuthenticationService().pipe(
        Effect.provideService(AuthConfig, configuration),
        Effect.provideService(AuthDatabase, authDatabase),
        Effect.provideService(PrincipalResolver, resolver),
      );
      const sql = yield* PgClient.makeClient({ url: Redacted.make(configuration.connectionString) });
      const transport: EmailTransportRuntime = {
        kind: 'smtp',
        makeDelivery: (from) => makeSmtpEmailDelivery({ from, host: '127.0.0.1', port: 1026 }),
        provider: { configured: true, label: 'Owned Mailpit test capture' },
      };
      const dispatch = dispatchEmailBatchWith(transport, { ONTOS_PUBLIC_URL: 'http://localhost:3020' }).pipe(
        Effect.provideService(PgClient.PgClient, sql),
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
      expect(membership?.status).toBe('invited');
      expect(
        (yield* contextAccess.legalEntities({
          legalEntityIds: [companyId],
          principalId: invited.principalRef.principalId,
          tenantId,
        }))[0]?.decision,
      ).toBe('denied');
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
      ).toHaveLength(2);
    }).pipe(Effect.provide(Reactivity.layer)),
);
