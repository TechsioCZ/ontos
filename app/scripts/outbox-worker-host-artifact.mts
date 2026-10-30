import { Option } from 'effect';

/**
 * The digest of the prebuilt Outbox Worker host artifact, served on the host's /status. A source run of the
 * host entry has none. scripts/materialize-outbox-worker.mjs compiles the deployment plan's host digest in
 * place of this module when it bundles the host.
 */
export const outboxHostArtifactDigest: Option.Option<string> = Option.none();
