// The Facility Operations reach, as the one access gate answers it (ADR-0030). The owner asks about
// three canonical declarations and maps their outcomes here; nothing in this module grants, and no
// legacy permission key appears anywhere in it.
import { Schema } from 'effect';

/** One gate answer, exactly as `AccessDecision.outcome` spells it (Core's own closed vocabulary). */
const GateOutcomeSchema = Schema.Literals(['ALLOWED', 'DENIED', 'NEEDS_APPROVAL', 'UNAVAILABLE']);
export type GateOutcome = typeof GateOutcomeSchema.Type;

export interface Grants {
  readonly readAll: boolean;
  readonly readOperational: boolean;
  readonly writeAll: boolean;
  readonly writeOperational: boolean;
}

/**
 * `read` is the parent records read (`facility.operations.api-records.read`) and is the operational
 * reach; `restricted` is its restricted field group
 * (`facility.operations.records-restricted.read`), which a full reader holds on top, so a caller with
 * the parent read alone sees its assigned calendar and operational meter fields. `write` is the facility write capability
 * (`facility.operations.apply-command.write`): the canonical catalog declares no narrower one, so a
 * writer reaches operational commands. Restricted writes additionally require the restricted
 * records read, so a write grant never widens an operational reader into a full manager.
 */
export const facilityGrantsOf = (input: {
  readonly read: GateOutcome;
  readonly restricted: GateOutcome;
  readonly write: GateOutcome;
}): Grants => {
  const readOperational = input.read === 'ALLOWED';
  const writeOperational = input.write === 'ALLOWED';
  return {
    readAll: readOperational && input.restricted === 'ALLOWED',
    readOperational,
    writeAll: writeOperational && readOperational && input.restricted === 'ALLOWED',
    writeOperational,
  };
};
