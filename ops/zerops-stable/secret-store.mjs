// Service-secret transport. These are the public API operations used by zerops-public-api.mts.
// Credentials travel in request headers/bodies, never through a subprocess or an error message.
const API = 'https://api.app-prg1.zerops.io/api/rest/public';
const PAGE = 100;

export const createSecretStore = ({ token, fetchImpl = fetch, pollMs = 1000 }) => {
  if (typeof token !== 'string' || !token) throw new Error('ZEROPS_TOKEN is required');
  const request = async (method, route, body) => {
    let response;
    try {
      response = await fetchImpl(`${API}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`Zerops secret ${method} request failed`);
    }
    if (!response.ok) throw new Error(`Zerops secret ${method} request returned HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error('Zerops secret response was not JSON');
    }
  };
  const mutate = async (method, route, body) => {
    let process = await request(method, route, body);
    if (typeof process?.id !== 'string' || typeof process.status !== 'string') {
      throw new Error('Zerops secret mutation returned no process');
    }
    const deadline = Date.now() + 15 * 60_000;
    while (!['FINISHED', 'FAILED', 'CANCELED'].includes(process.status)) {
      if (Date.now() > deadline) throw new Error('Zerops secret mutation timed out');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      process = await request('GET', `/process/${encodeURIComponent(process.id)}`);
    }
    if (process.status !== 'FINISHED') throw new Error('Zerops secret mutation failed');
  };
  return {
    list: async (serviceId) => {
      const result = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await request('GET', `/service-stack/${encodeURIComponent(serviceId)}/user-data?limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(page?.list) || !Number.isSafeInteger(page.total) || page.total < 0) {
          throw new Error('Zerops secret listing has an invalid shape');
        }
        for (const entry of page.list) {
          if (typeof entry?.id !== 'string' || typeof entry.key !== 'string' || typeof entry.content !== 'string') {
            throw new Error('Zerops secret listing has an invalid entry');
          }
          result.push({ id: entry.id, key: entry.key, content: entry.content });
        }
        if (result.length >= page.total) return result;
        if (page.list.length === 0) throw new Error('Zerops secret listing ended before its declared total');
      }
    },
    create: (serviceId, key, content) =>
      mutate('POST', `/service-stack/${encodeURIComponent(serviceId)}/user-data`, { key, content, sensitive: true }),
    remove: (id) => mutate('DELETE', `/user-data/${encodeURIComponent(id)}`),
  };
};
