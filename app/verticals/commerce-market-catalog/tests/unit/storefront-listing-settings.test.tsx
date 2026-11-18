// @rstest-environment happy-dom
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { executeManageCatalog } from '@app/merchandise/apis/manage-catalog-action/client';
import {
  ManageCatalogActionConflictProblemSchema,
  ManageCatalogActionUnavailableProblemSchema,
} from '@app/merchandise/apis/manage-catalog-action';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast' with { rstest: 'importActual' };
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { EshopCardView } from '../../src/routes/[lang]/prodej/eshopy/page.tsx';

rstest.mock('@app/merchandise/apis/manage-catalog-action/client');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({ useNavigate: () => constVoid }));
const toast = rstest.hoisted(() => rstest.fn());
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({ Toaster, toaster, useToast: () => ({ create: toast }) }));

let root: Root;
let container: HTMLDivElement;
/** React owns the Promise boundary; the test program remains an Effect. */
const inReact = (action: () => void) => Effect.promise(() => act(() => Promise.resolve().then(action)));
const settle = Effect.yieldNow.pipe(Effect.andThen(() => inReact(constVoid)));
const input = () =>
  Option.getOrThrow(Option.fromNullOr(container.querySelector<HTMLInputElement>('input[type="checkbox"]')));
const save = () => Option.getOrThrow(Option.fromNullOr(container.querySelector<HTMLButtonElement>('button')));
const mount = (canManageCatalog = true) =>
  inReact(() =>
    root.render(
      <EshopCardView
        card={{
          appId: 'akros-storefront',
          channels: ['B2C'],
          lifecycle: 'ACTIVE',
          markets: [],
          name: 'Akros',
          url: 'https://akros.test',
        }}
        onOpenMarket={constVoid}
        refresh={Effect.void}
        settings={{ canManageCatalog, revision: 17 }}
      />,
    ),
  ).pipe(Effect.andThen(settle));
const toggle = () => inReact(() => input().click()).pipe(Effect.andThen(settle));
const clickSave = () => inReact(() => save().click()).pipe(Effect.andThen(settle));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  rstest.mocked(executeManageCatalog).mockReset();
  toast.mockReset();
});
afterEach(async () => {
  await act(() => Promise.resolve().then(() => root.unmount()));
  container.remove();
  rstest.unstubAllGlobals();
});

it.effect('shows the Akros default and sends the changed checkbox only after Save', () =>
  Effect.gen(function* explicitSave() {
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 18 }));
    yield* mount();
    expect(input().checked).toBe(true);
    expect(save().disabled).toBe(true);
    yield* toggle();
    expect(input().checked).toBe(false);
    expect(executeManageCatalog).not.toHaveBeenCalled();
    yield* clickSave();
    expect(rstest.mocked(executeManageCatalog).mock.calls[0]?.[0]).toMatchObject({
      command: {
        _tag: 'ConfigureStorefrontCatalog',
        mainSourceProductsOnly: false,
        storefrontAppId: 'akros-storefront',
      },
      expectedRevision: 17,
    });
    expect(input().checked).toBe(false);
    expect(save().disabled).toBe(true);
    expect(toast).toHaveBeenCalledWith({ title: 'commerce-market-catalog.eshops.listing.saved', type: 'success' });
  }),
);

it.effect('retains an unsaved draft on failure and allows retrying', () =>
  Effect.gen(function* failedSave() {
    rstest.mocked(executeManageCatalog).mockReturnValue(
      Effect.fail(
        Schema.decodeUnknownSync(ManageCatalogActionUnavailableProblemSchema)({
          _tag: 'ManageCatalogActionUnavailableProblem',
          code: 'merchandise_persistence_unavailable',
          detail: 'The catalog owner is temporarily unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'https://ontos.dev/problems/unavailable',
        }),
      ),
    );
    yield* mount();
    yield* toggle();
    yield* clickSave();
    expect(input().checked).toBe(false);
    expect(save().disabled).toBe(false);
    expect(container.textContent).toContain('commerce-market-catalog.failures.unavailable');
    expect(toast).not.toHaveBeenCalled();
  }),
);

it.effect('keeps an unsaved checkbox editable and shows saving only during the request', () =>
  Effect.gen(function* dirtyIsNotSaving() {
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.never);
    yield* mount();
    yield* toggle();
    expect(input().disabled).toBe(false);
    expect(save().textContent).toBe('commerce-market-catalog.eshops.listing.save');
    yield* toggle();
    expect(input().checked).toBe(true);
    expect(save().disabled).toBe(true);
    yield* toggle();
    yield* clickSave();
    expect(input().disabled).toBe(true);
    expect(save().textContent).toBe('commerce-market-catalog.eshops.listing.saving');
    expect(executeManageCatalog).toHaveBeenCalledTimes(1);
  }),
);

it.effect('reports an approval proposal without claiming the preference was saved', () =>
  Effect.gen(function* proposedSave() {
    rstest.mocked(executeManageCatalog).mockReturnValue(
      Effect.succeed(
        Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
          _tag: 'ActionProposalAccepted',
          expiresAt: '2030-01-01T00:00:00.000Z',
          proposalId: '22222222-2222-4222-8222-222222222222',
        }),
      ),
    );
    yield* mount();
    yield* toggle();
    yield* clickSave();
    expect(toast).toHaveBeenCalledWith({ title: 'commerce-market-catalog.eshops.listing.proposed', type: 'warning' });
  }),
);

it.effect('offers no Save action without catalog management permission', () =>
  Effect.gen(function* readOnlySetting() {
    yield* mount(false);
    expect(input().checked).toBe(true);
    expect(input().readOnly).toBe(true);
    expect(container.querySelector('button')).toBeNull();
    expect(executeManageCatalog).not.toHaveBeenCalled();
  }),
);

it.effect('prevents duplicate saves and checkbox edits while the owner is responding', () =>
  Effect.gen(function* pendingSave() {
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.never);
    yield* mount();
    yield* toggle();
    yield* clickSave();
    expect(input().disabled).toBe(true);
    expect(save().disabled).toBe(true);
    yield* clickSave();
    expect(executeManageCatalog).toHaveBeenCalledTimes(1);
  }),
);

it.effect('keeps a conflicting draft and lets the person reload the saved version', () =>
  Effect.gen(function* conflictingSave() {
    rstest.mocked(executeManageCatalog).mockReturnValue(
      Effect.fail(
        Schema.decodeUnknownSync(ManageCatalogActionConflictProblemSchema)({
          _tag: 'ManageCatalogActionConflictProblem',
          code: 'merchandise_revision_conflict',
          detail: 'The catalog changed',
          status: 409,
          title: 'Conflict',
          type: 'https://ontos.dev/problems/conflict',
        }),
      ),
    );
    yield* mount();
    yield* toggle();
    yield* clickSave();
    expect(input().checked).toBe(false);
    expect(container.textContent).toContain('commerce-market-catalog.failures.conflict');
    const reload = Option.getOrThrow(
      Option.fromNullOr(container.querySelectorAll<HTMLButtonElement>('button').item(1)),
    );
    yield* inReact(() => reload.click());
    yield* settle;
    expect(input().checked).toBe(true);
    expect(container.textContent).not.toContain('commerce-market-catalog.failures.conflict');
  }),
);
