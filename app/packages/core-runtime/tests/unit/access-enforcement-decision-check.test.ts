import { v1 } from '@authzed/authzed-node';
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { enginePortOf } from '../../src/access/enforcement/enforcement-live.ts';
import { makeSpiceDbDecisionCheckPort } from '../../src/access/decision/spicedb-check-port.ts';
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
