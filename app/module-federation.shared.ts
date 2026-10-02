type SharedRuntimeVersions = Readonly<
  Record<
    '@modern-js/plugin-i18n/runtime' | '@modern-js/runtime' | '@tanstack/react-router' | 'react' | 'react-dom',
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
    strictVersion: true,
    treeShaking: false,
  },
  '@tanstack/react-router': {
    requiredVersion: versions['@tanstack/react-router'],
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  },
  react: {
    requiredVersion: versions.react,
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  },
  'react-dom': {
    requiredVersion: versions['react-dom'],
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  },
  'react-dom/client': {
    requiredVersion: versions['react-dom'],
    singleton: true,
    strictVersion: true,
    treeShaking: false,
  },
});

/**
 * Packages every Shell and browser remote shares as strict singletons. Application Composition pins
 * exactly these versions, so the list derives from the one sharing policy above instead of a copy.
 */
export const governedSharedSingletonPackages: readonly string[] = Object.freeze(
  Object.keys(
    createSharedRuntimeConfig({
      '@modern-js/plugin-i18n/runtime': '',
      '@modern-js/runtime': '',
      '@tanstack/react-router': '',
      react: '',
      'react-dom': '',
    }),
  ),
);
