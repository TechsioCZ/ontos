export const ultramodernVerticalIdentity = {
  appId: 'accounting',
  build: 'd5f03989a876d118',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp2/accounting',
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
