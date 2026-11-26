// Catalog product images stored in Core Media: the link target the assign Action stores an uploaded image under and
// the governed byte read serves it from. The Catalog media assignment names the asset; Core Media holds the bytes.
import type { MediaLinkTarget } from '@app/core-runtime';

export const CATALOG_MEDIA_OWNER_MODULE = 'core.media';
export const CATALOG_MEDIA_OWNER_TYPE = 'core.media.asset';

export const catalogMediaLinkTarget = (productId: string): MediaLinkTarget => ({
  linkKind: 'catalog_media',
  moduleKey: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
});
