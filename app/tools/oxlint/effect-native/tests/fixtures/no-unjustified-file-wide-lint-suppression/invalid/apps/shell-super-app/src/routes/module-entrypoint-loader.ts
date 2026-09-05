// expect-count: 3
/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- The loader preserves the typed Effect error channel until the framework boundary. */
/* eslint-disable no-negated-condition, unicorn/no-negated-condition -- Closed route states read most clearly as error-versus-ready branches. */
// oxlint-disable no-redeclare

export interface RemoteEntry {
	readonly moduleId: string;
}

export const loadRemote = (moduleId: string): Promise<RemoteEntry> =>
	Promise.resolve({ moduleId }).then((entry) => entry);
