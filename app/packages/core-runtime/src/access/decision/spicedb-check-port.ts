import { v1 } from '@authzed/authzed-node';
import { Effect, Predicate } from 'effect';

import { objectTypeOf } from '../compiler/object-id.ts';
import { PROJECTION_SUBJECT_TYPES } from '../compiler/relationship.ts';
import { fullyConsistent } from '../../permissions/client.ts';
import type { SpiceDbRpc, SpiceDbRpcError } from '../../permissions/spicedb-rpc.ts';
import { accessDecisionUnavailable } from './errors.ts';
import type { AccessDecisionUnavailable } from './errors.ts';
import type {
  AccessCheckContext,
  AccessCheckItem,
  AccessCheckPermissionship,
  AccessCheckResult,
  AccessCheckSubjectType,
  DecisionCheckPort,
} from './engine.ts';
import { withOptional } from './optional.ts';

/**
 * The compiler owns the subject vocabulary; the decision path must name the same object types. A
 * holder check names the human or agent type, and a witness-chain relation check names the exact
 * grant or assignment object (O51(4), O49).
 */
export const SPICEDB_V2_SUBJECT_TYPES = {
  access_assignment: objectTypeOf('assignment'),
  access_grant: objectTypeOf('grant'),
  agent: PROJECTION_SUBJECT_TYPES.agent,
  principal: PROJECTION_SUBJECT_TYPES.human,
} as const satisfies Readonly<Record<AccessCheckSubjectType, string>>;

const mutableContext = (context: AccessCheckContext) => {
  const entries = Object.entries(context).map(
    ([key, value]) => [key, Predicate.isString(value) || Predicate.isNumber(value) ? value : [...value]] as const,
  );
  return Object.fromEntries(entries);
};

const toCheckItem = (item: AccessCheckItem): v1.CheckBulkPermissionsRequestItem =>
  withOptional(
    {
      permission: item.permission,
      resource: v1.ObjectReference.create({ objectId: item.resource.id, objectType: item.resource.type }),
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({
          objectId: item.subject.id,
          objectType: SPICEDB_V2_SUBJECT_TYPES[item.subject.type],
        }),
        optionalRelation: item.subject.relation ?? '',
      }),
    },
    'context',
    item.context === undefined ? undefined : v1.createStructFromObject(mutableContext(item.context)),
  );

/**
 * One pair's answer. A per-item error is an engine failure (`error`, which the engine turns into
 * UNAVAILABLE), never a denial: only an explicit NO_PERMISSION is `none`, an explicit CONDITIONAL
 * is `conditional`, and an unspecified answer cannot be read as anything (O48b, L1).
 */
const permissionshipOf = (response: v1.CheckBulkPermissionsPair['response']): AccessCheckPermissionship => {
  if (response.oneofKind !== 'item') {
    return 'error';
  }
  const { permissionship } = response.item;
  if (permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION) {
    return 'has';
  }
  if (permissionship === v1.CheckPermissionResponse_Permissionship.NO_PERMISSION) {
    return 'none';
  }
  return permissionship === v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION ? 'conditional' : 'error';
};

/**
 * One `CheckBulkPermissions` request: fully consistent, or at exactly the snapshot `at` another request of the same
 * batch was answered at, so every item of one batch sees the same snapshot.
 */
export const toCheckBulkRequest = (
  items: readonly AccessCheckItem[],
  at?: v1.ZedToken,
): v1.CheckBulkPermissionsRequest =>
  v1.CheckBulkPermissionsRequest.create({
    consistency:
      at === undefined
        ? fullyConsistent
        : v1.Consistency.create({ requirement: { atExactSnapshot: at, oneofKind: 'atExactSnapshot' } }),
    items: items.map(toCheckItem),
  });

/**
 * Items per `CheckBulkPermissions` request. SpiceDB refuses more than 10,000 checks in one request (a fixed server
 * maximum, measured on the pinned v1.57.0: 10,000 answer, 10,001 is INVALID_ARGUMENT); half of it also keeps a
 * request well inside gRPC's default 4 MiB message size.
 */
export const CHECK_BULK_ITEMS_PER_REQUEST = 5000;

const engineUnavailable = (cause?: unknown) =>
  accessDecisionUnavailable('The authorization engine did not answer', cause);

/** Each pair's answer, in the order the request named its items. */
const resultsOf = (response: v1.CheckBulkPermissionsResponse): readonly AccessCheckResult[] =>
  response.pairs.map(({ response: item }) => ({ permissionship: permissionshipOf(item) }));

/**
 * Every item's answer, in item order, from as many requests as the server's item limit needs. The first request is
 * fully consistent and the others are pinned to the snapshot it was answered at, so the batch is one snapshot. Any
 * failed request, or one answering a different number of items, fails the whole batch: never a partial answer.
 */
export const checkBulkInRequests = (
  items: readonly AccessCheckItem[],
  send: (request: v1.CheckBulkPermissionsRequest) => Effect.Effect<v1.CheckBulkPermissionsResponse, SpiceDbRpcError>,
): Effect.Effect<readonly AccessCheckResult[], AccessDecisionUnavailable> => {
  const chunks = Array.from({ length: Math.ceil(items.length / CHECK_BULK_ITEMS_PER_REQUEST) }, (_, index) =>
    items.slice(index * CHECK_BULK_ITEMS_PER_REQUEST, (index + 1) * CHECK_BULK_ITEMS_PER_REQUEST),
  );
  const answer = (chunk: readonly AccessCheckItem[], at?: v1.ZedToken) =>
    send(toCheckBulkRequest(chunk, at)).pipe(
      Effect.mapError(engineUnavailable),
      Effect.filterOrFail(
        (response) => response.pairs.length === chunk.length,
        () => engineUnavailable('The authorization engine answered a different number of checks'),
      ),
    );
  const [first = [], ...rest] = chunks;
  return answer(first).pipe(
    Effect.flatMap((answered) => {
      const at = answered.checkedAt;
      if (rest.length === 0) {
        return Effect.succeed(resultsOf(answered));
      }
      if (at === undefined) {
        return Effect.fail(engineUnavailable('The authorization engine named no snapshot to answer the rest at'));
      }
      return Effect.forEach(rest, (chunk) => answer(chunk, at), { concurrency: 1 }).pipe(
        Effect.map((others) => [answered, ...others].flatMap(resultsOf)),
      );
    }),
  );
};

/**
 * Adapts the Core SpiceDB RPC to the decision engine. It returns results in request order so the
 * engine can correlate each item with the exact cell that planned it. A transport failure and a
 * per-item engine error are UNAVAILABLE; only a conditional caveat answer is a fail-closed denial,
 * and the engine decides that per side (O46, O48b).
 */
export const makeSpiceDbDecisionCheckPort = (rpc: SpiceDbRpc): DecisionCheckPort => ({
  checkBulk: (items) => checkBulkInRequests(items, rpc.checkBulkPermissions),
});
