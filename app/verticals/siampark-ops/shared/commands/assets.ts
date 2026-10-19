// Siampark provoz — commands of agenda `assets` (S02 majetek a inventura + S03 odpisy).
// OWNED BY THE `assets` LANE. To add a command: append a Schema.TaggedStruct to `assetsCommandSchemas`
// (tag must be globally unique, prefix it like `Asset…`), then handle it in `evolveAssets`.
// The central dispatcher (shared/agendas.ts) picks the agenda by tag; nothing else needs editing.
import { Effect, Match, Schema } from 'effect';
import { auditCreated, defineAgenda, entityIdOf, mintId, NoteSchema, opsConflict, PropertyRefSchema, TextSchema } from '../domain/common.ts';
import type { OpsCommandInput } from '../domain/common.ts';
import { AssetsStateSchema, AssetIdSchema, emptyAssetsState } from '../domain/assets.ts';
import type { AssetsState, Asset } from '../domain/assets.ts';

export const assetsCommandSchemas = [
  Schema.TaggedStruct('AssetCreate', {
    inventoryNumber: TextSchema(64),
    name: TextSchema(200),
    category: TextSchema(120),
    location: Schema.optionalKey(PropertyRefSchema),
    note: Schema.optionalKey(NoteSchema),
  }),
] as const;

export const AssetsCommandSchema = Schema.Union(assetsCommandSchemas);
export type AssetsCommand = typeof AssetsCommandSchema.Type;
type CommandOf<Tag extends AssetsCommand['_tag']> = Extract<AssetsCommand, { readonly _tag: Tag }>;

const createAsset = Effect.fn('SiamparkOps.Assets.create')(function* createAsset(
  state: AssetsState,
  value: CommandOf<'AssetCreate'>,
  input: OpsCommandInput,
) {
  if (state.assets.some((entry) => entry.inventoryNumber.toLowerCase() === value.inventoryNumber.toLowerCase())) {
    return yield* opsConflict('An asset with this inventory number already exists');
  }
  const id = yield* mintId(AssetIdSchema, input.resourceId);
  const { _tag, ...fields } = value;
  void _tag;
  const record: Asset = { ...fields, ...auditCreated(input), id };
  const entity = yield* entityIdOf(id);
  return { entityIds: [entity], state: { ...state, assets: [...state.assets, record] } };
});

/** Pure reducer: applies one command to the `assets` state. Persistence decides when it is saved. */
export const evolveAssets = (state: AssetsState, command: AssetsCommand, input: OpsCommandInput) =>
  Match.value(command).pipe(
    Match.tag('AssetCreate', (value) => createAsset(state, value, input)),
    Match.exhaustive,
  );

export const assetsAgenda = defineAgenda({
  commandSchema: AssetsCommandSchema,
  empty: emptyAssetsState,
  evolve: evolveAssets,
  id: 'assets',
  sensitivity: 'restricted',
  stateSchema: AssetsStateSchema,
});
