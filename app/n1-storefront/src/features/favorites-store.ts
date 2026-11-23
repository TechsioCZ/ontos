"use client";

import { useSyncExternalStore } from "react";
import { Effect, Option, Schema } from "effect";
import { clientRuntime } from "@/ontos/client-runtime";

const referencePart = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const referenceSchema = Schema.Struct({
  productId: referencePart,
  slug: referencePart,
  variantId: Schema.NullOr(referencePart),
});
export type FavoriteReference = typeof referenceSchema.Type;

const storageKey = "n1-favorites-v1";
const changedEvent = "n1-favorites-changed";
const unavailable = Symbol("favorites-storage-unavailable");
const emptyReferences: readonly FavoriteReference[] = [];
const serverSnapshot = { available: true, ready: false, references: emptyReferences };
const unavailableSnapshot = { available: false, ready: true, references: emptyReferences };
const getServerSnapshot = () => serverSnapshot;
let cached: { raw: string | null; snapshot: typeof serverSnapshot } | null = null;
class FavoritesStorageUnavailable extends Schema.TaggedError<FavoritesStorageUnavailable>()(
  "FavoritesStorageUnavailable",
  {},
) {}

export const favoriteKey = ({ productId, variantId }: FavoriteReference) =>
  JSON.stringify([productId, variantId]);

const decodeFavorite = Schema.decodeUnknownOption(referenceSchema);
const decodeRecords = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const readReferences = (raw: string | null): readonly FavoriteReference[] => {
  const records = Option.getOrElse(decodeRecords(raw), () => []);
  const references = new Map<string, FavoriteReference>();
  for (const record of records) {
    const reference = decodeFavorite(record);
    if (Option.isSome(reference)) {
      references.set(favoriteKey(reference.value), reference.value);
    }
  }
  return [...references.values()];
};

const getRawStorage = () => {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return unavailable;
  }
};

const getSnapshot = () => {
  const raw = getRawStorage();
  if (raw === unavailable) {
    return unavailableSnapshot;
  }
  if (cached?.raw !== raw) {
    cached = { raw, snapshot: { available: true, ready: true, references: readReferences(raw) } };
  }
  return cached.snapshot;
};

const subscribe = (onChange: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changedEvent, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changedEvent, onChange);
  };
};

export const useFavorites = () => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export const updateFavorites = (
  change: (references: readonly FavoriteReference[]) => readonly FavoriteReference[],
) =>
  clientRuntime.runSync(
    Effect.try({
      catch: () => new FavoritesStorageUnavailable(),
      try: () => {
        const references = readReferences(window.localStorage.getItem(storageKey));
        window.localStorage.setItem(storageKey, JSON.stringify(change(references)));
        window.dispatchEvent(new Event(changedEvent));
      },
    }).pipe(Effect.match({ onFailure: () => false, onSuccess: () => true })),
  );

export const setFavorite = (reference: FavoriteReference, saved: boolean) =>
  updateFavorites((references) => {
    const rest = references.filter((item) => favoriteKey(item) !== favoriteKey(reference));
    return saved ? [...rest, reference] : rest;
  });
