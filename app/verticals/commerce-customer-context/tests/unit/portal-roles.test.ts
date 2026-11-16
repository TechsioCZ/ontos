import { readFileSync } from 'node:fs';

import { AccessCatalogModulesSchema, buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { ModuleKeySchema } from '@app/core-runtime/access/ids';
import { compilePortalRole, portalRoleRelease } from '@app/core-runtime/access/portal';
import type { AccessPortalRole } from '@app/core-runtime/access/portal';
import { DateTime, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { COUNTERPARTY_PERMISSION_CATALOG } from '../../shared/domain/permission-catalog.ts';
import { claimCounterpartyAccessInvitationAction } from '../../src/actions/claim-counterparty-access-invitation.action.ts';
import { counterpartyPermissionByOperation } from '../../src/persistence/owner-authorization-overlay.ts';
import {
  COUNTERPARTY_CUSTOMER_PORTAL_ROLE,
  COUNTERPARTY_INVITEE_PORTAL_ROLE,
  RETAIL_CUSTOMER_PORTAL_ROLE,
} from '../../src/portal-access/portal-roles.ts';

const MODULE_KEY = ModuleKeySchema.make('commerce.customer-context');
const ROLES = [RETAIL_CUSTOMER_PORTAL_ROLE, COUNTERPARTY_INVITEE_PORTAL_ROLE, COUNTERPARTY_CUSTOMER_PORTAL_ROLE];

/** The declarations the checked-in authorization catalog publishes for this module. */
const { modules } = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema })),
)(readFileSync(new URL('../../../../topology/authorization-catalog.json', import.meta.url), 'utf-8'));
const commerceModule = modules.find(({ moduleId }) => moduleId === MODULE_KEY);
const descriptors = (commerceModule?.descriptors ?? []).map((descriptor) => ({
  ...descriptor,
  accessFieldGroups: descriptor.accessFieldGroups ?? [],
}));
const declarations = new Map<string, { readonly kind: string; readonly modes: readonly string[] }>(
  descriptors.flatMap(({ accessDeclaration, accessFieldGroups }) =>
    [accessDeclaration, ...accessFieldGroups].map((declaration) => [String(declaration.key), declaration] as const),
  ),
);
const capabilityOfEntrypoint = new Map<string, string>(
  descriptors.map(({ accessDeclaration, entrypoint }) => [
    String(entrypoint.entrypointKey),
    String(accessDeclaration.key),
  ]),
);
const fieldGroupsOf = new Map<string, readonly string[]>(
  descriptors.map(({ accessDeclaration, accessFieldGroups }) => [
    String(accessDeclaration.key),
    accessFieldGroups.map(({ key }) => String(key)),
  ]),
);

const release = Result.getOrThrow(
  buildAccessCatalogRelease({
    installedModuleKeys: [MODULE_KEY],
    modules: commerceModule === undefined ? [] : [commerceModule],
    publishedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-05T09:00:00Z')),
  }),
);

/** The rows Core reads for a role: the entries of its capabilities in one published release. */
const releaseRowsOf = (role: AccessPortalRole) =>
  release.entries
    .filter((entry) => role.capabilities.includes(entry.key))
    .map((entry) => ({
      catalogSnapshotId: release.id,
      digest: release.digest,
      entryJson: entry,
      publishedAt: release.publishedAt,
    }));

describe('Commerce portal roles', () => {
  it('names only run-mode capabilities this module declares', () => {
    for (const role of ROLES) {
      for (const capability of role.capabilities) {
        expect(declarations.get(capability)?.modes, `${role.key}: ${capability}`).toContain('run');
      }
    }
  });

  it('opens the claim alone to an invited recipient', () => {
    expect(COUNTERPARTY_INVITEE_PORTAL_ROLE.capabilities).toEqual([
      claimCounterpartyAccessInvitationAction.descriptor.accessDeclaration?.key,
    ]);
  });

  it('opens exactly the entrypoints a grantable Counterparty Permission protects', () => {
    const expected = new Set(
      [...counterpartyPermissionByOperation].flatMap(([entrypoint, permission]) => {
        const descriptor = COUNTERPARTY_PERMISSION_CATALOG[permission];
        const capability = capabilityOfEntrypoint.get(entrypoint);
        return (descriptor.customerDelegable || descriptor.internalGrantable) && capability !== undefined
          ? [capability, ...(fieldGroupsOf.get(capability) ?? [])]
          : [];
      }),
    );
    expect(new Set(COUNTERPARTY_CUSTOMER_PORTAL_ROLE.capabilities)).toEqual(expected);
  });

  it('never gives a Retail customer an administrative capability', () => {
    for (const capability of RETAIL_CUSTOMER_PORTAL_ROLE.capabilities) {
      expect(declarations.get(capability)?.kind, capability).not.toBe('admin');
    }
  });

  it('lets an authorized Counterparty assignment author open exact receipt recovery', () => {
    expect(COUNTERPARTY_CUSTOMER_PORTAL_ROLE.capabilities).toContain(
      'commerce.customer-context.counterparty-price-group.assign',
    );
    expect(COUNTERPARTY_CUSTOMER_PORTAL_ROLE.capabilities).toContain(
      'commerce.customer-context.customer-price-group-assignment-receipt.read',
    );
    expect(RETAIL_CUSTOMER_PORTAL_ROLE.capabilities).not.toContain(
      'commerce.customer-context.customer-price-group-assignment-receipt.read',
    );
  });

  it('compiles each role into one run cell per capability against a release of this module', () => {
    for (const role of ROLES) {
      const pinned = Result.getOrThrow(portalRoleRelease(role, releaseRowsOf(role)));
      const cells = Result.getOrThrow(compilePortalRole(role, pinned));
      expect(new Set(cells.map(({ capabilityKey }) => capabilityKey))).toEqual(new Set(role.capabilities));
      expect(cells).toHaveLength(role.capabilities.length);
      expect(cells.every(({ mode }) => mode === 'run')).toBe(true);
    }
  });
});
