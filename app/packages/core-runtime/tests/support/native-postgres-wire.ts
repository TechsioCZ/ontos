import { NodeSocketServer } from '@effect/platform-node';
import { PgTypes } from '@effect/sql-pg';
import { Data, Effect, Match, Option, Predicate, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { NetAddress } from 'effect/net';
import type { Socket, SocketServer } from 'effect/socket';

/** One column of a statement's result, as PostgreSQL describes it: binary values of this type OID. */
export interface PostgresWireColumn {
  readonly name: string;
  readonly oid: number;
}

const PostgresWireScalarSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.BigInt,
  Schema.Date,
  Schema.Null,
]);
/** A value PostgreSQL exchanges with the client after binary decoding: a scalar or a one-dimensional array. */
export const PostgresWireValueSchema = Schema.Union([PostgresWireScalarSchema, Schema.Array(PostgresWireScalarSchema)]);
export type PostgresWireValue = typeof PostgresWireValueSchema.Type;
const isPostgresWireValue = Schema.is(PostgresWireValueSchema);

/** The complete outcome of one statement: its command tag, described columns and positional rows. */
export interface PostgresWireResult {
  readonly columns: readonly PostgresWireColumn[];
  readonly command: string;
  readonly rows: readonly (readonly PostgresWireValue[])[];
}

/** The per-connection state PostgreSQL keeps between statements. */
export interface PostgresWireSession {
  inTransaction: boolean;
  readonly settings: Map<string, string>;
}

export interface PostgresWireStatement {
  readonly params: readonly PostgresWireValue[];
  readonly session: PostgresWireSession;
  readonly sql: string;
}

/** A statement the scripted server refuses, delivered to the client as a native ErrorResponse. */
export class PostgresWireStatementError extends Data.TaggedError('PostgresWireStatementError')<{
  readonly code: string;
  readonly message: string;
}> {}

export type PostgresWireExecutor = (
  statement: PostgresWireStatement,
) => Effect.Effect<PostgresWireResult, PostgresWireStatementError>;

const SSL_REQUEST_CODE = 80_877_103;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codeOf = (character: string) => character.codePointAt(0) ?? 0;

const frame = (type: string, body: readonly Uint8Array[]): Uint8Array => {
  const length = body.reduce((total, part) => total + part.byteLength, 4);
  const bytes = new Uint8Array(length + 1);
  bytes[0] = codeOf(type);
  new DataView(bytes.buffer).setInt32(1, length);
  let offset = 5;
  for (const part of body) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};
const int16 = (value: number) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, value);
  return bytes;
};
const int32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value);
  return bytes;
};
const cString = (value: string) => {
  const text = encoder.encode(value);
  const bytes = new Uint8Array(text.byteLength + 1);
  bytes.set(text);
  return bytes;
};

const transactionStatus = (session: PostgresWireSession, failed: boolean) => {
  if (failed) {
    return 'E';
  }
  return session.inTransaction ? 'T' : 'I';
};
const readyForQuery = (session: PostgresWireSession, failed: boolean) =>
  frame('Z', [new Uint8Array([codeOf(transactionStatus(session, failed))])]);
const errorResponse = (error: PostgresWireStatementError) =>
  frame('E', [
    encoder.encode('S'),
    cString('ERROR'),
    encoder.encode('V'),
    cString('ERROR'),
    encoder.encode('C'),
    cString(error.code),
    encoder.encode('M'),
    cString(error.message),
    new Uint8Array([0]),
  ]);
const fieldDescription = (column: PostgresWireColumn) => [
  cString(column.name),
  int32(0),
  int16(0),
  int32(column.oid),
  int16(-1),
  int32(-1),
  int16(1),
];
const rowDescription = (columns: readonly PostgresWireColumn[]) =>
  frame('T', [int16(columns.length), ...columns.flatMap(fieldDescription)]);
const encodedValue = (value: Option.Option<Uint8Array>) =>
  Option.match(value, { onNone: () => [int32(-1)], onSome: (bytes) => [int32(bytes.byteLength), bytes] });
const dataRow = (values: readonly Option.Option<Uint8Array>[]) =>
  frame('D', [int16(values.length), ...values.flatMap(encodedValue)]);

const unencodable = (cause: PgTypes.CodecError) =>
  new PostgresWireStatementError({ code: 'XX000', message: `Unencodable result value: ${cause.message}` });
const encodeValue = (
  value: PostgresWireValue,
  oid: number,
): Effect.Effect<Option.Option<Uint8Array>, PostgresWireStatementError> =>
  value === null
    ? Effect.succeedNone
    : Effect.fromResult(Result.mapError(PgTypes.encode(value, oid), unencodable)).pipe(Effect.map(Option.some));

/** A cursor over one frontend message body. */
interface MessageReader {
  readonly byte: () => number;
  readonly bytes: (length: number) => Uint8Array;
  readonly cString: () => string;
  readonly int16: () => number;
  readonly int32: () => number;
}
const makeReader = (bytes: Uint8Array): MessageReader => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const advance = (length: number) => {
    const start = offset;
    offset += length;
    return start;
  };
  return {
    byte: () => bytes[advance(1)] ?? 0,
    bytes: (length) => {
      const start = advance(length);
      return bytes.subarray(start, start + length);
    },
    cString: () => {
      const end = bytes.indexOf(0, offset);
      return decoder.decode(bytes.subarray(advance(end - offset + 1), end));
    },
    int16: () => view.getInt16(advance(2)),
    int32: () => view.getInt32(advance(4)),
  };
};

interface PreparedStatement {
  columns?: readonly PostgresWireColumn[];
  readonly parameterTypes: readonly number[];
  readonly sql: string;
}
interface Portal {
  readonly params: readonly PostgresWireValue[];
  result?: PostgresWireResult;
  readonly statement: PreparedStatement;
}

const decodeParameter = (bytes: Uint8Array, oid: number, format: number): PostgresWireValue => {
  if (format === 0 || oid === 0) {
    return decoder.decode(bytes);
  }
  const decoded = PgTypes.decode(bytes, oid, 1);
  return Result.isSuccess(decoded) && isPostgresWireValue(decoded.success) ? decoded.success : decoder.decode(bytes);
};

/** Everything one PostgreSQL session holds between messages. */
interface ConnectionState {
  readonly execute: PostgresWireExecutor;
  failed: boolean;
  readonly portals: Map<string, Portal>;
  readonly session: PostgresWireSession;
  readonly statements: Map<string, PreparedStatement>;
  readonly write: (chunk: Uint8Array) => Effect.Effect<void, Socket.SocketError>;
}
const MessageOutcomeSchema = Schema.Literals(['continue', 'terminate']);
type MessageOutcome = typeof MessageOutcomeSchema.Type;
type MessageHandler = (
  state: ConnectionState,
  reader: MessageReader,
) => Effect.Effect<MessageOutcome, PostgresWireStatementError | Socket.SocketError>;

const resultOf = (state: ConnectionState, portal: Portal) => {
  if (portal.result !== undefined) {
    return Effect.succeed(portal.result);
  }
  return state.execute({ params: portal.params, session: state.session, sql: portal.statement.sql }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        portal.result = result;
        portal.statement.columns ??= result.columns;
      }),
    ),
  );
};
const portalNamed = (state: ConnectionState, name: string) =>
  Effect.fromNullishOr(state.portals.get(name)).pipe(
    Effect.mapError(() => new PostgresWireStatementError({ code: '34000', message: 'Unknown portal' })),
  );

const parse: MessageHandler = (state, reader) => {
  const name = reader.cString();
  const sql = reader.cString();
  const parameterTypes = Array.from({ length: reader.int16() }, () => reader.int32());
  state.statements.set(name, { parameterTypes, sql });
  return state.write(frame('1', [])).pipe(Effect.as('continue' as const));
};
const bind: MessageHandler = (state, reader) =>
  Effect.gen(function* bindPortal() {
    const portal = reader.cString();
    const statement = yield* Effect.fromNullishOr(state.statements.get(reader.cString())).pipe(
      Effect.mapError(() => new PostgresWireStatementError({ code: '26000', message: 'Unknown prepared statement' })),
    );
    const formats = Array.from({ length: reader.int16() }, () => reader.int16());
    const params = Array.from({ length: reader.int16() }, (_, index) => {
      const length = reader.int32();
      const format = formats.length === 1 ? formats[0] : formats[index];
      return length < 0
        ? null
        : decodeParameter(reader.bytes(length), statement.parameterTypes[index] ?? 0, format ?? 0);
    });
    state.portals.set(portal, { params, statement });
    yield* state.write(frame('2', []));
    return 'continue' as const;
  });
const describe: MessageHandler = (state, reader) =>
  Effect.gen(function* describeTarget() {
    const target = reader.byte();
    const name = reader.cString();
    if (target === codeOf('S')) {
      const parameterTypes = state.statements.get(name)?.parameterTypes ?? [];
      yield* state.write(frame('t', [int16(parameterTypes.length), ...parameterTypes.map(int32)]));
      yield* state.write(frame('n', []));
      return 'continue' as const;
    }
    const portal = yield* portalNamed(state, name);
    const result = yield* resultOf(state, portal);
    const columns = portal.statement.columns ?? result.columns;
    yield* state.write(columns.length === 0 ? frame('n', []) : rowDescription(columns));
    return 'continue' as const;
  });
const encodeRow = (row: readonly PostgresWireValue[], columns: readonly PostgresWireColumn[]) =>
  Effect.all(columns.map((column, index) => encodeValue(row[index] ?? null, column.oid)));
const execute: MessageHandler = (state, reader) =>
  Effect.gen(function* executePortal() {
    const portal = yield* portalNamed(state, reader.cString());
    const result = yield* resultOf(state, portal);
    const columns = portal.statement.columns ?? result.columns;
    for (const row of result.rows) {
      yield* state.write(dataRow(yield* encodeRow(row, columns)));
    }
    yield* state.write(frame('C', [cString(result.command)]));
    return 'continue' as const;
  });
const close: MessageHandler = (state, reader) => {
  const target = reader.byte();
  const name = reader.cString();
  if (target === codeOf('S')) {
    state.statements.delete(name);
  } else {
    state.portals.delete(name);
  }
  return state.write(frame('3', [])).pipe(Effect.as('continue' as const));
};
const sync: MessageHandler = (state) => {
  const failed = state.failed && state.session.inTransaction;
  state.failed = false;
  return state.write(readyForQuery(state.session, failed)).pipe(Effect.as('continue' as const));
};
const messageHandlers = new Map<string, MessageHandler>([
  ['B', bind],
  ['C', close],
  ['D', describe],
  ['E', execute],
  ['H', () => Effect.succeed('continue')],
  ['P', parse],
  ['S', sync],
  ['X', () => Effect.succeed('terminate')],
]);

/** One complete frontend message, or none while its bytes are still arriving. */
const takeMessage = (buffered: Uint8Array) => {
  if (buffered.byteLength < 5) {
    return Option.none();
  }
  const length = new DataView(buffered.buffer, buffered.byteOffset).getInt32(1);
  if (buffered.byteLength < length + 1) {
    return Option.none();
  }
  return Option.some({
    body: buffered.slice(5, length + 1),
    rest: buffered.subarray(length + 1),
    type: String.fromCodePoint(buffered[0] ?? 0),
  });
};
/** The startup packet or an SSL request, which carry no type byte. */
const takeStartup = (buffered: Uint8Array) => {
  if (buffered.byteLength < 8) {
    return Option.none();
  }
  const view = new DataView(buffered.buffer, buffered.byteOffset);
  const length = view.getInt32(0);
  if (buffered.byteLength < length) {
    return Option.none();
  }
  return Option.some({ rest: buffered.subarray(length), sslRequest: view.getInt32(4) === SSL_REQUEST_CODE });
};

const handleMessage = (state: ConnectionState, type: string, body: Uint8Array) => {
  if (state.failed && type !== 'S' && type !== 'X') {
    return Effect.succeed<MessageOutcome>('continue');
  }
  const handler = messageHandlers.get(type);
  const handled =
    handler === undefined
      ? Effect.fail(new PostgresWireStatementError({ code: '08P01', message: `Unsupported message ${type}` }))
      : handler(state, makeReader(body));
  return handled.pipe(
    Effect.catchTag('PostgresWireStatementError', (refusal) => {
      state.failed = true;
      return state.write(errorResponse(refusal)).pipe(Effect.as<MessageOutcome>('continue'));
    }),
  );
};

const answerStartup = (state: ConnectionState, sslRequest: boolean) =>
  sslRequest
    ? state.write(encoder.encode('N'))
    : Effect.forEach(
        [
          frame('R', [int32(0)]),
          frame('S', [cString('server_version'), cString('17.0')]),
          frame('K', [int32(1), int32(1)]),
          readyForQuery(state.session, false),
        ],
        (chunk) => state.write(chunk),
        { discard: true },
      );

const append = (buffered: Uint8Array, chunk: Uint8Array | string) => {
  const bytes = Predicate.isString(chunk) ? encoder.encode(chunk) : chunk;
  const next = new Uint8Array(buffered.byteLength + bytes.byteLength);
  next.set(buffered);
  next.set(bytes, buffered.byteLength);
  return next;
};

/** How far one session has read its socket. */
interface SessionProgress {
  readonly buffered: Uint8Array;
  readonly ended: boolean;
  readonly started: boolean;
}

/** Consumes every complete message in `buffered`; returns what remains and whether the session ended. */
const drainMessages = Effect.fn('NativePostgresWire.drainMessages')(function* drainMessages(
  state: ConnectionState,
  initial: { readonly buffered: Uint8Array; readonly started: boolean },
) {
  let { buffered, started } = initial;
  let next = started ? takeMessage(buffered) : Option.none();
  let startup = started ? Option.none() : takeStartup(buffered);
  while (Option.isSome(next) || Option.isSome(startup)) {
    if (Option.isSome(startup)) {
      yield* answerStartup(state, startup.value.sslRequest);
      buffered = startup.value.rest;
      started = !startup.value.sslRequest;
    } else if (Option.isSome(next)) {
      buffered = next.value.rest;
      if ((yield* handleMessage(state, next.value.type, next.value.body)) === 'terminate') {
        return { buffered, ended: true, started };
      }
    }
    next = started ? takeMessage(buffered) : Option.none();
    startup = started ? Option.none() : takeStartup(buffered);
  }
  return { buffered, ended: false, started };
});

/**
 * One native PostgreSQL v3 protocol session over a socket: startup, the extended query protocol the
 * Effect PostgreSQL client speaks, transaction status and ErrorResponse recovery at Sync.
 */
const serveConnection = (socket: Socket.Socket, executor: PostgresWireExecutor) =>
  Effect.scoped(
    Effect.gen(function* postgresConnection() {
      const { pull } = yield* socket.reader;
      const { write } = yield* socket.writer;
      const state: ConnectionState = {
        execute: executor,
        failed: false,
        portals: new Map(),
        session: { inTransaction: false, settings: new Map() },
        statements: new Map(),
        write,
      };
      let progress: SessionProgress = {
        buffered: new Uint8Array(0),
        ended: false,
        started: false,
      };
      while (!progress.ended) {
        let { buffered } = progress;
        for (const chunk of yield* pull) {
          buffered = append(buffered, chunk);
        }
        progress = yield* drainMessages(state, { buffered, started: progress.started });
      }
    }),
  ).pipe(Effect.catchTag('SocketError', () => Effect.void));

/** A loopback PostgreSQL listener whose every statement is answered by `executor` for the surrounding scope. */
export const serveScriptedPostgres = (
  executor: PostgresWireExecutor,
): Effect.Effect<number, SocketServer.SocketServerError, Scope.Scope> =>
  Effect.gen(function* scriptedPostgres() {
    const server = yield* NodeSocketServer.make({ host: '127.0.0.1', port: 0 });
    yield* server.run((socket) => serveConnection(socket, executor)).pipe(Effect.forkScoped);
    return yield* Match.value(server.address).pipe(
      Match.when(NetAddress.isInetAddress, (address) => Effect.succeed(address.port)),
      Match.orElse(() => Effect.die('The scripted PostgreSQL listener did not bind to TCP')),
    );
  });
