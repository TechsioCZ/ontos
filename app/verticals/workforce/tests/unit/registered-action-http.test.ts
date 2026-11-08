import { WorkforceDuplicateEmail } from '../../shared/errors/workforce-duplicate-email.ts';
import { WorkforceDuplicateEmailProblemSchema } from '../../shared/workforce-action-problems.ts';
import { DateTime, Effect, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { ProposalIdSchema } from '@app/core-runtime/access/ids';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { executeUpdateEmployeeWithAuthorization } from '../../src/api/update-employee-action-client.ts';
import { UpdateEmployeePayloadSchema } from '../../shared/actions/apply-command.ts';
import { expect, it } from 'effect-rstest';
import { cases, makeFixture } from './registered-action-http-fixture.ts';

const id = '50000000-0000-4000-8000-000000000001';

for (const { command, slug } of cases) {
  it.effect(`${slug}/${command._tag} publishes its own closed HTTP route and commits the same audit action key`, () =>
    Effect.scoped(
      Effect.gen(function* httpIdentity() {
        const { harness, request, writes } = yield* makeFixture();
        const response = yield* request(`/workforce/actions/${slug}`, command, slug);
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ revision: 2 });
        expect(harness.snapshot().committed).toHaveLength(1);
        expect(harness.snapshot().invocations[0]?.actionKey).toBe(`demo.workforce.${slug}`);
        expect(harness.snapshot().committed[0]?.actionKey).toBe(`demo.workforce.${slug}`);
        expect(writes.at(-1)).toEqual(command);
        const replay = yield* request(`/workforce/actions/${slug}`, command, slug);
        expect(replay.status).toBe(409);
        expect(harness.snapshot().committed).toHaveLength(1);
        if (slug !== 'apply-command') {
          const rejected = yield* request('/workforce/actions/apply-command', command, `${slug}-old`);
          expect(rejected.status).toBe(400);
          expect(harness.snapshot().invocations).toHaveLength(1);
        }
        return response.status;
      }),
    ),
  );
}

it.effect(
  'a parked HTTP 202 preserves its actual narrow registration, payload and receipt without a business commit',
  () =>
    Effect.scoped(
      Effect.gen(function* pendingReceipt() {
        const parks: Parameters<NonNullable<ActionTestHarnessOptions['mandateDispatch']>['parkProposal']>[0][] = [];
        const parked = {
          expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-10T12:00:00.000Z')),
          proposalId: ProposalIdSchema.make('60000000-0000-4000-8000-000000000001'),
        };
        const { compositionRevision, harness, requestContext, router } = yield* makeFixture({
          access: 'needs_approval',
          mandateDispatch: {
            claim: () => Effect.die('A proposal cannot claim a mandate'),
            commit: () => Effect.die('A proposal cannot commit a mandate'),
            loadParkedProposal: () => Effect.succeed(Option.none()),
            parkProposal: (input) => {
              parks.push(input);
              return Effect.succeed(parked);
            },
            prepare: () => Effect.die('A proposal cannot execute a mandate'),
          },
        });
        const command = { _tag: 'UpdateEmployee', id, patch: { department: 'Pending' } } as const;
        const statuses: number[] = [];
        const receipt = yield* executeUpdateEmployeeWithAuthorization(
          Schema.decodeUnknownSync(UpdateEmployeePayloadSchema)({ command, expectedRevision: 1 }),
          'Bearer fixture',
          'pending-update',
          {
            baseUrl: 'https://owner.test',
            compositionRevision,
            idempotencyKey: 'pending-update',
            intent: 'propose',
          },
        ).pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
            const response = await router.handler(new Request(input, init), requestContext);
            statuses.push(response.status);
            return response;
          }),
        );
        expect(statuses).toEqual([202]);
        expect(Schema.is(ActionProposalAcceptedSchema)(receipt)).toBe(true);
        if (!Schema.is(ActionProposalAcceptedSchema)(receipt)) {
          expect.unreachable('Expected a real proposal receipt');
        }
        expect(receipt.proposalId).toBe(parked.proposalId);
        expect(DateTime.toEpochMillis(receipt.expiresAt)).toBe(parked.expiresAt.getTime());
        expect(parks).toHaveLength(1);
        expect(parks[0]?.actionKey).toBe('demo.workforce.update-employee');
        expect(parks[0]?.capabilityKey).toBe('demo.workforce.employee.update');
        expect(parks[0]?.target).toBe(id);
        expect(parks[0]?.payload).toEqual({ command, expectedRevision: 1 });
        expect(harness.snapshot().committed).toEqual([]);
        expect(harness.snapshot().stages).not.toContain('handler_executed');
      }),
    ),
);

it.effect('the real update-employee HTTP contract keeps duplicate email at 422 and never commits it', () =>
  Effect.scoped(
    Effect.gen(function* duplicateEmail() {
      const { harness, request } = yield* makeFixture(
        {},
        new WorkforceDuplicateEmail({ code: 'workforce_duplicate_email', reason: 'unsafe private database detail' }),
      );
      const response = yield* request('/workforce/actions/update-employee', cases[1].command, 'duplicate-email');
      expect(response.status).toBe(422);
      const problem = yield* Schema.decodeUnknownEffect(WorkforceDuplicateEmailProblemSchema)(
        yield* Effect.promise(() => response.json()),
      );
      expect(problem.code).toBe('workforce_duplicate_email');
      expect(problem.detail).not.toContain('unsafe');
      expect(harness.snapshot().committed).toEqual([]);
    }),
  ),
);
