import { useEffect, useRef } from "react";
import type { TimelinePosition, TimelineYear } from "../pages/likedTimeline";
import styles from "./LikedTimeline.module.css";

export function LikedTimeline({ years, active, onJump, viewportHeight }: {
  years: TimelineYear[]; active?: TimelinePosition; onJump: (index: number) => void; viewportHeight: number;
}) {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !current) return;
    // Scroll only this rail, never the song list or the application window.
    const bounds = nav.getBoundingClientRect(), item = current.getBoundingClientRect();
    if (item.top < bounds.top) nav.scrollTop -= bounds.top - item.top + 8;
    else if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom + 8;
  }, [active?.year, active?.month, years]);
  return <nav ref={navRef} className={styles.timeline} aria-label="Liked songs timeline"
    style={{ maxHeight: viewportHeight ? Math.max(100, viewportHeight - 32) : undefined }}>
    <div className={styles.heading}>Timeline</div>
    {years.map(year => {
      const expanded = year.key === active?.year;
      return <div key={year.key} className={styles.year}>
        <button type="button" className={`${styles.yearButton} ${expanded ? styles.activeYear : ""}`}
          aria-label={`Jump to ${year.label}`} aria-expanded={year.months.length ? expanded : undefined}
          aria-current={expanded && !active?.month ? "location" : undefined}
          onClick={() => onJump(year.index)}>
          <span aria-hidden="true" className={styles.chevron}>{year.months.length ? (expanded ? "▾" : "▸") : "·"}</span>
          {year.label}
        </button>
        {expanded && year.months.length > 0 && <div className={styles.months}>
          {year.months.map(month => <button type="button" key={month.key}
            aria-label={`Jump to ${month.label} ${year.label}`}
            aria-current={active?.month === month.key ? "location" : undefined}
            onClick={() => onJump(month.index)}>{month.label}</button>)}
        </div>}
      </div>;
    })}
  </nav>;
}
