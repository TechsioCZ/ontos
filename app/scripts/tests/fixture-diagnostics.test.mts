import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import { describeFixtureDiagnostics, fixtureDiagnosticTail } from '../integration/support/fixture-diagnostics.mts';

it('keeps the final owner refusal and guard messages within a bounded diagnostic tail', () => {
  const history = Array.from({ length: 100 }, (_, index) => `owner line ${index}`);
  const tail = fixtureDiagnosticTail(
    [...history, 'Action refused: deny.workload_unbound', 'IoInsideDatabaseTransaction: privacy read'].join('\n'),
  );
  expect(tail.split('\n')).toHaveLength(60);
  expect(tail).not.toContain('owner line 0');
  expect(tail).toContain('Action refused: deny.workload_unbound');
  expect(tail).toContain('IoInsideDatabaseTransaction: privacy read');
  expect(fixtureDiagnosticTail('bounded log '.repeat(2000)).length).toBeLessThanOrEqual(4096);
});

for (const [index, credential] of [
  'Bearer fixture-bearer-value',
  'Authorization: Basic fixture-basic-value',
  'Cookie: session=fixture-cookie-value; refresh=fixture-refresh-value',
  'Set-Cookie: session=fixture-cookie-value; HttpOnly',
  'password=fixture-password-value',
  '"password":\n"fixture-password-value"',
  '"password": "escaped\\"fixture-password-value"',
  'DATABASE_ADMIN_URL=postgres://fixture:fixture-password-value@localhost/fixture',
  'connectionString: "postgresql://fixture@localhost/fixture?password=fixture-password-value"',
  'dsn: postgres://fixture@localhost/fixture',
  'access_token: fixture-access-value',
  'SPICEDB_PRESHARED_KEY: fixture-key-value',
  'eyJfixture-header.fixture-payload.fixture-signature',
].entries()) {
  it(`removes credential-shaped data from diagnostic example ${index + 1}`, () => {
    const tail = fixtureDiagnosticTail(`${credential}\nIoInsideDatabaseTransaction: privacy read`);
    expect(tail).not.toMatch(/fixture-(?:bearer|basic|cookie|refresh|password|access|key)-value/u);
    expect(tail).not.toContain('postgres');
    expect(tail).not.toContain('eyJfixture');
    expect(tail).toContain('[redacted');
    expect(tail).toContain('IoInsideDatabaseTransaction: privacy read');
  });
}

it('redacts credentials before truncating a long diagnostic line', () => {
  const tail = fixtureDiagnosticTail(`password=${'fixture-password-value'.repeat(500)}\nAction refused`);
  expect(tail).not.toContain('fixture-password-value');
  expect(tail).toContain('Action refused');
});

it.effect('uses a non-sensitive marker when gateway diagnostics are unavailable', () =>
  Effect.gen(function* unavailableDiagnostics() {
    const diagnostic = yield* describeFixtureDiagnostics(Effect.fail('private gateway failure'));
    expect(diagnostic).toBe('Fixture diagnostics unavailable');
    expect(diagnostic).not.toContain('private gateway failure');
  }),
);
