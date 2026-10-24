import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { DOCUMENT_ACCEPTANCE_MS, verifyStage } from '../ops/stage-demo-verify.mjs';

const shellUrl = 'https://shell.stage.test';
const storefrontUrl = 'https://storefront.stage.test';
const sessionCookie = 'ontos.session=issued; Path=/; HttpOnly';
const persona = 'management@siampark.demo';
const SIGN_IN = '/shell-super-app-api/auth/sign-in';
const SIGN_OUT = '/shell-super-app-api/auth/sign-out';
const CS = '/cs';
const WELL_KNOWN = '/.well-known/';
const SIGN_OUT_LINE = 'sign-out 200';
const OAUTH_AUTHORIZATION_SERVER = '/.well-known/oauth-authorization-server';
const OAUTH_PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const record = (url: string, init?: RequestInit) => ({
  cookie: new Headers(init?.headers).get('cookie'),
  method: init?.method ?? 'GET',
  path: pathOf(url),
  signal: init?.signal !== undefined && init.signal !== null,
});

const oauthMetadata = () => Response.json({ issuer: shellUrl });
const signInResponse = () => {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append('set-cookie', sessionCookie);
  return Response.json({ identity: {} }, { headers });
};
const signOutResponse = () => Response.json({ signedOut: true });
const documentResponse = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
// The pass writes one line per probe; the cases keep them so a silent regression is visible.
const logInto = (lines: string[]) => (line: string) => {
  lines.push(line);
};

it.live('signs the persona out through the native action after a passing verification pass', () =>
  Effect.gen(function* signsOutAfterPassingPass() {
    const calls: ReturnType<typeof record>[] = [];
    const output: string[] = [];
    const transport = async (url: string, init?: RequestInit) => {
      calls.push(record(url, init));
      const path = pathOf(url);
      if (path === SIGN_IN) {
        return signInResponse();
      }
      if (path === SIGN_OUT) {
        return signOutResponse();
      }
      if (path.startsWith(WELL_KNOWN)) {
        return oauthMetadata();
      }
      return documentResponse();
    };

    const { failures } = yield* Effect.promise(() =>
      verifyStage({
        log: logInto(output),
        now: () => 0,
        persona,
        shellUrl,
        storefrontUrl,
        transport,
      }),
    );

    expect(failures).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual([
      OAUTH_AUTHORIZATION_SERVER,
      OAUTH_PROTECTED_RESOURCE,
      SIGN_IN,
      CS,
      CS,
      CS,
      '/',
      SIGN_OUT,
    ]);
    const signOutCall = calls.at(-1);
    expect(signOutCall?.method).toBe('POST');
    expect(signOutCall?.cookie).toBe('ontos.session=issued');
    // The cleanup request owns its own bounded timeout instead of the shared 60-second budget.
    expect(signOutCall?.signal).toBe(true);
    expect(output.at(-1)).toContain(SIGN_OUT_LINE);
  }),
);

it.live('still signs the session out when a document probe throws', () =>
  Effect.gen(function* signsOutAfterFailedProbe() {
    let csAttempts = 0;
    const calls: ReturnType<typeof record>[] = [];
    const transport = (url: string, init?: RequestInit) => {
      calls.push(record(url, init));
      const path = pathOf(url);
      if (path === SIGN_IN) {
        return Promise.resolve(signInResponse());
      }
      if (path === SIGN_OUT) {
        return Promise.resolve(signOutResponse());
      }
      if (path.startsWith(WELL_KNOWN)) {
        return Promise.resolve(oauthMetadata());
      }
      if (path === CS) {
        csAttempts += 1;
        return csAttempts === 2 ? Promise.reject(new Error('socket hang up')) : Promise.resolve(documentResponse());
      }
      return Promise.resolve(new Response('unavailable', { status: 503 }));
    };

    const output: string[] = [];
    const { failures } = yield* Effect.promise(() =>
      verifyStage({ log: logInto(output), now: () => 0, persona, shellUrl, storefrontUrl, transport }),
    );

    expect(failures).toEqual([
      '/cs #2 (management@siampark.demo) failed: Error: socket hang up',
      'storefront home answered 503',
    ]);
    expect(output.at(-1)).toContain(SIGN_OUT_LINE);
    expect(calls.at(-1)?.path).toBe(SIGN_OUT);
    expect(csAttempts).toBe(3);
  }),
);

it.live('rejects a page document over the acceptance budget but never a slow auth write', () =>
  Effect.gen(function* rejectsOverBudgetPage() {
    let clock = 0;
    let pages = 0;
    const transport = (url: string) => {
      const path = pathOf(url);
      if (path === SIGN_IN) {
        // Authentication writes are checked for status only; a slow sign-in is not a page budget miss.
        clock += 5000;
        return Promise.resolve(signInResponse());
      }
      if (path === SIGN_OUT) {
        return Promise.resolve(signOutResponse());
      }
      if (path.startsWith(WELL_KNOWN)) {
        return Promise.resolve(oauthMetadata());
      }
      pages += 1;
      if (pages === 1) {
        clock += DOCUMENT_ACCEPTANCE_MS + 100;
      }
      return Promise.resolve(documentResponse());
    };

    const output: string[] = [];
    const { failures } = yield* Effect.promise(() =>
      verifyStage({ log: logInto(output), now: () => clock, persona, shellUrl, storefrontUrl, transport }),
    );

    expect(output.at(-1)).toContain(SIGN_OUT_LINE);
    expect(DOCUMENT_ACCEPTANCE_MS).toBe(1500);
    expect(failures).toEqual(['/cs #1 (management@siampark.demo) took 1600ms, over the 1500ms page budget']);
  }),
);

it.live('includes the complete document body in the page budget and reports failed cleanup', () =>
  Effect.gen(function* rejectsSlowBodyAndFailedCleanup() {
    let clock = 0;
    const transport = (url: string) => {
      const path = pathOf(url);
      if (path === SIGN_IN) {
        return Promise.resolve(signInResponse());
      }
      if (path === SIGN_OUT) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      if (path.startsWith(WELL_KNOWN)) {
        return Promise.resolve(oauthMetadata());
      }
      const response = documentResponse();
      if (url === `${storefrontUrl}/`) {
        const readBody = response.arrayBuffer.bind(response);
        response.arrayBuffer = () => {
          clock += DOCUMENT_ACCEPTANCE_MS + 100;
          return readBody();
        };
      }
      return Promise.resolve(response);
    };

    const { failures } = yield* Effect.promise(() =>
      verifyStage({ log: () => undefined, now: () => clock, persona, shellUrl, storefrontUrl, transport }),
    );

    expect(failures).toEqual(['storefront home took 1600ms, over the 1500ms page budget', 'sign-out answered 503']);
  }),
);
