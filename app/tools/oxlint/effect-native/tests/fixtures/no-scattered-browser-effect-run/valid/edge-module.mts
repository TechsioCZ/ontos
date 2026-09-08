// `.mts` module with top-level await and `import.meta`: no Effect runner, no report.
export const source = import.meta.url;

export const settled = await Promise.resolve(source);
