// @rstest-environment happy-dom
// Real module providers, toaster and generated Action client; the public HTTP contract answers in process.
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
  ManageCatalogActionInvalidProblemSchema,
  ManageCatalogActionSchemaErrorMiddleware,
  ManageCatalogActionUnavailableProblemSchema,
} from '@app/merchandise/apis/manage-catalog-action';
import type { ManageCatalogPayloadSchema } from '@app/merchandise/apis/manage-catalog-action';
import { ApplyCommandResultSchema } from '@app/merchandise/contracts/apply-command';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { constVoid } from 'effect/Function';
import { EshopCardView } from '../../src/routes/[lang]/prodej/eshopy/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision: 18 });
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2030-01-01T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});
type OwnerProblem =
  | typeof ManageCatalogActionConflictProblemSchema.Type
  | typeof ManageCatalogActionUnavailableProblemSchema.Type;
let answer: Effect.Effect<typeof committed | typeof proposal, OwnerProblem> = Effect.succeed(committed);
const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const OwnerApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(
      Layer.provide(
        HttpApiMiddleware.layerSchemaErrorTransform(ManageCatalogActionSchemaErrorMiddleware, () =>
          Effect.fail(
            ManageCatalogActionInvalidProblemSchema.make({
              detail: 'The test endpoint received an invalid request.',
              status: 400,
              title: 'Invalid request',
              type: 'https://ontos.dev/problems/action-invalid',
            }),
          ),
        ),
      ),
    ),
  ),
);

const czech = moduleText('cs');
const copy = (path: string) => czech(`commerce-market-catalog.${path}`);
const input = () =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[type="checkbox"]')));
const save = () =>
  Option.getOrThrow(
    Option.fromNullOr(buttons(copy('eshops.listing.save'))[0] ?? buttons(copy('eshops.listing.saving'))[0]),
  );
const mount = (canManageCatalog = true) =>
  Effect.gen(function* mountStorefrontSetting() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <>
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
        />
        <Toaster />
      </>,
    );
  });
const toggle = () => acted(() => input().click());
const clickSave = () => acted(() => save().click());
const saved = () => text().includes(copy('eshops.listing.saved'));

beforeEach(() => {
  commands.length = 0;
  answer = Effect.succeed(committed);
  toaster.remove();
});

afterEach(() => {
  unmountAll();
  toaster.remove();
});

it.live('shows the Akros default and sends the changed checkbox only after Save', () =>
  Effect.gen(function* explicitSave() {
    yield* mount();
    expect(input().checked).toBe(true);
    expect(save().disabled).toBe(true);
    yield* toggle();
    expect(input().checked).toBe(false);
    yield* networkIdle;
    expect(commands).toEqual([]);
    yield* clickSave();
    yield* networkIdle;
    yield* waitUntil(saved);
    expect(commands).toEqual([
      {
        command: {
          _tag: 'ConfigureStorefrontCatalog',
          mainSourceProductsOnly: false,
          storefrontAppId: 'akros-storefront',
        },
        expectedRevision: 17,
      },
    ]);
    expect(input().checked).toBe(false);
    expect(save().disabled).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('retains an unsaved draft on failure and allows retrying', () =>
  Effect.gen(function* failedSave() {
    answer = Effect.fail(
      Schema.decodeUnknownSync(ManageCatalogActionUnavailableProblemSchema)({
        _tag: 'ManageCatalogActionUnavailableProblem',
        code: 'merchandise_persistence_unavailable',
        detail: 'The catalog owner is temporarily unavailable',
        retryable: true,
        status: 503,
        title: 'Unavailable',
        type: 'https://ontos.dev/problems/unavailable',
      }),
    );
    yield* mount();
    yield* toggle();
    yield* clickSave();
    yield* networkIdle;
    yield* waitUntil(() => text().includes(copy('failures.unavailable')));
    expect(input().checked).toBe(false);
    expect(save().disabled).toBe(false);
    expect(saved()).toBe(false);
    expect(commands).toHaveLength(1);

    answer = Effect.succeed(committed);
    yield* clickSave();
    yield* networkIdle;
    yield* waitUntil(saved);
    expect(commands).toHaveLength(2);
    expect(input().checked).toBe(false);
    expect(save().disabled).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('keeps an unsaved checkbox editable and shows saving only during the request', () =>
  Effect.gen(function* dirtyIsNotSaving() {
    const response = yield* Deferred.make<typeof committed>();
    answer = Deferred.await(response);
    yield* mount();
    yield* toggle();
    expect(input().disabled).toBe(false);
    expect(save().textContent).toBe(copy('eshops.listing.save'));
    yield* toggle();
    expect(input().checked).toBe(true);
    expect(save().disabled).toBe(true);
    yield* networkIdle;
    expect(commands).toEqual([]);

    yield* toggle();
    yield* clickSave();
    yield* waitUntil(() => commands.length === 1);
    yield* networkQuietExcept(1);
    expect(input().disabled).toBe(true);
    expect(save().textContent).toBe(copy('eshops.listing.saving'));
    yield* Deferred.succeed(response, committed);
    yield* networkIdle;
    yield* waitUntil(saved);
    expect(commands).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('reports an approval proposal without claiming the preference was saved', () =>
  Effect.gen(function* proposedSave() {
    answer = Effect.succeed(proposal);
    yield* mount();
    yield* toggle();
    yield* clickSave();
    yield* networkIdle;
    yield* waitUntil(() => text().includes(copy('eshops.listing.proposed')));
    expect(saved()).toBe(false);
    expect(input().checked).toBe(false);
    expect(commands).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('offers no Save action without catalog management permission', () =>
  Effect.gen(function* readOnlySetting() {
    yield* mount(false);
    expect(input().checked).toBe(true);
    expect(input().readOnly).toBe(true);
    expect(buttons(copy('eshops.listing.save'))).toEqual([]);
    yield* toggle();
    yield* networkIdle;
    expect(input().checked).toBe(true);
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('prevents duplicate saves and checkbox edits while the owner is responding', () =>
  Effect.gen(function* pendingSave() {
    const response = yield* Deferred.make<typeof committed>();
    answer = Deferred.await(response);
    yield* mount();
    yield* toggle();
    yield* clickSave();
    yield* waitUntil(() => commands.length === 1);
    yield* networkQuietExcept(1);
    expect(input().disabled).toBe(true);
    expect(save().disabled).toBe(true);
    yield* clickSave();
    yield* toggle();
    yield* networkQuietExcept(1);
    expect(input().checked).toBe(false);
    expect(commands).toHaveLength(1);
    yield* Deferred.succeed(response, committed);
    yield* networkIdle;
    yield* waitUntil(saved);
    expect(commands).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('keeps a conflicting draft and lets the person reload the saved version', () =>
  Effect.gen(function* conflictingSave() {
    answer = Effect.fail(
      Schema.decodeUnknownSync(ManageCatalogActionConflictProblemSchema)({
        _tag: 'ManageCatalogActionConflictProblem',
        code: 'merchandise_revision_conflict',
        detail: 'The catalog changed',
        status: 409,
        title: 'Conflict',
        type: 'https://ontos.dev/problems/conflict',
      }),
    );
    yield* mount();
    yield* toggle();
    yield* clickSave();
    yield* networkIdle;
    yield* waitUntil(() => text().includes(copy('failures.conflict')));
    expect(input().checked).toBe(false);
    yield* acted(() => {
      Option.getOrThrow(Option.fromNullOr(buttons(copy('eshops.listing.reload'))[0])).click();
    });
    yield* settle;
    expect(input().checked).toBe(true);
    expect(text()).not.toContain(copy('failures.conflict'));
    expect(commands).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);
