import type { GtinTarget } from '../../shared/domain/commercial-code.ts';

export const gtinResultPermissionTarget = (target: GtinTarget) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId: target.kind === 'VARIANT' ? target.variantId : target.packageDefinitionId,
  resourceType:
    target.kind === 'VARIANT'
      ? ('commerce.catalog.variant' as const)
      : ('commerce.catalog.package-definition' as const),
  tenantId: target.tenantId,
});
