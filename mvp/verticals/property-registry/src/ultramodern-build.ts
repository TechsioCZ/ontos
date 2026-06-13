export const ultramodernVerticalIdentity = {
  appId: 'property-registry',
  build: '56fdaea94be0f3ad',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp/property-registry',
  version: '0.1.0',
} as const;

export const ultramodernUiMarker = {
  ...ultramodernVerticalIdentity,
  surface: 'ui',
} as const;

export const ultramodernApiMarker = {
  ...ultramodernVerticalIdentity,
  surface: 'effect-bff',
} as const;
