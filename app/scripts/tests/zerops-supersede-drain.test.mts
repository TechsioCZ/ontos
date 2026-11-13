import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  Clock,
  Console,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestClock, TestConsole } from 'effect/testing';

import { hostApplication } from '../zerops/app-host.mts';
import { workspaceRoot } from '../zerops/hosted-units.mts';
import { makeHostRefusalLog } from '../zerops/host-refusal-log.mts';
import {
  APP_SERVICE_HOSTNAME,
  containerBoot,
  DRAIN_FORWARDED_HEADER,
  DRAIN_REFUSED_HEADER,
  drainSupersededHost,
  makeSupersedeDrain,
  platformDrainPeers,
  publicationAllowed,
  renewWhileHolding,
  restartMayPublish,
} from '../zerops/supersede-drain.mts';
import type { DrainPeer, SupersedeDrain } from '../zerops/supersede-drain.mts';

/**
 * Two real hosts on loopback, each the real `hostApplication` on its own socket with its own `crm` unit, so a
 * superseded host relays over real HTTP exactly as on the platform; the platform's DNS answer is the injected peer.
 */

const EchoSchema = Schema.Struct({
  bytes: Schema.Number,
  hop: Schema.Boolean,
  host: Schema.String,
  marker: Schema.Boolean,
  path: Schema.String,
  release: Schema.String,
});
const decodeEcho = Schema.decodeUnknownOption(Schema.fromJsonString(EchoSchema));
const ECHO = '/_m/crm/echo';
const UPLOAD = '/_m/crm/upload';

/** A unit that names its release: `/echo` and `/upload` answer JSON, `/events` streams until the client goes. */
const unitApplication = (release: string, seen: Ref.Ref<number>) =>
  Effect.gen(function* unit() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    yield* Ref.update(seen, (count) => count + 1);
    const pathname = request.url.split('?')[0] ?? '';
    if (pathname === '/slow') {
      yield* Effect.sleep('1500 millis');
    }
    if (pathname === '/events') {
      return HttpServerResponse.stream(
        Stream.tick('50 millis').pipe(Stream.map((): Uint8Array => new TextEncoder().encode(`data: ${release}\n\n`))),
        { contentType: 'text/event-stream' },
      );
    }
    if (pathname === '/signals') {
      // A unit that sets the host's own drain headers, by mistake or on purpose.
      return HttpServerResponse.text(release).pipe(
        HttpServerResponse.setHeader(DRAIN_REFUSED_HEADER, 'draining'),
        HttpServerResponse.setHeader(DRAIN_FORWARDED_HEADER, '1'),
      );
    }
    const body = request.method === 'POST' ? yield* request.arrayBuffer.pipe(Effect.orDie) : new ArrayBuffer(0);
    return HttpServerResponse.text(
      JSON.stringify({
        bytes: body.byteLength,
        hop: request.headers['x-hop-secret'] !== undefined || request.headers['proxy-authorization'] !== undefined,
        host: request.headers.host ?? '',
        marker: request.headers[DRAIN_FORWARDED_HEADER] !== undefined,
        path: request.url,
        release,
      }),
      { contentType: 'application/json' },
    );
  });

/** Serves `app` on a fresh loopback port within `scope`; closing the scope closes the port. */
const serveOn = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>, scope: Scope.Scope) =>
  Effect.gen(function* serve() {
    const server = Context.get(yield* Layer.buildWithScope(NodeHttpServer.layerTest, scope), HttpServer.HttpServer);
    yield* server.serve(app).pipe(Scope.provide(scope));
    return NetAddress.isUnixPathAddress(server.address) ? 0 : server.address.port;
  });

interface Answer {
  readonly body: string;
  readonly error?: string;
  readonly headers: IncomingHttpHeaders;
  readonly status: number;
}

/** One request on a fresh connection, as the balancer opens them; a refused connection is an answer too. */
const send = (
  port: number,
  pathname: string,
  options: { body?: Uint8Array; expectContinue?: boolean; headers?: Record<string, string>; method?: string } = {},
) =>
  Effect.callback<Answer>((resume) => {
    const request = httpRequest(
      {
        agent: false,
        headers: options.expectContinue === true ? { ...options.headers, expect: '100-continue' } : options.headers,
        host: '127.0.0.1',
        method: options.method ?? 'GET',
        path: pathname,
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () =>
          resume(
            Effect.succeed({
              body: Buffer.concat(chunks).toString('utf-8'),
              headers: response.headers,
              status: response.statusCode ?? 0,
            }),
          ),
        );
        response.on('error', (error) =>
          resume(Effect.succeed({ body: '', error: error.message, headers: {}, status: 0 })),
        );
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) =>
      resume(Effect.succeed({ body: '', error: error.code ?? error.message, headers: {}, status: 0 })),
    );
    if (options.expectContinue === true) {
      // As curl does above 1 MiB: the body follows only once the server said 100 Continue.
      request.on('continue', () => {
        request.end(options.body);
      });
    } else {
      request.end(options.body);
    }
  });

const releaseOf = (answer: Answer) =>
  Option.match(decodeEcho(answer.body), {
    onNone: () => `status ${String(answer.status)}`,
    onSome: (echo) => echo.release,
  });

/** Two hosts: `old` (to be superseded) and `new`, each with its own unit and request counter. */
const twoHosts = (console?: TestConsole.TestConsole) =>
  Effect.gen(function* startTwoHosts() {
    const scope = yield* Effect.scope;
    const oldPublic = yield* Scope.fork(scope, 'sequential');
    const oldUnitSeen = yield* Ref.make(0);
    const newUnitSeen = yield* Ref.make(0);
    const oldUnit = yield* serveOn(unitApplication('old', oldUnitSeen), scope);
    const newUnit = yield* serveOn(unitApplication('new', newUnitSeen), scope);
    const published = yield* Ref.make(true);
    const none = Effect.succeed(Option.none<string>());
    const drain = makeSupersedeDrain();
    const oldHost = hostApplication(new Map([['crm', oldUnit]]), published, none, makeHostRefusalLog(), drain);
    const newHost = hostApplication(new Map([['crm', newUnit]]), published, none);
    const oldPort = yield* serveOn(
      console === undefined ? oldHost : oldHost.pipe(Effect.provideService(Console.Console, console)),
      oldPublic,
    );
    const newPort = yield* serveOn(newHost, scope);
    const supersede = (
      peers: readonly DrainPeer[] = [{ address: '127.0.0.1', port: newPort }],
      duration = Duration.millis(800),
    ) =>
      drainSupersededHost({
        drain,
        duration,
        peers: Effect.succeed(peers),
        publicPort: oldPort,
        revision: 'new-revision',
        stopAccepting: Scope.close(oldPublic, Exit.void),
      });
    return { drain, newPort, newUnitSeen, oldPort, oldUnitSeen, supersede };
  });

/** One host with its own `crm` unit (answering `release`), serving until it is superseded. */
const standingHost = (release: string) =>
  Effect.gen(function* startStandingHost() {
    const scope = yield* Effect.scope;
    const publicScope = yield* Scope.fork(scope, 'sequential');
    const seen = yield* Ref.make(0);
    const unit = yield* serveOn(unitApplication(release, seen), scope);
    const published = yield* Ref.make(true);
    const drain = makeSupersedeDrain();
    const app = hostApplication(
      new Map([['crm', unit]]),
      published,
      Effect.succeed(Option.none<string>()),
      makeHostRefusalLog(),
      drain,
    );
    const port = yield* serveOn(app, publicScope);
    const supersede = (peers: Effect.Effect<readonly DrainPeer[]>, duration = Duration.seconds(10)) =>
      drainSupersededHost({
        drain,
        duration,
        peers,
        publicPort: port,
        revision: 'newer',
        stopAccepting: Scope.close(publicScope, Exit.void),
      });
    return { drain, port, seen, supersede };
  });

const peerAt = (port: number): DrainPeer => ({ address: '127.0.0.1', port });

const startDrain = <A, E, R>(drain: Effect.Effect<A, E, R>, until: SupersedeDrain) =>
  Effect.gen(function* started() {
    const fiber = yield* Effect.forkChild(drain);
    yield* Effect.repeat(until.active, { until: (active) => active });
    return fiber;
  });

it.live(
  'across a hand-over the old port answers every 100 ms sample, first itself, then by the new host; it closes after the drain',
  () =>
    Effect.gen(function* handOver() {
      const console = yield* TestConsole.make;
      const hosts = yield* twoHosts();
      const samples = yield* Ref.make<readonly Answer[]>([]);
      const sampler = yield* Effect.forkChild(
        send(hosts.oldPort, ECHO).pipe(
          Effect.tap((answer) => Ref.update(samples, (all) => [...all, answer])),
          Effect.repeat({ schedule: Schedule.spaced('100 millis'), times: 11 }),
        ),
      );
      yield* Effect.sleep('400 millis');
      // The drain outlasts the sampler by about a second: no sample starts after the listener closed, whatever the load.
      const drain = yield* Effect.forkChild(
        hosts.supersede(undefined, Duration.seconds(2)).pipe(Effect.provideService(Console.Console, console)),
      );
      yield* Fiber.join(sampler);
      const answers = yield* Ref.get(samples);
      expect(answers.length).toBe(12);
      expect(answers.every((answer) => answer.status === 200 && answer.error === undefined)).toBe(true);
      const releases = answers.map(releaseOf);
      expect(releases[0]).toBe('old');
      expect(releases.at(-1)).toBe('new');
      // Once relayed, always relayed: no answer of the old release after the first of the new one.
      expect(releases.slice(releases.indexOf('new')).every((release) => release === 'new')).toBe(true);
      yield* Fiber.join(drain);
      expect((yield* send(hosts.oldPort, ECHO)).error).toBe('ECONNREFUSED');
      const lines = (yield* console.logLines).map(String);
      expect(lines[0]).toMatch(/drain started: public port \d+ relays to 1 peer\(s\) 127\.0\.0\.1:\d+ for up to 2s/u);
      expect(lines[1]).toMatch(
        /^\[app-host\] drain ended \(deadline\): forwarded=\d+ failed=0 looped=0 dropped=0; closing public port/u,
      );
    }),
);

it.live('the drain marker: refused when a draining host receives it, stripped and ignored by a serving host', () =>
  Effect.gen(function* drainMarker() {
    const hosts = yield* twoHosts();
    const served = yield* send(hosts.newPort, ECHO, { headers: { [DRAIN_FORWARDED_HEADER]: '1' } });
    expect(served.status).toBe(200);
    expect(Option.map(decodeEcho(served.body), (echo) => echo.marker)).toEqual(Option.some(false));
    yield* startDrain(hosts.supersede(), hosts.drain);
    const before = yield* Ref.get(hosts.newUnitSeen);
    const refused = yield* send(hosts.oldPort, ECHO, { headers: { [DRAIN_FORWARDED_HEADER]: '1' } });
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.headers.connection).toBe('close');
    expect(yield* Ref.get(hosts.newUnitSeen)).toBe(before);
    // A relayed request carries the marker to the new host, which strips it before its unit.
    const relayed = yield* send(hosts.oldPort, ECHO);
    expect(Option.map(decodeEcho(relayed.body), ({ marker, release }) => ({ marker, release }))).toEqual(
      Option.some({ marker: false, release: 'new' }),
    );
  }),
);

it.live('a unit cannot speak for its host: its drain headers never leave the host, and a drain keeps its peer', () =>
  Effect.gen(function* unitSignals() {
    const hosts = yield* twoHosts();
    const direct = yield* send(hosts.newPort, '/_m/crm/signals');
    expect(direct.status).toBe(200);
    expect(direct.headers[DRAIN_REFUSED_HEADER]).toBeUndefined();
    expect(direct.headers[DRAIN_FORWARDED_HEADER]).toBeUndefined();
    yield* startDrain(hosts.supersede(), hosts.drain);
    // Through the drain the serving peer answers as itself, and stays a peer for the next request.
    for (const _ of [1, 2]) {
      const relayed = yield* send(hosts.oldPort, '/_m/crm/signals');
      expect({ body: relayed.body, status: relayed.status }).toEqual({ body: 'new', status: 200 });
      expect(relayed.headers[DRAIN_REFUSED_HEADER]).toBeUndefined();
    }
    expect(yield* hosts.drain.livePeers).toHaveLength(1);
  }),
);

it.live('with no other app container, after 5 s of asking the DNS again, the old host closes its public port', () =>
  Effect.gen(function* noPeer() {
    const console = yield* TestConsole.make;
    const hosts = yield* twoHosts();
    yield* hosts.supersede([]).pipe(Effect.provideService(Console.Console, console));
    expect((yield* send(hosts.oldPort, ECHO)).error).toBe('ECONNREFUSED');
    expect((yield* console.logLines).map(String)[0]).toMatch(
      /no other app container resolves; closing public port \d+ now/u,
    );
  }),
);

it.live(
  'the relay target is never chosen by the request: Host, X-Forwarded-* and an absolute-form URL are ignored',
  () =>
    Effect.gen(function* fixedTarget() {
      const hosts = yield* twoHosts();
      yield* startDrain(hosts.supersede(), hosts.drain);
      const answer = yield* send(hosts.oldPort, ECHO, {
        headers: { host: 'evil.example', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'evil.example' },
      });
      expect(releaseOf(answer)).toBe('new');
      // An absolute-form request line: its host is dropped, its path relayed to the peer.
      const raw = yield* Effect.callback<string>((resume) => {
        const socket = connect(hosts.oldPort, '127.0.0.1', () => {
          socket.write(
            'GET http://evil.example:9/_m/crm/echo HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n',
          );
        });
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        socket.on('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf-8'))));
      });
      expect(raw).toMatch(/^HTTP\/1\.1 200/u);
      expect(raw).toContain('"release":"new"');
      expect(raw).toContain('"path":"/echo"');
    }),
);

it.live('a request body streams through the relay to the new host; the old unit never sees it', () =>
  Effect.gen(function* streamedBody() {
    const hosts = yield* twoHosts();
    yield* startDrain(hosts.supersede(), hosts.drain);
    const oldBefore = yield* Ref.get(hosts.oldUnitSeen);
    const body = new Uint8Array(2 * 1024 * 1024).fill(7);
    const answer = yield* send(hosts.oldPort, UPLOAD, { body, method: 'POST' });
    expect(Option.map(decodeEcho(answer.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
      Option.some({ bytes: body.byteLength, release: 'new' }),
    );
    expect(yield* Ref.get(hosts.oldUnitSeen)).toBe(oldBefore);
  }),
);

it.live('an event stream open on the old release ends when the drain starts, so its client reconnects', () =>
  Effect.gen(function* eventStream() {
    const hosts = yield* twoHosts();
    const stream = yield* Effect.forkChild(send(hosts.oldPort, '/_m/crm/events'));
    yield* Effect.sleep('200 millis');
    yield* startDrain(hosts.supersede(undefined, Duration.seconds(5)), hosts.drain);
    const ended = yield* Fiber.join(stream).pipe(Effect.timeout('2 seconds'));
    expect(ended.status).toBe(200);
    expect(ended.body).toContain('data: old');
    expect(ended.error).toBeUndefined();
  }),
);

it.live('a relay that cannot reach its peer answers the retryable 503 and logs one line', () =>
  Effect.gen(function* failedRelay() {
    const console = yield* TestConsole.make;
    const hosts = yield* twoHosts(console);
    yield* startDrain(hosts.supersede([{ address: '127.0.0.1', port: 9 }]), hosts.drain);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = yield* send(hosts.oldPort, ECHO);
      expect(answer.status).toBe(503);
      expect(answer.headers['retry-after']).toBe('1');
    }
    const lines = (yield* console.errorLines).map(String);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[app-host\] WARN drain relay failed: cause=ECONNREFUSED elapsedMs=\d+ method=GET peer=http:\/\/127\.0\.0\.1:9 route=\/_m\/crm\/echo status=503$/u,
    );
  }),
);

it.live('the platform resolver never returns this container itself', () =>
  Effect.gen(function* ownAddress() {
    expect(yield* platformDrainPeers('localhost', 3000)).toEqual([]);
  }),
);

it('the relay resolves the app service name the project declares, and the new host opens its port before it reports ready', () => {
  expect(readFileSync(path.join(workspaceRoot, 'zerops-import.yaml'), 'utf-8')).toContain(
    `hostname: ${APP_SERVICE_HOSTNAME}\n`,
  );
  const host = readFileSync(path.join(workspaceRoot, 'scripts/zerops/app-host.mts'), 'utf-8');
  const startup = host.slice(host.indexOf('function* startupSequence()'));
  const publish = startup.indexOf('yield* publishSnapshot(');
  const open = startup.indexOf('yield* openPublicPort;');
  const ready = startup.indexOf('yield* Ref.set(published, true);');
  const drain = startup.indexOf('yield* drainWhenSuperseded(revision)');
  expect(publish).toBeGreaterThan(0);
  expect(open).toBeGreaterThan(publish);
  expect(ready).toBeGreaterThan(open);
  expect(drain).toBeGreaterThan(ready);
});

it.live('back-to-back deploys: a host drops a peer that is draining itself and reaches the current one', () =>
  Effect.gen(function* threeHosts() {
    const [a, b, c] = yield* Effect.all([standingHost('a'), standingHost('b'), standingHost('c')]);
    yield* startDrain(b.supersede(Effect.succeed([peerAt(c.port)])), b.drain);
    yield* startDrain(a.supersede(Effect.succeed([peerAt(b.port), peerAt(c.port)])), a.drain);
    expect(releaseOf(yield* send(a.port, ECHO))).toBe('c');
    expect(releaseOf(yield* send(a.port, ECHO))).toBe('c');
    const counts = yield* a.drain.finish;
    expect(counts).toEqual({ dropped: 1, failed: 0, forwarded: 2, looped: 0 });
  }),
);

it.live(
  'a body is never sent twice: after a draining peer saw it the request fails; the next one reaches the current host',
  () =>
    Effect.gen(function* bodyAfterDrainingPeer() {
      const [a, b, c] = yield* Effect.all([standingHost('a'), standingHost('b'), standingHost('c')]);
      yield* startDrain(b.supersede(Effect.succeed([peerAt(c.port)])), b.drain);
      yield* startDrain(a.supersede(Effect.succeed([peerAt(b.port), peerAt(c.port)])), a.drain);
      const body = new Uint8Array(64 * 1024).fill(1);
      const first = yield* send(a.port, UPLOAD, { body, method: 'POST' });
      expect(first.status).toBe(503);
      expect(first.headers['retry-after']).toBe('1');
      const second = yield* send(a.port, UPLOAD, { body, method: 'POST' });
      expect(Option.map(decodeEcho(second.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
        Option.some({ bytes: body.byteLength, release: 'c' }),
      );
      expect(yield* Ref.get(c.seen)).toBe(1);
    }),
);

it.live('a body moves to the next peer when the connection was refused, before anything was sent', () =>
  Effect.gen(function* bodyAfterRefusedConnection() {
    const [a, c] = yield* Effect.all([standingHost('a'), standingHost('c')]);
    yield* startDrain(a.supersede(Effect.succeed([peerAt(9), peerAt(c.port)])), a.drain);
    const body = new Uint8Array(64 * 1024).fill(2);
    const answer = yield* send(a.port, UPLOAD, { body, method: 'POST' });
    expect(Option.map(decodeEcho(answer.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
      Option.some({ bytes: body.byteLength, release: 'c' }),
    );
  }),
);

it.live('when every known peer failed the peers are resolved again, at most once per second', () =>
  Effect.gen(function* reResolve() {
    const [a, b, c] = yield* Effect.all([standingHost('a'), standingHost('b'), standingHost('c')]);
    yield* startDrain(b.supersede(Effect.succeed([peerAt(c.port)])), b.drain);
    const answers = yield* Ref.make<readonly (readonly DrainPeer[])[]>([[peerAt(b.port)], [peerAt(c.port)]]);
    const resolver = Ref.modify(
      answers,
      (remaining): readonly [readonly DrainPeer[], readonly (readonly DrainPeer[])[]] => [
        remaining[0] ?? [],
        remaining.length > 1 ? remaining.slice(1) : remaining,
      ],
    );
    yield* startDrain(a.supersede(resolver), a.drain);
    // B refuses as draining; within the second no new answer is asked for.
    expect((yield* send(a.port, ECHO)).status).toBe(503);
    yield* Effect.sleep('1100 millis');
    expect(releaseOf(yield* send(a.port, ECHO))).toBe('c');
  }),
);

/** One raw HTTP/1.1 exchange, so the request line reaches the host exactly as written. */
const rawExchange = (port: number, requestLine: string, headerLines: readonly string[] = []) =>
  Effect.callback<{
    readonly hop: Option.Option<boolean>;
    readonly path: Option.Option<string>;
    readonly status: number;
  }>((resume) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${[requestLine, 'Host: stage.test', ...headerLines, 'Connection: close'].join('\r\n')}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      const status = Number(/^HTTP\/1\.1 (?<status>\d{3})/u.exec(text)?.groups?.status ?? 0);
      const body = text.slice(text.indexOf('\r\n\r\n') + 4);
      const echo = decodeEcho(body);
      resume(
        Effect.succeed({
          hop: echo.pipe(Option.map(({ hop }) => hop)),
          path: echo.pipe(Option.map((found) => found.path)),
          status,
        }),
      );
    });
  });

it.live('a request target reaches the unit as received, directly and through a drain; other forms answer 400', () =>
  Effect.gen(function* targetForms() {
    const [old, current] = yield* Effect.all([standingHost('old'), standingHost('new')]);
    const asReceived = [
      ['GET /_m/crm/echo//double HTTP/1.1', '/echo//double'],
      ['GET /_m/crm/echo/%2e%2e/a%2fb/./x?q=a%20b&r=%2F HTTP/1.1', '/echo/%2e%2e/a%2fb/./x?q=a%20b&r=%2F'],
      [String.raw`GET /_m/crm/echo/a\b HTTP/1.1`, String.raw`/echo/a\b`],
      ['GET http://user:secret@evil.example:9/_m/crm/echo//x?y=1 HTTP/1.1', '/echo//x?y=1'],
    ] as const;
    for (const [line, expected] of asReceived) {
      const direct = yield* rawExchange(current.port, line);
      expect({ line, path: direct.path, status: direct.status }).toEqual({
        line,
        path: Option.some(expected),
        status: 200,
      });
    }
    for (const line of [
      'GET //evil.example/_m/crm/echo HTTP/1.1',
      'OPTIONS * HTTP/1.1',
      'GET http://evil.example//x HTTP/1.1',
    ]) {
      expect({ line, status: (yield* rawExchange(current.port, line)).status }).toEqual({ line, status: 400 });
    }
    yield* startDrain(old.supersede(Effect.succeed([peerAt(current.port)])), old.drain);
    for (const [line, expected] of asReceived) {
      const relayed = yield* rawExchange(old.port, line);
      expect({ line, path: relayed.path, status: relayed.status }).toEqual({
        line,
        path: Option.some(expected),
        status: 200,
      });
    }
  }),
);

/** A connection that writes `bytes` and then only waits; resolves with what it read once the server closed it. */
const heldConnection = (port: number, bytes: string) =>
  Effect.callback<string>((resume) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(bytes);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('close', () => {
      resume(Effect.succeed(Buffer.concat(chunks).toString('utf-8')));
    });
  });

/** An upload whose body never ends: its headers and a first chunk, then nothing; resolves with the response head. */
const unfinishedUpload = (port: number) =>
  Effect.callback<string>((resume) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'POST /_m/crm/upload HTTP/1.1\r\nHost: stage.test\r\nTransfer-Encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n',
      );
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('close', () => {
      resume(Effect.succeed(Buffer.concat(chunks).toString('utf-8')));
    });
  });

it.live(
  'on SIGTERM a host ends its relayed event stream and the upload in flight, then closes, well within the bound',
  () =>
    Effect.gen(function* stopSignalHandling() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fixture = path.join(import.meta.dirname, '../integration/fixtures/stop-signal-host.mts');
      const child = yield* spawner.spawn(ChildProcess.make(process.execPath, [fixture], { stderr: 'inherit' }));
      const lines = yield* Ref.make<readonly string[]>([]);
      yield* Effect.forkChild(
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Ref.update(lines, (all) => [...all, line])),
        ),
      );
      const portLine = yield* Ref.get(lines).pipe(
        Effect.map((all) => all.find((line) => line.startsWith('PORT '))),
        Effect.repeat({ schedule: Schedule.spaced('50 millis'), until: (line) => line !== undefined }),
        Effect.timeout('30 seconds'),
      );
      const port = Number(portLine?.slice('PORT '.length));
      const events = yield* Effect.forkChild(send(port, '/_m/crm/events'));
      const upload = yield* Effect.forkChild(unfinishedUpload(port));
      // A kept-alive connection idle after its answer, and one whose request head never ends (the server's own
      // header timeout is 66 s).
      const keptAlive = yield* Effect.forkChild(
        heldConnection(port, 'GET /_m/crm/echo HTTP/1.1\r\nHost: stage.test\r\nConnection: keep-alive\r\n\r\n'),
      );
      const halfSent = yield* Effect.forkChild(
        heldConnection(port, 'GET /_m/crm/echo HTTP/1.1\r\nHost: stage.test\r\n'),
      );
      yield* Effect.sleep('300 millis');
      const started = yield* Clock.currentTimeMillis;
      yield* child.kill({ forceKillAfter: '25 seconds', killSignal: 'SIGTERM' });
      const stoppedAfter = (yield* Clock.currentTimeMillis) - started;
      expect(yield* child.exitCode).toBe(0);
      // The public port's own cap is the server's 20 s graceful timeout; ending streams and uploads first leaves it
      // nothing to wait for.
      expect(stoppedAfter).toBeLessThan(5000);
      expect(yield* Fiber.join(keptAlive)).toMatch(/^HTTP\/1\.1 200 /u);
      expect(yield* Fiber.join(halfSent)).toBe('');
      const stream = yield* Fiber.join(events);
      expect(stream.status).toBe(200);
      expect(stream.error).toBeUndefined();
      expect(stream.body).toContain('data: tick');
      // The upload may already have reached its unit: a plain 502, never an invitation to retry it.
      const cut = yield* Fiber.join(upload);
      expect(cut).toMatch(/^HTTP\/1\.1 502 /u);
      expect(cut.toLowerCase()).not.toContain('retry-after');
      expect(yield* Ref.get(lines)).toEqual(
        expect.arrayContaining([
          '[app-host] SIGTERM received; stopping gracefully',
          '[fixture] closing the public port',
          '[fixture] public port closed',
        ]),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('an Expect: 100-continue upload of 2 MiB reaches its unit, directly and through a drain', () =>
  Effect.gen(function* expectContinue() {
    const [old, current] = yield* Effect.all([standingHost('old'), standingHost('new')]);
    const body = new Uint8Array(2 * 1024 * 1024).fill(3);
    const direct = yield* send(current.port, UPLOAD, { body, expectContinue: true, method: 'POST' });
    expect(Option.map(decodeEcho(direct.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
      Option.some({ bytes: body.byteLength, release: 'new' }),
    );
    yield* startDrain(old.supersede(Effect.succeed([peerAt(current.port)])), old.drain);
    const relayed = yield* send(old.port, UPLOAD, { body, expectContinue: true, method: 'POST' });
    expect(Option.map(decodeEcho(relayed.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
      Option.some({ bytes: body.byteLength, release: 'new' }),
    );
  }),
);

it.live(
  'headers a Connection header names, and proxy credentials, never pass a relay, directly or through a drain',
  () =>
    Effect.gen(function* hopByHop() {
      const [old, current] = yield* Effect.all([standingHost('old'), standingHost('new')]);
      const headers = ['Connection: x-hop-secret', 'X-Hop-Secret: 1', 'Proxy-Authorization: Basic dXNlcjpwYXNz'];
      const direct = yield* rawExchange(current.port, 'GET /_m/crm/echo HTTP/1.1', headers);
      expect(direct.status).toBe(200);
      expect(direct.hop).toEqual(Option.some(false));
      yield* startDrain(old.supersede(Effect.succeed([peerAt(current.port)])), old.drain);
      const relayed = yield* rawExchange(old.port, 'GET /_m/crm/echo HTTP/1.1', headers);
      expect(relayed.status).toBe(200);
      expect(relayed.hop).toEqual(Option.some(false));
    }),
);

it.effect('a superseded host never writes the authority again, however long it lives', () =>
  Effect.gen(function* neverRenewsAgain() {
    const console = yield* TestConsole.make;
    const drain = makeSupersedeDrain();
    const writes = yield* Ref.make(0);
    const renewal = yield* Effect.forkChild(
      renewWhileHolding({
        interval: Duration.hours(6),
        renew: Ref.update(writes, (count) => count + 1),
        superseded: drain.superseded,
      }).pipe(Effect.provideService(Console.Console, console)),
    );
    yield* TestClock.adjust('6 hours');
    yield* TestClock.adjust('6 hours');
    expect(yield* Ref.get(writes)).toBe(2);
    yield* drain.begin([], Effect.succeed([]));
    yield* TestClock.adjust('365 days');
    expect(yield* Ref.get(writes)).toBe(2);
    // It idles: the host neither exits (an exit would let the platform restart this old release) nor publishes.
    expect(renewal.pollUnsafe()).toBeUndefined();
    expect((yield* console.logLines).map(String)).toEqual([
      '[app-host] superseded: this host never renews or publishes the authority again',
    ]);
  }),
);

it.effect('a process restarted in a container a newer release superseded never publishes; its own release does', () =>
  Effect.gen(function* restartGuard() {
    const fs = yield* FileSystem.FileSystem;
    const marker = path.join(yield* fs.makeTempDirectoryScoped(), 'first-boot');
    yield* TestClock.adjust('1 hour');
    const first = yield* containerBoot(marker);
    expect(first.restart).toBe(false);
    const bootedAt = first.firstBootMillis;
    // The old release published a minute after the container booted; a newer one took over 20 minutes later.
    const ownActivated = { activatedAtMillis: bootedAt + 60_000, revision: 'old' };
    const newerActivated = { activatedAtMillis: bootedAt + 21 * 60_000, revision: 'newer' };
    yield* TestClock.adjust('30 minutes');
    // The process crashes and the platform restarts it inside the same container.
    const restart = yield* containerBoot(marker);
    expect(restart).toEqual({ firstBootMillis: bootedAt, restart: true });
    const mayPublish = (holder: Option.Option<{ activatedAtMillis: number; revision: string }>) =>
      restartMayPublish({ boot: Option.some(restart), holder, ownRevision: 'old' });
    expect(mayPublish(Option.some(newerActivated))).toBe(false);
    // The release that holds the row restarts and renews as before.
    expect(mayPublish(Option.some(ownActivated))).toBe(true);
    // Crashed before it ever published: the release that held the row then is older than this container.
    expect(mayPublish(Option.some({ activatedAtMillis: bootedAt - 3_600_000, revision: 'older' }))).toBe(true);
    expect(mayPublish(Option.none())).toBe(true);
    // A first boot, and a host without a marker (local runs), publish as before.
    for (const boot of [Option.some(first), Option.none()]) {
      expect(restartMayPublish({ boot, holder: Option.some(newerActivated), ownRevision: 'old' })).toBe(true);
    }
    // A later restart still reads the first boot, not the restart.
    yield* TestClock.adjust('2 hours');
    expect((yield* containerBoot(marker)).firstBootMillis).toBe(bootedAt);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('a host publishes first freely, then only while the authority still names its own revision', () =>
  Effect.gen(function* publicationGuard() {
    const drain = makeSupersedeDrain();
    const allowed = (
      ownRevision: Option.Option<string>,
      activeRevision: Effect.Effect<Option.Option<string>, string>,
    ) => publicationAllowed({ activeRevision, ownRevision, superseded: drain.superseded });
    expect(yield* allowed(Option.none(), Effect.succeed(Option.some('other')))).toBe(true);
    expect(yield* allowed(Option.some('own'), Effect.succeed(Option.some('own')))).toBe(true);
    expect(yield* allowed(Option.some('own'), Effect.succeed(Option.some('newer')))).toBe(false);
    expect(yield* allowed(Option.some('own'), Effect.succeed(Option.none()))).toBe(false);
    expect(yield* allowed(Option.some('own'), Effect.fail('database unavailable'))).toBe(false);
    yield* drain.begin([], Effect.succeed([]));
    expect(yield* allowed(Option.some('own'), Effect.succeed(Option.some('own')))).toBe(false);
    expect(yield* allowed(Option.none(), Effect.succeed(Option.none()))).toBe(false);
  }),
);

it.live(
  "the drain deadline is not a stop: a slow POST in flight gets the peer's real answer, sent to the peer once",
  () =>
    Effect.gen(function* deadlineWithRequestInFlight() {
      const [old, current] = yield* Effect.all([standingHost('old'), standingHost('new')]);
      yield* startDrain(old.supersede(Effect.succeed([peerAt(current.port)]), Duration.millis(500)), old.drain);
      const before = yield* Ref.get(current.seen);
      const answer = yield* send(old.port, '/_m/crm/slow', { body: new Uint8Array(1024).fill(5), method: 'POST' });
      expect(answer.status).toBe(200);
      expect(Option.map(decodeEcho(answer.body), ({ bytes, release }) => ({ bytes, release }))).toEqual(
        Option.some({ bytes: 1024, release: 'new' }),
      );
      expect((yield* Ref.get(current.seen)) - before).toBe(1);
      // After the deadline the listener no longer accepts.
      expect((yield* send(old.port, ECHO)).error).toBe('ECONNREFUSED');
    }),
);

const decodeBoundPort = Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Number }));

/** A loopback port nothing listens on yet: bound once by the OS, then released. */
const freePort = Effect.callback<number>((resume) => {
  const probe = createTcpServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = Option.match(decodeBoundPort(probe.address()), { onNone: () => 0, onSome: (bound) => bound.port });
    probe.close(() => resume(Effect.succeed(port)));
  });
});

/** From now on, `port` accepts connections and pipes their bytes to `target`: a listener that came up late. */
const lateListener = (port: number, target: number) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createTcpServer>>((resume) => {
      const server = createTcpServer((client) => {
        const upstream = connect(target, '127.0.0.1');
        client.pipe(upstream).pipe(client);
      });
      server.listen(port, '127.0.0.1', () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<true>((resume) => {
        server.close(() => resume(Effect.succeed(true)));
      }),
  );

it.live('a peer that refused the connection once is tried again after the next resolution', () =>
  Effect.gen(function* lateNewHost() {
    const [a, c] = yield* Effect.all([standingHost('a'), standingHost('c')]);
    const port = yield* freePort;
    yield* startDrain(a.supersede(Effect.succeed([peerAt(port)])), a.drain);
    // The new host's listener is not up yet: nothing reached it, so the caller may retry.
    expect((yield* send(a.port, ECHO)).status).toBe(503);
    yield* lateListener(port, c.port);
    yield* Effect.sleep('1100 millis');
    expect(releaseOf(yield* send(a.port, ECHO))).toBe('c');
  }),
);

it.live('an empty DNS answer at supersede is asked again, and the drain proceeds once the new host resolves', () =>
  Effect.gen(function* dnsLag() {
    const [a, c] = yield* Effect.all([standingHost('a'), standingHost('c')]);
    const answers = yield* Ref.make<readonly (readonly DrainPeer[])[]>([[], [], [peerAt(c.port)]]);
    const resolver = Ref.modify(
      answers,
      (remaining): readonly [readonly DrainPeer[], readonly (readonly DrainPeer[])[]] => [
        remaining[0] ?? [],
        remaining.length > 1 ? remaining.slice(1) : remaining,
      ],
    );
    yield* startDrain(a.supersede(resolver), a.drain);
    expect(releaseOf(yield* send(a.port, ECHO))).toBe('c');
  }),
);
