// @effect-diagnostics *:off
// Local after-commit host. Receipts/provider reads use the Shell API in every runtime;
// this loop keeps Mailpit SMTP and a loopback-only health endpoint for demo/up.sh.
import { createServer } from 'node:http';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, ManagedRuntime } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { dispatchEmailBatch } from '../../../packages/email-delivery/src/dispatcher/dispatch.ts';
import { emailTransport } from '../../../packages/email-delivery/src/transport.ts';

const port = Number(process.env['EMAIL_DISPATCHER_PORT'] ?? 3096);
const intervalMs = Number(process.env['EMAIL_DISPATCHER_INTERVAL_MS'] ?? 2000);
const DatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const runtime = ManagedRuntime.make(DatabaseLive);
const server = createServer((request, response) => {
  const ok = request.method === 'GET' && request.url === '/healthz';
  response.writeHead(ok ? 200 : 404, { 'cache-control': 'no-store', 'content-type': 'application/json' });
  response.end(JSON.stringify(ok ? { ok: true, provider: emailTransport.provider } : { error: 'not_found' }));
});

const main = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(
    `[email] local dispatcher; ${emailTransport.provider.label ?? 'NO provider'}; receipts at /shell-super-app-api/email/deliveries`,
  );
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    server.close();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  while (!stopping) {
    try {
      await runtime.runPromise(dispatchEmailBatch);
    } catch {
      console.error('[email] cycle failed');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  await runtime.dispose();
};

main().catch(() => {
  console.error('[email] dispatcher failed to start');
  process.exitCode = 1;
  server.close();
});
