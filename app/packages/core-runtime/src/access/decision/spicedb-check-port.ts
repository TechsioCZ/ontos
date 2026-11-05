import { v1 } from '@authzed/authzed-node';
import { Effect, Predicate } from 'effect';

import { objectTypeOf } from '../compiler/object-id.ts';
import { PROJECTION_SUBJECT_TYPES } from '../compiler/relationship.ts';
import { fullyConsistent } from '../../permissions/client.ts';
import type { SpiceDbRpc } from '../../permissions/spicedb-rpc.ts';
import { accessDecisionUnavailable } from './errors.ts';
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

/** One fully consistent `CheckBulkPermissions` request; every item sees the same snapshot. */
export const toCheckBulkRequest = (items: readonly AccessCheckItem[]): v1.CheckBulkPermissionsRequest =>
  v1.CheckBulkPermissionsRequest.create({
    consistency: fullyConsistent,
    items: items.map(toCheckItem),
  });

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
 * Adapts the Core SpiceDB RPC to the decision engine. It returns results in request order so the
 * engine can correlate each item with the exact cell that planned it. A transport failure and a
 * per-item engine error are UNAVAILABLE; only a conditional caveat answer is a fail-closed denial,
 * and the engine decides that per side (O46, O48b).
 */
export const makeSpiceDbDecisionCheckPort = (rpc: SpiceDbRpc): DecisionCheckPort => ({
  checkBulk: (items) =>
    rpc.checkBulkPermissions(toCheckBulkRequest(items)).pipe(
      Effect.mapError((cause) => accessDecisionUnavailable('The authorization engine did not answer', cause)),
      Effect.map((response): readonly AccessCheckResult[] =>
        response.pairs.map(({ response: itemResponse }) => ({
          permissionship: permissionshipOf(itemResponse),
        })),
      ),
    ),
});
