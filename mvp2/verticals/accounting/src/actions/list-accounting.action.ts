import type { ActionDescriptor } from '@mvp2/core-runtime/sdk';
import {
  accountingListPayloadSchema,
  accountingListResultSchema,
} from '../../shared/effect/api.ts';

export type ListAccountingAction = typeof accountingListPayloadSchema.Type;
export type ListAccountingResult = typeof accountingListResultSchema.Type;

export const listAccountingActionDescriptor = {
  actionKey: 'accounting.demo.listAccounting',
  auditProfile: 'standard',
  gatewayAudience: 'accounting',
  idempotency: 'optional',
  moduleStateAccess: 'read',
  transportRequestSchema: accountingListPayloadSchema,
  transportResponseSchema: accountingListResultSchema,
} satisfies ActionDescriptor<ListAccountingAction, ListAccountingResult>;
