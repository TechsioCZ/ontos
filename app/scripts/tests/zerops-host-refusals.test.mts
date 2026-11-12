import { createServer } from 'node:net';

import { Console, Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpServerRequest } from 'effect/http';
import { TestClock, TestConsole } from 'effect/testing';

import { hostApplication, hostControlApplication } from '../zerops/app-host.mts';
import { makeHostRefusalLog } from '../zerops/host-refusal-log.mts';

const decodeBoundAddress = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

/** A loopback port nothing listens on: bound once by the OS, then released. */
const closedPort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = Option.match(decodeBoundAddress(server.address()), { onNone: () => 0, onSome: (bound) => bound.port });
    server.close(() => resume(Effect.succeed(port)));
  });
});

const at = (url: string, method = 'GET') =>
  Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request(url, { method })));

/** A request from a process inside the container, as the composition readers are. */
const fromLoopback = (url: string) =>
  Effect.provideService(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request(url)).modify({ remoteAddress: Option.some('127.0.0.1') }),
  );

const SECRET_QUERY = '?api_token=never-logged&q=1';

it.effect('a relay to a unit that does not listen answers 502 and logs one WARN with its fields, never the query', () =>
  Effect.gen(function* refusedRelay() {
    const console = yield* TestConsole.make;
    const port = yield* closedPort;
    const published = yield* Ref.make(true);
    const app = hostApplication(new Map([['crm', port]]), published, Effect.succeed(Option.none()));
    const response = yield* app.pipe(
      at(`https://stage.test/_m/crm/crm-api/records${SECRET_QUERY}`),
      Effect.provideService(Console.Console, console),
    );
    expect(response.status).toBe(502);
    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatch(/^\[app-host\] WARN relay refused: /u);
    for (const field of [
      'cause=ECONNREFUSED',
      'method=GET',
      'path=/_m/crm/crm-api/records',
      'stage=request',
      'status=502',
      'unit=crm',
      `upstream=loopback:${String(port)}`,
    ]) {
      expect(line).toContain(field);
    }
    expect(line).toMatch(/elapsedMs=\d+/u);
    expect(line).not.toContain('never-logged');
    expect(line).not.toContain('?');
  }),
);

it.effect('a burst of 50 refusals writes one line at once and one summary after the window, not 50', () =>
  Effect.gen(function* burst() {
    const console = yield* TestConsole.make;
    const port = yield* closedPort;
    const published = yield* Ref.make(true);
    const refusals = makeHostRefusalLog();
    const app = hostApplication(new Map([['crm', port]]), published, Effect.succeed(Option.none()), refusals);
    for (let request = 0; request < 50; request += 1) {
      const response = yield* app.pipe(
        at('https://stage.test/_m/crm/x'),
        Effect.provideService(Console.Console, console),
      );
      expect(response.status).toBe(502);
    }
    expect((yield* console.errorLines).length).toBe(1);
    // The window has not passed: nothing to summarize yet.
    yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
    expect((yield* console.errorLines).length).toBe(1);
    yield* TestClock.adjust('10 seconds');
    yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('repeats=49');
    expect(lines[1]).toContain('windowSeconds=10');
    // Summarized counts are not written twice.
    yield* TestClock.adjust('10 seconds');
    yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
    expect((yield* console.errorLines).length).toBe(2);
  }),
);

it.effect('the host logs its own refusals: an unknown control path, a published host without a snapshot, no unit', () =>
  Effect.gen(function* hostRefusals() {
    const console = yield* TestConsole.make;
    const published = yield* Ref.make(false);
    const none = Effect.succeed(Option.none<string>());
    const control = hostControlApplication(published, none);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(Console.Console, console));

    expect((yield* run(control.pipe(at(`http://127.0.0.1/_host/other${SECRET_QUERY}`)))).status).toBe(404);
    // Before publication the composition source's 503 is the expected answer while the host starts.
    expect((yield* run(control.pipe(fromLoopback('http://127.0.0.1/_host/composition')))).status).toBe(503);
    yield* Ref.set(published, true);
    expect((yield* run(control.pipe(fromLoopback('http://127.0.0.1/_host/composition')))).status).toBe(503);
    const host = hostApplication(new Map(), published, none);
    expect((yield* run(host.pipe(at('https://stage.test/_m/uninstalled/remoteEntry.js')))).status).toBe(404);

    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('[app-host] WARN control port refused: method=GET path=/_host/other status=404');
    expect(lines[1]).toBe(
      '[app-host] WARN composition source unavailable: method=GET path=/_host/composition status=503 reason=no snapshot the authority admits',
    );
    expect(lines[2]).toBe(
      '[app-host] WARN no unit serves this path: method=GET path=/_m/uninstalled/remoteEntry.js status=404 unit=uninstalled',
    );
  }),
);
