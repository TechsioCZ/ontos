import { describe, expect, it } from 'effect-rstest';

import { catalogAuthorityBundles, catalogPublicOperationContracts } from '../../shared/api.ts';
import { catalogManifest } from '../../vertical.manifest.ts';

const recoveryNames = Object.keys(catalogManifest.publicSurface.api).filter((name) => name.endsWith('-recovery'));
const actionsByKey = new Map(
  catalogManifest.publicSurface.actions.map((action) => [action.descriptor.actionKey, action]),
);

describe('Catalog Action recovery permission exclusivity (#478)', () => {
  it('registers all 82 separately typed recovery reads with exact, non-umbrella permissions', () => {
    const permissions = new Set<string>();
    for (const name of recoveryNames) {
      const readKey = `commerce.catalog.api.${name}`;
      const permission = `commerce.catalog.read.${name}`;
      const actionKey = `commerce.catalog.${name.slice(0, -'-recovery'.length)}`;
      const action = actionsByKey.get(actionKey);
      const api = catalogManifest.publicSurface.api[name];
      const contract = Object.entries(catalogPublicOperationContracts).find(([key]) => key === readKey)?.[1];

      expect(action, actionKey).toBeDefined();
      expect(api, name).toBeDefined();
      expect(contract).toMatchObject({
        authorityBundle: 'CATALOG_READER',
        permission,
        permissionKind: 'context_permission',
        scope: 'tenant',
      });
      expect(catalogAuthorityBundles.CATALOG_READER).toContain(permission);
      expect(permissions.has(permission), permission).toBe(false);
      permissions.add(permission);
    }

    expect(permissions).not.toContain('commerce.catalog.read.recovery');
    expect(permissions).not.toContain('commerce.catalog.read.action-result');
    expect(permissions).not.toContain('commerce.catalog.read');
    expect(new Set(recoveryNames).size).toBe(82);
    expect(recoveryNames).toHaveLength(82);
  });
});
