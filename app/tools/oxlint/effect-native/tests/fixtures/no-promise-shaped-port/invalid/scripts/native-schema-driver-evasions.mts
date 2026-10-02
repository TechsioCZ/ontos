// expect-count: 10
import { createRequire } from 'node:module';

import { Schema } from 'effect';

const requireNative = createRequire(import.meta.url);

// A different native export does not own a first-party Promise operation.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    ownedOperation: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
// A fake Schema namespace cannot prove an Effect codec boundary.
{
  type OwnedPort = () => Promise<void>;
  const Schema = {
    declare: <T,>(predicate: unknown) => predicate,
    Struct: (fields: unknown) => fields,
    decodeUnknownSync: (codec: unknown) => (value: unknown) => value,
  };
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
// Reassigning a native require alias destroys the original public-module provenance.
{
  type OwnedPort = () => Promise<void>;
  let driverRequire = requireNative;
  driverRequire = (name: string) => ({ name });
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(driverRequire('@modern-js/server-core/node'));
}
// A different module does not prove the native driver.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(requireNative('./owned-service.ts'));
}
// A local lookalike require function does not have Node module provenance.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  const requireNative = (name: string) => ({ name });
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
// A local first-party value is not a foreign module, even when its field name matches.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)({ createNodeServer: () => 1 });
}
// A mutable schema alias does not preserve its original native codec contract.
{
  type OwnedPort = () => Promise<void>;
  let codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  codec = Schema.Struct({});
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
// A declaration alone provides no evidence about the value eventually decoded.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  void codec;
}
// Other fields of a native module schema remain first-party types.
{
  type OwnedPort = () => Promise<void>;
  const codec = Schema.Struct({
    createNodeServer: Schema.Unknown,
    ownedOperation: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
// Even a correctly named factory from a shadowed createRequire is locally owned.
{
  type OwnedPort = () => Promise<void>;
  const createRequire = () => (name: string) => ({ name });
  const requireNative = createRequire();
  const codec = Schema.Struct({
    createNodeServer: Schema.declare<OwnedPort>((value): value is OwnedPort => typeof value === 'function'),
  });
  Schema.decodeUnknownSync(codec)(requireNative('@modern-js/server-core/node'));
}
