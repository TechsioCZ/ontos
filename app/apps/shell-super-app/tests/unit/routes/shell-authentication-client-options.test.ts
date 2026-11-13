import { ConfigProvider, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { shellAuthenticationClientOptionsFromRequest } from '../../../src/routes/shell-authentication-client-options.ts';

const PUBLIC_ORIGIN = 'https://ontos.example.test';
const LOOPBACK_API = 'http://127.0.0.1:3000/shell-super-app-api';
const SESSION_COOKIE = '__Secure-better-auth.session_token=visitor-session; theme=dark';

/** A document request as the Shell's server receives it: a client chose its Host and forwarding headers. */
const documentRequest = () => {
  const forwarded = new Map([
    ['cookie', SESSION_COOKIE],
    ['x-forwarded-host', 'attacker.example.test'],
    ['x-forwarded-proto', 'http'],
  ]);
  // happy-dom's Request drops the cookie header (a browser-forbidden name); the server's request carries it.
  const headers = Object.assign(new Headers(), { get: (name: string) => forwarded.get(name.toLowerCase()) ?? null });
  return Object.defineProperty(new Request('https://attacker.example.test/cs/prodej/objednavky'), 'headers', {
    value: headers,
  });
};

/** Runs as server rendering: no browser document. */
const asServerRender = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'document');
      return descriptor;
    }),
    () => operation,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor !== undefined) {
          Object.defineProperty(globalThis, 'document', descriptor);
        }
      }),
  );

const optionsWith = (environment: Readonly<Record<string, string>>) =>
  shellAuthenticationClientOptionsFromRequest(documentRequest()).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
  );

it.effect('server rendering reaches its own BFF over the host loopback address with the same cookie', () =>
  Effect.gen(function* loopback() {
    const options = yield* asServerRender(
      optionsWith({ BETTER_AUTH_URL: PUBLIC_ORIGIN, ONTOS_SHELL_GATEWAY_BASE_URL: LOOPBACK_API }),
    );
    expect(String(options.baseUrl)).toBe(LOOPBACK_API);
    // The visitor's credentials pass verbatim: the BFF authenticates and authorizes this read as any other.
    expect(options.cookie).toBe(SESSION_COOKIE);
    expect(options.targetSourcePath).toBe('/cs/prodej/objednavky');
  }),
);

it.effect('server rendering never lets the request choose where the visitor cookie goes', () =>
  Effect.gen(function* requestCannotChoose() {
    const configured = yield* asServerRender(optionsWith({ BETTER_AUTH_URL: PUBLIC_ORIGIN }));
    expect(String(configured.baseUrl)).toBe(`${PUBLIC_ORIGIN}/shell-super-app-api`);
    for (const refused of [
      'http://shell.internal.example.test:3000/shell-super-app-api',
      'http://user:secret@127.0.0.1:3000/shell-super-app-api',
      'not a url',
    ]) {
      const exit = yield* asServerRender(
        optionsWith({ BETTER_AUTH_URL: PUBLIC_ORIGIN, ONTOS_SHELL_GATEWAY_BASE_URL: refused }),
      ).pipe(Effect.exit);
      // A misconfigured address fails the read (the page shows "unavailable"); the public origin is not a fallback.
      expect(Exit.isFailure(exit)).toBe(true);
    }
  }),
);

it.effect('the browser keeps its own origin even where the loopback address is configured', () =>
  Effect.gen(function* browserUnchanged() {
    const options = yield* optionsWith({ ONTOS_SHELL_GATEWAY_BASE_URL: LOOPBACK_API });
    expect(String(options.baseUrl)).toBe('https://attacker.example.test/shell-super-app-api');
  }),
);
