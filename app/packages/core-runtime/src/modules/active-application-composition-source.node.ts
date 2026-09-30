import { Config } from 'effect';

/** Node services read the snapshot from the Zerops project variable the publisher sets. */
export const encodedActiveApplicationCompositionSnapshot = Config.String(
  'ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON',
);
