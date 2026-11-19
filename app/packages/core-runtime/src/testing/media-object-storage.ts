/**
 * TEST DOUBLE. Everything in this file is an in-memory stand-in for the Core Media `ObjectStorage` port and a
 * fault injector around it. It is never storage proof, never wired into a production composition and not
 * exported from the package barrel; a real provider path must be proven by its own integration test.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { Effect, Option, Ref, Schema, Stream } from 'effect';
import { Hex } from 'effect/encoding';

import {
  ObjectStorage,
  ObjectStorageChecksumMismatch,
  ObjectStorageChecksumUnsupported,
  ObjectStorageObjectMissing,
} from '../media/object-storage.ts';
import type { ObjectStat, ObjectStorageFailure, ObjectStorageService } from '../media/object-storage.ts';
import type { MediaStorageKey } from '../media/storage-key.ts';

const ObjectStorageOperationSchema = Schema.Literals(['get', 'put', 'stat']);
export type ObjectStorageOperation = typeof ObjectStorageOperationSchema.Type;

export interface ObjectStorageCall {
  readonly key: MediaStorageKey;
  readonly operation: ObjectStorageOperation;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly versionRef: string | undefined;
}

export interface InMemoryObjectStorageOptions {
  /** Whether the double verifies a requested SHA-256 itself (a provider that attests) or refuses it. Default: refuses. */
  readonly attestsSha256?: boolean;
  /** Whether each stored object gets a technical `v<n>` version reference. Default: none. */
  readonly versionRefs?: boolean;
}

export interface InMemoryObjectStorage {
  /** Every call that reached the double, in order: the spy for "zero provider calls" assertions. */
  readonly calls: Effect.Effect<readonly ObjectStorageCall[]>;
  readonly peek: (key: MediaStorageKey) => Effect.Effect<Option.Option<Uint8Array>>;
  readonly service: ObjectStorageService;
}

const concatenate = (chunks: readonly Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const statOf = (stored: StoredObject): ObjectStat =>
  stored.versionRef === undefined
    ? { byteSize: stored.bytes.byteLength }
    : { byteSize: stored.bytes.byteLength, versionRef: stored.versionRef };

const missing = () =>
  new ObjectStorageObjectMissing({ code: 'object_storage_object_missing', reason: 'Object not found' });

const nextVersionRef = (versionRefs: boolean, stored: ReadonlyMap<string, StoredObject>) =>
  versionRefs ? `v${stored.size + 1}` : undefined;

/** Deterministic in-memory implementation of the port. A failed body stores nothing. */
export const makeInMemoryObjectStorage = Effect.fn('MediaObjectStorageDouble.makeInMemory')(
  function* makeInMemoryObjectStorage(options: InMemoryObjectStorageOptions = {}) {
    const objects = yield* Ref.make<ReadonlyMap<string, StoredObject>>(new Map());
    const callLog = yield* Ref.make<readonly ObjectStorageCall[]>([]);
    const record = (operation: ObjectStorageOperation, key: MediaStorageKey) =>
      Ref.update(callLog, (calls) => [...calls, { key, operation }]);
    const find = (key: MediaStorageKey) =>
      Ref.get(objects).pipe(
        Effect.flatMap((all) => {
          const stored = all.get(key);
          return stored === undefined ? Effect.fail(missing()) : Effect.succeed(stored);
        }),
      );
    const store = (key: MediaStorageKey, contentType: string, bytes: Uint8Array) =>
      Ref.modify(objects, (all) => {
        const next: StoredObject = {
          bytes,
          contentType,
          versionRef: nextVersionRef(options.versionRefs ?? false, all),
        };
        return [next, new Map(all).set(key, next)] as const;
      });

    const put: ObjectStorageService['put'] = Effect.fn('MediaObjectStorageDouble.put')(function* put(request) {
      yield* record('put', request.key);
      if (request.expectedSha256 !== undefined && options.attestsSha256 !== true) {
        return yield* new ObjectStorageChecksumUnsupported({
          code: 'object_storage_checksum_unsupported',
          reason: 'The provider cannot verify a SHA-256',
        });
      }
      const bytes = concatenate(yield* Stream.runCollect(request.body));
      if (request.expectedSha256 !== undefined && Hex.encode(sha256(bytes)) !== request.expectedSha256) {
        return yield* new ObjectStorageChecksumMismatch({
          code: 'object_storage_checksum_mismatch',
          reason: 'The stored bytes do not match the requested digest',
        });
      }
      return statOf(yield* store(request.key, request.contentType, bytes));
    });

    const service: ObjectStorageService = {
      get: (key) =>
        record('get', key).pipe(
          Effect.andThen(find(key)),
          Effect.map((stored) => ({ body: Stream.make(stored.bytes), stat: statOf(stored) })),
        ),
      put,
      stat: (key) => record('stat', key).pipe(Effect.andThen(find(key)), Effect.map(statOf)),
    };
    const inMemory: InMemoryObjectStorage = {
      calls: Ref.get(callLog),
      peek: (key) =>
        Ref.get(objects).pipe(
          Effect.map((all) => Option.map(Option.fromUndefinedOr(all.get(key)), ({ bytes }) => bytes)),
        ),
      service,
    };
    return inMemory;
  },
);

/**
 * One controlled fault. `before` fails the call without reaching the inner storage; `after` lets the inner call
 * complete and then fails it, which is the uncertain outcome (stored, but the caller was told it failed).
 */
export interface ObjectStorageFaultRule {
  readonly failure: ObjectStorageFailure;
  readonly operation: ObjectStorageOperation;
  /** Number of calls to fail before the rule is spent. Default: every call. */
  readonly times?: number;
  readonly when?: 'after' | 'before';
}

const ruleApplies = (
  rule: ObjectStorageFaultRule,
  spent: number,
  operation: ObjectStorageOperation,
  when: 'after' | 'before',
) =>
  rule.operation === operation && (rule.when ?? 'before') === when && (rule.times === undefined || spent < rule.times);

const claimFault = (
  rules: readonly ObjectStorageFaultRule[],
  spent: Ref.Ref<readonly number[]>,
  operation: ObjectStorageOperation,
  when: 'after' | 'before',
) =>
  Ref.modify(spent, (counts) => {
    const index = rules.findIndex((rule, position) => ruleApplies(rule, counts[position] ?? 0, operation, when));
    const rule = rules[index];
    return rule === undefined
      ? ([Option.none<ObjectStorageFailure>(), counts] as const)
      : ([
          Option.some(rule.failure),
          counts.map((count, position) => (position === index ? count + 1 : count)),
        ] as const);
  });

/**
 * The port from context, wrapped with controlled fault injection. Every injected failure is a labelled test
 * fault, not an incident.
 */
export const withObjectStorageFaults = Effect.fn('MediaObjectStorageDouble.withFaults')(
  function* withObjectStorageFaults(rules: readonly ObjectStorageFaultRule[]) {
    const inner = yield* ObjectStorage;
    const spent = yield* Ref.make<readonly number[]>(rules.map(() => 0));
    const inject = Effect.fn('MediaObjectStorageDouble.inject')(function* inject<A, E>(
      operation: ObjectStorageOperation,
      call: Effect.Effect<A, E>,
    ) {
      const before = yield* claimFault(rules, spent, operation, 'before');
      if (Option.isSome(before)) {
        return yield* before.value;
      }
      const result = yield* call;
      const after = yield* claimFault(rules, spent, operation, 'after');
      return Option.isSome(after) ? yield* after.value : result;
    });
    const faulty: ObjectStorageService = {
      get: (key) => inject('get', inner.get(key)),
      put: (request) => inject('put', inner.put(request)),
      stat: (key) => inject('stat', inner.stat(key)),
    };
    return faulty;
  },
);
