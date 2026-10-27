// Siampark properties with their units, read through property-portfolio's public records client (governed read).
// Used by the assets page to place an asset on a property or unit and to scope an inventory by property.
import { executeRecords as executePropertyRecords } from '@app/property-portfolio/clients/records';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import type { PropertyRef } from '../../../../../shared/domain/common.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';

export interface PropertyNode {
  readonly ref: PropertyRef;
  readonly units: readonly PropertyRef[];
}

export type PropertyTree =
  | { readonly status: 'loading' }
  | { readonly cause: Effect.Error<ReturnType<typeof executePropertyRecords>>; readonly status: 'failed' }
  | { readonly nodes: readonly PropertyNode[]; readonly status: 'ready' };

const propertyNodes = (response: Effect.Success<ReturnType<typeof executePropertyRecords>>): PropertyTree => {
  const nodes: PropertyNode[] = [];
  for (const property of response.properties) {
    const units: PropertyRef[] = [];
    for (const unit of response.units) {
      if (unit.propertyRef.resourceId === property.propertyRef.resourceId) {
        units.push({
          id: unit.unitRef.resourceId,
          kind: 'unit',
          label: `${property.name} › ${unit.name} (${unit.code})`,
        });
      }
    }
    nodes.push({
      ref: {
        id: property.propertyRef.resourceId,
        kind: 'property',
        label: `${property.name} (${property.code})`,
      },
      units,
    });
  }
  return { nodes, status: 'ready' };
};

export const usePropertyTree = (): PropertyTree => {
  const [tree, setTree] = useState<PropertyTree>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    void browserRuntime.runPromise(
      executePropertyRecords({}, 'facility-operations.assets.property-tree').pipe(
        Effect.match({
          onFailure: (cause): PropertyTree => ({ cause, status: 'failed' }),
          onSuccess: propertyNodes,
        }),
        Effect.tap((next) =>
          Effect.sync(() => {
            if (alive) {
              setTree(next);
            }
          }),
        ),
      ),
    );
    return () => {
      alive = false;
    };
  }, []);
  return tree;
};

/** Property id that owns a picked location (the property itself, or the parent of a unit). */
export const owningPropertyId = (tree: PropertyTree, location: PropertyRef | undefined): string | undefined => {
  if (location === undefined || tree.status !== 'ready') {
    return undefined;
  }
  if (location.kind === 'property') {
    return location.id;
  }
  return tree.nodes.find((node) => node.units.some((unit) => unit.id === location.id))?.ref.id;
};

/** Flat select items: each property followed by its units (indented label). */
export const locationItems = (tree: PropertyTree) =>
  tree.status === 'ready'
    ? tree.nodes.flatMap((node) => [
        { label: node.ref.label, ref: node.ref, value: `property:${node.ref.id}` },
        ...node.units.map((unit) => ({
          label: `   ${unit.label.split(' › ').at(-1) ?? unit.label}`,
          ref: unit,
          value: `unit:${unit.id}`,
        })),
      ])
    : [];
