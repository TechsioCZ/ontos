/**
 * A Worker has no Zerops project variable, and a Worker secret holds at most 5.1 kB while the snapshot
 * grows with every vertical. A placed consumer Worker therefore reads the published snapshot from this
 * Workers KV binding, under this key; the stage deploy writes it there once per publication.
 */
export const ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING = 'ONTOS_ACTIVE_APPLICATION_COMPOSITION';
export const ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY = 'active';
