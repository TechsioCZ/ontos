export const ultramodernVerticalIdentity = {
  appId: 'shell-super-app',
  build: 'd8373a68d162dd99',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp/shell-super-app',
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
