export const SYMMY_DEMO_ORDER_EXPORT_WORKLOAD = 'demo.merchandise.symmy-order-export';

export const demoOrderExportOperation = {
  audience: 'merchandise',
  declarationKey: 'demo.merchandise.demo-order-export.read',
  entrypointKey: 'demo.merchandise.api.demo-order-export',
  moduleId: 'demo.merchandise',
  schemaVersion: '1',
  workloadKey: SYMMY_DEMO_ORDER_EXPORT_WORKLOAD,
} as const;
