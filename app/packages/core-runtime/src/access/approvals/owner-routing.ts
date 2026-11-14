import { Effect, Result } from 'effect';

import { CapabilityKeySchema } from '../ids.ts';
import { decodeActionCommandV2 } from './action-command-v2.ts';
import { verifyFrozenCommand } from './frozen-command.ts';
import type { FrozenCommandRecord } from './frozen-command.ts';
import type { OwnerActionApprovalRouting } from './owner-api.ts';
import { ownerActionApprovalFailure } from './owner-errors.ts';
import type { OwnerActionApprovalError } from './owner-errors.ts';

const refused = <Cause>(cause?: Cause) => ownerActionApprovalFailure('approval_refused', cause);

/** Server-only projection. A routing answer grants nothing and never replaces owner admission. */
export const readOwnerActionApprovalRouting = Effect.fn('OwnerActionApproval.readRouting')(
  function* readOwnerActionApprovalRouting(
    record: FrozenCommandRecord,
  ): Effect.fn.Return<OwnerActionApprovalRouting, OwnerActionApprovalError> {
    const verified = verifyFrozenCommand(record);
    if (Result.isFailure(verified) || record.command.target !== undefined) {
      return yield* refused(Result.isFailure(verified) ? verified.failure : undefined);
    }
    const command = yield* decodeActionCommandV2(record.command.payload).pipe(Effect.mapError(refused));
    if (
      command.actionKey !== record.actionKey ||
      command.scope.tenantId !== record.tenantId ||
      CapabilityKeySchema.make(command.declaration.key) !== record.command.capabilityKey
    ) {
      return yield* refused();
    }
    return Object.freeze({
      format: command.format,
      owningModuleKey: command.owningModuleKey,
      scope: Object.freeze({ ...command.scope }),
    });
  },
);
