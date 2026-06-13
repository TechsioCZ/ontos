/// <reference types='react' />
/// <reference types='@modern-js/app-tools/types' />

declare const ULTRAMODERN_SITE_URL: string;
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.css';

declare module 'propertyRegistry/Widget' {
  const Component: React.ComponentType<Record<string, never>>;
  export default Component;
}

declare module 'accountingCore/Widget' {
  const Component: React.ComponentType<Record<string, never>>;
  export default Component;
}
