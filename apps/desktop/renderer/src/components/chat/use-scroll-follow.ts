import { useLayoutEffect, useRef } from "react";
import { ScrollFollow } from "./scroll-follow";

/** Resize observation covers streamed text, tool expansion, images, and viewport changes. */
export function useScrollFollow() {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(new ScrollFollow());
  const pendingFrame = useRef<number | null>(null);
  const moveToBottom = () => {
    const element = viewport.current;
    if (!element || !follow.current.following) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    follow.current.recordFollow(element.scrollTop);
  };
  const scheduleFollow = () => {
    if (pendingFrame.current !== null || !follow.current.following) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = null;
      moveToBottom();
    });
  };
  useLayoutEffect(() => {
    const element = viewport.current;
    const contents = content.current;
    if (!element || !contents) return;
    moveToBottom();
    const observer = new ResizeObserver(scheduleFollow);
    observer.observe(element);
    observer.observe(contents);
    return () => {
      observer.disconnect();
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = null;
    };
  }, []);
  return {
    viewport,
    content,
    jumpTo: (element: HTMLElement) => {
      const container = viewport.current;
      if (!container) return;
      follow.current.following = false;
      if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = null;
      container.scrollTop +=
        element.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    },
    onScroll: () => {
      const element = viewport.current;
      if (!element) return;
      const wasFollowing = follow.current.following;
      follow.current.observeScroll(element);
      if (!wasFollowing && follow.current.following) scheduleFollow();
    },
  };
}
