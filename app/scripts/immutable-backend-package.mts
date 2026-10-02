import { createHash } from 'node:crypto';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';

export interface ImmutableBackendModule {
  readonly bytes: Uint8Array;
  readonly path: string;
}

export class ImmutableBackendPackageError extends Schema.TaggedError<ImmutableBackendPackageError>()(
  'ImmutableBackendPackageError',
  { message: Schema.String },
) {}

const fail = (message: string) => new ImmutableBackendPackageError({ message });
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const comparePaths = Order.make<ImmutableBackendModule>((left, right) => {
  if (left.path < right.path) {
    return -1;
  }
  return left.path > right.path ? 1 : 0;
});
const InventoryDocument = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String, size: Schema.Number })),
);

/** Identifies uploaded modules, rather than the pre-Wrangler build directory. */
export const immutableBackendModuleInventorySha256 = Effect.fn('ImmutableBackendPackage.inventorySha256')(
  function* inventorySha256(modules: readonly ImmutableBackendModule[]) {
    const document = yield* Schema.encodeEffect(InventoryDocument)(
      EffectArray.map(EffectArray.sort(modules, comparePaths), (module) => ({
        path: module.path,
        sha256: sha256(module.bytes),
        size: module.bytes.byteLength,
      })),
    ).pipe(Effect.mapError(() => fail('the Worker module inventory could not be encoded')));
    return sha256(document);
  },
);

/** The provider's native /content multipart response must reproduce the complete captured upload package. */
export const verifyImmutableBackendModuleContent = Effect.fn('ImmutableBackendPackage.verifyContent')(
  function* verifyContent(expected: readonly ImmutableBackendModule[], content: FormData) {
    if (expected.length === 0) {
      return yield* fail('the immutable Worker upload package is empty');
    }
    const modules = new Map<string, ImmutableBackendModule>();
    for (const module of expected) {
      if (
        module.path === 'metadata' ||
        !/^[\w.@-]+(?:\/[\w.@-]+)*$/u.test(module.path) ||
        module.path.split('/').some((part) => part === '.' || part === '..') ||
        modules.has(module.path)
      ) {
        return yield* fail('the immutable Worker upload package has an unsafe or duplicate module path');
      }
      modules.set(module.path, module);
    }
    const seen = new Set<string>();
    let metadataSeen = false;
    for (const [name, value] of content.entries()) {
      if (name === 'metadata' && Schema.is(Schema.String)(value)) {
        if (metadataSeen) {
          return yield* fail('the provider returned duplicate Worker metadata');
        }
        metadataSeen = true;
        continue;
      }
      const module = modules.get(name);
      if (module === undefined || seen.has(name) || !Schema.is(Schema.instanceOf(File))(value) || value.name !== name) {
        return yield* fail('the provider returned an unexpected, duplicate or incorrectly named Worker module');
      }
      const bytes = yield* Effect.tryPromise({
        catch: () => fail('the provider Worker module bytes could not be read'),
        try: async () => new Uint8Array(await value.arrayBuffer()),
      });
      if (bytes.byteLength !== module.bytes.byteLength || sha256(bytes) !== sha256(module.bytes)) {
        return yield* fail('the provider Worker module bytes differ from the captured upload package');
      }
      seen.add(name);
    }
    if (seen.size !== modules.size) {
      return yield* fail('the provider returned an incomplete Worker module inventory');
    }
    return yield* immutableBackendModuleInventorySha256(expected);
  },
);
