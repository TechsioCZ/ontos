import { Effect, Match, Predicate } from 'effect';

/*
 * CONTROLLED FAULT INJECTION. A small in-process HTTP proxy between the S3 adapter and a real S3-compatible
 * server. It forwards every request unchanged unless a fault rule matches; a matched rule deliberately breaks
 * that one exchange in a named way. Every injected fault is recorded in `injected`, so evidence can show that a
 * failure was an injected test fault and not a real incident. It lives in test support and is exported from no
 * production barrel.
 */

const http = process.getBuiltinModule('http');
type Server = ReturnType<typeof http.createServer>;
type IncomingMessage = InstanceType<typeof http.IncomingMessage>;
type ServerResponse = Parameters<NonNullable<Parameters<typeof http.createServer>[1]>>[1];
type Socket = IncomingMessage['socket'];

type S3FaultKind =
  /** Let the provider handle the request, then close the connection without delivering its answer. */
  | { readonly kind: 'drop-answer-after-commit' }
  /** Never answer (a hung provider, for the adapter's timeout). */
  | { readonly kind: 'hang' }
  /** Close the connection before the request reaches the provider (network reset). */
  | { readonly kind: 'reset-before' }
  /** Answer with this HTTP status and an S3-style error document, without reaching the provider. */
  | { readonly code: string; readonly kind: 'status'; readonly status: number }
  /** Deliver the status line, headers and this many body bytes of the provider's answer, then break the socket. */
  | { readonly after: number; readonly kind: 'truncate-body' };

interface S3FaultRule {
  readonly fault: S3FaultKind;
  readonly method: string;
  /** A request matches when its path and query contain this text. Default: any. */
  readonly pathIncludes?: string;
  /** Matching requests to let through before the first fault. Default 0. */
  readonly skip?: number;
  /** Number of matching requests to break before the rule is spent. Default 1. */
  readonly times?: number;
}

interface InjectedFault {
  readonly fault: string;
  readonly method: string;
}

export interface S3FaultProxy {
  readonly injected: () => readonly InjectedFault[];
  /** The proxy's own origin: point the adapter's endpoint here. */
  readonly origin: URL;
  readonly requests: () => number;
  readonly setRules: (rules: readonly S3FaultRule[]) => void;
}

/** A loopback origin on a port. The scheme is plain on purpose: the adapter accepts it only on loopback. */
export const loopbackOrigin = (port: number): URL => {
  const origin = new URL('https://127.0.0.1');
  origin.protocol = 'http:';
  origin.port = String(port);
  return origin;
};

const describeFault = (fault: S3FaultKind): string =>
  Match.value(fault).pipe(
    Match.discriminatorsExhaustive('kind')({
      'drop-answer-after-commit': () => 'drop-answer-after-commit',
      hang: () => 'hang',
      'reset-before': () => 'reset-before',
      status: ({ code, status }) => `status-${status}-${code}`,
      'truncate-body': ({ after }) => `truncate-body-after-${after}`,
    }),
  );

const errorDocument = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>controlled fault injection</Message></Error>`;

/** The programmed faults and what happened: one script belongs to one proxy. */
class FaultScript {
  readonly injected: InjectedFault[] = [];
  requests = 0;
  #entries: { broken: number; readonly rule: S3FaultRule; seen: number }[] = [];

  setRules(rules: readonly S3FaultRule[]): void {
    this.#entries = rules.map((rule) => ({ broken: 0, rule, seen: 0 }));
  }

  /** The fault to apply to this request, if a rule matches and still has faults left. */
  claim(method: string, path: string): S3FaultKind | undefined {
    this.requests += 1;
    for (const entry of this.#entries) {
      const { pathIncludes } = entry.rule;
      if (entry.rule.method === method && (pathIncludes === undefined || path.includes(pathIncludes))) {
        entry.seen += 1;
        if (entry.seen > (entry.rule.skip ?? 0) && entry.broken < (entry.rule.times ?? 1)) {
          entry.broken += 1;
          this.injected.push({ fault: describeFault(entry.rule.fault), method });
          return entry.rule.fault;
        }
      }
    }
    return undefined;
  }
}

const relayTruncated = (
  upstreamResponse: InstanceType<typeof http.IncomingMessage>,
  response: ServerResponse,
  socket: Socket,
  limit: number,
) => {
  let sent = 0;
  upstreamResponse.on('data', (chunk: Buffer) => {
    const room = Math.max(limit - sent, 0);
    sent += chunk.byteLength;
    const reachedLimit = sent >= limit;
    // The socket is broken only once the delivered part has been flushed to the client.
    response.write(chunk.subarray(0, room), () => {
      if (reachedLimit) {
        socket.destroy();
      }
    });
    if (reachedLimit) {
      upstreamResponse.destroy();
    }
  });
};

const forward = (upstream: URL, request: IncomingMessage, response: ServerResponse, fault: S3FaultKind | undefined) => {
  const upstreamRequest = http.request(
    {
      headers: request.headers,
      host: upstream.hostname,
      method: request.method,
      path: request.url,
      port: upstream.port,
    },
    (upstreamResponse) => {
      if (fault?.kind === 'drop-answer-after-commit') {
        upstreamResponse.resume();
        upstreamResponse.on('end', () => {
          request.socket.destroy();
        });
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      if (fault?.kind === 'truncate-body') {
        relayTruncated(upstreamResponse, response, request.socket, fault.after);
        return;
      }
      upstreamResponse.pipe(response);
    },
  );
  upstreamRequest.on('error', () => {
    request.socket.destroy();
  });
  request.pipe(upstreamRequest);
};

const handle = (script: FaultScript, upstream: URL) => (request: IncomingMessage, response: ServerResponse) => {
  const fault = script.claim(request.method ?? 'GET', request.url ?? '/');
  if (fault?.kind === 'reset-before') {
    request.socket.destroy();
  } else if (fault?.kind === 'hang') {
    request.resume();
  } else if (fault?.kind === 'status') {
    request.resume();
    response.writeHead(fault.status, { 'content-type': 'application/xml' });
    response.end(errorDocument(fault.code));
  } else {
    forward(upstream, request, response, fault);
  }
};

const listen = (upstream: URL, port: number) =>
  Effect.callback<{ readonly proxy: S3FaultProxy; readonly server: Server }>((resume) => {
    const script = new FaultScript();
    const sockets = new Set<Socket>();
    const server = http.createServer(handle(script, upstream));
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    server.on('close', () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const proxy: S3FaultProxy = {
        injected: () => [...script.injected],
        origin: loopbackOrigin(Predicate.hasProperty(address, 'port') ? address.port : 0),
        requests: () => script.requests,
        setRules: (rules) => {
          script.setRules(rules);
        },
      };
      resume(Effect.succeed({ proxy, server }));
    });
  });

const close = ({ server }: { readonly server: Server }) =>
  Effect.callback<undefined>((resume) => {
    server.closeAllConnections();
    server.close(() => {
      resume(Effect.undefined);
    });
  });

const PROXYABLE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Starts the proxy in front of `upstream` for the lifetime of the surrounding scope (any free port unless one is named). */
export const startS3FaultProxy = (upstream: URL, port = 0) =>
  PROXYABLE_HOSTS.has(upstream.hostname)
    ? Effect.acquireRelease(listen(upstream, port), close).pipe(Effect.map(({ proxy }) => proxy))
    : Effect.die(
        new Error('The fault proxy forwards in plain HTTP and only to a loopback upstream, never to a real endpoint'),
      );
