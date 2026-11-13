// A company's stored finance ledger that does not decode on a read: the read stays unavailable, and one WARN a minute
// per company names the module, tenant, company, document, field path and reason, never a value of the ledger.
import { Effect, Logger, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { decodeFinanceState } from '../../src/services/finance-state-repository.ts';
import type { StateRow } from '../../src/services/finance-state-repository.ts';

const scope = {
  legalEntityId: '31000000-0000-4000-8000-000000000021',
  tenantId: '21000000-0000-4000-8000-000000000021',
};
/** A ledger whose recorded VAT wait is stored as null (the class of fault that took stage's catalogues down). */
const row: StateRow = {
  revision: 3,
  state: JSON.parse('{"financialPlanEntries":[],"invoices":[],"opportunitiesAwaitingVat":null}'),
};
const LineSchema = Schema.Struct({ annotations: Schema.Json, level: Schema.String, message: Schema.Json });

it.effect('an undecodable ledger answers unavailable with one WARN a minute per company', () =>
  Effect.gen(function* undecodableLedger() {
    const lines: string[] = [];
    const capture = Logger.make((options) => {
      lines.push(JSON.stringify(Logger.formatStructured.log(options)));
    });
    const read = decodeFinanceState(row, scope).pipe(
      Effect.flip,
      Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
    );
    expect(yield* read).toMatchObject({ code: 'finance_persistence_unavailable' });
    yield* read;
    expect(lines).toHaveLength(1);
    yield* TestClock.adjust('61 seconds');
    yield* read;
    const [first, second] = lines.map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(LineSchema))(line));
    expect(first?.annotations).toEqual({
      company: scope.legalEntityId,
      document: 'finance_billing.finance_states.state',
      failures: 1,
      issues: [{ path: 'opportunitiesAwaitingVat', reason: expect.stringMatching(/^Expected /u) }],
      module: 'finance.billing',
      tenant: scope.tenantId,
    });
    expect(second?.annotations).toMatchObject({ failures: 2 });
    expect(lines.join('\n')).not.toContain('got null');
  }),
);
