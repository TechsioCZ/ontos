import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import { db, sqlClient } from '../../../packages/core-runtime/src/db/client.ts';
import { createPersonDirectory } from '../../../packages/core-runtime/src/person-directory.ts';

const createdTenantIds = [];

after(async () => {
  await Promise.all(
    createdTenantIds.map(async (tenantId) => {
      await sqlClient`delete from core.principal_directory_field_visibility where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principal_directory_entries where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.principals where tenant_id = ${tenantId}`;
      await sqlClient`delete from core.tenants where tenant_id = ${tenantId}`;
    }),
  );
  await sqlClient.end({ timeout: 1 });
});

const createTenant = async (label) => {
  const suffix = `${Date.now()}-${randomUUID()}`;
  const [tenant] = await sqlClient`
    insert into core.tenants (name, slug, default_locale, status)
    values (${label}, ${`directory-${suffix}`}, ${'en-GB'}, ${'active'})
    returning tenant_id
  `;
  createdTenantIds.push(tenant.tenant_id);
  return tenant.tenant_id;
};

const createPrincipal = async (
  tenantId,
  {
    displayName,
    email = null,
    kind = 'human',
    login = null,
    membershipKind = 'member',
    membershipStatus = 'active',
    status = 'active',
    withDirectoryEntry = true,
  },
) => {
  const [principal] = await sqlClient`
    insert into core.principals (tenant_id, display_name, kind, status)
    values (${tenantId}, ${displayName}, ${kind}, ${status})
    returning principal_id
  `;
  if (withDirectoryEntry) {
    await sqlClient`
      insert into core.principal_directory_entries (
        email,
        login,
        membership_kind,
        membership_status,
        principal_id,
        tenant_id
      )
      values (
        ${email},
        ${login},
        ${membershipKind},
        ${membershipStatus},
        ${principal.principal_id},
        ${tenantId}
      )
    `;
  }
  return principal.principal_id;
};

test('Core Person Directory separates current eligibility from historical resolution', async () => {
  const tenantId = await createTenant('Directory tenant');
  const otherTenantId = await createTenant('Other directory tenant');
  const memberPrincipalId = await createPrincipal(tenantId, {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    login: 'hidden-ada-login',
  });
  const guestPrincipalId = await createPrincipal(tenantId, {
    displayName: 'Grace Hopper',
    email: 'grace@example.test',
    login: 'grace-login',
    membershipKind: 'guest',
  });
  const disabledPrincipalId = await createPrincipal(tenantId, {
    displayName: 'Former Member',
    status: 'disabled',
  });
  const departedPrincipalId = await createPrincipal(tenantId, {
    displayName: 'Departed Guest',
    membershipKind: 'guest',
    membershipStatus: 'departed',
  });
  await createPrincipal(tenantId, {
    displayName: 'Automation Actor',
    kind: 'system',
  });
  await createPrincipal(otherTenantId, {
    displayName: 'Cross Tenant Person',
  });

  const directory = createPersonDirectory({ db, tenantId });
  assert.deepEqual(
    [...(await directory.eligiblePrincipalIds([memberPrincipalId, guestPrincipalId]))].toSorted(),
    [guestPrincipalId, memberPrincipalId].toSorted(),
  );
  assert.deepEqual(
    await directory.resolveStoredPrincipalIds([disabledPrincipalId, departedPrincipalId]),
    [
      {
        displayName: 'Former Member',
        eligible: false,
        principalId: disabledPrincipalId,
        status: 'disabled',
      },
      {
        displayName: 'Departed Guest',
        eligible: false,
        principalId: departedPrincipalId,
        status: 'departed',
      },
    ],
  );
});
