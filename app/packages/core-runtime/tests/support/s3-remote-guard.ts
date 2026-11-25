import { Result } from 'effect';

/*
 * The guard in front of the opt-in run of the Core Media S3 provider suite against a REAL endpoint. It decides from
 * values only (no connection), so it is unit-tested. A real endpoint is written to when, and only when:
 *   1. CORE_MEDIA_S3_ALLOW_REMOTE is exactly `1` (anything else is the refusal the suite always gave), and
 *   2. the bucket name contains the safety marker (default `-d20-test`, configurable with
 *      CORE_MEDIA_S3_TEST_BUCKET_MARKER, which must itself be at least five characters long).
 * The suite is a THROWAWAY-BUCKET suite: use a bucket created for it, never a bucket that holds real data.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const DEFAULT_BUCKET_MARKER = '-d20-test';
const MINIMUM_MARKER_CHARACTERS = 5;

export const LOOPBACK_ONLY_REFUSAL =
  'The S3 integration suite writes only to a loopback emulator unless CORE_MEDIA_S3_ALLOW_REMOTE=1';

type RemoteDecision = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly marker: string };

interface RemoteGuardInput {
  readonly bucket: string;
  readonly endpoint: URL;
  readonly environment: Readonly<
    Partial<Record<'CORE_MEDIA_S3_ALLOW_REMOTE' | 'CORE_MEDIA_S3_TEST_BUCKET_MARKER', string>>
  >;
}

export const remoteRunSettings = (input: RemoteGuardInput): Result.Result<RemoteDecision, string> => {
  if (LOOPBACK_HOSTS.has(input.endpoint.hostname)) {
    return Result.succeed({ kind: 'local' });
  }
  if (input.environment.CORE_MEDIA_S3_ALLOW_REMOTE !== '1') {
    return Result.fail(LOOPBACK_ONLY_REFUSAL);
  }
  const marker = input.environment.CORE_MEDIA_S3_TEST_BUCKET_MARKER ?? DEFAULT_BUCKET_MARKER;
  if (marker.length < MINIMUM_MARKER_CHARACTERS) {
    return Result.fail(
      `CORE_MEDIA_S3_TEST_BUCKET_MARKER must be at least ${MINIMUM_MARKER_CHARACTERS} characters: a short marker protects nothing`,
    );
  }
  return input.bucket.includes(marker)
    ? Result.succeed({ kind: 'remote', marker })
    : Result.fail(
        `Refusing to write to a remote bucket whose name does not contain the safety marker "${marker}": use a throwaway bucket created for this suite`,
      );
};
