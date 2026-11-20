import { Effect } from 'effect';

/*
 * CONTROLLED FAULT INJECTION. A byte-for-byte TCP relay in front of one service (the engine's gRPC port). While it is
 * up it changes nothing, TLS included. `setDown(true)` closes every open connection and refuses new ones, which is what
 * a network partition looks like to the client. Test support only; no production barrel exports it.
 */

const net = process.getBuiltinModule('net');
type Server = ReturnType<typeof net.createServer>;
type Socket = ReturnType<typeof net.connect>;

export interface TcpFaultProxy {
  /** Connections the relay accepted while it was up. */
  readonly relayed: () => number;
  readonly setDown: (down: boolean) => void;
}

interface TcpTarget {
  readonly host: string;
  readonly port: number;
}

const listen = (listenPort: number, target: TcpTarget) =>
  Effect.callback<{ readonly proxy: TcpFaultProxy; readonly server: Server }>((resume) => {
    const sockets = new Set<Socket>();
    let down = false;
    let relayed = 0;
    const server = net.createServer((client) => {
      if (down) {
        client.destroy();
        return;
      }
      relayed += 1;
      const upstream = net.connect(target.port, target.host === 'localhost' ? '127.0.0.1' : target.host);
      sockets.add(client);
      sockets.add(upstream);
      const end = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', end);
      upstream.on('error', end);
      client.on('close', end);
      upstream.on('close', end);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.listen(listenPort, '127.0.0.1', () => {
      resume(
        Effect.succeed({
          proxy: {
            relayed: () => relayed,
            setDown: (value) => {
              down = value;
              if (value) {
                for (const socket of sockets) {
                  socket.destroy();
                }
                sockets.clear();
              }
            },
          },
          server,
        }),
      );
    });
  });

/** Starts the relay on a fixed loopback port for the lifetime of the surrounding scope. */
export const startTcpFaultProxy = (listenPort: number, target: TcpTarget) =>
  Effect.acquireRelease(listen(listenPort, target), ({ proxy, server }) =>
    Effect.callback<undefined>((resume) => {
      proxy.setDown(true);
      server.close(() => {
        resume(Effect.undefined);
      });
    }),
  ).pipe(Effect.map(({ proxy }) => proxy));
