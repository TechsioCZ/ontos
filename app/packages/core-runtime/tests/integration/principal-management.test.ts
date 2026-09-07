import {
  makeEffectTestCallback as nativeTestCallback,
  runEffectTestPromise,
} from '@app/core-runtime/testing/effect-runtime';

// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import { eq } from 'drizzle-orm';
import { Effect, Exit as NativeExit, Scope as NativeScope, Predicate } from 'effect';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import { Pool } from 'pg';
import {
  bindApiKey,
  createNonHumanPrincipal,
  PrincipalManagementRepository,
  principalManagementRepositoryFromTransaction,
  setApiKeyBindingStatus,
} from '../../src/auth/principal-management.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { coreRelations, principalAuthBindings, principals, tenants } from '../../src/db/schema.ts';
import { makeTestDatabaseFromPool } from '../support/database.ts';
import { runEffectTestSync as runNativeSync } from '../support/effect-runtime.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

void test('persists managed key lifecycle without credential material and enforces global key cardinality', async () => {
  const tenantId = randomUUID();
  const providerKeyId = `better-auth-principal-management-${randomUUID()}`;
  const configuration = await runEffectTestPromise(loadDatabaseConfig());
  const pool = new Pool({ connectionString: configuration.connectionString });
  const database = await runEffectTestPromise(
    makeTestDatabaseFromPool(pool, coreRelations).pipe(NativeScope.provide(nativeDatabaseScope)),
  );
  const cleanup = async () => {
    await runEffectTestPromise(
      database
        .delete(principalAuthBindings)
        .where(eq(principalAuthBindings.providerSubjectId, providerKeyId)),
    );
    await runEffectTestPromise(
      database.delete(principals).where(eq(principals.tenantId, tenantId)),
    );
    await runEffectTestPromise(database.delete(tenants).where(eq(tenants.tenantId, tenantId)));
  };

  try {
    await cleanup();
    await runEffectTestPromise(
      database.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Principal management integration',
        slug: `principal-management-${tenantId}`,
        status: 'active',
        tenantId,
      }),
    );
    const first = await runEffectTestPromise(
      database.transaction((transaction) =>
        createNonHumanPrincipal({
          displayName: 'Managed integration',
          kind: 'integration',
          tenantId,
        }).pipe(
          Effect.provideService(
            PrincipalManagementRepository,
            principalManagementRepositoryFromTransaction(transaction),
          ),
        ),
      ),
    );
    const second = await runEffectTestPromise(
      database.transaction((transaction) =>
        createNonHumanPrincipal({
          displayName: 'Managed service',
          kind: 'service',
          tenantId,
        }).pipe(
          Effect.provideService(
            PrincipalManagementRepository,
            principalManagementRepositoryFromTransaction(transaction),
          ),
        ),
      ),
    );
    const binding = await runEffectTestPromise(
      database.transaction((transaction) =>
        bindApiKey({
          managed: true,
          principalId: first.principalId,
          providerSubjectId: providerKeyId,
          tenantId,
        }).pipe(
          Effect.provideService(
            PrincipalManagementRepository,
            principalManagementRepositoryFromTransaction(transaction),
          ),
        ),
      ),
    );
    const duplicate = await runEffectTestPromise(
      database.transaction((transaction) =>
        Effect.flip(
          bindApiKey({
            managed: true,
            principalId: second.principalId,
            providerSubjectId: providerKeyId,
            tenantId,
          }).pipe(
            Effect.provideService(
              PrincipalManagementRepository,
              principalManagementRepositoryFromTransaction(transaction),
            ),
          ),
        ),
      ),
    );
    assert.ok(Predicate.isTagged(duplicate, 'IdentityLifecycleConflictError'));

    const missingReason = await runEffectTestPromise(
      database.transaction((transaction) =>
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
              principalManagementRepositoryFromTransaction(transaction),
            ),
          ),
        ),
      ),
    );
    assert.ok(Predicate.isTagged(missingReason, 'IdentityTargetInvalidError'));

    await runEffectTestPromise(
      database.transaction((transaction) =>
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
            principalManagementRepositoryFromTransaction(transaction),
          ),
        ),
      ),
    );
    const [stored] = await runEffectTestPromise(
      database
        .select()
        .from(principalAuthBindings)
        .where(eq(principalAuthBindings.principalAuthBindingId, binding.authBindingId)),
    );
    assert.equal(stored?.status, 'revoked');
    assert.equal(JSON.stringify(stored).includes('secret'), false);
  } finally {
    await cleanup();
    await pool.end();
  }
});
