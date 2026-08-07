import path from 'node:path';

const normalize = (filePath: string): string => filePath.split(path.sep).join('/');

const privateOwnerSpecifierPattern = /vertical\.(?:manifest|registration)(?:\.ts)?$/u;

export const privateOwnerImportViolation = (
  root: string,
  file: string,
  specifier: string,
): string | undefined => {
  if (!privateOwnerSpecifierPattern.test(specifier)) {
    return undefined;
  }
  const ownerMatch = /^verticals\/(?<owner>[^/]+)\//u.exec(normalize(file));
  const owner = ownerMatch?.groups?.['owner'];
  if (owner === undefined || !specifier.startsWith('.')) {
    return 'Shell/Core and consumers may not import a deployment owner file';
  }
  const ownerRoot = path.resolve(root, 'verticals', owner);
  const resolved = path.resolve(root, path.dirname(file), specifier).replace(/\.ts$/u, '');
  const expectedManifest = path.join(ownerRoot, 'vertical.manifest');
  const expectedRegistration = path.join(ownerRoot, 'vertical.registration');
  return resolved === expectedManifest || resolved === expectedRegistration
    ? undefined
    : 'a MicroVertical may import only its own deployment owner files';
};
