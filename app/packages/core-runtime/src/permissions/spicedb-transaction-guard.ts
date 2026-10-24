import { spiceDbTransport } from '#spicedb-transport';
import { Effect } from 'effect';

import { refuseInsideDatabaseTransaction } from '../db/transaction-io-guard.ts';
import type { SpiceDbConfigValue } from './config.ts';
import type { SpiceDbRpc } from './spicedb-rpc.ts';

const outsideTransaction =
  <Request, Response, Failure>(rpc: string, call: (request: Request) => Effect.Effect<Response, Failure>) =>
  (request: Request): Effect.Effect<Response, Failure> =>
    refuseInsideDatabaseTransaction('spicedb', rpc).pipe(Effect.andThen(Effect.suspend(() => call(request))));

/** Wraps every SpiceDB RPC so it dies instead of running inside a marked database transaction. */
export const guardSpiceDbRpc = (rpc: SpiceDbRpc): SpiceDbRpc =>
  Object.freeze({
    checkBulkPermissions: outsideTransaction('CheckBulkPermissions', rpc.checkBulkPermissions),
    checkPermission: outsideTransaction('CheckPermission', rpc.checkPermission),
    close: rpc.close,
    diffSchema: outsideTransaction('DiffSchema', rpc.diffSchema),
    readRelationships: outsideTransaction('ReadRelationships', rpc.readRelationships),
    readSchema: outsideTransaction('ReadSchema', rpc.readSchema),
    writeRelationships: outsideTransaction('WriteRelationships', rpc.writeRelationships),
    writeSchema: outsideTransaction('WriteSchema', rpc.writeSchema),
  });

/** The only way runtime code opens SpiceDB: the platform transport behind the transaction guard. */
export const openSpiceDbRpc = (configuration: SpiceDbConfigValue, timeoutMilliseconds: number): SpiceDbRpc =>
  guardSpiceDbRpc(spiceDbTransport.open(configuration, timeoutMilliseconds));
