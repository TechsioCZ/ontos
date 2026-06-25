/// <reference types='react' />
/// <reference types='@modern-js/app-tools/types' />

declare const ULTRAMODERN_SITE_URL: string;
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.css';

declare module 'properties/Widget' {
  const Component: React.ComponentType<Record<string, never>>;
  export default Component;
}

declare module 'accounting/Widget' {
  const Component: React.ComponentType<Record<string, never>>;
  export default Component;
}
