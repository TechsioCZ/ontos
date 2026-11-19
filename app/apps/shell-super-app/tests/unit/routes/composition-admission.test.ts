import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ShellReloadRequiredProblemSchema,
  ShellResourceResponseSchema,
  ShellSearchResponseSchema,
} from '../../../shared/browser-api.ts';
import { resetBrowserSessionCache } from '../../../src/routes/[lang]/home-page-model.ts';
import { loader as resourceLoader } from '../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.data.client.ts';
import { loader as searchLoader } from '../../../src/routes/[lang]/search/page.data.client.ts';
import {
  adaSelectingCompany,
  adaSignedIn,
  makeShellBff,
  shellCompositionRevision,
  signedInShellReads,
} from '../../support/shell-bff-double.ts';
import type { ShellBffEndpoint, ShellBffScript } from '../../support/shell-bff-double.ts';

const request = () => new Request('https://shell.example.test/en/search?q=invoice');
const resourceRef = {
  moduleId: 'billing.invoices',
  resourceId: 'invoice-42',
  resourceType: 'invoice',
};

const reloadRequired = Schema.decodeUnknownSync(ShellReloadRequiredProblemSchema)({
  _tag: 'ShellReloadRequiredProblem',
  detail: 'This document belongs to a previous application release.',
  status: 409,
  title: 'Application reload required',
  type: 'about:blank',
});

/** The Shell BFF of a signed-in Ada whose search and resource owners answer, unless a test scripts otherwise. */
const ownerBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSignedIn),
    resourceDetail: (payload) =>
      Effect.succeed(
        Schema.decodeUnknownSync(ShellResourceResponseSchema)({
          detail: { fields: [], title: 'Invoice 42' },
          media: { enabled: false, reason: 'absent' },
          projectionLagging: false,
          ref: { moduleId: payload.moduleId, resourceId: payload.resourceId, resourceType: payload.resourceType },
          timeline: [],
        }),
      ),
    search: () => Effect.succeed(Schema.decodeUnknownSync(ShellSearchResponseSchema)({ partial: false, results: [] })),
    ...overrides,
  });
const sent = (bff: ReturnType<typeof ownerBff>, endpoint: ShellBffEndpoint) =>
  bff.requests.filter((received) => received.endpoint === endpoint).map((received) => received.body);

it.live('does not read a search or resource owner for a stale document', () => {
  const bff = ownerBff({ shellComposition: () => Effect.fail(reloadRequired) });
  return Effect.gen(function* staleDocumentStopsOwnerReads() {
    // Each case is a cold document: the signed-in session one case cached must not answer the next.
    yield* resetBrowserSessionCache;
    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(sent(bff, 'search')).toEqual([]);
    expect(sent(bff, 'resourceDetail')).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

it.live('includes the captured release in each search and resource request', () => {
  const bff = ownerBff();
  return Effect.gen(function* everyOwnerRequestCarriesTheRelease() {
    yield* resetBrowserSessionCache;
    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({ state: 'ready' });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'ready',
    });
    expect(sent(bff, 'search')).toEqual([{ compositionRevision: shellCompositionRevision, query: 'invoice' }]);
    expect(sent(bff, 'resourceDetail')).toEqual([{ ...resourceRef, compositionRevision: shellCompositionRevision }]);
  }).pipe(Effect.provide(bff.browser));
});

it.live('does not read an owner before a release has been admitted', () => {
  // A session that still has to select its company is never given a composition release.
  const bff = ownerBff({ currentSession: () => Effect.succeed(adaSelectingCompany) });
  return Effect.gen(function* missingAdmissionStopsOwnerReads() {
    yield* resetBrowserSessionCache;
    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      shell: { contextState: 'selection_required', state: 'authenticated' },
      state: 'selection_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'selection_required',
    });
    expect(sent(bff, 'shellComposition')).toEqual([]);
    expect(sent(bff, 'search')).toEqual([]);
    expect(sent(bff, 'resourceDetail')).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

it.live('preserves reload-required responses from search and resource owners', () => {
  const bff = ownerBff({
    resourceDetail: () => Effect.fail(reloadRequired),
    search: () => Effect.fail(reloadRequired),
  });
  return Effect.gen(function* changedReleaseRequiresANewDocument() {
    yield* resetBrowserSessionCache;
    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(sent(bff, 'search')).toHaveLength(1);
    expect(sent(bff, 'resourceDetail')).toHaveLength(1);
  }).pipe(Effect.provide(bff.browser));
});
