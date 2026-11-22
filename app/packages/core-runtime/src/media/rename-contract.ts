import { Schema } from 'effect';

import { MediaAssetRefSchema } from '../resources/media-asset.ts';
import { MediaDisplayFilenameSchema } from './upload-contract.ts';

/*
 * The public shape of the display-name rename. It names the asset and the new presentation name and nothing else:
 * there is no field through which any other column, the original file name, the content identity or the status
 * could be addressed, so no payload can turn the rename into a general edit of an asset.
 */

export const RenameDisplayFilenamePayloadSchema = Schema.Struct({
  displayFilename: MediaDisplayFilenameSchema,
  mediaAssetRef: MediaAssetRefSchema,
});
export type RenameDisplayFilenamePayload = typeof RenameDisplayFilenamePayloadSchema.Type;

export const RenameDisplayFilenameResultSchema = Schema.Struct({
  displayFilename: MediaDisplayFilenameSchema,
  mediaAssetRef: MediaAssetRefSchema,
});
