import { TreeView } from "@techsio/ui-kit/molecules/tree-view";
import type { CategoryNode } from "@/ontos/catalog-navigation";

/** Figma214:3169: 32px navigation rows, without file-picker indent guides.
 * The kit keeps collection, selection, expansion and keyboard behavior. */
export const CategoryTreeNode = ({
  indexPath,
  node,
}: {
  indexPath: number[];
  node: CategoryNode;
}) => (
  <TreeView.NodeProvider indexPath={indexPath} node={node}>
    {node.children.length > 0 ? (
      <TreeView.Branch>
        <div className="grid min-h-(--dimension-32) items-center">
          <TreeView.BranchTrigger>
            <TreeView.BranchControl>
              <TreeView.BranchText />
            </TreeView.BranchControl>
            <TreeView.BranchIndicator />
          </TreeView.BranchTrigger>
        </div>
        <TreeView.BranchContent>
          {node.children.map((child, index) => (
            <CategoryTreeNode indexPath={[...indexPath, index]} key={child.id} node={child} />
          ))}
        </TreeView.BranchContent>
      </TreeView.Branch>
    ) : (
      <div className="grid min-h-(--dimension-32) items-center">
        <TreeView.Item>
          <TreeView.ItemText />
        </TreeView.Item>
      </div>
    )}
  </TreeView.NodeProvider>
);
