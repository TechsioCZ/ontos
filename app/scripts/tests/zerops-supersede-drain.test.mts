import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';

import { NodeHttpServer } from '@effect/platform-node';
import {
  Console,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
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
import { TestConsole } from 'effect/testing';

import { hostApplication } from '../zerops/app-host.mts';
import { workspaceRoot } from '../zerops/hosted-units.mts';
import { makeHostRefusalLog } from '../zerops/host-refusal-log.mts';
import {
  APP_SERVICE_HOSTNAME,
  DRAIN_FORWARDED_HEADER,
  drainSupersededHost,
  makeSupersedeDrain,
  platformDrainPeers,
} from '../zerops/supersede-drain.mts';
import type { DrainPeer, SupersedeDrain } from '../zerops/supersede-drain.mts';

/**
 * Two real hosts on loopback, each the real `hostApplication` on its own socket with its own `crm` unit, so a
 * superseded host relays over real HTTP exactly as on the platform; the platform's DNS answer is the injected peer.
 */

const EchoSchema = Schema.Struct({
  bytes: Schema.Number,
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
    if (pathname === '/events') {
      return HttpServerResponse.stream(
        Stream.tick('50 millis').pipe(Stream.map((): Uint8Array => new TextEncoder().encode(`data: ${release}\n\n`))),
        { contentType: 'text/event-stream' },
      );
    }
    const body = request.method === 'POST' ? yield* request.arrayBuffer.pipe(Effect.orDie) : new ArrayBuffer(0);
    return HttpServerResponse.text(
      JSON.stringify({
        bytes: body.byteLength,
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
  options: { body?: Uint8Array; headers?: Record<string, string>; method?: string } = {},
) =>
  Effect.callback<Answer>((resume) => {
    const request = httpRequest(
      {
        agent: false,
        headers: options.headers,
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
    request.end(options.body);
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
        closePublicPort: Scope.close(oldPublic, Exit.void),
        drain,
        duration,
        peers: Effect.succeed(peers),
        publicPort: oldPort,
        revision: 'new-revision',
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
        closePublicPort: Scope.close(publicScope, Exit.void),
        drain,
        duration,
        peers,
        publicPort: port,
        revision: 'newer',
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
      const drain = yield* Effect.forkChild(hosts.supersede().pipe(Effect.provideService(Console.Console, console)));
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
      expect(lines[0]).toMatch(
        /drain started: public port \d+ relays to 1 peer\(s\) 127\.0\.0\.1:\d+ for up to 0\.8s/u,
      );
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

it.live('with no other app container the old host closes its public port at once', () =>
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
