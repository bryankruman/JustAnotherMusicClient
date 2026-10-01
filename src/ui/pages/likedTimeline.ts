import type { LikedDateEstimate } from "../../datasource/youtube/likedDateEstimates";

export interface TimelineMonth { key: string; label: string; index: number }
export interface TimelineYear { key: string; label: string; index: number; months: TimelineMonth[] }
export interface TimelinePosition { year: string; month?: string }
const monthName = new Intl.DateTimeFormat("en-US", { month: "short" });

/** Build from the displayed order, keeping uncertain dates at their real precision. */
export function buildLikedTimeline(tracks: readonly { id: string }[], dates: Record<string, string>, estimates: Record<string, LikedDateEstimate>) {
  const years: TimelineYear[] = [];
  const positions: TimelinePosition[] = [];
  const seen = new Map<string, TimelineYear>();
  tracks.forEach((track, index) => {
    const exact = Date.parse(dates[track.id] ?? "");
    const estimate = estimates[track.id];
    const from = new Date(Number.isFinite(exact) ? exact : estimate?.earliest ?? NaN);
    const to = new Date(Number.isFinite(exact) ? exact : estimate?.latest ?? NaN);
    let yearKey = "unknown", yearLabel = "Unknown";
    let monthKey: string | undefined, monthLabel = "";
    if (Number.isFinite(from.getTime()) && Number.isFinite(to.getTime())) {
      const firstYear = from.getFullYear(), lastYear = to.getFullYear();
      if (firstYear !== lastYear) {
        yearKey = `range:${firstYear}-${lastYear}`;
        yearLabel = `${firstYear}–${lastYear}`;
      } else {
        yearKey = String(firstYear);
        yearLabel = yearKey;
        const firstMonth = from.getMonth(), lastMonth = to.getMonth();
        if (firstMonth === lastMonth) {
          monthKey = `${firstMonth}-${lastMonth}`;
          monthLabel = monthName.format(from);
        }
      }
    }
    let year = seen.get(yearKey);
    if (!year) {
      year = { key: yearKey, label: yearLabel, index, months: [] };
      seen.set(yearKey, year);
      years.push(year);
    }
    if (monthKey && !year.months.some(month => month.key === monthKey)) {
      year.months.push({ key: monthKey, label: monthLabel, index });
    }
    positions.push({ year: yearKey, month: monthKey });
  });
  return { years, positions };
}
