import type { Asset } from './assets.ts';

/** Filter only the governed operations snapshot. Unit details must not show a sibling unit's equipment. */
export const assetsAtLocation = (assets: readonly Asset[], propertyId: string, unitId?: string): readonly Asset[] =>
  assets.filter((asset) =>
    unitId !== undefined && unitId !== ''
      ? asset.location?.kind === 'unit' && asset.location.id === unitId
      : asset.propertyId === propertyId || (asset.location?.kind === 'property' && asset.location.id === propertyId),
  );
