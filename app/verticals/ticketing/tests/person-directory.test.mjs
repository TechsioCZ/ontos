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

const grantFieldVisibility = async ({
  emailVisible,
  loginVisible,
  subjectPrincipalId,
  tenantId,
  viewerPrincipalId,
}) => {
  await sqlClient`
    insert into core.principal_directory_field_visibility (
      email_visible,
      login_visible,
      subject_principal_id,
      tenant_id,
      viewer_principal_id
    )
    values (
      ${emailVisible},
      ${loginVisible},
      ${subjectPrincipalId},
      ${tenantId},
      ${viewerPrincipalId}
    )
  `;
};

test('Core Person Directory separates visibility-aware eligible search from historical resolution', async () => {
  const tenantId = await createTenant('Directory tenant');
  const otherTenantId = await createTenant('Other directory tenant');
  const viewerPrincipalId = await createPrincipal(tenantId, {
    displayName: 'Directory viewer',
    withDirectoryEntry: false,
  });
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
  await grantFieldVisibility({
    emailVisible: true,
    loginVisible: false,
    subjectPrincipalId: memberPrincipalId,
    tenantId,
    viewerPrincipalId,
  });
  await grantFieldVisibility({
    emailVisible: true,
    loginVisible: true,
    subjectPrincipalId: guestPrincipalId,
    tenantId,
    viewerPrincipalId,
  });

  const directory = createPersonDirectory({ db, tenantId, viewerPrincipalId });
  assert.deepEqual(await directory.searchEligiblePeople('ada@example'), [
    {
      displayName: 'Ada Lovelace',
      email: 'ada@example.test',
      principalId: memberPrincipalId,
    },
  ]);
  assert.deepEqual(await directory.searchEligiblePeople('hidden-ada-login'), []);
  assert.deepEqual(await directory.searchEligiblePeople('grace-login'), [
    {
      displayName: 'Grace Hopper',
      email: 'grace@example.test',
      login: 'grace-login',
      principalId: guestPrincipalId,
    },
  ]);
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
