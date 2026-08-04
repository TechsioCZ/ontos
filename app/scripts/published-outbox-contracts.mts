export interface PublishedOutboxPackage {
  readonly exports?: Readonly<Record<string, unknown>>;
}

const outboxExportPattern = /^\.\/outbox\/(?<slug>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u;

export const publishedOutboxContractExports = (
  packageJson: PublishedOutboxPackage,
): readonly string[] =>
  Object.entries(packageJson.exports ?? {})
    .filter(([exportKey, target]) => {
      const match = outboxExportPattern.exec(exportKey);
      return match !== null && target === `./shared/outbox/${match.groups?.['slug'] ?? ''}.ts`;
    })
    .map(([exportKey]) => exportKey)
    .toSorted();

export const assertPublishedOutboxDependencyUsage = (input: {
  readonly dependencyPackageName: string;
  readonly dependencyPackageJson: PublishedOutboxPackage;
  readonly moduleSpecifiers: readonly string[];
}): void => {
  const contractExports = publishedOutboxContractExports(input.dependencyPackageJson);
  if (contractExports.length === 0) {
    throw new Error(
      `${input.dependencyPackageName} is not a published schema-only Outbox contract dependency`,
    );
  }
  const dependencySpecifiers = input.moduleSpecifiers.filter(
    (specifier) =>
      specifier === input.dependencyPackageName ||
      specifier.startsWith(`${input.dependencyPackageName}/`),
  );
  const allowedSpecifiers = new Set(
    contractExports.map((exportKey) => `${input.dependencyPackageName}${exportKey.slice(1)}`),
  );
  if (dependencySpecifiers.length === 0) {
    throw new Error(`${input.dependencyPackageName} is an unused cross-MicroVertical dependency`);
  }
  const forbiddenSpecifier = dependencySpecifiers.find(
    (specifier) => !allowedSpecifiers.has(specifier),
  );
  if (forbiddenSpecifier !== undefined) {
    throw new Error(`${forbiddenSpecifier} is not a published schema-only Outbox contract subpath`);
  }
};
