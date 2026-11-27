// @rstest-environment happy-dom
// Mounted product detail draft: the real `useProductDetailDraft` the editor uses, with the real draft
// controller and save. The real catalog client calls an in-process HTTP register that refuses every command that
// does not name the product's current version, whatever the company's catalogue revision is. The editor stays mounted
// while its product reloads, so `product` still shows the version before a save until that reload lands.
import { acted, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { DateTime, Deferred, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import type { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import {
  ManageCatalogActionApi,
  ManageCatalogActionConflictProblemSchema,
  ManageCatalogActionUnavailableProblemSchema,
} from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecord } from '../../shared/domain/merchandise-model.ts';
import { useProductDetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-detail-save.ts';
import type { DetailDraft } from '../../src/routes/[lang]/provoz/produkty/product-detail-draft.ts';

/** The product's `updatedAt` after `step` writes of it since the page first read it. */
const FIRST_READ = Date.parse('2026-10-20T09:00:00.000Z');
const versionAt = (step: number) => new Date(FIRST_READ + step * 1000).toISOString();
const stepOf = (updatedAt: DateTime.Utc | undefined) =>
  updatedAt === undefined ? undefined : (DateTime.toEpochMillis(updatedAt) - FIRST_READ) / 1000;

const productOf = (fields: {
  readonly description?: string;
  readonly name?: string;
  readonly priceMinor?: number;
  /** Writes of this product since the first read. */
  readonly version?: number;
}): ProductRecord =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Zrnková káva',
    createdAt: '2026-10-20T09:00:00.000Z',
    currentPriceMinor: fields.priceMinor ?? 25_804,
    description: fields.description ?? 'Etiopie, 250 g.',
    id: 'product-1',
    lowStock: false,
    lowStockThreshold: 3,
    name: fields.name ?? 'Etiopie',
    priceHistory: [],
    shortDescription: 'Svěží káva',
    sku: 'ETI-250',
    stockOnHand: 12,
    stockValueMinor: 309_648,
    unit: 'ks',
    updatedAt: versionAt(fields.version ?? 0),
    variants: [],
    vatRate: 12,
  });

const conflict = Schema.decodeSync(ManageCatalogActionConflictProblemSchema)({
  _tag: 'ManageCatalogActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'Changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

const unavailable = Schema.decodeSync(ManageCatalogActionUnavailableProblemSchema)({
  _tag: 'ManageCatalogActionUnavailableProblem',
  code: 'merchandise_persistence_unavailable',
  detail: 'Try again',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});

/**
 * The catalog: one revision for the whole company that every write moves, and the product's version that only a write
 * of this product moves. A command must name exactly the product's current version. While `priceChangesFail` is set,
 * a price change is refused without changing anything.
 */
const register = { priceChangesFail: false, revision: 1, version: 0 };
const commands: (typeof ManageCatalogPayloadSchema.Type)[] = [];
let proposed: typeof ActionProposalAcceptedSchema.Type | null = null;

/** Why the register refuses a command, or null when it takes it. */
const refusalOf = (
  command: (typeof ManageCatalogPayloadSchema.Type)['command'],
): typeof conflict | typeof unavailable | null => {
  if (Predicate.isTagged(command, 'ChangePrice') && register.priceChangesFail) {
    return unavailable;
  }
  const named =
    Predicate.isTagged(command, 'ChangePrice') || Predicate.isTagged(command, 'UpdateProduct')
      ? stepOf(command.expectedUpdatedAt)
      : undefined;
  return named === register.version ? null : conflict;
};

const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        // Decoded through the command schema just as at real ingress.
        Schema.decodeEffect(ManageCatalogPayloadSchema)(payload).pipe(
          Effect.orDie,
          Effect.flatMap(
            (
              decoded,
            ): Effect.Effect<
              typeof ActionProposalAcceptedSchema.Type | typeof ManageCatalogResultSchema.Type,
              typeof conflict | typeof unavailable
            > => {
              commands.push(decoded);
              if (proposed !== null) {
                const receipt = proposed;
                proposed = null;
                return Effect.succeed(receipt);
              }
              const refusal = refusalOf(decoded.command);
              if (refusal !== null) {
                return Effect.fail(refusal);
              }
              register.revision += 1;
              register.version += 1;
              return Effect.succeed({
                entityIds: [],
                revision: register.revision,
                updatedAt: DateTime.makeUnsafe(versionAt(register.version)),
              });
            },
          ),
        ),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);

/** Every command the register received, with the product version it named (writes since the first read). */
const sent = () =>
  commands.map(({ command }) =>
    Predicate.isTagged(command, 'ChangePrice')
      ? { named: stepOf(command.expectedUpdatedAt), priceMinor: command.priceMinor, tag: command._tag }
      : {
          named: Predicate.isTagged(command, 'UpdateProduct') ? stepOf(command.expectedUpdatedAt) : undefined,
          patch: Predicate.isTagged(command, 'UpdateProduct') ? command.patch : undefined,
          tag: command._tag,
        },
  );

type ProductEdit = ReturnType<typeof useProductDetailDraft>;

let latest: ProductEdit | null = null;
const edit = (): ProductEdit => Option.getOrThrow(Option.fromNullOr(latest));

const Harness = ({ product, revision }: { readonly product: ProductRecord; readonly revision: number }) => {
  const value = useProductDetailDraft({ onReload: constVoid, product, revision });
  useEffect(() => {
    latest = value;
  }, [value]);
  return null;
};

interface Mounted {
  /** The page hands the mounted editor another read of the same product. */
  readonly reload: (product: ProductRecord, revision: number) => Effect.Effect<void>;
  readonly unmount: () => void;
}

const mounted: Mounted[] = [];

const mount = (product: ProductRecord, revision: number) =>
  Effect.gen(function* mountEditor() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const show = (nextProduct: ProductRecord, nextRevision: number) =>
      acted(() => root.render(createElement(Harness, { product: nextProduct, revision: nextRevision })));
    let live = true;
    const view: Mounted = {
      reload: show,
      unmount: () => {
        if (live) {
          live = false;
          act(() => {
            root.unmount();
            container.remove();
          });
        }
      },
    };
    mounted.push(view);
    yield* show(product, revision);
    return view;
  });

const type = (patch: Partial<DetailDraft>) =>
  acted(() => edit().record.setDraft((current) => ({ ...current, ...patch })));

/** The Save button: the changed draft is sent now. Resolves once the save has settled. */
const saveNow = Effect.gen(function* saveAndJoin() {
  const completed = yield* Deferred.make<boolean>();
  yield* acted(() => {
    const { record } = edit();
    record.save();
    record.afterSave(() => {
      Deferred.doneUnsafe(completed, Effect.succeed(true));
    });
  });
  yield* Deferred.await(completed);
  yield* waitUntil(() => !['dirty', 'saving'].includes(edit().record.status));
});

beforeEach(() => {
  commands.length = 0;
  proposed = null;
  register.priceChangesFail = false;
  register.revision = 1;
  register.version = 0;
  latest = null;
});

afterEach(() => {
  for (const view of mounted) {
    view.unmount();
  }
  mounted.length = 0;
});

describe('mounted product detail draft while its product reloads', () => {
  it.live('taking a just-saved field back is sent, so the reload does not bring the saved value back', () =>
    Effect.gen(function* revert() {
      yield* pinTestDocument;
      const view = yield* mount(productOf({}), 1);
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().record.status).toBe('saved');

      // The reload after that save is still on its way: the page shows the product named `Etiopie`.
      yield* type({ name: 'Etiopie' });
      yield* saveNow;
      expect(sent()).toEqual([
        { named: 0, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { named: 1, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' },
      ]);
      expect(edit().record.status).toBe('saved');

      // The reload lands with what the register now has, and the field keeps what the user chose.
      yield* view.reload(productOf({ version: 2 }), 3);
      expect(edit().draft.name).toBe('Etiopie');
    }).pipe(Effect.provide(network)),
  );

  it.live('an edit after a save sends only what changed since that save', () =>
    Effect.gen(function* resend() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;

      yield* type({ lowStock: 5, lowStockText: '5' });
      yield* saveNow;
      expect(sent()[1]).toEqual({ named: 1, patch: { lowStockThreshold: 5 }, tag: 'UpdateProduct' });
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );

  it.live('a save after stock movements, orders and edits of other products moved the catalogue is saved', () =>
    Effect.gen(function* afterOtherWrites() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      // Other writes of the company took the catalogue from revision 1 to 9; none of them changed this product.
      register.revision = 9;

      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(sent()).toEqual([{ named: 0, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );

  it.live('a save over a change someone else made to this product is refused', () =>
    Effect.gen(function* afterProductWrite() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      register.revision = 2;
      register.version = 1;

      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(sent()).toEqual([{ named: 0, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('conflict');
    }).pipe(Effect.provide(network)),
  );

  it.live('after a save whose price change failed, taking the written name back is sent with the price', () =>
    Effect.gen(function* partialThenRevert() {
      yield* pinTestDocument;
      const view = yield* mount(productOf({}), 1);
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      // The name went through and left version 1; the price did not.
      expect(sent()).toEqual([
        { named: 0, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { named: 1, priceMinor: 30_000, tag: 'ChangePrice' },
      ]);
      expect(edit().record.status).toBe('error');

      // The reload lands with what the register has: the new name, the old price. The draft stays as typed.
      yield* view.reload(productOf({ name: 'Etiopie B', version: 1 }), 2);
      expect(edit().draft.name).toBe('Etiopie B');
      expect(edit().draft.priceCzk).toBe(300);

      // The name goes back to what the form opened with, and the price is tried again.
      register.priceChangesFail = false;
      yield* type({ name: 'Etiopie' });
      yield* saveNow;
      expect(sent().slice(2)).toEqual([
        { named: 1, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' },
        { named: 2, priceMinor: 30_000, tag: 'ChangePrice' },
      ]);
      expect(edit().record.status).toBe('saved');

      yield* view.reload(productOf({ priceMinor: 30_000, version: 3 }), 4);
      expect(edit().draft.name).toBe('Etiopie');
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );

  it.live('after a save whose price change failed, taking both changes back still restores the name', () =>
    Effect.gen(function* partialThenRevertAll() {
      yield* pinTestDocument;
      const view = yield* mount(productOf({}), 1);
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(edit().record.status).toBe('error');
      yield* view.reload(productOf({ name: 'Etiopie B', version: 1 }), 2);

      // Back to exactly what the form opened with: the register still has the changed name.
      yield* type({ name: 'Etiopie', priceCzk: 258.04, priceText: '258,04' });
      yield* saveNow;
      expect(sent().slice(2)).toEqual([{ named: 1, patch: { name: 'Etiopie' }, tag: 'UpdateProduct' }]);
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );

  it.live('retrying a save whose price change failed sends only the price, naming the version the name left', () =>
    Effect.gen(function* partialThenRetry() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      register.priceChangesFail = true;
      yield* type({ name: 'Etiopie B', priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(edit().record.status).toBe('error');

      // The reload has not landed: the page still shows the old name at revision 1.
      register.priceChangesFail = false;
      yield* saveNow;
      yield* waitUntil(() => edit().record.status === 'saved');
      expect(sent().slice(2)).toEqual([{ named: 1, priceMinor: 30_000, tag: 'ChangePrice' }]);
    }).pipe(Effect.provide(network)),
  );

  it.live('a price change that failed on its own leaves the confirmed version where it was', () =>
    Effect.gen(function* priceOnly() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      register.priceChangesFail = true;
      yield* type({ priceCzk: 300, priceText: '300' });
      yield* saveNow;
      expect(sent()).toEqual([{ named: 0, priceMinor: 30_000, tag: 'ChangePrice' }]);
      expect(edit().record.status).toBe('error');

      // Taking the price back leaves nothing to save.
      yield* type({ priceCzk: 258.04, priceText: '258,04' });
      yield* saveNow;
      expect(sent()).toHaveLength(1);
      expect(edit().record.status).toBe('idle');
    }).pipe(Effect.provide(network)),
  );

  it.live('a save parked for approval is held: Save does not send it again, a further edit is sent', () =>
    Effect.gen(function* approval() {
      yield* pinTestDocument;
      yield* mount(productOf({}), 1);
      const receipt = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-10T12:00:00.000Z',
        proposalId: '60000000-0000-4000-8000-000000000001',
      });
      proposed = receipt;
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().record.status).toBe('proposed');
      expect(edit().record.dirty).toBe(false);
      expect(edit().record.canSave).toBe(false);

      yield* saveNow;
      expect(sent()).toHaveLength(1);

      yield* type({ name: 'Etiopie C' });
      expect(edit().record.status).toBe('dirty');
      yield* saveNow;
      expect(sent()).toHaveLength(2);
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );
  it.live('a save refused over another field someone else saved is rebased on the fresh read and saved again', () =>
    Effect.gen(function* rebaseAndSave() {
      yield* pinTestDocument;
      const view = yield* mount(productOf({}), 1);
      // Another session saved the description: the register has version 1, this page still shows version 0.
      register.revision = 2;
      register.version = 1;
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      expect(edit().record.status).toBe('conflict');

      yield* view.reload(productOf({ description: 'Nový popis', version: 1 }), 2);
      yield* waitUntil(() => edit().record.status === 'saved');
      expect(sent()).toEqual([
        { named: 0, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
        { named: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' },
      ]);
      expect(edit().draft.name).toBe('Etiopie B');
      expect(edit().draft.description).toBe('Nový popis');
    }).pipe(Effect.provide(network)),
  );

  it.live('a save refused over the same field keeps the typed value; "Načíst aktuální verzi" makes it savable', () =>
    Effect.gen(function* overlapThenReload() {
      yield* pinTestDocument;
      const view = yield* mount(productOf({}), 1);
      register.revision = 2;
      register.version = 1;
      yield* type({ name: 'Etiopie B' });
      yield* saveNow;
      yield* view.reload(productOf({ description: 'Nový popis', name: 'Etiopie C', version: 1 }), 2);
      // Both changed the name: nothing is sent again by itself, and the typed name stays.
      expect(edit().record.status).toBe('conflict');
      expect(edit().draft.name).toBe('Etiopie B');
      expect(sent()).toHaveLength(1);

      yield* acted(() => edit().reloadLatest());
      expect(edit().record.status).toBe('dirty');
      expect(edit().record.canSave).toBe(true);
      expect(edit().draft.name).toBe('Etiopie B');
      expect(edit().draft.description).toBe('Nový popis');
      yield* saveNow;
      expect(sent()[1]).toEqual({ named: 1, patch: { name: 'Etiopie B' }, tag: 'UpdateProduct' });
      expect(edit().record.status).toBe('saved');
    }).pipe(Effect.provide(network)),
  );
});
