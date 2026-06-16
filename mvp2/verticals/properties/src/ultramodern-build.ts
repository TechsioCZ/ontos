export const ultramodernVerticalIdentity = {
  appId: 'properties',
  build: '957d201f97fe501a',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp2/properties',
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
