import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { prepareEngineEvidence } from '../../src/access/enforcement/prepared-check.ts';
import { sameAuthorityRevision } from '../../src/access/enforcement/currentness.ts';
import type { AccessCheckItem, DecisionCheckPort } from '../../src/access/decision/engine.ts';
import { insideDatabaseTransaction, refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';

const question: AccessCheckItem = {
  context: { resource_key: 'employee-1' },
  permission: 'run_all_grant',
  resource: { id: 'exact-capability', type: 'access_capability' },
  subject: { id: 'exact-grant-incarnation', type: 'access_grant' },
};

it.effect('replays only exact remote evidence under the physical transaction I/O guard', () =>
  Effect.gen(function* exactPreparedEvidence() {
    let remoteCalls = 0;
    const remote: DecisionCheckPort = {
      checkBulk: Effect.fn('PreparedEvidenceFixture.remote')(function* remoteCheck(items: readonly AccessCheckItem[]) {
        yield* refuseInsideDatabaseTransaction('spicedb', 'prepared-proof-fixture');
        remoteCalls += 1;
        return items.map(() => ({ permissionship: 'has' as const }));
      }),
    };
    const evidence = prepareEngineEvidence(remote);
    yield* evidence.capture.checkBulk([question]);
    evidence.seal();
    const allowed = yield* evidence.replay.checkBulk([question]).pipe(insideDatabaseTransaction('prepared-action'));
    expect(allowed).toEqual([{ permissionship: 'has' }]);
    expect(remoteCalls).toBe(1);
    for (const changed of [
      { ...question, context: { resource_key: 'employee-2' } },
      { ...question, permission: 'approve_all_grant' },
      { ...question, subject: { ...question.subject, id: 'different-incarnation' } },
      { ...question, resource: { ...question.resource, id: 'different-company-capability' } },
    ]) {
      expect(
        Exit.isFailure(
          yield* Effect.exit(evidence.replay.checkBulk([changed]).pipe(insideDatabaseTransaction('prepared-action'))),
        ),
      ).toBe(true);
    }
    expect(remoteCalls).toBe(1);
    expect(Exit.isFailure(yield* Effect.exit(evidence.capture.checkBulk([question])))).toBe(true);
  }),
);

it.effect('never seals incomplete or indeterminate engine answers into an authority proof', () =>
  Effect.gen(function* incompleteEngineEvidence() {
    for (const results of [[], [{ permissionship: 'conditional' as const }], [{ permissionship: 'error' as const }]]) {
      const evidence = prepareEngineEvidence({ checkBulk: () => Effect.succeed(results) });
      expect(Exit.isFailure(yield* Effect.exit(evidence.capture.checkBulk([question])))).toBe(true);
      evidence.seal();
      expect(Exit.isFailure(yield* Effect.exit(evidence.replay.checkBulk([question])))).toBe(true);
    }
  }),
);

it('compares both persisted fence identities and revisions without an ABA or empty-snapshot allow', () => {
  const revision = [
    { revision: 10, scopeId: 'tenant' },
    { revision: 4, scopeId: 'company' },
  ] as const;
  expect(sameAuthorityRevision(revision, revision)).toBe(true);
  expect(sameAuthorityRevision([], [])).toBe(false);
  expect(sameAuthorityRevision(revision, [{ revision: 12, scopeId: 'tenant' }, revision[1]])).toBe(false);
  expect(sameAuthorityRevision(revision, [{ revision: 10, scopeId: 'other-tenant' }, revision[1]])).toBe(false);
  expect(sameAuthorityRevision(revision, [revision[0]])).toBe(false);
});
