import { createServer } from 'node:net';

import { Console, Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { HttpServerRequest } from 'effect/http';
import { TestClock, TestConsole } from 'effect/testing';

import { hostApplication, hostControlApplication } from '../zerops/app-host.mts';
import { loggableRoute, makeHostRefusalLog } from '../zerops/host-refusal-log.mts';

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
      'route=/_m/crm/crm-api/records',
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

it.effect('the host logs its own refusals: an unknown control path and a published host without a snapshot', () =>
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

    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('[app-host] WARN control port refused: method=GET route=/_host/other status=404');
    expect(lines[1]).toBe(
      '[app-host] WARN composition source unavailable: method=GET route=/_host/composition status=503 reason=no snapshot the authority admits',
    );
  }),
);

it.effect(
  'refusals any client can cause write no line of their own: 1,000 of them become one count line in 10 minutes',
  () =>
    Effect.gen(function* clientCaused() {
      const console = yield* TestConsole.make;
      const published = yield* Ref.make(true);
      const refusals = makeHostRefusalLog();
      const host = hostApplication(new Map(), published, Effect.succeed(Option.none<string>()), refusals);
      for (let request = 0; request < 1000; request += 1) {
        const response = yield* host.pipe(at(`https://stage.test/_m/probe-${String(request)}/remoteEntry.js`));
        expect(response.status).toBe(404);
      }
      yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
      expect(yield* console.errorLines).toEqual([]);
      yield* TestClock.adjust('10 minutes');
      yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
      expect((yield* console.errorLines).map(String)).toEqual([
        '[app-host] WARN client-caused refusals in the last 600s: unroutedModulePath=1000',
      ]);
      yield* TestClock.adjust('10 minutes');
      yield* refusals.flush.pipe(Effect.provideService(Console.Console, console));
      expect((yield* console.errorLines).length).toBe(1);
    }),
);

describe('loggableRoute', () => {
  // Every route of the repository that carries a secret in its path, and the forms a client can send.
  const RESET_TOKEN = 'Q7mXk2vN9pLr4TzA8bWcE1sY';
  it.each([
    // Customer Context password reset link: the token is the fourth segment.
    [
      `/_m/commerce-customer-context/api/portal-auth/reset-password/${RESET_TOKEN}`,
      '/_m/commerce-customer-context/api/portal-auth/:x/:x',
    ],
    [`/api/portal-auth/reset-password/${RESET_TOKEN}`, '/api/portal-auth/:x/:x'],
    // Enrollment claims carry the attempt id.
    [
      '/_m/commerce-customer-context/api/portal-auth/enrollment/9f0c2a1e-3b4d-4e5f-8a6b-7c8d9e0f1a2b/claim-invitation',
      '/_m/commerce-customer-context/api/portal-auth/:x/:x/:x',
    ],
    // OAuth callbacks and verification links carry their codes in the query, which is never logged.
    ['/shell-super-app-api/oauth/callback?code=SECRETCODE123&state=abc', '/shell-super-app-api/oauth/:x'],
    [
      '/_m/commerce-customer-context/api/portal-auth/verify-email?token=SECRET',
      '/_m/commerce-customer-context/api/portal-auth/:x',
    ],
    // A short secret, hex digests and UUIDs in the first segments.
    ['/invite/Zx9QpL2mR7tK', '/invite/:x'],
    ['/d41d8cd98f00b204e9800998ecf8427e/download', '/:x/download'],
    ['/_m/9f0c2a1e-3b4d-4e5f-8a6b-7c8d9e0f1a2b/x', '/_m/:x/x'],
    ['/files/report%20secret.pdf', '/files/:x'],
    // An absolute-form target: scheme, host and `user:pass@` are never logged.
    ['http://user:hunter2@evil.example/_m/crm/crm-api/records?x=1', '/_m/crm/crm-api/records'],
    // Plain routes keep their first two segments.
    ['/cs/crm/klienti', '/cs/crm/:x'],
    ['/shell-super-app-api/auth/api-key/gateway-read', '/shell-super-app-api/auth/:x/:x'],
  ])('%s logs as %s', (target, expected) => {
    expect(loggableRoute(target)).toBe(expected);
  });

  it('caps a logged route at 200 characters', () => {
    expect(loggableRoute(`/${'a'.repeat(20)}`.repeat(30)).length).toBeLessThanOrEqual(201);
  });
});

it.effect('a refused password-reset link never puts its token into the log', () =>
  Effect.gen(function* resetLink() {
    const console = yield* TestConsole.make;
    const port = yield* closedPort;
    const published = yield* Ref.make(true);
    const app = hostApplication(
      new Map([['commerce-customer-context', port]]),
      published,
      Effect.succeed(Option.none()),
    );
    const token = 'Q7mXk2vN9pLr4TzA8bWcE1sY';
    const response = yield* app.pipe(
      at(`https://stage.test/_m/commerce-customer-context/api/portal-auth/reset-password/${token}`),
      Effect.provideService(Console.Console, console),
    );
    expect(response.status).toBe(502);
    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('route=/_m/commerce-customer-context/api/portal-auth/:x/:x');
    expect(lines.join('\n')).not.toContain(token);
  }),
);
