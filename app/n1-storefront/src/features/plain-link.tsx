import { Link as KitLink } from "@techsio/ui-kit/atoms/link";
import type { LinkProps } from "@techsio/ui-kit/atoms/link";
import type { ElementType } from "react";

/**
 * The UI-kit Link as the N1 design uses it: it inherits the surrounding colour and size and has no underline, the way
 * the Figma screens were built. Since ui-kit 0.58 the Link brings its own colour, size and underline, which on the
 * dark header made the links invisible. A caller's own classes still win.
 */
export const Link = <T extends ElementType = "a">(props: LinkProps<T>) => (
  <KitLink<T>
    {...props}
    className={
      props.className === undefined
        ? "text-current no-underline"
        : `text-current no-underline ${props.className}`
    }
    size={props.size ?? "current"}
  />
);
