export const ultramodernVerticalIdentity = {
  appId: 'shell-super-app',
  build: '73866e4b6807f22a',
  deployProfile: 'cloudflare-ssr-mf-effect-v1',
  packageName: '@mvp2/shell-super-app',
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
