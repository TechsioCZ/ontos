import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, FileSystem, Option, Schema } from 'effect';
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { TestConsole } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  connectPseudonymSeedClient,
  makePseudonymWriteCheckpoint,
  pseudonymCheckpointHttpClient,
  pseudonymSeedTarget,
} from './pseudonymize-akros-demo.mts';
import { DemoSeedError } from './seed-client.mts';
import { seedCheckpointDirectory } from './seed-checkpoint.mts';

const callerOwnedContent = 'caller-owned';
const callerKey = 'unpersisted-caller-key';
const testCredential = 'synthetic-credential';
const audience = 'commerce-market-catalog';
const route = '/commerce-market-catalog/actions/associate-storefront';
const ownerApi = '/shell-super-app-api/module-api/commerce-market-catalog/fixture/market-api';
const payload = '{"marketId":"reviewed-market"}';
const context = {
  compositionRevision: 'a'.repeat(64),
  principalId: '493dafec-c9b1-5a84-89cb-bee630de3c34',
};
const requestHash = (body = payload, owner = audience, action = route) =>
  createHash('sha256').update(`${owner}|${action}|${body}`).digest('hex');
const entrySchema = Schema.fromJsonString(
  Schema.Struct({
    idempotencyKey: Schema.toEncoded(Schema.String.pipe(Schema.brand('SeedIdempotencyKey'))),
    requestHash: Schema.String,
  }),
);
const request = (body = payload, url = `${pseudonymSeedTarget.shellUrl}${ownerApi}${route}`) =>
  HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeader('idempotency-key', callerKey),
    HttpClientRequest.setHeader('x-ontos-composition-revision', 'a'.repeat(64)),
    HttpClientRequest.bodyText(body, 'application/json'),
  );
const fixture = Effect.gen(function* checkpointFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({
    directory: yield* Config.option(Config.String('OWNED_TEMP_DIR')).pipe(Effect.map(Option.getOrUndefined)),
    prefix: 'p21-checkpoint-',
  });
  const journal = yield* makePseudonymWriteCheckpoint(fs, root);
  yield* journal.bindContext(context);
  const console = yield* TestConsole.make;
  const entryFile = path.join(journal.directory, 'writes', `${requestHash()}.json`);
  const readEntry = fs.readFileString(entryFile).pipe(Effect.flatMap(Schema.decodeUnknownEffect(entrySchema)));
  return { console, entryFile, fs, journal, readEntry, root };
});
const failsClosed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  );

it.effect('persists the native request identity before dispatch, with private modes, and reuses it after restart', () =>
  Effect.gen(function* nativeIdentity() {
    const { entryFile, fs, journal, readEntry, root } = yield* fixture;
    const key = yield* journal.checkpoint(audience, route, payload);
    expect(yield* readEntry).toEqual({ idempotencyKey: key, requestHash: requestHash() });
    expect(JSON.parse(yield* fs.readFileString(entryFile))).toEqual({
      idempotencyKey: key,
      requestHash: requestHash(),
    });
    for (const directory of [
      root,
      journal.directory,
      path.join(journal.directory, 'writes'),
      path.join(journal.directory, 'pending'),
    ]) {
      expect((yield* fs.stat(directory)).mode % 0o1000).toBe(0o700);
    }
    expect((yield* fs.stat(entryFile)).mode % 0o1000).toBe(0o600);
    const restarted = yield* makePseudonymWriteCheckpoint(fs, root);
    yield* restarted.bindContext(context);
    expect(yield* restarted.checkpoint(audience, route, payload)).toBe(key);
    expect(yield* fs.readDirectory(path.join(journal.directory, 'writes'))).toEqual([`${requestHash()}.json`]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'refuses changed pending payload, audience, action, caller or composition without creating another native key',
  () =>
    Effect.gen(function* mismatches() {
      const { fs, journal, readEntry, root } = yield* fixture;
      const key = yield* journal.checkpoint(audience, route, payload);
      for (const [owner, action, body] of [
        [audience, route, '{}'],
        ['merchandise', route, payload],
        [audience, '/other-action', payload],
      ]) {
        yield* failsClosed(journal.checkpoint(owner ?? '', action ?? '', body ?? ''));
      }
      for (const changed of [
        { ...context, compositionRevision: 'b'.repeat(64) },
        { ...context, principalId: '493dafec-c9b1-5a84-89cb-bee630de3c35' },
      ]) {
        const restarted = yield* makePseudonymWriteCheckpoint(fs, root);
        yield* restarted.bindContext(changed);
        yield* failsClosed(restarted.checkpoint(audience, route, payload));
      }
      expect((yield* readEntry).idempotencyKey).toBe(key);
      expect((yield* fs.readDirectory(path.join(journal.directory, 'writes'))).length).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses foreign scope and unbound context before creating a new scoped journal', () =>
  Effect.gen(function* foreignContext() {
    const { fs, journal, root } = yield* fixture;
    for (const target of [
      { ...pseudonymSeedTarget, tenantId: '70000000-0000-4000-8000-000000000099' },
      { ...pseudonymSeedTarget, legalEntityId: '71000000-0000-4000-8000-000000000099' },
      { ...pseudonymSeedTarget, shellUrl: 'https://foreign.example.test' },
    ]) {
      yield* failsClosed(makePseudonymWriteCheckpoint(fs, root, target));
      expect(yield* fs.exists(seedCheckpointDirectory(target, root))).toBe(false);
    }
    const unbound = yield* makePseudonymWriteCheckpoint(fs, root);
    yield* failsClosed(unbound.checkpoint(audience, route, payload));
    expect(yield* fs.exists(path.join(journal.directory, 'writes'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'makes one transport attempt, retains the failed lookup identity and uses the same key only on explicit restart',
  () =>
    Effect.gen(function* transportFailure() {
      const { console, fs, journal, readEntry, root } = yield* fixture;
      const keys: string[] = [];
      const http = HttpClient.make((outgoing) =>
        Effect.gen(function* loseResponse() {
          const saved = yield* readEntry.pipe(Effect.orDie);
          expect(outgoing.headers['idempotency-key']).toBe(saved.idempotencyKey);
          keys.push(saved.idempotencyKey);
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ cause: new Error('SECRET-CAUSE'), request: outgoing }),
          });
        }),
      );
      yield* failsClosed(
        pseudonymCheckpointHttpClient(http, journal)
          .execute(request())
          .pipe(Effect.provideService(Console.Console, console)),
      );
      expect(keys.length).toBe(1);
      const restarted = yield* makePseudonymWriteCheckpoint(fs, root);
      yield* restarted.bindContext(context);
      yield* failsClosed(
        pseudonymCheckpointHttpClient(http, restarted)
          .execute(request())
          .pipe(Effect.provideService(Console.Console, console)),
      );
      expect(keys.length).toBe(2);
      expect(new Set(keys).size).toBe(1);
      const output = JSON.stringify([yield* console.logLines, yield* console.errorLines]);
      expect(output).toContain('commerce.market-catalog.associate-storefront');
      expect(output).toContain(context.principalId);
      expect(output).toContain(context.compositionRevision);
      expect(output).toContain(requestHash());
      expect(output).toContain('transport-failed');
      expect(output).not.toContain('SECRET-CAUSE');
      expect(output).not.toContain(keys[0]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('records only safe HTTP failure identity and status, never response, payload, headers or key', () =>
  Effect.gen(function* safeFailure() {
    const { console, journal, readEntry } = yield* fixture;
    const http = HttpClient.make((outgoing) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(outgoing, Response.json({ secret: 'SECRET-RESPONSE' }, { status: 403 })),
      ),
    );
    const response = yield* pseudonymCheckpointHttpClient(http, journal)
      .execute(request('SECRET-PAYLOAD').pipe(HttpClientRequest.setHeader('authorization', 'SECRET-AUTH')))
      .pipe(Effect.provideService(Console.Console, console));
    expect(response.status).toBe(403);
    const output = JSON.stringify([yield* console.logLines, yield* console.errorLines]);
    expect(output).toContain('http-rejected');
    expect(output).toContain('403');
    for (const secret of ['SECRET-RESPONSE', 'SECRET-PAYLOAD', 'SECRET-AUTH', callerKey]) {
      expect(output).not.toContain(secret);
    }
    yield* failsClosed(readEntry);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('acknowledges only a successful exact pending request, retains native journals, permits the next write', () =>
  Effect.gen(function* successfulDispatch() {
    const { console, fs, journal, readEntry } = yield* fixture;
    const http = HttpClient.make((outgoing) =>
      Effect.succeed(HttpClientResponse.fromWeb(outgoing, Response.json({ ok: true }))),
    );
    const client = pseudonymCheckpointHttpClient(http, journal);
    yield* client.execute(request()).pipe(Effect.provideService(Console.Console, console));
    const key = (yield* readEntry).idempotencyKey;
    expect(yield* fs.readDirectory(path.join(journal.directory, 'pending'))).toEqual([]);
    yield* client.execute(request()).pipe(Effect.provideService(Console.Console, console));
    expect((yield* readEntry).idempotencyKey).toBe(key);
    yield* client.execute(request('{}')).pipe(Effect.provideService(Console.Console, console));
    expect((yield* fs.readDirectory(path.join(journal.directory, 'writes'))).length).toBe(2);
    yield* failsClosed(journal.acknowledge('../unowned'));
    expect((yield* readEntry).idempotencyKey).toBe(key);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'journals generated Shell managed-key dispatch and reuses the saved identity without outputting the returned secret',
  () =>
    Effect.gen(function* managedKey() {
      const { console, fs, journal, root } = yield* fixture;
      const keys: (string | undefined)[] = [];
      const http = HttpClient.make((outgoing) => {
        keys.push(outgoing.headers['idempotency-key']);
        return Effect.succeed(
          HttpClientResponse.fromWeb(outgoing, Response.json({ secret: 'SECRET-KEY' }, { status: 503 })),
        );
      });
      const outgoing = request(
        '{}',
        `${pseudonymSeedTarget.shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
      );
      yield* pseudonymCheckpointHttpClient(http, journal)
        .execute(outgoing)
        .pipe(Effect.provideService(Console.Console, console));
      expect(keys.length).toBe(1);
      const restarted = yield* makePseudonymWriteCheckpoint(fs, root);
      yield* restarted.bindContext(context);
      yield* pseudonymCheckpointHttpClient(http, restarted)
        .execute(outgoing)
        .pipe(Effect.provideService(Console.Console, console));
      expect(keys[1]).toBe(keys[0]);
      expect(keys[0]).not.toBe(callerKey);
      const output = JSON.stringify([yield* console.logLines, yield* console.errorLines]);
      expect(output).toContain('core.identity.bind-managed-api-key');
      expect(output).not.toContain('SECRET-KEY');
      expect(output).not.toContain(keys[0]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects unknown action, non-POST, foreign origin, credentials, query and fragment before transport', () =>
  Effect.gen(function* transportBounds() {
    const { journal } = yield* fixture;
    let attempts = 0;
    const http = HttpClient.make((outgoing) => {
      attempts += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(outgoing, Response.json({})));
    });
    const client = pseudonymCheckpointHttpClient(http, journal);
    for (const outgoing of [
      request('{}', `${pseudonymSeedTarget.shellUrl}/unknown`),
      request('{}', `https://foreign.example.test${ownerApi}${route}`),
      request('{}', `https://user:SECRET@ontos-stage.web-revolution.cz${ownerApi}${route}`),
      request().pipe(HttpClientRequest.setUrlParam('secret', 'SECRET')),
      request().pipe(HttpClientRequest.setHash('SECRET')),
      request().pipe(HttpClientRequest.setMethod('GET')),
      request().pipe(HttpClientRequest.setHeader('x-ontos-composition-revision', 'b'.repeat(64))),
    ]) {
      yield* failsClosed(client.execute(outgoing));
    }
    expect(attempts).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('a journal write failure prevents native dispatch and preserves caller-owned storage', () =>
  Effect.gen(function* cannotPersistIntent() {
    const { console, fs, journal } = yield* fixture;
    const blocked = path.join(journal.directory, 'writes');
    yield* fs.writeFileString(blocked, callerOwnedContent);
    let attempts = 0;
    const http = HttpClient.make((outgoing) => {
      attempts += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(outgoing, Response.json({})));
    });
    yield* failsClosed(
      pseudonymCheckpointHttpClient(http, journal)
        .execute(request())
        .pipe(Effect.provideService(Console.Console, console)),
    );
    expect(attempts).toBe(0);
    expect(yield* fs.readFileString(blocked)).toBe(callerOwnedContent);
    expect(JSON.stringify(yield* console.errorLines)).toContain('checkpoint-refused');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'an acknowledgement failure retains a potentially committed identity and never claims it was not dispatched',
  () =>
    Effect.gen(function* acknowledgementFailure() {
      const { console, fs, journal, readEntry } = yield* fixture;
      let attempts = 0;
      const http = HttpClient.make((outgoing) => {
        attempts += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(outgoing, Response.json({})));
      });
      const interruptedJournal = {
        ...journal,
        acknowledge: () => Effect.fail(new DemoSeedError({ reason: 'injected acknowledgement failure' })),
      };
      yield* failsClosed(
        pseudonymCheckpointHttpClient(http, interruptedJournal)
          .execute(request())
          .pipe(Effect.provideService(Console.Console, console)),
      );
      expect(attempts).toBe(1);
      expect((yield* readEntry).requestHash).toBe(requestHash());
      expect((yield* fs.readDirectory(path.join(journal.directory, 'pending'))).length).toBe(1);
      const output = JSON.stringify(yield* console.errorLines);
      expect(output).toContain('acknowledgement-failed');
      expect(output).toContain('200');
      expect(output).not.toContain('not dispatched');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('known write routes cannot skip the journal by omitting the caller idempotency header', () =>
  Effect.gen(function* missingCallerKey() {
    const { console, journal, readEntry } = yield* fixture;
    const http = HttpClient.make((outgoing) =>
      Effect.gen(function* persistedBeforeDispatch() {
        expect(outgoing.headers['idempotency-key']).toBe((yield* readEntry.pipe(Effect.orDie)).idempotencyKey);
        return HttpClientResponse.fromWeb(outgoing, Response.json({}));
      }),
    );
    yield* pseudonymCheckpointHttpClient(http, journal)
      .execute(request().pipe(HttpClientRequest.removeHeader('idempotency-key')))
      .pipe(Effect.provideService(Console.Console, console));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('fails closed on corrupt journal or unavailable storage without dispatch or replacement', () =>
  Effect.gen(function* storageFailure() {
    const { entryFile, fs, journal, root } = yield* fixture;
    yield* journal.checkpoint(audience, route, payload);
    yield* fs.writeFileString(entryFile, '{}');
    let attempts = 0;
    const http = HttpClient.make((outgoing) => {
      attempts += 1;
      return Effect.succeed(HttpClientResponse.fromWeb(outgoing, Response.json({})));
    });
    yield* failsClosed(pseudonymCheckpointHttpClient(http, journal).execute(request()));
    expect(yield* fs.readFileString(entryFile)).toBe('{}');
    expect(attempts).toBe(0);
    const blocked = path.join(root, 'regular-file');
    yield* fs.writeFileString(blocked, callerOwnedContent);
    expect(Schema.is(DemoSeedError)(yield* makePseudonymWriteCheckpoint(fs, blocked).pipe(Effect.flip))).toBe(true);
    expect(yield* fs.readFileString(blocked)).toBe(callerOwnedContent);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  'actual SeedClient persists its failed action key across explicit client recreation and signs out on each failure',
  () =>
    Effect.gen(function* actualSeedClient() {
      const { console, fs, journal, readEntry, root } = yield* fixture;
      let signOuts = 0;
      const keys: string[] = [];
      const http = HttpClient.make((outgoing, url) =>
        Effect.gen(function* fakeNativeTransport() {
          if (url.pathname.endsWith(route)) {
            const entry = yield* readEntry.pipe(Effect.orDie);
            expect(outgoing.headers['idempotency-key']).toBe(entry.idempotencyKey);
            keys.push(entry.idempotencyKey);
            return HttpClientResponse.fromWeb(outgoing, Response.json({ secret: 'SECRET-BODY' }, { status: 403 }));
          }
          if (url.pathname.endsWith('/sign-out')) {
            signOuts += 1;
          }
          if (url.pathname.endsWith('/session')) {
            return HttpClientResponse.fromWeb(
              outgoing,
              Response.json({ identity: pseudonymSeedTarget, state: 'authenticated' }),
            );
          }
          if (url.pathname.endsWith('/composition')) {
            return HttpClientResponse.fromWeb(
              outgoing,
              Response.json({ compositionRevision: context.compositionRevision, state: 'available' }),
            );
          }
          if (url.pathname.endsWith('/gateway-context')) {
            return HttpClientResponse.fromWeb(
              outgoing,
              Response.json({
                apiBaseUrl: ownerApi,
                compositionRevision: context.compositionRevision,
                token: 'SECRET-TOKEN',
              }),
            );
          }
          return HttpClientResponse.fromWeb(outgoing, Response.json({}));
        }),
      );
      const run = (checkpoint: typeof journal) =>
        Effect.gen(function* oneExplicitRun() {
          const client = yield* connectPseudonymSeedClient(checkpoint.checkpoint);
          yield* client.call(
            audience,
            route,
            Schema.Struct({ marketId: Schema.toEncoded(Schema.String.pipe(Schema.brand('MarketId'))) }),
            { marketId: 'reviewed-market' },
            Schema.Struct({}),
            true,
          );
        }).pipe(
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, pseudonymCheckpointHttpClient(http, checkpoint)),
          Effect.provideService(Console.Console, console),
        );
      yield* failsClosed(run(journal));
      expect(keys.length).toBe(1);
      const restarted = yield* makePseudonymWriteCheckpoint(fs, root);
      yield* restarted.bindContext(context);
      yield* failsClosed(run(restarted));
      expect(keys.length).toBe(2);
      expect(new Set(keys).size).toBe(1);
      expect(signOuts).toBe(2);
      const output = JSON.stringify([yield* console.logLines, yield* console.errorLines]);
      for (const secret of [testCredential, 'SECRET-TOKEN', 'SECRET-BODY', ...keys]) {
        expect(output).not.toContain(secret);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ONTOS_AGENT_SETUP_PASSWORD: testCredential }).pipe(
          ConfigProvider.orElse(ConfigProvider.fromEnv()),
        ),
      ),
    ),
);

it.effect(
  'scoped offline fixtures clean up on failure while the explicitly caller-owned persistent root survives',
  () =>
    Effect.gen(function* ownedCleanup() {
      const fs = yield* FileSystem.FileSystem;
      const callerRoot = yield* fs.makeTempDirectoryScoped({
        directory: yield* Config.option(Config.String('OWNED_TEMP_DIR')).pipe(Effect.map(Option.getOrUndefined)),
        prefix: 'p21-caller-',
      });
      let operationRoot = '';
      yield* Effect.gen(function* failAfterAllocation() {
        operationRoot = yield* fs.makeTempDirectoryScoped({ directory: callerRoot, prefix: 'owned-' });
        yield* makePseudonymWriteCheckpoint(fs, operationRoot);
        return yield* new DemoSeedError({ reason: 'injected offline failure' });
      }).pipe(Effect.scoped, failsClosed);
      expect(yield* fs.exists(operationRoot)).toBe(false);
      const journal = yield* makePseudonymWriteCheckpoint(fs, callerRoot);
      yield* journal.bindContext(context);
      yield* journal.checkpoint(audience, route, payload);
      expect(yield* fs.exists(path.join(journal.directory, 'writes', `${requestHash()}.json`))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
