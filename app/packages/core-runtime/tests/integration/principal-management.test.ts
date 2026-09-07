import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off -- Existing compatibility boundary; expires: 2026-12-31.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Effect } from 'effect';
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

void test('persists managed key lifecycle without credential material and enforces global key cardinality', async () => {
  const tenantId = randomUUID();
  const providerKeyId = `better-auth-principal-management-${randomUUID()}`;
  const configuration = await runEffectTestPromise(loadDatabaseConfig());
  const pool = new Pool({ connectionString: configuration.connectionString });
  const database = drizzle({ client: pool, relations: coreRelations });
  const cleanup = async () => {
    await database
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.providerSubjectId, providerKeyId));
    await database.delete(principals).where(eq(principals.tenantId, tenantId));
    await database.delete(tenants).where(eq(tenants.tenantId, tenantId));
  };

  try {
    await cleanup();
    await database.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Principal management integration',
      slug: `principal-management-${tenantId}`,
      status: 'active',
      tenantId,
    });
    const first = await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    const second = await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    const binding = await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    const duplicate = await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    assert.equal(duplicate._tag, 'IdentityLifecycleConflictError');

    const missingReason = await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    assert.equal(missingReason._tag, 'IdentityTargetInvalidError');

    await database.transaction(
      async (transaction) =>
        await runEffectTestPromise(
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
    const [stored] = await database
      .select()
      .from(principalAuthBindings)
      .where(eq(principalAuthBindings.principalAuthBindingId, binding.authBindingId));
    assert.equal(stored?.status, 'revoked');
    assert.equal(JSON.stringify(stored).includes('secret'), false);
  } finally {
    await cleanup();
    await pool.end();
  }
});
