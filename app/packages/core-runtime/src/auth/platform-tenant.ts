import { stableUuid } from '../access/catalog/stable-id.ts';

/**
 * The platform tenant. The platform creates it and nobody administers it: it has no person, membership, Role or
 * company, so no Action, grant or tenant-managed key can reach what it holds. It holds exactly one service
 * principal per calling module, and the module credentials the platform issues to those principals.
 */
export const PLATFORM_TENANT = Object.freeze({
  defaultLocale: 'cs',
  name: 'OntOS platform',
  slug: 'ontos-platform',
  tenantId: stableUuid('ontos.platform/tenant'),
});
