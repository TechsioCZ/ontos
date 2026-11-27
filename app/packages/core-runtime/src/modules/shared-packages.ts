/** The design system. The Shell provides every one of its subpaths; a browser remote never ships a copy. */
export const UI_KIT_PACKAGE = '@techsio/ui-kit';

const isUiKitSubpath = (name: string): boolean => name.startsWith(`${UI_KIT_PACKAGE}/`);

/**
 * The shared entries of a Module Federation manifest as packages: the kit has no root export, so its subpaths
 * become one kit entry at the version the first claims, and a composition pins the kit once, like React.
 */
export const sharedPackagesOf = <Entry extends { readonly name: string }>(
  shared: readonly Entry[],
): readonly Entry[] => {
  const kit = shared.find(({ name }) => isUiKitSubpath(name));
  return kit === undefined
    ? shared
    : [...shared.filter(({ name }) => !isUiKitSubpath(name)), { ...kit, name: UI_KIT_PACKAGE }];
};
