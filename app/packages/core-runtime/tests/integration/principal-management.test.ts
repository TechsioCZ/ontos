import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  bindApiKey,
  createNonHumanPrincipal,
  PrincipalManagementRepository,
  principalManagementRepositoryFromTransaction,
  setApiKeyBindingStatus,
} from '../../src/auth/principal-management.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { coreRelations, principalAuthBindings, principals, tenants } from '../../src/db/schema.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { purgeFixtureRows } from '../support/fixture-cleanup.ts';

const staffAuthenticationNamespaceId = 'test.staff.better-auth.v1';

it.live('persists managed key lifecycle without credential material and enforces global key cardinality', () =>
  Effect.gen(function* principalManagement1() {
    const tenantId = randomUUID();
    const providerKeyId = `better-auth-principal-management-${randomUUID()}`;
    const configuration = yield* loadDatabaseConfig();
    const database = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(configuration.connectionString),
      coreRelations,
    );
    const cleanup = purgeFixtureRows([
      database.delete(principalAuthBindings).where(eq(principalAuthBindings.providerSubjectId, providerKeyId)),
      database.delete(principals).where(eq(principals.tenantId, tenantId)),
      database.delete(tenants).where(eq(tenants.tenantId, tenantId)),
    ]);

    yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
    yield* database.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Principal management integration',
      slug: `principal-management-${tenantId}`,
      status: 'active',
      tenantId,
    });
    const first = yield* database.transaction((transaction) =>
      createNonHumanPrincipal({
        displayName: 'Managed integration',
        kind: 'integration',
        tenantId,
      }).pipe(
        Effect.provideService(
          PrincipalManagementRepository,
          principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
        ),
      ),
    );
    const second = yield* database.transaction((transaction) =>
      createNonHumanPrincipal({
        displayName: 'Managed service',
        kind: 'service',
        tenantId,
      }).pipe(
        Effect.provideService(
          PrincipalManagementRepository,
          principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
        ),
      ),
    );
    const binding = yield* database.transaction((transaction) =>
      bindApiKey({
        managed: true,
        principalId: first.principalId,
        providerSubjectId: providerKeyId,
        tenantId,
      }).pipe(
        Effect.provideService(
          PrincipalManagementRepository,
          principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
        ),
      ),
    );
    const duplicate = yield* database.transaction((transaction) =>
      Effect.flip(
        bindApiKey({
          managed: true,
          principalId: second.principalId,
          providerSubjectId: providerKeyId,
          tenantId,
        }).pipe(
          Effect.provideService(
            PrincipalManagementRepository,
            principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
          ),
        ),
      ),
    );
    expect(Predicate.isTagged(duplicate, 'IdentityLifecycleConflictError')).toBe(true);

    const missingReason = yield* database.transaction((transaction) =>
      Effect.flip(
        setApiKeyBindingStatus({
          authBindingId: binding.authBindingId,
          expectedStatus: 'active',
          managed: true,
          newStatus: 'revoked',
          principalId: first.principalId,
          tenantId,
        }).pipe(
          Effect.provideService(
            PrincipalManagementRepository,
            principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
          ),
        ),
      ),
    );
    expect(Predicate.isTagged(missingReason, 'IdentityTargetInvalidError')).toBe(true);

    yield* database.transaction((transaction) =>
      setApiKeyBindingStatus({
        authBindingId: binding.authBindingId,
        expectedStatus: 'active',
        managed: true,
        newStatus: 'revoked',
        principalId: first.principalId,
        reason: 'Integration lifecycle proof',
        tenantId,
      }).pipe(
        Effect.provideService(
          PrincipalManagementRepository,
          principalManagementRepositoryFromTransaction(transaction, staffAuthenticationNamespaceId),
        ),
      ),
    );
    const [stored] = yield* database
      .select()
      .from(principalAuthBindings)
      .where(eq(principalAuthBindings.principalAuthBindingId, binding.authBindingId));
    expect(stored?.authenticationNamespaceId).toBe(staffAuthenticationNamespaceId);
    expect(stored?.status).toBe('revoked');
    expect((yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(stored)).includes('secret')).toBe(false);
  }),
);
