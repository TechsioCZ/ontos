// @rstest-environment happy-dom
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { cleanup, renderHook } from '@testing-library/react';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, expect, it as test } from 'effect-rstest';
import type { ReactNode } from 'react';

import type { ShellSearchResponse } from '../../shared/browser-api.ts';
import { LegalEntityIdSchema, ModuleIdSchema, ResourceIdSchema, TenantIdSchema } from '../../shared/browser-api.ts';
import { useShellSearchSuggestions } from '../../src/routes/shell-search-suggestions.ts';

import { makeShellBff } from '../support/shell-bff-double.ts';
import { ShellI18n, shellLocaleCopy } from '../support/shell-i18n.tsx';
import type { ShellLanguage } from '../support/shell-i18n.tsx';

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
  readonly language: ShellLanguage;
  readonly revision: string | undefined;
}

const renderSuggestions = (initialProps: ScopeProps) => {
  let translations = shellLocaleCopy(initialProps.language);
  const view = renderHook(({ revision }: ScopeProps) => useShellSearchSuggestions(revision, 'scope-a'), {
    initialProps,
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <ShellI18n translations={translations}>{children}</ShellI18n>
    ),
  });
  return {
    rerender: (props: ScopeProps) => {
      translations = shellLocaleCopy(props.language);
      view.rerender(props);
    },
    result: view.result,
  };
};

afterEach(cleanup);

test.live('a new composition revision clears old results and an old response cannot win', () =>
  Effect.gen(function* staleResponseCannotWin() {
    const deferred = yield* Deferred.make<ShellSearchResponse>();
    const received = yield* Deferred.make<boolean>();
    const answered = yield* Deferred.make<boolean>();
    const bff = makeShellBff({
      search: () =>
        Deferred.succeed(received, true).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.tap(() => Deferred.succeed(answered, true)),
        ),
    });
    yield* Effect.gen(function* revisionScope() {
      const firstRevision = 'a'.repeat(64);
      const secondRevision = 'b'.repeat(64);
      const { rerender, result } = renderSuggestions({ language: 'en', revision: firstRevision });

      yield* acted(() => {
        result.current.handleQueryChange('dvorak');
      });
      yield* Deferred.await(received);
      expect(result.current.state.status).toBe('loading');
      expect(bff.requests).toEqual([
        expect.objectContaining({
          acceptLanguage: 'en',
          body: { compositionRevision: firstRevision, query: 'dvorak' },
          endpoint: 'search',
        }),
      ]);

      // The release changed while the old request was still open: its answer must not become the visible suggestion.
      rerender({ language: 'en', revision: secondRevision });
      expect(result.current.state.status).toBe('idle');
      yield* Deferred.succeed(deferred, response);
      yield* Deferred.await(answered);
      yield* settle;
      expect(result.current.state.status).toBe('idle');
    }).pipe(Effect.provide(bff.browser));
  }),
);

test.live('a language change clears results that belonged to the old language', () => {
  const bff = makeShellBff({ search: () => Effect.succeed(response) });
  return Effect.gen(function* languageChangeClearsResults() {
    const { rerender, result } = renderSuggestions({ language: 'en', revision: 'c'.repeat(64) });

    yield* acted(() => {
      result.current.handleQueryChange('dvorak');
    });
    yield* waitUntil(() => result.current.state.status === 'ready');
    expect(result.current.state.status).toBe('ready');
    if (result.current.state.status === 'ready') {
      expect(result.current.state.query).toBe('dvorak');
      expect(result.current.state.groups).toHaveLength(1);
    }

    rerender({ language: 'cs', revision: 'c'.repeat(64) });
    expect(result.current.state.status).toBe('idle');
  }).pipe(Effect.provide(bff.browser));
});
