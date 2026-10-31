import { useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import {
  clampPanelWidth,
  draggedPanelWidth,
  readPanelWidth,
  savePanelWidth,
  subscribePanelWidth,
  serverPanelWidth,
} from './side-panel-width.ts';

interface PanelDrag {
  readonly pointerId: number;
  readonly previousWidth: number | undefined;
  readonly startWidth: number;
  readonly startX: number;
}

/** Local visual interaction only; the owning form and its draft are untouched. */
export const useSidePanelResize = () => {
  const content = useRef<HTMLDivElement | null>(null);
  const drag = useRef<PanelDrag | null>(null);
  const storedWidth = useSyncExternalStore(subscribePanelWidth, readPanelWidth, serverPanelWidth);
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const width = liveWidth ?? storedWidth;

  const boundedWidth = (next: number): number => {
    const node = content.current;
    if (node === null) {
      return next;
    }
    const minimum = Number(globalThis.getComputedStyle(node).minWidth.replace('px', '')) || 0;
    return clampPanelWidth(next, minimum, node.ownerDocument.documentElement.clientWidth);
  };

  const commitWidth = (next?: number) => {
    const saved = savePanelWidth(next);
    setLiveWidth(saved ? null : (next ?? null));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || content.current === null) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      previousWidth: width,
      startWidth: content.current.getBoundingClientRect().width,
      startX: event.clientX,
    };
  };

  const pointerWidth = (event: PointerEvent<HTMLButtonElement>): number | undefined => {
    const active = drag.current;
    return active?.pointerId === event.pointerId
      ? boundedWidth(draggedPanelWidth(active.startWidth, active.startX, event.clientX))
      : undefined;
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const next = pointerWidth(event);
    if (next !== undefined) {
      setLiveWidth(next);
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const next = pointerWidth(event);
    if (next !== undefined) {
      drag.current = null;
      commitWidth(next);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelDrag = () => {
    if (drag.current !== null) {
      setLiveWidth(drag.current.previousWidth ?? null);
      drag.current = null;
    }
  };

  const resetLiveWidth = () => {
    drag.current = null;
    commitWidth();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const node = content.current;
    if (node === null || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      resetLiveWidth();
      return;
    }
    const step = Number(globalThis.getComputedStyle(node).paddingLeft.replace('px', '')) * (event.shiftKey ? 4 : 1);
    const next =
      event.key === 'End'
        ? node.ownerDocument.documentElement.clientWidth
        : node.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? step : -step);
    commitWidth(boundedWidth(next));
  };

  return {
    contentRef: content,
    handleProps: {
      onDoubleClick: resetLiveWidth,
      onKeyDown,
      onLostPointerCapture: cancelDrag,
      onPointerCancel: cancelDrag,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
    width,
  };
};
