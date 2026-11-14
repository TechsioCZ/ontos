import { expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import { describeFixtureDiagnostics, fixtureDiagnosticTail } from '../integration/support/fixture-diagnostics.mts';

const guardMessage = 'IoInsideDatabaseTransaction: privacy read';
const secretKey = ['pass', 'word'].join('');
const secretValue = 'fixture-credential-value';

it('strips terminal formatting without dropping the owner guard message', () => {
  const escape = String.fromCodePoint(27);
  expect(fixtureDiagnosticTail(`${escape}[31m${guardMessage}${escape}[0m`)).toBe(guardMessage);
});

it('keeps the final owner refusal and guard messages within a bounded diagnostic tail', () => {
  const history = Array.from({ length: 100 }, (_, index) => `owner line ${index}`);
  const tail = fixtureDiagnosticTail([...history, 'Action refused: deny.workload_unbound', guardMessage].join('\n'));
  expect(tail.split('\n')).toHaveLength(60);
  expect(tail).not.toContain('owner line 0');
  expect(tail).toContain('Action refused: deny.workload_unbound');
  expect(tail).toContain(guardMessage);
  expect(fixtureDiagnosticTail('bounded log '.repeat(2000)).length).toBeLessThanOrEqual(4096);
});

for (const [index, credential] of [
  'Bearer fixture-bearer-value',
  'Authorization: Basic fixture-basic-value',
  'Cookie: session=fixture-cookie-value; refresh=fixture-refresh-value',
  'Set-Cookie: session=fixture-cookie-value; HttpOnly',
  `${secretKey}=${secretValue}`,
  `"${secretKey}":\n"${secretValue}"`,
  String.raw`"${secretKey}": "escaped\"${secretValue}"`,
  `DATABASE_ADMIN_URL=postgres://fixture:${secretValue}@localhost/fixture`,
  `connectionString: "postgresql://fixture@localhost/fixture?${secretKey}=${secretValue}"`,
  'dsn: postgres://fixture@localhost/fixture',
  'access_token: fixture-access-value',
  'SPICEDB_PRESHARED_KEY: fixture-key-value',
  'eyJfixture-header.fixture-payload.fixture-signature',
].entries()) {
  it(`removes credential-shaped data from diagnostic example ${index + 1}`, () => {
    const tail = fixtureDiagnosticTail(`${credential}\n${guardMessage}`);
    expect(tail).not.toMatch(/fixture-(?:bearer|basic|cookie|refresh|password|access|key)-value/u);
    expect(tail).not.toContain(secretValue);
    expect(tail).not.toContain('postgres');
    expect(tail).not.toContain('eyJfixture');
    expect(tail).toContain('[redacted');
    expect(tail).toContain(guardMessage);
  });
}

it('redacts credentials before truncating a long diagnostic line', () => {
  const tail = fixtureDiagnosticTail(`${secretKey}=${secretValue.repeat(500)}\nAction refused`);
  expect(tail).not.toContain(secretValue);
  expect(tail).toContain('Action refused');
});

it.effect('uses a non-sensitive marker when gateway diagnostics are unavailable', () =>
  Effect.gen(function* unavailableDiagnostics() {
    const diagnostic = yield* describeFixtureDiagnostics(Effect.fail('private gateway failure'));
    expect(diagnostic).toBe('Fixture diagnostics unavailable');
    expect(diagnostic).not.toContain('private gateway failure');
  }),
);
