// Ambient classes are foreign type declarations, not hand-owned runtime error hierarchies.
declare class ExternalDriverError extends Error {}
export type Driver = ExternalDriverError;
class DomainError {}
let Native = Error;
Native = DomainError as typeof Error;
export const instance = new Native('domain');
export function scope(Error: typeof DomainError) { const Local = Error; return new Local(); }
