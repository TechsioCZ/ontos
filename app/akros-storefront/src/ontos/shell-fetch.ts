import "server-only";

/** Reaches the OntOS Shell at its configured URL. */
export const shellFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);
