import { Effect, FileSystem, Path, Schema } from 'effect';

/** Workspace-relative development overlay that owns every application's port, headless units included. */
export const DEVELOPMENT_OVERLAY_PATH = 'topology/local-overlays/development.json';

const DevelopmentOverlaySchema = Schema.fromJsonString(
  Schema.Struct({
    ports: Schema.Record(Schema.String, Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
  }),
);

/**
 * Reads application ports from the development overlay. UltraModern topology omits the Module Federation
 * boundary of headless (api-only) units, so their manifest URL can no longer carry the port.
 *
 * @param {string} root Workspace root.
 */
export const readDevelopmentPorts = (root) =>
  Effect.gen(function* readDevelopmentPortsEffect() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { ports } = yield* Schema.decodeUnknownEffect(DevelopmentOverlaySchema)(
      yield* fs.readFileString(path.join(root, DEVELOPMENT_OVERLAY_PATH)),
    );
    return ports;
  });
