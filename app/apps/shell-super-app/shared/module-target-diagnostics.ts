/** Diagnostic hints only. Never used for authorization or target selection. */
export const moduleTargetSourceHeader = 'x-ontos-target-source';
export const moduleTargetSourcePathHeader = 'x-ontos-target-source-path';
export const moduleTargetSources = ['browser_page', 'home', 'menu_prefetch', 'server_render'] as const;
export type ModuleTargetSource = (typeof moduleTargetSources)[number];
