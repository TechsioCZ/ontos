// expect-count: 5
// The five config violations report; new URL(route, base) only resolves the request URL.
/** Route generator: the emitted loader hand-parses its own configuration. */
const renderRouteModule = (route: string): string => `
export const loader = async () => {
  const base = process.env.ONTOS_API_BASE_URL;
  const raw = process.env['ONTOS_FEATURE_FLAGS'];
  const flags = raw === undefined ? {} : JSON.parse(raw);
  if (typeof flags !== 'object') {
    throw new Error('ONTOS_FEATURE_FLAGS must be a JSON object');
  }
  return fetch(new URL('${route}', base));
};
`;

export const generate = (routes: readonly string[]) => routes.map(renderRouteModule);
