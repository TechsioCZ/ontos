import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPayloadValidationError, ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { ActionKeySchema } from '../../src/access/approvals/frozen-command.ts';
import type { FrozenCommandRecord } from '../../src/access/approvals/frozen-command.ts';
import { frozenCommandAmount } from '../../src/access/approvals/governed-amount.ts';
import { CurrencyCodeSchema } from '../../src/access/ids.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { capabilityKey, commandDigest, proposalId, SCOPE, TENANT } from './access-approvals-fixtures.ts';

/*
 * The governed amount of a frozen command: the same amount the mandate is decided with, read from the
 * stored payload by the owner Action's own rule, never from a preview or a caller.
 */

const ACTION_KEY = 'finance.invoice.pay';
const CZK = Schema.decodeSync(CurrencyCodeSchema)('CZK');

const entrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: ACTION_KEY,
  moduleKey: 'finance',
  role: 'action',
});
const declarationOf = (amountInput: string) => {
  const input: AccessDeclarationInput = {
    amountInput,
    key: ACTION_KEY,
    kind: 'action',
    modes: ['run', 'propose', 'approve'],
    placement: { group: 'finance', level: 'manage' },
    risk: 'sensitive',
    selectors: [],
  };
  return decodeAccessDeclarationOrThrow(input, entrypoint);
};

const PayInvoice = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ minor: Schema.Int })),
  total: Schema.Struct({ currency: Schema.String, minor: Schema.Int }),
});

const frozen = (payload: Schema.Json, actionKey = ACTION_KEY): FrozenCommandRecord => ({
  actionKey: Schema.decodeSync(ActionKeySchema)(actionKey),
  command: { capabilityKey: capabilityKey(ACTION_KEY), payload },
  commandDigest: commandDigest('c'.repeat(64)),
  proposalId: proposalId(1),
  scopeId: SCOPE,
  tenantId: TENANT,
});

const scope = {
  authBindingId: '53000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:governed-amount',
  authMethod: 'session' as const,
  correlationId: 'governed-amount',
  principalId: '54000000-0000-4000-8000-000000000001',
  tenantId: TENANT,
};

const payload = { lines: [{ minor: 30_000 }, { minor: 20_000 }], total: { currency: 'CZK', minor: 50_000 } };

it.effect('reads a frozen command’s amount by the Action’s own rule, and refuses another Action’s command', () =>
  Effect.gen(function* governedAmountOfFrozenCommand() {
    // A payload-named amount is read at the declaration's own path.
    const named = yield* frozenCommandAmount({
      descriptor: { accessDeclaration: declarationOf('total'), actionKey: ACTION_KEY, payloadSchema: PayInvoice },
      record: frozen(payload),
      scope,
    });
    expect(named).toEqual(Option.some({ currency: CZK, minor: 50_000 }));

    // An owner-derived total comes from the Action's resolver over the decoded stored payload.
    const derived = yield* frozenCommandAmount({
      descriptor: {
        accessAmount: (decoded) => ({ currency: CZK, minor: decoded.lines.reduce((sum, line) => sum + line.minor, 1) }),
        accessDeclaration: declarationOf('derived.total'),
        actionKey: ACTION_KEY,
        payloadSchema: PayInvoice,
      },
      record: frozen(payload),
      scope,
    });
    expect(derived).toEqual(Option.some({ currency: CZK, minor: 50_001 }));

    const foreign = yield* Effect.flip(
      frozenCommandAmount({
        descriptor: { accessDeclaration: declarationOf('total'), actionKey: ACTION_KEY, payloadSchema: PayInvoice },
        record: frozen(payload, 'finance.invoice.void'),
        scope,
      }),
    );
    expect(foreign).toBeInstanceOf(ActionPermissionCheckError);
    // A stored payload the Action no longer decodes is refused, never read as "no amount".
    const undecodable = yield* Effect.flip(
      frozenCommandAmount({
        descriptor: { accessDeclaration: declarationOf('total'), actionKey: ACTION_KEY, payloadSchema: PayInvoice },
        record: frozen({ total: 'fifty' }),
        scope,
      }),
    );
    expect(undecodable).toBeInstanceOf(ActionPayloadValidationError);
  }),
);
