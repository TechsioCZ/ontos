/**
 * The surface a host edge needs to deliver the bytes of a Media Asset: the object storage port and its S3
 * adapter, the stored-object channel of the governed download Read, the verified byte stream, its response
 * headers and the integrity port. Core Media is Core-owned, not a MicroVertical: only the composing host (the
 * Shell) imports this.
 */
export { assetDownloadRead } from '../generated-reads/asset-download.ts';
export { MediaDownloadSource } from './download-contract.ts';
export { streamConfirmedBytes } from './download.ts';
export { downloadResponseHeaders } from './download-headers.ts';
export { MediaIntegrityRecorder, integrityRecordRequest } from './integrity-recorder.ts';
export { ProvenMediaIntegrityFinding } from './integrity-contract.ts';
export { logMediaRecovery, mediaRecoveryRef } from './recovery-log.ts';
export { ObjectStorage, unconfiguredObjectStorage } from './object-storage.ts';
export { loadS3ObjectStorageConfig, mediaDigestStepTimeoutLayer } from './s3-config.ts';
export { DigestStepTimeout } from './content-digest.ts';
export { makeS3ObjectStorage } from './s3-object-storage.ts';
export { recordAssetIntegrityFailureAction } from '../modules/actions/record-asset-integrity-failure.action.ts';
export type { MediaVerifiableAsset as MediaVerifiableAssetOffer } from './verified-read.ts';
