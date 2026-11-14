import { act, cleanup, renderHook } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it as test, rstest } from 'effect-rstest';

import type { ShellSearchResponse } from '../../shared/browser-api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/browser-api.ts';
import { useShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';

const { languageState, searchResourcesMock } = rstest.hoisted(() => ({
  languageState: { current: 'en' },
  searchResourcesMock: rstest.fn(),
}));

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: languageState.current }),
}));

rstest.mock('../../src/api/auth-client.ts', () => ({
  searchResources: searchResourcesMock,
}));

const tenantId = Schema.decodeUnknownSync(TenantIdSchema)('00000000-0000-4000-8000-000000000101');
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('00000000-0000-4000-8000-000000000201');

const response: ShellSearchResponse = {
  partial: false,
  results: [
    {
      kind: 'resource',
      ref: {
        moduleId: Schema.decodeUnknownSync(ModuleIdSchema)('work.tasks'),
        resourceId: Schema.decodeUnknownSync(ResourceIdSchema)('dvorak-1'),
        resourceType: 'work.tasks.task',
        tenantId,
      },
      selectedLegalEntityId: legalEntityId,
      title: 'Zavolat Dvořákovi',
    },
  ],
};

interface ScopeProps {
  readonly language: string;
  readonly revision: string | undefined;
}

const renderSuggestions = (initialProps: ScopeProps) =>
  renderHook(
    ({ language, revision }: ScopeProps) => {
      // The i18n double reads the language the test currently asks for; the hook itself only receives the revision.
      languageState.current = language;
      return useShellSearchSuggestions(revision, 'scope-a');
    },
    { initialProps },
  );

/** Let the hook's debounce and the following response settle inside `act`, without real time. */
const settle = (milliseconds = 200) =>
  Effect.promise(() =>
    act(async () => {
      await rstest.advanceTimersByTimeAsync(milliseconds);
    }),
  );

beforeEach(() => {
  languageState.current = 'en';
  rstest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  rstest.useRealTimers();
  languageState.current = 'en';
  rstest.clearAllMocks();
});

test.effect('a new composition revision clears old results and an old response cannot win', () =>
  Effect.gen(function* staleResponseCannotWin() {
    const deferred = yield* Deferred.make<ShellSearchResponse>();
    searchResourcesMock.mockReturnValue(Deferred.await(deferred));
    const firstRevision = 'a'.repeat(64);
    const secondRevision = 'b'.repeat(64);
    const { rerender, result } = renderSuggestions({ language: 'en', revision: firstRevision });

    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* settle();
    expect(result.current.state.status).toBe('loading');
    expect(searchResourcesMock).toHaveBeenCalledWith(
      { compositionRevision: firstRevision, query: 'dvorak' },
      { locale: 'en' },
    );

    // The release changed while the old request was still open: its answer must not become the visible suggestion.
    rerender({ language: 'en', revision: secondRevision });
    expect(result.current.state.status).toBe('idle');
    yield* Deferred.succeed(deferred, response);
    yield* Effect.promise(() =>
      act(async () => {
        await rstest.advanceTimersByTimeAsync(0);
      }),
    );
    expect(result.current.state.status).toBe('idle');
  }),
);

test.effect('a language change clears results that belonged to the old language', () =>
  Effect.gen(function* languageChangeClearsResults() {
    searchResourcesMock.mockReturnValue(Effect.succeed(response));
    const { rerender, result } = renderSuggestions({ language: 'en', revision: 'c'.repeat(64) });

    act(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* settle();
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.query).toBe('dvorak');
      expect(result.current.state.groups).toHaveLength(1);
    }

    rerender({ language: 'cs', revision: 'c'.repeat(64) });
    expect(result.current.state.status).toBe('idle');
  }),
);
