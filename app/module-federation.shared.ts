type SharedRuntimeVersions = Readonly<
  Record<
    | '@modern-js/plugin-i18n/runtime'
    | '@modern-js/runtime'
    | '@tanstack/react-router'
    | 'react'
    | 'react-dom',
    string
  >
>;

/** Both delivery units must use the same singleton sharing policy. */
export const createSharedRuntimeConfig = (versions: SharedRuntimeVersions) => ({
  '@modern-js/plugin-i18n/runtime': {
    import: '@modern-js/plugin-i18n/runtime/no-react-i18next',
    requiredVersion: versions['@modern-js/plugin-i18n/runtime'],
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  },
  '@modern-js/runtime': {
    requiredVersion: versions['@modern-js/runtime'],
    singleton: true,
    treeShaking: false,
  },
  '@tanstack/react-router': {
    requiredVersion: versions['@tanstack/react-router'],
    singleton: true,
    treeShaking: false,
  },
  react: {
    requiredVersion: versions.react,
    singleton: true,
    treeShaking: false,
  },
  'react-dom': {
    requiredVersion: versions['react-dom'],
    singleton: true,
    treeShaking: false,
  },
  'react-dom/client': {
    requiredVersion: versions['react-dom'],
    singleton: true,
    treeShaking: false,
  },
});
