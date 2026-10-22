import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { ActionPrepareContext, ActionWriteContext } from '../../src/actions/definition.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';

interface Grants {
  readonly writeAll: boolean;
}
interface Services {
  readonly apply: (amount: number, grants: Grants) => Effect.Effect<{ readonly total: number }>;
}

const prepare = (_payload: { readonly amount: number }, _context: ActionPrepareContext) =>
  Effect.succeed<Grants>({ writeAll: true });
const write = (
  payload: { readonly amount: number },
  context: ActionWriteContext<Readonly<Record<string, never>>, Services, Grants>,
) => context.services.apply(payload.amount, context.prepared);

// An annotated write context with no domain events infers alongside a prepared step and a service factory.
const action = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.inference.v1' },
    actionKey: 'test.inference',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'test.inference',
      moduleKey: 'test.inference',
      role: 'action',
    }),
    idempotency: 'optional',
    legalEntityScope: 'optional',
    owningModuleKey: 'test.inference',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    resultSchema: Schema.Struct({ total: Schema.Finite }),
    schemaVersion: '1',
  },
  {
    prepare,
    write,
  },
  () =>
    Effect.succeed<Services>({
      apply: (amount, grants) => Effect.succeed({ total: grants.writeAll ? amount : 0 }),
    }),
);

it('infers a prepared pipeline with an annotated write context', () => {
  expect(action.descriptor.actionKey).toBe('test.inference');
});
