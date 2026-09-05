// expect-count: 4
// Audit A3/A9 evidence shape: bundler-injected configuration parsed inside a route module.
export const apiBase = new URL(import.meta.env.VITE_API_BASE ?? 'http://localhost:3020');
export const isDevelopment = import.meta.env.MODE === 'development';

export function Banner() {
  const banner = import.meta.env.VITE_BANNER?.toLowerCase();
  return <div data-enabled={banner === 'on' ? 'yes' : 'no'}>{apiBase.host}</div>;
}
