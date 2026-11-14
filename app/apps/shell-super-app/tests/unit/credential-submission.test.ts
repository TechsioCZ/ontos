// @rstest-environment node
import { Effect, Option } from 'effect';
import { expect, it } from 'effect-rstest';

import { guardCredentialSubmission } from '../../server/credential-submission.ts';
import type { MiddlewareContext, RequestLog, RequestMonitors } from '../../server/root-routes.ts';

it.effect('strips credential queries and rejects pre-hydration POSTs before any downstream routing or logging', () =>
  Effect.gen(function* rejectsCredentialSubmissions() {
    let downstream = 0;
    const next = Effect.sync(() => {
      downstream += 1;
    });
    for (const [method, path] of [
      ['GET', '/cs/login?login=x&password=y'],
      ['GET', '/shell-super-app-api/auth/sign-in?newPassword=y'],
      ['GET', '/mcp?api_key=y'],
      ['POST', '/en/login?returnTo=%2Fen%2Fcrm'],
      ['POST', '/cs/set-password?token=one-use'],
    ] as const) {
      const init: RequestInit = { method };
      if (method === 'POST') {
        init.body = new URLSearchParams([['password', 'body-secret']]).toString();
      }
      const raw = new Request(`https://stage.test${path}`, init);
      const response = Option.getOrThrow(
        yield* guardCredentialSubmission(
          { req: { method: raw.method, path: new URL(raw.url).pathname, raw }, res: new Response(null) },
          next,
        ),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(path.startsWith('/en/') ? '/en/login' : '/cs/login');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(raw.bodyUsed).toBe(false);
      expect(yield* Effect.promise(() => response.text())).toBe('');
    }
    expect(downstream).toBe(0);
    const result = yield* guardCredentialSubmission(
      {
        req: { method: 'GET', path: '/cs/login', url: 'https://stage.test/cs/login?returnTo=/cs/crm' },
        res: new Response(null),
      },
      next,
    );
    expect(Option.isNone(result)).toBe(true);
    expect(downstream).toBe(1);
  }),
);

it.effect('strips auth query values in Modern request error logs without changing the routed request', () =>
  Effect.gen(function* modernRequestLogRedaction() {
    const entries: string[] = [];
    const log: RequestLog = (message, ...args) => {
      entries.push(JSON.stringify([message, ...args]));
    };
    let monitors: RequestMonitors = { debug: log, error: log, info: log, trace: log, warn: log };
    const raw = new Request('https://stage.test/cs/login?client_id=private-client&sig=private-signature');
    const context: MiddlewareContext = {
      get: () => monitors,
      req: { method: 'GET', path: '/cs/login', raw },
      res: new Response(null),
      set: (_key, value) => {
        monitors = value;
      },
    };
    yield* guardCredentialSubmission(
      context,
      Effect.sync(() => {
        monitors.error('request failed, req.url = %s', raw.url);
        monitors.warn(`request ${raw.url} retried`);
      }),
    );
    expect(entries).toHaveLength(2);
    expect(entries.join('')).not.toContain('private-client');
    expect(entries.join('')).not.toContain('private-signature');
    expect(entries.join('')).toContain('https://stage.test/cs/login');
    expect(new URL(raw.url).searchParams.get('sig')).toBe('private-signature');
  }),
);
