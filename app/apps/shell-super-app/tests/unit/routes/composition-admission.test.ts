import { Effect } from 'effect';
import { beforeEach, expect, rstest, it } from 'effect-rstest';

import { loader as resourceLoader } from '../../../src/routes/[lang]/resources/[moduleId]/[resourceType]/[resourceId]/page.data.client.ts';
import { loader as searchLoader } from '../../../src/routes/[lang]/search/page.data.client.ts';
import { authenticatedShellFixture } from './authenticated-shell-fixture.ts';

const { loadHomePageModelMock, resourceDetailMock, searchResourcesMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resourceDetailMock: rstest.fn(),
  searchResourcesMock: rstest.fn(),
}));

rstest.mock('../../../src/routes/[lang]/home-page-model.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
}));

rstest.mock('../../../src/api/auth-client.ts', () => ({
  resourceDetail: resourceDetailMock,
  searchResources: searchResourcesMock,
}));

const request = () => new Request('https://shell.example.test/en/search?q=invoice');
const resourceRef = {
  moduleId: 'billing.invoices',
  resourceId: 'invoice-42',
  resourceType: 'invoice',
};

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(authenticatedShellFixture()));
  searchResourcesMock.mockReturnValue(Effect.succeed({ partial: false, results: [] }));
  resourceDetailMock.mockReturnValue(Effect.succeed({ detail: { fields: [], title: 'Invoice 42' } }));
});

it.live('does not read a search or resource owner for a stale document', () =>
  Effect.gen(function* staleDocumentStopsOwnerReads() {
    loadHomePageModelMock.mockReturnValue(Effect.succeed({ state: 'reload_required' }));

    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(searchResourcesMock).not.toHaveBeenCalled();
    expect(resourceDetailMock).not.toHaveBeenCalled();
  }),
);

it.live('includes the captured release in each search and resource request', () =>
  Effect.gen(function* everyOwnerRequestCarriesTheRelease() {
    const shell = authenticatedShellFixture();

    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({ state: 'ready' });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'ready',
    });
    expect(searchResourcesMock.mock.calls[0]?.[0]).toEqual({
      compositionRevision: shell.compositionRevision,
      query: 'invoice',
    });
    expect(resourceDetailMock.mock.calls[0]?.[0]).toEqual({
      ...resourceRef,
      compositionRevision: shell.compositionRevision,
    });
  }),
);

it.live('does not read an owner before a release has been admitted', () =>
  Effect.gen(function* missingAdmissionStopsOwnerReads() {
    const { compositionRevision, ...shell } = authenticatedShellFixture();
    expect(compositionRevision).toHaveLength(64);
    loadHomePageModelMock.mockReturnValue(Effect.succeed(shell));

    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      state: 'selection_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'selection_required',
    });
    expect(searchResourcesMock).not.toHaveBeenCalled();
    expect(resourceDetailMock).not.toHaveBeenCalled();
  }),
);

it.live('preserves reload-required responses from search and resource owners', () =>
  Effect.gen(function* changedReleaseRequiresANewDocument() {
    searchResourcesMock.mockReturnValue(Effect.fail({ _tag: 'ShellReloadRequiredProblem' }));
    resourceDetailMock.mockReturnValue(Effect.fail({ _tag: 'ShellReloadRequiredProblem' }));

    expect(yield* Effect.promise(() => searchLoader({ request: request() }))).toMatchObject({
      state: 'reload_required',
    });
    expect(yield* Effect.promise(() => resourceLoader({ params: resourceRef, request: request() }))).toMatchObject({
      state: 'reload_required',
    });
  }),
);
