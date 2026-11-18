import { ConfigProvider, Effect, Logger, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AuthenticationUnavailableProblemSchema } from '../../shared/browser-api.ts';
import { loadHomePageModel } from '../../src/routes/[lang]/home-page-model.ts';
import { makeShellBff } from '../support/shell-bff-double.ts';

// The server render has no window; this project runs in Node, so the loader reports as it does in SSR.
it.effect('logs the collapsed server failure once with correlation and no session data', () => {
  const entries: string[] = [];
  const logger = Logger.layer([
    Logger.make((options) => entries.push(JSON.stringify(Logger.formatStructured.log(options)))),
  ]);
  const bff = makeShellBff({
    currentSession: () =>
      Effect.fail(
        Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)({
          _tag: 'AuthenticationUnavailableProblem',
          detail: 'private-session-detail',
          status: 503,
          title: 'private-session-title',
          type: 'about:blank',
        }),
      ),
  });
  return Effect.gen(function* reportsServerFailure() {
    expect(
      yield* loadHomePageModel(
        new Request('https://shell.example.test/en', {
          headers: { cookie: 'private-session-cookie', 'x-correlation-id': 'browser-reload-123' },
        }),
      ),
    ).toEqual({ state: 'unavailable' });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0] ?? '')).toMatchObject({
      annotations: { correlationId: 'browser-reload-123', errorTag: 'AuthenticationUnavailableProblem' },
      level: 'ERROR',
      message: 'Authenticated Shell home loader failed',
    });
    expect(entries.join('')).not.toContain('private-session');
    expect(bff.requests.map((received) => received.endpoint)).toEqual(['currentSession']);
  }).pipe(
    Effect.provide([bff.layer, logger]),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );
});
