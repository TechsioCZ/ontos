import { Effect, FileSystem, Path, PlatformError, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { NativeStartupReceiptSchema, withNativeStartupReceipt } from '../support/native-startup-receipt.ts';

const privateText = 'password=fake-password token=fake-token https://fake-user:fake-secret@example.invalid/private';
const memoryFilesystem = (files: Map<string, string>) =>
  FileSystem.layerNoop({
    makeDirectory: () => Effect.void,
    writeFileString: (path, contents) =>
      Effect.sync(() => {
        files.set(path, contents);
      }),
  });

const onlyReceipt = (files: Map<string, string>) =>
  Effect.gen(function* decodeOnlyReceipt() {
    expect(files.size).toBe(1);
    const entry = files.entries().next().value;
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return yield* Effect.die('Missing closed startup receipt');
    }
    const [path, encoded] = entry;
    expect(path).toMatch(/\/\.cache\/native-owner-startup\/startup-diagnostic-[\da-f-]{36}\.json$/u);
    expect(encoded).not.toContain('fake-');
    expect(encoded).not.toContain('https://');
    expect(encoded.length).toBeLessThan(256);
    return yield* Schema.decodeEffect(Schema.fromJsonString(NativeStartupReceiptSchema))(encoded);
  });

for (const launch of ['packaged', 'compiled'] as const) {
  const identity = { appId: 'shell-super-app', launch } as const;

  it.effect(`${launch}: failed spawn persists a closed receipt and the original failure past scope teardown`, () =>
    Effect.gen(function* failedSpawn() {
      const files = new Map<string, string>();
      const failure = new PlatformError.PlatformError(
        new PlatformError.SystemError({
          _tag: 'NotFound',
          description: privateText,
          method: 'spawn',
          module: 'ChildProcess',
          pathOrDescriptor: privateText,
        }),
      );
      const result = yield* Effect.scoped(
        withNativeStartupReceipt(identity, (startup) => {
          startup.phase('spawn');
          return Effect.fail(failure);
        }).pipe(Effect.provide(memoryFilesystem(files)), Effect.provide(Path.layer), Effect.flip),
      );
      expect(result).toBe(failure);
      expect(yield* onlyReceipt(files)).toEqual({
        ...identity,
        classification: 'SPAWN_NOT_FOUND',
        exitStatus: 'UNKNOWN',
        phase: 'spawn',
      });
    }),
  );

  it.effect(`${launch}: early exit keeps only the observed closed federation signature and exit status`, () =>
    Effect.gen(function* earlyExit() {
      const files = new Map<string, string>();
      const failure = new Error(privateText);
      const result = yield* withNativeStartupReceipt(identity, (startup) =>
        Effect.gen(function* observeEarlyExit() {
          startup.phase('ready_address');
          startup.line(privateText);
          startup.line(
            `[ Federation Runtime ]: Version 1.170.46 of shared singleton module @tanstack/react-router does not satisfy the requirement of ${privateText}`,
          );
          startup.exited(1);
          return yield* Effect.fail(failure);
        }),
      ).pipe(Effect.provide(memoryFilesystem(files)), Effect.provide(Path.layer), Effect.flip);
      expect(result).toBe(failure);
      expect(yield* onlyReceipt(files)).toEqual({
        ...identity,
        classification: 'FEDERATION_SHARED_VERSION',
        exitStatus: 1,
        phase: 'ready_address',
      });
    }),
  );

  it.effect(`${launch}: readiness failure remains UNKNOWN for unrecognized credential-bearing output`, () =>
    Effect.gen(function* unknownReadiness() {
      const files = new Map<string, string>();
      const failure = new Error(privateText);
      const result = yield* withNativeStartupReceipt(identity, (startup) =>
        Effect.gen(function* observeUnknownReadiness() {
          startup.phase('contract');
          startup.line(`${privateText} TypeError: arbitrary message`);
          startup.line(`[ Federation Runtime ]: ${privateText}`);
          startup.exited(Number.NaN);
          return yield* Effect.fail(failure);
        }),
      ).pipe(Effect.provide(memoryFilesystem(files)), Effect.provide(Path.layer), Effect.flip);
      expect(result).toBe(failure);
      expect(yield* onlyReceipt(files)).toEqual({
        ...identity,
        classification: 'UNKNOWN',
        exitStatus: 'UNKNOWN',
        phase: 'contract',
      });
    }),
  );

  it.effect(`${launch}: diagnostic write failure never replaces the original startup failure`, () =>
    Effect.gen(function* unavailableReceiptStorage() {
      const failure = new Error(privateText);
      const result = yield* withNativeStartupReceipt(identity, () => Effect.fail(failure)).pipe(
        Effect.provide(FileSystem.layerNoop({ makeDirectory: () => Effect.void })),
        Effect.provide(Path.layer),
        Effect.flip,
      );
      expect(result).toBe(failure);
    }),
  );

  it.effect(`${launch}: syntax and module errors retain no raw error detail`, () =>
    Effect.gen(function* recognizedNativeSignatures() {
      for (const [line, classification] of [
        [`SyntaxError: Cannot use 'import.meta' outside a module ${privateText}`, 'IMPORT_META_SYNTAX'],
        [`Error [ERR_MODULE_NOT_FOUND]: Cannot find package ${privateText}`, 'MODULE_NOT_FOUND'],
        [`Error: Cannot find module ${privateText}`, 'MODULE_NOT_FOUND'],
      ] as const) {
        const files = new Map<string, string>();
        const failure = new Error(privateText);
        const result = yield* withNativeStartupReceipt(identity, (startup) => {
          startup.phase('ready_address');
          startup.line(line);
          startup.exited(1);
          return Effect.fail(failure);
        }).pipe(Effect.provide(memoryFilesystem(files)), Effect.provide(Path.layer), Effect.flip);
        expect(result).toBe(failure);
        expect(yield* onlyReceipt(files)).toEqual({
          ...identity,
          classification,
          exitStatus: 1,
          phase: 'ready_address',
        });
      }
    }),
  );

  it.effect(`${launch}: successful startup writes no failure artifact`, () =>
    Effect.gen(function* successfulStartup() {
      const files = new Map<string, string>();
      const result = yield* withNativeStartupReceipt(identity, () => Effect.succeed(42)).pipe(
        Effect.provide(memoryFilesystem(files)),
        Effect.provide(Path.layer),
      );
      expect(result).toBe(42);
      expect(files.size).toBe(0);
    }),
  );
}
