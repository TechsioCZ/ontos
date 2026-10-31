export function inspectTableLayout(table) {
  const failures = [];
  const compact = getComputedStyle(table).display === "block";
  const cells = table.querySelectorAll(compact ? "tbody td" : "thead th, tbody td");
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas color inspection is unavailable");

  const rgba = (color) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };

  const backgroundOf = (element) => {
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const color = rgba(getComputedStyle(ancestor).backgroundColor);
      if (color[3] === 255) return color;
    }
    return [255, 255, 255, 255];
  };

  for (const cell of cells) {
    const bounds = cell.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let textNode;

    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent.trim();
      if (!text) continue;
      const parent = textNode.parentElement;
      if (!parent || getComputedStyle(parent).visibility !== "visible") continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);

      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        let { left, right, top, bottom } = rect;

        // Account for intentionally clipped product titles and control contents.
        for (
          let ancestor = parent;
          ancestor && ancestor !== cell;
          ancestor = ancestor.parentElement
        ) {
          const style = getComputedStyle(ancestor);
          const clip = ancestor.getBoundingClientRect();
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
            left = Math.max(left, clip.left);
            right = Math.min(right, clip.right);
          }
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
            top = Math.max(top, clip.top);
            bottom = Math.min(bottom, clip.bottom);
          }
        }

        if (right <= left || bottom <= top) continue;
        if (
          left < bounds.left - 1 ||
          right > bounds.right + 1 ||
          top < bounds.top - 1 ||
          bottom > bounds.bottom + 1
        ) {
          failures.push({
            column: cell.cellIndex,
            text,
            problem: "text crosses cell bounds",
          });
        }

        const foreground = rgba(getComputedStyle(parent).color);
        const background = backgroundOf(parent);
        if (
          foreground[3] === 0 ||
          foreground.every((value, index) => value === background[index])
        ) {
          failures.push({ column: cell.cellIndex, text, problem: "text is invisible" });
        }
      }
    }

    for (const control of cell.querySelectorAll("button, input:not([type=hidden]), a")) {
      const rect = control.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      if (
        rect.left < bounds.left - 1 ||
        rect.right > bounds.right + 1 ||
        rect.top < bounds.top - 1 ||
        rect.bottom > bounds.bottom + 1
      ) {
        failures.push({ column: cell.cellIndex, problem: "control crosses cell bounds" });
      }
    }
  }

  return {
    failures,
    horizontalOverflow: table.parentElement.scrollWidth - table.parentElement.clientWidth,
  };
}
