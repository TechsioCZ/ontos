import { openSpiceDbGrpcRpc } from './spicedb-grpc-rpc.ts';
import type { SpiceDbTransport } from './spicedb-rpc.ts';

/** Node reaches SpiceDB over gRPC (`SPICEDB_ENDPOINT` is the gRPC host:port). */
export const spiceDbTransport: SpiceDbTransport = Object.freeze<SpiceDbTransport>({ open: openSpiceDbGrpcRpc });
