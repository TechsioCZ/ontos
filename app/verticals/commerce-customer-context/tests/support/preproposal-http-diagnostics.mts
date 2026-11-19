import { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import { Socket } from 'node:net';
import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Config, ConfigProvider, DateTime, ManagedRuntime, Predicate, Schema } from 'effect';

// Only allowlisted lifecycle metadata enters the ring; never URLs, headers, bodies or error messages.
interface Fields {
  readonly code?: number | null;
  readonly complete?: boolean | undefined;
  readonly ownerPid?: number | undefined;
  readonly peerPort?: number | undefined;
  readonly port?: number | undefined;
  readonly requestId?: number | undefined;
  readonly signal?: string | null;
  readonly status?: number | undefined;
}
// One runtime owns Config/Clock at the plain Node --import and synchronous event-callback boundary.
const runtime = ManagedRuntime.make(ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })));
const events: string[] = [];
const bindings = new Map<string, string>();
let sequence = 0;
export const nextHttpDiagnosticId = () => {
  sequence += 1;
  return sequence;
};
export const httpDiagnostic = (owner: string, event: string, fields: Fields = {}) => {
  const line = JSON.stringify({
    at: DateTime.formatIso(runtime.runSync(DateTime.now)),
    event,
    owner,
    pid: process.pid,
    ...fields,
  });
  if (event === 'owner-port-bound' || event === 'placement-bound' || event === 'child-start') {
    bindings.set(`${owner}:${event}`, line);
    if (bindings.size > 128) {
      bindings.delete(bindings.keys().next().value ?? '');
    }
  } else {
    events.push(line);
    if (events.length > 256) {
      events.shift();
    }
  }
  // Write on every event, including success: an outer transport error need not reach the proxy's tapCause.
  // Keep port/PID bindings outside the rolling request tail so a busy proof cannot evict them.
  writeFileSync(
    path.join(tmpdir(), `preproposal-http-${process.pid}.diag.log`),
    `${[...bindings.values(), ...events].join('\n')}\n`,
    { mode: 0o600 },
  );
};

const children = new Map<number, string>();
export const bindNativeChildDiagnostic = (owner: string, pid: number) => {
  children.set(pid, owner);
  httpDiagnostic(owner, 'child-start', { ownerPid: pid });
};
const ChildMessageSchema = Schema.Struct({ process: Schema.instanceOf(ChildProcess) });
// Observe Node's actual exit event, even after scoped Effect observers have been interrupted for teardown.
channel('child_process').subscribe((message) => {
  if (!Schema.is(ChildMessageSchema)(message)) {
    return;
  }
  const child = message.process;
  child.once('exit', (code, signal) => {
    if (child.pid === undefined) {
      return;
    }
    const owner = children.get(child.pid);
    if (owner === undefined) {
      return;
    }
    httpDiagnostic(owner, 'child-exit', { code, ownerPid: child.pid, signal });
    children.delete(child.pid);
  });
});

const requestIds = new WeakMap<object, number>();
export const httpDiagnosticRequestId = (request: IncomingMessage | Http2ServerRequest) => requestIds.get(request);
export const observeHttpRequest = (owner: string, request: IncomingMessage, response: ServerResponse) => {
  const forwardedId = request.headers['x-ontos-preproposal-request-id'];
  const requestId =
    Predicate.isString(forwardedId) && /^[1-9][0-9]{0,8}$/u.test(forwardedId)
      ? Number(forwardedId)
      : nextHttpDiagnosticId();
  requestIds.set(request, requestId);
  const ports = { peerPort: request.socket.remotePort, port: request.socket.localPort, requestId };
  httpDiagnostic(owner, 'request-start', ports);
  request.once('aborted', () => httpDiagnostic(owner, 'request-abort', ports));
  response.once('finish', () => httpDiagnostic(owner, 'response-end', { ...ports, status: response.statusCode }));
  response.once('close', () =>
    httpDiagnostic(owner, 'response-close', { ...ports, complete: response.writableFinished }),
  );
  return requestId;
};

// Placements keep the existing NodeHttpServer.layerTest listener; channels observe it by its bound port.
const placementOwners = new Map<number, string>();
export const bindHttpPlacementDiagnostic = (owner: string, port: number) => {
  placementOwners.set(port, owner);
  return () => placementOwners.delete(port);
};
const observedServers = new WeakSet<EventEmitter>();
const SocketMessageSchema = Schema.Struct({ socket: Schema.instanceOf(Socket) });
const RequestMessageSchema = Schema.Struct({
  request: Schema.instanceOf(IncomingMessage),
  response: Schema.instanceOf(ServerResponse),
  server: Schema.instanceOf(EventEmitter),
});

// Loaded with --import in the native owner, before its server starts. This observes the actual owner hop.
const configuredOwner = runtime.runSync(Config.String('ONTOS_PREPROPOSAL_HTTP_OWNER').pipe(Config.withDefault('')));
const owner = /^[a-z][a-z0-9-]{0,80}$/u.test(configuredOwner) ? configuredOwner : undefined;
const requestOwner = (port: number | undefined) => (port === undefined ? owner : (placementOwners.get(port) ?? owner));
channel('net.server.socket').subscribe((message) => {
  if (!Schema.is(SocketMessageSchema)(message)) {
    return;
  }
  const { socket } = message;
  const socketOwner = requestOwner(socket.localPort);
  if (socketOwner === undefined) {
    return;
  }
  const ports = { peerPort: socket.remotePort, port: socket.localPort };
  httpDiagnostic(socketOwner, 'socket-open', ports);
  socket.once('close', (hadError) => httpDiagnostic(socketOwner, 'socket-close', { ...ports, complete: !hadError }));
});
channel('http.server.request.start').subscribe((message) => {
  if (!Schema.is(RequestMessageSchema)(message)) {
    return;
  }
  const httpOwner = requestOwner(message.request.socket.localPort);
  if (httpOwner === undefined) {
    return;
  }
  if (owner === undefined && !observedServers.has(message.server)) {
    observedServers.add(message.server);
    message.server.once('close', () => httpDiagnostic(httpOwner, 'placement-closed'));
  }
  observeHttpRequest(httpOwner, message.request, message.response);
});
if (owner !== undefined) {
  httpDiagnostic(owner, 'owner-start');
  process.once('exit', (code) => httpDiagnostic(owner, 'owner-exit', { code, signal: null }));
}
