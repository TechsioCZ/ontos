import { Effect, Option, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AuthorityCell } from '../../src/access/decision/authority.ts';
import type { DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess } from '../../src/access/decision/engine.ts';
import type { DecisionInput } from '../../src/access/decision/engine.ts';
import { CurrencyCodeSchema, DelegationIdSchema, PrincipalIdSchema } from '../../src/access/ids.ts';
import { delegatedCellCeiling } from '../../src/access/intent/delegated-cell.ts';
import type { DelegatedLimits, Delegation } from '../../src/access/model.ts';
import {
  amount,
  at,
  capability,
  cell,
  makeAuthority,
  makeCheck,
  otherPerson,
  person,
  principalHolder,
  scopeId,
  tenant,
} from './access-decision-support.ts';

const now = at('2026-11-03T12:00:00Z');
const readKey = capability('finance.invoice.read');
const payKey = capability('finance.invoice.pay');
const ceiling = { currency: CurrencyCodeSchema.make('CZK'), limitMinor: 10_000 };
const delegationId = DelegationIdSchema.make('00000000-0000-4000-8000-000000000077');

const delegation: Delegation = {
  amountCeiling: ceiling,
  capabilityKeys: [readKey, payKey],
  grantedBy: PrincipalIdSchema.make('00000000-0000-4000-8000-000000000099'),
  id: delegationId,
  managerId: otherPerson,
  people: [person],
  roleIds: [cell().roleId],
  scopeId,
  status: 'active',
  tenantId: tenant,
  validFrom: at('2026-10-01T00:00:00Z'),
  validUntil: at('2026-12-31T00:00:00Z'),
};
const frozen: DelegatedLimits = {
  amountCeiling: ceiling,
  capabilityKeys: [readKey, payKey],
  delegationId,
  until: at('2026-12-31T00:00:00Z'),
};

/** One cell of the delegated role, bounded exactly as the intent loader bounds it (D10b). */
const delegatedCell = (granted: AuthorityCell, amountGoverned: boolean): AuthorityCell => {
  const bounded = delegatedCellCeiling({
    amountGoverned,
    cell: granted,
    delegation,
    frozen,
    holder: principalHolder(),
    roleId: granted.roleId,
  });
  if (Result.isFailure(bounded)) {
    throw new Error(`the delegated cell must fit its envelope: ${bounded.failure.reason}`);
  }
  const { amountCeiling: _own, ...rest } = granted;
  return Option.match(bounded.success, {
    onNone: () => rest,
    onSome: (narrowed) => ({ ...rest, amountCeiling: narrowed }),
  });
};

const readPolicy: DecisionCapabilityPolicy = {
  capabilityKey: readKey,
  kind: 'read',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
};
const payPolicy: DecisionCapabilityPolicy = {
  capabilityKey: payKey,
  kind: 'action',
  modes: ['run'],
  risk: 'routine',
  selectors: [],
};

it.effect('caps only the money capability of a capped delegation, never its plain read', () =>
  Effect.gen(function* capsOnlyMoneyCapabilityOfCappedDelegation() {
    const cells = [
      delegatedCell(cell({ capability: readKey }), false),
      delegatedCell(cell({ capability: payKey }), true),
    ];
    const authority = { cells };
    const decide = (request: DecisionInput['request']) =>
      Effect.map(
        decideAccess(makeAuthority(authority).port, makeCheck({ authority }).port, {
          actor: { actor: { _tag: 'Principal', principalId: person }, tenantId: tenant },
          now,
          request,
        }),
        ({ outcome, reasons }) => ({ codes: reasons.map(({ code }) => code), outcome }),
      );

    // The read governs no amount, so the delegation's money limit never reaches it.
    expect(cells[0]?.amountCeiling).toBeUndefined();
    const read = yield* decide({ capability: readPolicy, mode: 'run' });
    expect(read.outcome).toBe('ALLOWED');

    // The money action takes the delegation's ceiling even though its own cell names none.
    expect(cells[1]?.amountCeiling).toEqual(ceiling);
    const missing = yield* decide({ capability: payPolicy, mode: 'run' });
    expect(missing.outcome).toBe('DENIED');
    expect(missing.codes).toContain('deny.amount_required');

    const over = yield* decide({ amount: amount(10_001), capability: payPolicy, mode: 'run' });
    expect(over.outcome).toBe('DENIED');
    expect(over.codes).toContain('deny.amount_exceeds_ceiling');

    const within = yield* decide({ amount: amount(10_000), capability: payPolicy, mode: 'run' });
    expect(within.outcome).toBe('ALLOWED');
  }),
);
