import { v1 } from '@authzed/authzed-node';
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { enginePortOf } from '../../src/access/enforcement/enforcement-live.ts';
import {
  CHECK_BULK_ITEMS_PER_REQUEST,
  makeSpiceDbDecisionCheckPort,
} from '../../src/access/decision/spicedb-check-port.ts';
import { SpiceDbRpcError } from '../../src/permissions/spicedb-rpc.ts';
import type { SpiceDbRpc } from '../../src/permissions/spicedb-rpc.ts';
import { holderId, principalHolder } from './access-decision-support.ts';

/*
 * The seam's engine port is a small adaptation of the one check transport. This suite holds it equal
 * to `access/decision/spicedb-check-port.ts` answer for answer, so an engine answer can never mean
 * two different things depending on which layer asked (O48b, L1). The engine's L43X suite owns the
 * SpiceDB behaviour itself; this suite owns only the equivalence.
 */
const item = (permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckBulkPermissionsResponse.create({ pairs: [{ response: { item: { permissionship }, oneofKind: 'item' } }] });

/** The scripted transport owns no channel, so closing it frees nothing. */
const closeTransport = (): void => {
  // A scripted transport has no channel to close.
};

const unused = () => Effect.die('only checkBulkPermissions is exercised here');

const scripted = (response: v1.CheckBulkPermissionsResponse | 'failed'): SpiceDbRpc => ({
  checkBulkPermissions: () =>
    response === 'failed'
      ? Effect.fail(new SpiceDbRpcError({ cause: 'transport down', code: Option.none() }))
      : Effect.succeed(response),
  checkPermission: unused,
  close: closeTransport,
  diffSchema: unused,
  readRelationships: unused,
  readSchema: unused,
  writeRelationships: unused,
  writeSchema: unused,
});

const items = [
  {
    permission: 'use',
    resource: { id: 'gr_test', type: 'access_grant' },
    subject: { id: holderId(principalHolder()).replace(/^principal /u, ''), type: 'principal' as const },
  },
];

const answersOf = (port: ReturnType<typeof enginePortOf>) => port.checkBulk(items);

it.effect('answers every engine permissionship exactly as the decision engine expects', () =>
  Effect.gen(function* agreesOnEveryAnswer() {
    const cases = [
      v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION,
      v1.CheckPermissionResponse_Permissionship.UNSPECIFIED,
    ] as const;
    for (const permissionship of cases) {
      const rpc = scripted(item(permissionship));
      const ours = yield* answersOf(enginePortOf(rpc));
      const theirs = yield* answersOf(makeSpiceDbDecisionCheckPort(rpc));
      expect(ours).toEqual(theirs);
    }
  }),
);

it.effect('answers UNAVAILABLE, never a denial, when the transport fails', () =>
  Effect.gen(function* failsClosedAsUnavailable() {
    const outcome = yield* Effect.matchEffect(answersOf(enginePortOf(scripted('failed'))), {
      onFailure: (failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed('answered'),
    });
    expect(outcome).toBe('AccessDecisionUnavailable');
    const theirs = yield* Effect.matchEffect(answersOf(makeSpiceDbDecisionCheckPort(scripted('failed'))), {
      onFailure: (failure) => Effect.succeed(failure._tag),
      onSuccess: () => Effect.succeed('answered'),
    });
    expect(theirs).toBe(outcome);
  }),
);

/** SpiceDB's own maximum of checks in one `CheckBulkPermissions` request (fixed in the pinned v1.57.0). */
const SERVER_MAXIMUM = 10_000;

/** The `n`-th item of a large batch; the transport below answers each by its own number. */
const numberedItem = (index: number) => ({
  permission: 'use',
  resource: { id: `gr_${index}`, type: 'access_grant' },
  subject: { id: holderId(principalHolder()).replace(/^principal /u, ''), type: 'principal' as const },
});

/**
 * A transport that behaves like SpiceDB on bulk checks: it refuses more than `SERVER_MAXIMUM` items, answers each
 * item by its number (multiples of three are allowed), names the snapshot it answered at, and records every request.
 * `failing` names the request (1-based) that fails in transport, `short` one that answers one item too few.
 */
const bulkServer = (options: { readonly failing?: number; readonly short?: number } = {}) => {
  const requests: v1.CheckBulkPermissionsRequest[] = [];
  const rpc: SpiceDbRpc = {
    ...scripted('failed'),
    checkBulkPermissions: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        if (request.items.length > SERVER_MAXIMUM || requests.length === options.failing) {
          return Effect.fail(new SpiceDbRpcError({ cause: 'refused', code: Option.some(3) }));
        }
        const answered = requests.length === options.short ? request.items.slice(1) : request.items;
        return Effect.succeed(
          v1.CheckBulkPermissionsResponse.create({
            checkedAt: { token: 'snapshot-1' },
            pairs: answered.map((one) => ({
              response: {
                item: {
                  permissionship:
                    Number((one.resource?.objectId ?? '').replace('gr_', '')) % 3 === 0
                      ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                      : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
                },
                oneofKind: 'item',
              },
            })),
          }),
        );
      }),
  };
  return { requests, rpc };
};

const PORTS = [
  ['the enforcement seam', enginePortOf],
  ['the decision engine', makeSpiceDbDecisionCheckPort],
] as const;

for (const [name, portOf] of PORTS) {
  for (const count of [
    CHECK_BULK_ITEMS_PER_REQUEST,
    CHECK_BULK_ITEMS_PER_REQUEST + 1,
    3 * CHECK_BULK_ITEMS_PER_REQUEST,
    3 * SERVER_MAXIMUM,
  ]) {
    it.effect(`answers ${count} checks in item order from requests within the server maximum (${name})`, () =>
      Effect.gen(function* splitBatch() {
        const server = bulkServer();
        const batch = Array.from({ length: count }, (_, index) => numberedItem(index));
        const answers = yield* portOf(server.rpc).checkBulk(batch);
        expect(answers.map(({ permissionship }) => permissionship)).toEqual(
          batch.map((_, index) => (index % 3 === 0 ? 'has' : 'none')),
        );
        expect(server.requests).toHaveLength(Math.ceil(count / CHECK_BULK_ITEMS_PER_REQUEST));
        expect(server.requests.every(({ items: sent }) => sent.length <= CHECK_BULK_ITEMS_PER_REQUEST)).toBe(true);
        // One snapshot: the first request is fully consistent, every other one is pinned to where it was answered.
        const [first, ...rest] = server.requests;
        expect(first?.consistency?.requirement.oneofKind).toBe('fullyConsistent');
        for (const request of rest) {
          expect(request.consistency?.requirement).toEqual({
            atExactSnapshot: { token: 'snapshot-1' },
            oneofKind: 'atExactSnapshot',
          });
        }
      }),
    );
  }

  for (const failure of [{ failing: 2 }, { short: 2 }, { short: 1 }] as const) {
    it.effect(
      `answers a whole batch UNAVAILABLE when one of its requests fails (${name}, ${JSON.stringify(failure)})`,
      () =>
        Effect.gen(function* failedRequest() {
          const server = bulkServer(failure);
          const batch = Array.from({ length: 3 * CHECK_BULK_ITEMS_PER_REQUEST }, (_, index) => numberedItem(index));
          const outcome = yield* portOf(server.rpc)
            .checkBulk(batch)
            .pipe(
              Effect.match({
                onFailure: (unavailable) => unavailable._tag,
                onSuccess: (answers) => `answered ${answers.length}`,
              }),
            );
          // Never a partial answer: the engine treats the failure as an unavailable engine, never as denials.
          expect(outcome).toBe('AccessDecisionUnavailable');
        }),
    );
  }
}
