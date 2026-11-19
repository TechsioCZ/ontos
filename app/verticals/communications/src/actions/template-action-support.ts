/** Every template Action reads Communications' own template tables; this is that read as bounded metadata evidence. */
export const templateAccessEvidence = (operation: 'activate' | 'deactivate' | 'invalidate' | 'prepare') =>
  ({
    accessKind: 'read',
    queryHash: `communications.core:template-revision:${operation}`,
    resultCount: 1,
    servingModuleKey: 'communications.core',
  }) as const;
