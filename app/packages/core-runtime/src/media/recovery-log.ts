import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';

/*
 * The only operational log line Core Media recovery, and verified reads emit. It carries a
 * redacted correlation reference, a closed operation and category vocabulary and, for a provider failure, the
 * stable failure code. There is no free-text field: no byte, digest, credential, URL (signed or raw), token, file
 * name, storage key or provider message can be written through it, because the type has nowhere to put them.
 * The time is the logger's own.
 */

const RECOVERY_REF_DOMAIN = 'core.media.recovery.ref';
/** Sixteen hex characters: enough to correlate a retry with the attempt before it, far too few to recover the locator. */
const RECOVERY_REF_LENGTH = 16;

const MediaRecoveryOperationSchema = Schema.Literals(['verified_read', 'reconcile', 'integrity']);
type MediaRecoveryOperation = typeof MediaRecoveryOperationSchema.Type;

const MediaRecoveryCategorySchema = Schema.Literals([
  'completed',
  'closed_failed',
  'unresolved',
  'verified',
  'unavailable',
  'missing_object',
  'inconsistent_metadata',
  'integrity_failed',
]);
type MediaRecoveryCategory = typeof MediaRecoveryCategorySchema.Type;

export interface MediaRecoveryEvent {
  readonly category: MediaRecoveryCategory;
  readonly operation: MediaRecoveryOperation;
  /** The stable code of the provider failure class, when there was one. */
  readonly providerFailure?: string | undefined;
  /** From `mediaRecoveryRef`: the redacted reference of the object this event is about. */
  readonly ref: string;
}

/** A redacted, stable reference to one stored object: a fingerprint of the key, never the key itself. */
export const mediaRecoveryRef = (storageKey: string): string =>
  Hex.encode(sha256(utf8ToBytes(`${RECOVERY_REF_DOMAIN}\0${storageKey}`))).slice(0, RECOVERY_REF_LENGTH);

/** Only proven corruption is worth a warning; every other category is routine. */
const isWarning = (category: MediaRecoveryCategory): boolean => category === 'integrity_failed';

export const logMediaRecovery = (event: MediaRecoveryEvent): Effect.Effect<void> => {
  const annotations = {
    category: event.category,
    operation: event.operation,
    providerFailure: event.providerFailure ?? 'none',
    ref: event.ref,
  };
  const line = isWarning(event.category)
    ? Effect.logWarning('core.media.recovery')
    : Effect.logInfo('core.media.recovery');
  return line.pipe(Effect.annotateLogs(annotations));
};
