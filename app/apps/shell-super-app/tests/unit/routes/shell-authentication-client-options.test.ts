// @rstest-environment happy-dom
import { execFileSync } from 'node:child_process';

import { ConfigProvider, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { shellAuthenticationClientOptionsFromRequest } from '../../../src/routes/shell-authentication-client-options.ts';

const PUBLIC_ORIGIN = 'https://ontos.example.test';
const LOOPBACK_API = 'http://127.0.0.1:3000/shell-super-app-api';
const SESSION_COOKIE = '__Secure-better-auth.session_token=visitor-session; theme=dark';

/** A document request carrying attacker-controlled forwarding headers. */
const documentRequest = () =>
  new Request('https://attacker.example.test/cs/prodej/objednavky', {
    headers: {
      cookie: SESSION_COOKIE,
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'http',
    },
  });

const ServerResult = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ error: Schema.String, kind: Schema.Literal('failed') }),
    Schema.Struct({
      kind: Schema.Literal('succeeded'),
      options: Schema.Struct({
        baseUrl: Schema.URLFromString,
        cookie: Schema.optionalKey(Schema.String),
        targetSourcePath: Schema.String,
      }),
    }),
  ]),
);

/** Node supplies the real server environment and its native Request, including the cookie header. */
const serverOptionsWith = (environment: Readonly<Record<string, string>>) =>
  Effect.sync(() =>
    execFileSync(
      process.execPath,
      [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        `import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigProvider, Effect, Exit } from 'effect';
const { shellAuthenticationClientOptionsFromRequest } = await import(
  pathToFileURL(resolve('src/routes/shell-authentication-client-options.ts')).href
);
const [environment, cookie] = JSON.parse(process.argv[1]);
const request = new Request('https://attacker.example.test/cs/prodej/objednavky', {
  headers: { cookie, 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'http' },
});
const exit = await Effect.runPromise(shellAuthenticationClientOptionsFromRequest(request).pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
  Effect.exit,
));
process.stdout.write(JSON.stringify(Exit.isFailure(exit)
  ? { kind: 'failed', error: String(exit.cause) }
  : { kind: 'succeeded', options: { ...exit.value, baseUrl: String(exit.value.baseUrl) } }));`,
        JSON.stringify([environment, SESSION_COOKIE]),
      ],
      { encoding: 'utf-8' },
    ),
  ).pipe(
    Effect.map((stdout) => Schema.decodeUnknownSync(ServerResult)(stdout)),
    Effect.map((result) => (result.kind === 'failed' ? Exit.fail(result.error) : Exit.succeed(result.options))),
  );

const optionsWith = (environment: Readonly<Record<string, string>>) =>
  shellAuthenticationClientOptionsFromRequest(documentRequest()).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
  );

it.effect('server rendering reaches its own BFF over the host loopback address with the same cookie', () =>
  Effect.gen(function* loopback() {
    const options = yield* serverOptionsWith({
      BETTER_AUTH_URL: PUBLIC_ORIGIN,
      NODE_ENV: 'production',
      ONTOS_SHELL_RENDER_API_URL: LOOPBACK_API,
    }).pipe(Effect.flatten);
    expect(String(options.baseUrl)).toBe(LOOPBACK_API);
    // The visitor's credentials pass verbatim: the BFF authenticates and authorizes this read as any other.
    expect(options.cookie).toBe(SESSION_COOKIE);
    expect(options.targetSourcePath).toBe('/cs/prodej/objednavky');
  }),
);

it.effect('server rendering sends the cookie only to a loopback address, never one a request or gateway names', () =>
  Effect.gen(function* loopbackOnly() {
    for (const refused of [
      'https://gateway.example.test/shell-super-app-api',
      'http://shell.internal.example.test:3000/shell-super-app-api',
      'http://user:secret@127.0.0.1:3000/shell-super-app-api',
      'not a url',
    ]) {
      const exit = yield* serverOptionsWith({
        BETTER_AUTH_URL: PUBLIC_ORIGIN,
        NODE_ENV: 'production',
        ONTOS_SHELL_RENDER_API_URL: refused,
      });
      // A misconfigured address fails the read (the page shows "unavailable"); no other address is a fallback.
      expect(Exit.isFailure(exit)).toBe(true);
    }
    // The module gateway's address is the workers' setting, never the render's.
    const gatewayOnly = yield* serverOptionsWith({
      NODE_ENV: 'production',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://gateway.example.test/x',
    });
    expect(Exit.isFailure(gatewayOnly)).toBe(true);
  }),
);

it.effect('a production render without the loopback address fails closed instead of following the request', () =>
  Effect.gen(function* productionFailsClosed() {
    for (const environment of [
      { NODE_ENV: 'production' },
      { BETTER_AUTH_URL: PUBLIC_ORIGIN, NODE_ENV: 'production' },
    ]) {
      const exit = yield* serverOptionsWith(environment);
      expect(Exit.isFailure(exit)).toBe(true);
    }
    // A development server keeps its configured public origin, and only without one the document's own.
    const configured = yield* serverOptionsWith({ BETTER_AUTH_URL: PUBLIC_ORIGIN, NODE_ENV: 'development' }).pipe(
      Effect.flatten,
    );
    expect(String(configured.baseUrl)).toBe(`${PUBLIC_ORIGIN}/shell-super-app-api`);
    const unconfigured = yield* serverOptionsWith({ NODE_ENV: 'development' }).pipe(Effect.flatten);
    expect(String(unconfigured.baseUrl)).toBe('https://attacker.example.test/shell-super-app-api');
  }),
);

it.effect('the browser keeps its own origin even where the loopback address is configured', () =>
  Effect.gen(function* browserUnchanged() {
    const options = yield* optionsWith({ NODE_ENV: 'production', ONTOS_SHELL_RENDER_API_URL: LOOPBACK_API });
    expect(String(options.baseUrl)).toBe('https://attacker.example.test/shell-super-app-api');
  }),
);
