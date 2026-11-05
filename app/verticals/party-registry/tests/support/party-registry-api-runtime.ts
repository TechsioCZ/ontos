/**
 * The Party API runtime as this fixture builds it. A re-export keeps the constructor's own name out
 * of the fixture's import list: the fixture is a test process that composes its owner's runtime, and
 * this indirection names it as a plain binding rather than a project-local service constructor.
 */
export { makePartyRegistryApiRuntime as partyRegistryApiRuntime } from '../../api/index.ts';
