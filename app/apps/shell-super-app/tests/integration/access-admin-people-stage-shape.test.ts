import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';

import { NodeServices } from '@effect/platform-node';
import { parseDatabaseConnectionPair } from '@app/core-runtime';
import { Config, Duration, Effect, FileSystem, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import {
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, ShellHttp } from '../support/access-admin-real-gate-fixture.ts';

/*
 * Lidé in the stage shape: one tenant with five companies and its bootstrapped owner ("Plný přístup" in the tenant
 * context and in every company), served by the production Shell API runtime over the real Core gate, a real
 * PostgreSQL database and SpiceDB with the shipped (v2) schema and no other relationship than Core projects.
 *
 * It counts what one `people/list` and one `people/options` request cost: the SQL statements the runtime sends and the
 * transactions among them (read off its PostgreSQL connections, which reach the case database through a counting
 * relay), the SpiceDB permission calls (from the engine's own gRPC counters, when `PEOPLE_STAGE_SPICEDB_METRICS` names
 * its metrics endpoint) and the decision evidence rows each one leaves. `PEOPLE_STAGE_REPORT=<path>` writes each
 * request's counts and evidence rows to `<path>.<request>.json`, so two revisions can be compared row for row.
 */

const decodeBody = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.orDie);

/** The statements every relayed connection executed, by the first words of their text, in order. */
const executed: string[] = [];

const labelOf = (text: string) => text.trim().slice(0, 40).toUpperCase();
const cString = (body: Buffer, from: number) => {
  const end = body.indexOf(0, from);
  return { next: end + 1, text: body.subarray(from, end).toString('utf-8') };
};

/** The SSLRequest and GSSENCRequest codes a client may send before its startup message. */
const NEGOTIATION_CODES: ReadonlySet<number> = new Set([80_877_103, 80_877_104]);

/**
 * One client connection's frontend messages, framed across chunks: a simple query ('Q') is one statement, and an
 * extended-protocol execution ('E') runs the statement its last bind ('B') named, whose text a parse ('P') gave.
 */
const frontendReader = () => {
  let pending = Buffer.alloc(0);
  let started = false;
  let bound = '';
  const texts = new Map<string, string>();
  const message = (type: string, body: Buffer) => {
    if (type === 'Q') {
      executed.push(labelOf(body.toString('utf-8')));
    } else if (type === 'P') {
      const name = cString(body, 0);
      texts.set(name.text, labelOf(cString(body, name.next).text));
    } else if (type === 'B') {
      bound = texts.get(cString(body, cString(body, 0).next).text) ?? '';
    } else if (type === 'E') {
      executed.push(bound);
    }
  };
  const untyped = () => {
    const length = pending.readInt32BE(0);
    if (pending.length < length) {
      return false;
    }
    started = !NEGOTIATION_CODES.has(pending.readInt32BE(4));
    pending = pending.subarray(length);
    return true;
  };
  const typed = () => {
    const length = pending.readInt32BE(1);
    if (pending.length < length + 1) {
      return false;
    }
    message(String.fromCodePoint(pending[0] ?? 0), pending.subarray(5, length + 1));
    pending = pending.subarray(length + 1);
    return true;
  };
  return (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= (started ? 5 : 8) && (started ? typed() : untyped())) {
      // Each complete message is consumed by the step that framed it.
    }
  };
};

/** Relays one client connection to PostgreSQL unchanged, reading its frontend messages on the way. */
const relayConnection = (target: { readonly host: string; readonly port: number }, sockets: Set<Socket>) => {
  const read = frontendReader();
  return (client: Socket) => {
    const upstream = connect(target.port, target.host);
    sockets.add(client).add(upstream);
    client.on('data', (chunk: Buffer) => {
      read(chunk);
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      client.write(chunk);
    });
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      from.on('close', () => {
        to.destroy();
      });
      from.on('error', () => {
        to.destroy();
      });
    }
  };
};

/** A loopback port for the relay: one suite at a time per process, so the process id keeps it its own. */
const RELAY_PORT = 40_000 + (process.pid % 20_000);

/** A loopback relay to the integration PostgreSQL, for this scope. */
const countingRelay = (target: { readonly host: string; readonly port: number }) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly server: Server; readonly sockets: Set<Socket> }>((resume) => {
      const sockets = new Set<Socket>();
      const server = createServer((client) => {
        relayConnection(target, sockets)(client);
      });
      server.listen({ host: '127.0.0.1', port: RELAY_PORT }, () => {
        resume(Effect.succeed({ port: RELAY_PORT, server, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<boolean>((resume) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => {
          resume(Effect.succeed(true));
        });
      }),
  );

/** The case's own database pair, reached through the relay on `port`. */
const relayedDatabases = (accessCase: AccessAdminCase, port: number) => {
  const relayed = (connectionString: string) => {
    const url = new URL(connectionString);
    url.hostname = '127.0.0.1';
    url.port = String(port);
    return url.toString();
  };
  return parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: relayed(accessCase.databases.admin.connectionString),
    DATABASE_URL: relayed(accessCase.databases.runtime.connectionString),
  }).pipe(Effect.orDie);
};

/** The engine's handled permission-service calls, summed over every method; -1 without its metrics endpoint. */
const spiceDbCalls = Effect.gen(function* spiceDbCalls() {
  const endpoint = yield* Config.option(Config.String('PEOPLE_STAGE_SPICEDB_METRICS'));
  if (Option.isNone(endpoint)) {
    return -1;
  }
  const text = yield* Effect.promise(async () => {
    const response = await fetch(endpoint.value);
    return await response.text();
  });
  return text
    .split('\n')
    .filter((line) => line.startsWith('grpc_server_handled_total{') && line.includes('PermissionsService'))
    .reduce((total, line) => total + Number(line.split(' ').at(-1) ?? '0'), 0);
});

/** Every evidence row of the case tenant by id, as content: what, where and the outcome. */
const decisionRows = (accessCase: AccessAdminCase) =>
  accessCase.admin
    .unsafe<{ readonly content: string; readonly id: string }>(
      `select decision_log_id::text as id,
              concat_ws('|', capability_key, mode, outcome, reasons_json::text, scope_id) as content
         from core.access_decision_logs where tenant_id = '${accessCase.tenantId}'`,
    )
    .pipe(
      Effect.map((rows) => new Map(rows.map(({ content, id }) => [id, content] as const))),
      Effect.orDie,
    );

const TRANSACTION_START = /^(?:BEGIN|START TRANSACTION)\b/u;

const reportPath = Config.option(Config.String('PEOPLE_STAGE_REPORT'));

interface RequestReport {
  readonly decisionRows: number;
  readonly evidence: readonly string[];
  readonly ms: number;
  readonly spicedb: number;
  readonly statementKinds: Readonly<Record<string, number>>;
  readonly statements: number;
  readonly transactions: number;
}

const writeReport = (name: string, report: RequestReport) =>
  Effect.gen(function* writeReportEffect() {
    const path = yield* reportPath;
    if (Option.isNone(path)) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(report);
    yield* fileSystem.writeFileString(`${path.value}.${name}.json`, text);
  }).pipe(Effect.provide(NodeServices.layer));

/** One request of a person through the Shell, with its round trips and the evidence rows it left. */
const measuredRequest = Effect.fn('test.measuredPeopleRequest')(function* measuredRequest(input: {
  readonly accessCase: AccessAdminCase;
  readonly path: '/shell/access/people/list' | '/shell/access/people/options';
  readonly persona: 'member' | 'owner';
  readonly shell: ShellHttp;
}) {
  const before = yield* decisionRows(input.accessCase);
  const engineBefore = yield* spiceDbCalls;
  executed.length = 0;
  const [elapsed, answer] = yield* Effect.timed(
    input.shell.post({ path: input.path, payload: { limit: 100 }, persona: input.persona }),
  );
  const statements = [...executed];
  const engineAfter = yield* spiceDbCalls;
  const after = yield* decisionRows(input.accessCase);
  const evidence = [...after.entries()].flatMap(([id, content]) => (before.has(id) ? [] : [content])).toSorted();
  const counts = {
    decisionRows: evidence.length,
    ms: Math.round(Duration.toMillis(elapsed)),
    spicedb: engineBefore < 0 ? -1 : engineAfter - engineBefore,
    statements: statements.length,
    transactions: statements.filter((text) => TRANSACTION_START.test(text)).length,
  };
  const statementKinds = Object.fromEntries(
    [...new Set(statements)].map((text) => [text, statements.filter((other) => other === text).length] as const),
  );
  const suffix = input.persona === 'owner' ? '' : `-${input.persona}`;
  const name = (input.path.split('/').at(-1) ?? 'request') + suffix;
  yield* writeReport(name, { ...counts, evidence, statementKinds });
  return { answer, counts };
});

/** The round trips one owner request may make in this shape (measured on trunk 685b87f90 with this branch). */
const LIST_BOUNDS = { statements: 401, transactions: 40 };
const OPTIONS_BOUNDS = { statements: 814, transactions: 83 };

/** The case clones its database, bootstraps a tenant with five companies into SpiceDB and signs every persona in. */
const CASE_TIMEOUT = 300_000;

const ownerOfFiveCompanies = (accessCase: AccessAdminCase) =>
  Effect.gen(function* ownerOfFiveCompaniesEffect() {
    expect(accessCase.companies).toHaveLength(5);
    const server = new URL(accessCase.databases.runtime.connectionString);
    const relay = yield* countingRelay({ host: server.hostname, port: Number(server.port) });
    const databases = yield* relayedDatabases(accessCase, relay.port);
    const shell = yield* shellHttpFor({ ...accessCase, databases });
    // Warm-up: the first requests of a runtime build its layers and read the release once.
    for (const path of ['/shell/access/people/list', '/shell/access/people/options'] as const) {
      expect((yield* shell.post({ path, payload: { limit: 100 }, persona: 'owner' })).status).toBe(200);
    }

    const list = yield* measuredRequest({ accessCase, path: '/shell/access/people/list', persona: 'owner', shell });
    expect(list.answer.status).toBe(200);
    const listed = yield* decodeBody(ListAccessPeopleResponseSchema, list.answer.text);
    expect(listed.items.length).toBeGreaterThan(0);

    const options = yield* measuredRequest({
      accessCase,
      path: '/shell/access/people/options',
      persona: 'owner',
      shell,
    });
    expect(options.answer.status).toBe(200);
    const offered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, options.answer.text);
    expect(offered.revision).toBe(listed.revision);
    expect(Object.values(offered.writeAvailability).every(Boolean)).toBe(true);
    expect(offered.capabilities.length).toBeGreaterThan(800);

    yield* Effect.logInfo('people stage shape', { list: list.counts, options: options.counts });
    // Every decision keeps its evidence row: the list's own declaration in the tenant context and each of the five
    // companies, and the options' own declaration with its eight writes in the same six contexts.
    expect(list.counts.decisionRows).toBe(6);
    expect(options.counts.decisionRows).toBe(54);
    // On trunk 685b87f90 one-decision-at-a-time admission measured list 353 statements / 34 transactions and options
    // 767 / 77. The batch reads authority cells per company scope, which the single owner decisions skipped; it pays
    // off in wall time because the gate prepares two scopes at a time.
    expect(list.counts.statements).toBeLessThanOrEqual(LIST_BOUNDS.statements);
    expect(list.counts.transactions).toBeLessThanOrEqual(LIST_BOUNDS.transactions);
    expect(options.counts.statements).toBeLessThanOrEqual(OPTIONS_BOUNDS.statements);
    expect(options.counts.transactions).toBeLessThanOrEqual(OPTIONS_BOUNDS.transactions);

    // A person the options cover nowhere is refused after the read's own question alone: one refusal per context,
    // and no write is asked, so no write refusal is recorded.
    const refused = yield* measuredRequest({
      accessCase,
      path: '/shell/access/people/options',
      persona: 'member',
      shell,
    });
    expect(refused.answer.status).toBe(403);
    expect(refused.counts.decisionRows).toBeLessThanOrEqual(6);
    expect(refused.counts.decisionRows).toBeGreaterThan(0);
  });

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'Lidé in the stage shape',
  (suite) => {
    suite.effect(
      "an owner's people list and options of a tenant with five companies stay within their round-trip bounds",
      () => withAccessAdminCase((accessCase) => Effect.scoped(ownerOfFiveCompanies(accessCase)), { extraCompanies: 3 }),
      CASE_TIMEOUT,
    );
  },
);
