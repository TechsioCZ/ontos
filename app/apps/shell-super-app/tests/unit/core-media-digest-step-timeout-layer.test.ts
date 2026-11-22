import { DigestStepTimeout } from '@app/core-runtime/media/edge';
import { Duration, Effect, Layer, Logger } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreMediaDigestStepTimeoutLive } from '../../api/index.ts';

/*
 * The Shell's host layer of the digest step guard (decision 9 of #1428). A configured value reaches the guard the
 * digest steps read; unset keeps the built-in 5 s; a malformed value never stops the host: it is logged with the
 * failure reason and the built-in default applies, as the object store degrades. The routes that read it are proven in
 * the Shell E2E `core-media-e2e-digest-step-guard`.
 */

const guardOf = (environment: Readonly<Record<string, string>>) => {
  const entries: string[] = [];
  const logger = Logger.layer([
    Logger.make((options) => {
      entries.push(JSON.stringify(Logger.formatStructured.log(options)));
    }),
  ]);
  return Effect.gen(function* guard() {
    const context = yield* Layer.build(
      makeCoreMediaDigestStepTimeoutLive({ environment, envPath: '/nonexistent/core-media-digest.env' }),
    );
    const timeout = Duration.toMillis(yield* Effect.service(DigestStepTimeout).pipe(Effect.provideContext(context)));
    return { entries, timeout };
  }).pipe(Effect.scoped, Effect.provide(logger));
};

it.effect('provides the configured value as the guard of every digest step', () =>
  Effect.gen(function* configured() {
    const { entries, timeout } = yield* guardOf({ CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS: '75' });
    expect(timeout).toBe(75);
    expect(entries).toEqual([]);
  }),
);

it.effect('keeps the built-in 5 s when nothing (or only blanks) is configured', () =>
  Effect.gen(function* unset() {
    for (const environment of [{}, { CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS: '' }]) {
      const { entries, timeout } = yield* guardOf(environment);
      expect(timeout).toBe(5000);
      expect(entries).toEqual([]);
    }
  }),
);

it.effect('boots on a malformed value: logs the failure reason and keeps the built-in 5 s', () =>
  Effect.gen(function* malformed() {
    for (const value of ['not-a-number', '0', '-5', '1.5']) {
      const { entries, timeout } = yield* guardOf({ CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS: value });
      expect(timeout, value).toBe(5000);
      const logged = entries.join('\n');
      expect(logged, value).toContain('core.media.digest-step-timeout.invalid');
      expect(logged, value).toContain('CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS');
    }
  }),
);
