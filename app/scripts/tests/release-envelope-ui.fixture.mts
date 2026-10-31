import { Schema } from 'effect';

const RendererAppId = Schema.String.pipe(Schema.brand('AppId'));
const RendererBuildId = Schema.String.pipe(Schema.brand('BuildId'));
const RendererPackage = Schema.Struct({ name: Schema.String, version: Schema.String });
const RouterPackage = Schema.Struct({
  coreName: Schema.String,
  coreVersion: Schema.String,
  name: Schema.String,
  version: Schema.String,
});
const RouterPackageBinding = Schema.Struct({ ...RouterPackage.fields, framework: Schema.String });
const ownedRouterBinding = <Evidence extends 'file-routes' | 'owned-default'>(evidence: Evidence) =>
  Schema.Struct({
    defaultProvider: RouterPackageBinding,
    evidence: Schema.Literal(evidence),
    owner: Schema.String,
    providers: Schema.Tuple([RouterPackageBinding]),
  });
const RendererRouterBinding = Schema.Union([
  ownedRouterBinding('file-routes'),
  ownedRouterBinding('owned-default'),
  Schema.Struct({
    defaultProvider: RouterPackageBinding,
    evidence: Schema.Literal('provider-registry'),
    owner: Schema.String,
    providers: Schema.Array(RouterPackageBinding),
  }),
]);
/**
 * UltraModern 3.9.3 binds every UI surface and every release with a browser surface to the renderer
 * that built it. These are the renderer fields of a build artifact UI surface and of a release `ui`.
 */
export const ReleaseUiSchema = Schema.Struct({
  rendererIdentity: Schema.Struct({
    appId: RendererAppId,
    buildId: RendererBuildId,
    entryName: Schema.String,
    protocolVersion: Schema.Literal(1),
    renderer: Schema.String,
  }),
  rendererProfile: Schema.Struct({
    compiler: RendererPackage,
    hydration: RendererPackage,
    protocolVersion: Schema.Literal(1),
    renderer: Schema.String,
    router: RouterPackage,
  }),
  routerBindings: Schema.Record(Schema.String, RendererRouterBinding),
});
