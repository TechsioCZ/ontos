import type { Server } from 'node:http';
import { createRequire as nativeRequire } from 'node:module';

import { Schema as S } from 'effect';

type NativeNodeServerFactory = (handler: (request: Request) => PromiseLike<Response>) => PromiseLike<Server>;
const factoryCodec = S.declare<NativeNodeServerFactory>((value): value is NativeNodeServerFactory =>
  typeof value === 'function',
);
const fields = { createNodeServer: factoryCodec };
const nativeCodec = S.Struct(fields);
const codecAlias = nativeCodec;
const workspaceRequire = nativeRequire(import.meta.url);
const driverRequire = nativeRequire(workspaceRequire.resolve('@modern-js/bff-effect'));
export const adapter = S.decodeUnknownEffect(codecAlias)(driverRequire('@modern-js/server-core/node'));

type DirectNodeServerFactory = (handler: (request: Request) => Promise<Response>) => Promise<Server>;
export const direct = S.decodeUnknownSync(
  S.Struct({
    createNodeServer: S.declare<DirectNodeServerFactory>((value): value is DirectNodeServerFactory =>
      typeof value === 'function',
    ),
  }),
)(driverRequire('@modern-js/server-core/node'));
