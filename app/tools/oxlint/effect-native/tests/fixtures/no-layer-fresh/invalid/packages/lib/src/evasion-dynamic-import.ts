// expect-count: 4
declare const Base: unknown;

// A dynamic import binds the same module object as a static one.
export async function viaRootNamespace(): Promise<unknown> {
  const Effect = await import('effect');
  return Effect.Layer.fresh(Base as never);
}

export async function viaRootDestructure(): Promise<unknown> {
  const { Layer } = await import('effect');
  return Layer.fresh(Base as never);
}

export async function viaSubmodule(): Promise<unknown> {
  const LayerNs = await import('effect/Layer');
  return LayerNs['fresh'](Base as never);
}

export async function viaSubmoduleDestructure(): Promise<unknown> {
  const { fresh } = await import('effect/Layer');
  return fresh(Base as never);
}
