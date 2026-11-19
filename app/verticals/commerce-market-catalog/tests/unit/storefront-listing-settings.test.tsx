// @rstest-environment happy-dom
// Real module providers, toaster and generated Action client; the public HTTP contract answers in process.
import { acted, buttons, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
  ManageCatalogActionInvalidProblemSchema,
  ManageCatalogActionSchemaErrorMiddleware,
} from '@app/merchandise/apis/manage-catalog-action';
import type { ManageCatalogPayloadSchema } from '@app/merchandise/apis/manage-catalog-action';
import { ApplyCommandResultSchema } from '@app/merchandise/contracts/apply-command';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';
import { Toaster, toaster } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { StorefrontListingSetting } from '../../src/routes/[lang]/prodej/eshopy/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], revision: 18 });
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2030-01-01T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});
type OwnerProblem = typeof ManageCatalogActionConflictProblemSchema.Type;
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
const mount = (canManageCatalog = true, appId = 'akros-storefront') =>
  Effect.gen(function* mountStorefrontSetting() {
    yield* pinTestDocument;
    yield* mountInRoute(
      <>
        <StorefrontListingSetting appId={appId} refresh={Effect.void} settings={{ canManageCatalog, revision: 17 }} />
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

it.live('lists only main products by default on AKROS and SroubShop and on no other e-shop', () =>
  Effect.gen(function* defaults() {
    for (const [appId, checked] of [
      ['akros-storefront', true],
      ['sroubshop-storefront', true],
      ['n1-storefront', false],
    ] as const) {
      yield* mount(true, appId);
      expect(input().checked).toBe(checked);
      unmountAll();
    }
  }).pipe(Effect.provide(network)),
);

it.live('sends the changed checkbox only after Save', () =>
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
