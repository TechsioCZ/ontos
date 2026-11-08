import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionInvocationRefSchema } from '../../src/access/approvals/execution.ts';
import { proposalIdForInvocation } from '../../src/access/approvals/proposal-invocation-id.ts';
import { TenantIdSchema } from '../../src/access/ids.ts';

it.effect(
  'derives a stable name-based SHA-256 UUIDv8 proposal from the tenant namespace and owner Action invocation (O90)',
  () =>
    Effect.sync(() => {
      const tenant = TenantIdSchema.make('00000000-0000-4000-8000-000000000002');
      const invocation = ActionInvocationRefSchema.make('00000000-0000-4000-8000-000000000123');
      expect(proposalIdForInvocation(tenant, invocation)).toBe('912d3934-3f0a-8490-af24-53b80f62a0ad');
      expect(proposalIdForInvocation(tenant, invocation)).toBe(proposalIdForInvocation(tenant, invocation));
      expect(
        proposalIdForInvocation(tenant, ActionInvocationRefSchema.make('00000000-0000-4000-8000-000000000124')),
      ).toBe('8c59fe0a-17a9-82bd-bf4f-19e3f61852b1');
      expect(proposalIdForInvocation(TenantIdSchema.make('00000000-0000-4000-8000-000000000003'), invocation)).not.toBe(
        proposalIdForInvocation(tenant, invocation),
      );
    }),
);
