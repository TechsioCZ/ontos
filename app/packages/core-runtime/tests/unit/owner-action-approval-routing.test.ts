import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { readOwnerActionApprovalRouting } from '@app/core-runtime/access/approvals/owner-runtime';
import { OwnerActionApprovalRoutingSchema } from '@app/core-runtime/access/approvals/owner-api';
import { makeActionCommandV2, freezeActionCommandV2 } from '../../src/access/approvals/action-command-v2.ts';
import { freezeCommand } from '../../src/access/approvals/command.ts';
import { ActionKeySchema } from '../../src/access/approvals/frozen-command.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  CommandDigestSchema,
  ProposalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { actionFor, ownerKey, principal } from '../support/action-command-v2.ts';

const fixture = Effect.gen(function* routingFixture() {
  const action = actionFor();
  const command = yield* makeActionCommandV2({
    payload: { ids: [RecordKeySchema.make('one'), RecordKeySchema.make('two')], salary: 50 },
    registration: action,
    scope: { ...principal, correlationId: 'routing' },
  });
  const record: FrozenCommandRecord = {
    actionKey: command.actionKey,
    command: { capabilityKey: CapabilityKeySchema.make(command.declaration.key), payload: command },
    commandDigest: Result.getOrThrow(freezeActionCommandV2(command)),
    proposalId: ProposalIdSchema.make('00000000-0000-4000-8000-000000000010'),
    scopeId: AccessScopeIdSchema.make('00000000-0000-4000-8000-000000000011'),
    tenantId: command.scope.tenantId,
  };
  return record;
});

it.effect(
  'the canonical frozen-command routing projection exposes only the owner, format and exact tenant/company',
  () =>
    Effect.gen(function* safeProjection() {
      const record = yield* fixture;
      const routing = yield* readOwnerActionApprovalRouting(record);
      expect(routing).toEqual({
        format: 'core.action/2',
        owningModuleKey: ownerKey,
        scope: { legalEntityId: principal.legalEntityId, tenantId: principal.tenantId },
      });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(OwnerActionApprovalRoutingSchema))(routing),
      ).not.toContain('salary');
      expect(Object.keys(routing).toSorted()).toEqual(['format', 'owningModuleKey', 'scope']);
    }),
);

it.effect(
  'no scalar history, forged digest, foreign tenant, mismatched Action or capability can supply routing authority',
  () =>
    Effect.gen(function* strictRouting() {
      const record = yield* fixture;
      const scalar = { capabilityKey: record.command.capabilityKey, payload: { employeeId: 'one' } };
      const foreignCapability = { ...record.command, capabilityKey: CapabilityKeySchema.make('demo.other.change') };
      const scalarTarget = { ...record.command, target: RecordKeySchema.make('one') };
      const changed = [
        { ...record, commandDigest: CommandDigestSchema.make('0'.repeat(64)) },
        { ...record, tenantId: TenantIdSchema.make('00000000-0000-4000-8000-000000000099') },
        { ...record, actionKey: ActionKeySchema.make('demo.other.action') },
        { ...record, command: foreignCapability, commandDigest: Result.getOrThrow(freezeCommand(foreignCapability)) },
        { ...record, command: scalarTarget, commandDigest: Result.getOrThrow(freezeCommand(scalarTarget)) },
        { ...record, command: scalar, commandDigest: Result.getOrThrow(freezeCommand(scalar)) },
      ];
      for (const candidate of changed) {
        expect(yield* readOwnerActionApprovalRouting(candidate).pipe(Effect.result)).toMatchObject({
          failure: { _tag: 'OwnerActionApprovalError', code: 'approval_refused' },
        });
      }
    }),
);
