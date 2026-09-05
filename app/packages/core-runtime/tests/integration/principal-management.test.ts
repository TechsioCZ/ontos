// @effect-diagnostics asyncFunction:off
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
  principalManagementRepositoryFromTransaction,
  setApiKeyBindingStatus,
} from '../../src/auth/principal-management.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { coreRelations, principalAuthBindings, principals, tenants } from '../../src/db/schema.ts';

void test('persists managed key lifecycle without credential material and enforces global key cardinality', async () => {
  const tenantId = randomUUID();
  const providerKeyId = `better-auth-principal-management-${randomUUID()}`;
  const configuration = await Effect.runPromise(loadDatabaseConfig());
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
        await Effect.runPromise(
          createNonHumanPrincipal(principalManagementRepositoryFromTransaction(transaction), {
            displayName: 'Managed integration',
            kind: 'integration',
            tenantId,
          }),
        ),
    );
    const second = await database.transaction(
      async (transaction) =>
        await Effect.runPromise(
          createNonHumanPrincipal(principalManagementRepositoryFromTransaction(transaction), {
            displayName: 'Managed service',
            kind: 'service',
            tenantId,
          }),
        ),
    );
    const binding = await database.transaction(
      async (transaction) =>
        await Effect.runPromise(
          bindApiKey(principalManagementRepositoryFromTransaction(transaction), {
            managed: true,
            principalId: first.principalId,
            providerSubjectId: providerKeyId,
            tenantId,
          }),
        ),
    );
    const duplicate = await database.transaction(
      async (transaction) =>
        await Effect.runPromise(
          Effect.flip(
            bindApiKey(principalManagementRepositoryFromTransaction(transaction), {
              managed: true,
              principalId: second.principalId,
              providerSubjectId: providerKeyId,
              tenantId,
            }),
          ),
        ),
    );
    assert.equal(duplicate._tag, 'IdentityLifecycleConflictError');

    const missingReason = await database.transaction(
      async (transaction) =>
        await Effect.runPromise(
          Effect.flip(
            setApiKeyBindingStatus(principalManagementRepositoryFromTransaction(transaction), {
              authBindingId: binding.authBindingId,
              expectedStatus: 'active',
              managed: true,
              newStatus: 'revoked',
              principalId: first.principalId,
              tenantId,
            }),
          ),
        ),
    );
    assert.equal(missingReason._tag, 'IdentityTargetInvalidError');

    await database.transaction(
      async (transaction) =>
        await Effect.runPromise(
          setApiKeyBindingStatus(principalManagementRepositoryFromTransaction(transaction), {
            authBindingId: binding.authBindingId,
            expectedStatus: 'active',
            managed: true,
            newStatus: 'revoked',
            principalId: first.principalId,
            reason: 'Integration lifecycle proof',
            tenantId,
          }),
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
