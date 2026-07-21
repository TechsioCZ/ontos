// @effect-diagnostics extendsNativeError:off
export class MediaUploadRejectedError extends Error {
  readonly code: 'core.media.type_mismatch' | 'core.media.upload_too_large';

  constructor(code: 'core.media.type_mismatch' | 'core.media.upload_too_large', message: string) {
    super(message);
    this.code = code;
    this.name = 'MediaUploadRejectedError';
  }
}
