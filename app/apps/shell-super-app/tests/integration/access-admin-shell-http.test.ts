import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ListAccessApprovalsResponseSchema,
  ListAccessChangesResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import {
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The access administration groups over HTTP, through the composition `api/index.ts` builds for
 * production: the real Shell API runtime, pointed at one real-gate case database, with the real
 * People, Novinky and Approvals BFFs, the real Core stores and the real access gate over the
 * integration SpiceDB. The signed-in person is the one thing the fixture supplies itself; every
 * authorization answer is the engine's.
 *
 * It proves that the groups the browser calls are mounted and answer, and it pins both ship gates as
 * the composition provides them: Lidé open (every write control of the owner available, proven by
 * `access-admin-people-writes.test.ts`), Novinky still closed (reported unavailable, and a decision is
 * a retryable 503 that records nothing).
 */

const decodeBody = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.orDie);

/** Every scope a page of people names a membership in. */
const membershipScopesOf = (page: typeof ListAccessPeopleResponseSchema.Type) =>
  page.items.flatMap(({ memberships }) => memberships.map(({ scope }) => scope));

const decisionCount = (accessCase: AccessAdminCase) =>
  accessCase.admin
    .unsafe<{ readonly count: string }>(
      `select count(*)::text as count from core.access_change_decisions where tenant_id = '${accessCase.tenantId}'`,
    )
    .pipe(
      Effect.map((rows) => Number(rows[0]?.count ?? 'NaN')),
      Effect.orDie,
    );

const RetryableProblemSchema = Schema.Struct({ retryable: Schema.Boolean, status: Schema.Number });

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the Shell API serves People, Novinky and Ke schválení',
  (suite) => {
    suite.effect('People, its options, Novinky and the approval inbox answer through the production composition', () =>
      withAccessAdminCase((accessCase) =>
        Effect.scoped(
          Effect.gen(function* servedThroughShell() {
            const shell = yield* shellHttpFor(accessCase);
            const owner = accessCase.ids.get('owner')?.principalId;
            const companyAdmin = accessCase.ids.get('companyAdmin')?.principalId;

            const people = yield* shell.post({
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'owner',
            });
            expect({ status: people.status, text: people.status === 200 ? '' : people.text }).toEqual({
              status: 200,
              text: '',
            });
            const listed = yield* decodeBody(ListAccessPeopleResponseSchema, people.text);
            expect(listed.items.map(({ principalId }) => principalId)).toEqual(
              expect.arrayContaining([owner, companyAdmin]),
            );

            const options = yield* shell.post({
              path: '/shell/access/people/options',
              payload: { limit: 100 },
              persona: 'owner',
            });
            expect(options.status).toBe(200);
            const offered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, options.text);
            // The screen reads both and refuses a mismatch, so the two answers must name one revision.
            expect(offered.revision).toBe(listed.revision);
            // Lidé ships open: the tenant owner is offered every write, admission and ending included.
            expect(offered.writeAvailability).toEqual({
              canAdmitMember: true,
              canAssign: true,
              canDelegate: true,
              canEndMembership: true,
              canManageTeams: true,
              canRevokeDelegation: true,
              canTransferOwnership: true,
              canUnassign: true,
            });

            const narrowed = yield* shell.post({
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'companyAdmin',
            });
            expect(narrowed.status).toBe(200);
            const company = yield* decodeBody(ListAccessPeopleResponseSchema, narrowed.text);
            const [companyA] = accessCase.companies;
            // A company administrator sees only company A's rows: no tenant-context membership of anybody.
            expect(membershipScopesOf(company)).not.toContainEqual({ kind: 'tenant' });
            expect(membershipScopesOf(company)).toContainEqual({ kind: 'company', legalEntityId: companyA });

            const refused = yield* shell.post({
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'member',
            });
            expect(refused.status).toBe(403);

            // Novinky ships closed: the list reports it, and a decision is a retryable 503 that records nothing.
            const changes = yield* shell.post({
              path: '/shell/access/changes/list',
              payload: { limit: 50 },
              persona: 'owner',
            });
            expect({ status: changes.status, text: changes.status === 200 ? '' : changes.text }).toEqual({
              status: 200,
              text: '',
            });
            const novinky = yield* decodeBody(ListAccessChangesResponseSchema, changes.text);
            expect(novinky.writeAvailability).toEqual({ available: false, reason: 'pending real-gate verification' });
            const decisionsBefore = yield* decisionCount(accessCase);
            const decided = yield* shell.post({
              idempotencyKey: 'p14-novinky-closed',
              path: '/shell/access/changes/decide',
              payload: {
                catalogSnapshotId: novinky.catalogSnapshotId,
                decision: 'decline',
                itemIds: [novinky.items[0]?.id ?? globalThis.crypto.randomUUID()],
                legalEntityId: null,
              },
              persona: 'owner',
            });
            expect(decided.status).toBe(503);
            expect(yield* decodeBody(RetryableProblemSchema, decided.text)).toEqual({ retryable: true, status: 503 });
            expect(yield* decisionCount(accessCase)).toBe(decisionsBefore);

            const approvals = yield* shell.post({
              path: '/shell/access/approvals/list',
              payload: { limit: 50 },
              persona: 'owner',
            });
            expect({ status: approvals.status, text: approvals.status === 200 ? '' : approvals.text }).toEqual({
              status: 200,
              text: '',
            });
            const inbox = yield* decodeBody(ListAccessApprovalsResponseSchema, approvals.text);
            expect(inbox).toEqual({ items: [], nextCursor: null });
          }),
        ),
      ),
    );
  },
);
