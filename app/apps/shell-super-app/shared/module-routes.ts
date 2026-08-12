export const CRM_MODULE_ID = 'crm.core';

const dedicatedShellRouteByModuleId = new Map([[CRM_MODULE_ID, '/crm']]);

export const shellModuleHref = (moduleId: string): string =>
  dedicatedShellRouteByModuleId.get(moduleId) ?? `/modules/${encodeURIComponent(moduleId)}`;

export const hasDedicatedShellRoute = (moduleId: string): boolean =>
  dedicatedShellRouteByModuleId.has(moduleId);
