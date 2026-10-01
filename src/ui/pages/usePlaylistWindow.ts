import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { playlistWindow, PLAYLIST_ROW_HEIGHT } from "./playlistWindow";

export function usePlaylistWindow(count: number, enabled: boolean, resetKey: string, trackPosition = false) {
  const listRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef(resetKey);
  const [range, setRange] = useState({ start: 0, end: 30, activeIndex: 0, viewportHeight: 0 });
  const jumped = useRef<{ index: number; scrollTop: number } | null>(null);
  const jumpToIndex = useCallback((index: number) => {
    const list = listRef.current;
    if (!list || !count) return;
    const target = Math.max(0, Math.min(count - 1, index));
    const root = list.closest<HTMLElement>("[data-page-scroll-root]");
    const offset = list.getBoundingClientRect().top - (root?.getBoundingClientRect().top ?? 0);
    (root ?? window).scrollBy({ top: offset + target * PLAYLIST_ROW_HEIGHT - 16, behavior: "instant" });
    // At the bottom the browser clamps scrolling; keep the selected visible
    // month active until the user actually scrolls again.
    jumped.current = { index: target, scrollTop: root?.scrollTop ?? window.scrollY };
    setRange(previous => ({ ...previous, activeIndex: target }));
  }, [count]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if ((!enabled && !trackPosition) || !list) return;
    const root = list.closest<HTMLElement>("[data-page-scroll-root]");
    const scroller = root ?? window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = list.getBoundingClientRect().top;
      const offset = (root?.getBoundingClientRect().top ?? 0) - top;
      const viewportHeight = root?.clientHeight ?? window.innerHeight;
      const next = playlistWindow(count, offset, viewportHeight);
      const scrollTop = root?.scrollTop ?? window.scrollY;
      if (jumped.current && Math.abs(jumped.current.scrollTop - scrollTop) > 1) jumped.current = null;
      const activeIndex = jumped.current?.index ?? Math.max(0, Math.min(count - 1, Math.floor((offset + 16) / PLAYLIST_ROW_HEIGHT)));
      setRange(previous => previous.start === next.start && previous.end === next.end && previous.activeIndex === activeIndex && previous.viewportHeight === viewportHeight
        ? previous : { ...next, activeIndex, viewportHeight });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    if (lastKey.current !== resetKey) {
      jumped.current = null;
      // A new filter/sort should not leave the user below its results.
      const offset = list.getBoundingClientRect().top - (root?.getBoundingClientRect().top ?? 0);
      if (offset < 0) scroller.scrollBy({ top: offset });
    }
    lastKey.current = resetKey;
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(list);
    if (root) observer.observe(root);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [count, enabled, resetKey, trackPosition]);
  const start = enabled ? Math.min(range.start, Math.max(0, count - 1)) : 0;
  const end = enabled ? Math.min(count, Math.max(start + 1, range.end)) : count;
  return { listRef, start, end, before: start * PLAYLIST_ROW_HEIGHT, after: (count - end) * PLAYLIST_ROW_HEIGHT,
    activeIndex: Math.max(0, Math.min(count - 1, range.activeIndex)), viewportHeight: range.viewportHeight, jumpToIndex };
}
