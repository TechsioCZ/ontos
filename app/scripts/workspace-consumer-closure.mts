export interface WorkspaceConsumer {
  readonly contractProducer?: string;
  readonly dependencies: readonly string[];
  readonly name: string;
}

/** Package consumers and contract producers are followed to a fixed point, including dependency cycles. */
export const workspaceConsumerClosure = (
  packages: readonly WorkspaceConsumer[],
  seeds: readonly string[],
): ReadonlySet<string> => {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of packages) {
      if (affected.has(entry.name) && entry.contractProducer !== undefined && !affected.has(entry.contractProducer)) {
        affected.add(entry.contractProducer);
        changed = true;
      }
      if (!affected.has(entry.name) && entry.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(entry.name);
        changed = true;
      }
    }
  }
  return affected;
};
