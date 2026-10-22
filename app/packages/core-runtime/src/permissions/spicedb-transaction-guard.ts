import { spiceDbTransport } from '#spicedb-transport';
import { Context, Data, Effect, Option } from 'effect';

import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

/**
 * The governed operation whose database transaction is open on this fiber. A SpiceDB round trip under
 * it would hold a pooled connection idle in transaction for the whole network wait, so the SpiceDB
 * transport refuses to run while it is set.
 */
export const OpenDatabaseTransaction = Context.Reference<Option.Option<string>>(
  '@app/core-runtime/permissions/spicedb-transaction-guard/OpenDatabaseTransaction',
  { defaultValue: Option.none },
);

/** Marks `effect` as running inside the named operation's database transaction. */
export const insideDatabaseTransaction =
  (operationKey: string) =>
  <Value, Failure, Requirements>(
    effect: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, Failure, Requirements> =>
    Effect.updateService(effect, OpenDatabaseTransaction, () => Option.some(operationKey));

/** A defect: owner code reached SpiceDB between BEGIN and COMMIT. It is a programming error, never a denial. */
export class SpiceDbInsideTransaction extends Data.TaggedError('SpiceDbInsideTransaction')<{
  readonly operationKey: string;
  readonly rpc: string;
}> {
  override get message(): string {
    return `SpiceDB ${this.rpc} ran inside the database transaction of ${this.operationKey}. Call SpiceDB in the owner prepare or finish step, never in load.`;
  }
}

const outsideTransaction =
  <Request, Response, Failure>(rpc: string, call: (request: Request) => Effect.Effect<Response, Failure>) =>
  (request: Request): Effect.Effect<Response, Failure> =>
    Effect.flatMap(Effect.service(OpenDatabaseTransaction), (operationKey) =>
      Option.isNone(operationKey)
        ? call(request)
        : Effect.die(new SpiceDbInsideTransaction({ operationKey: operationKey.value, rpc })),
    );

/** Wraps every SpiceDB RPC so it dies instead of running inside a marked database transaction. */
export const guardSpiceDbRpc = (rpc: SpiceDbRpc): SpiceDbRpc =>
  Object.freeze({
    checkBulkPermissions: outsideTransaction('CheckBulkPermissions', rpc.checkBulkPermissions),
    checkPermission: outsideTransaction('CheckPermission', rpc.checkPermission),
    close: rpc.close,
    readRelationships: outsideTransaction('ReadRelationships', rpc.readRelationships),
    writeRelationships: outsideTransaction('WriteRelationships', rpc.writeRelationships),
    writeSchema: outsideTransaction('WriteSchema', rpc.writeSchema),
  });

/** The only way runtime code opens SpiceDB: the platform transport behind the transaction guard. */
export const openSpiceDbRpc = (configuration: SpiceDbConfigValue, timeoutMilliseconds: number): SpiceDbRpc =>
  guardSpiceDbRpc(spiceDbTransport.open(configuration, timeoutMilliseconds));
