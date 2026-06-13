export const ultramodernVerticalIdentity = {
  appId: 'accounting-core',
  build: 'f8e72a9e938880d4',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp/accounting-core',
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
