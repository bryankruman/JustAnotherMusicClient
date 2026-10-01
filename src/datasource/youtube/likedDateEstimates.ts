export interface PublicationDate {
  publishedAt: string | null;
  checkedAt: number;
  retryAfter: number;
}
export interface LikedDateEstimate {
  earliest: number;
  latest: number;
  usesPublication: boolean;
}

/** Input must be the complete playlist in YouTube's newest-first order. */
export function estimateLikedDates(
  tracks: readonly { id: string }[], exact: Record<string, string>,
  publications: Record<string, PublicationDate> = {}, now = Date.now(),
): Record<string, LikedDateEstimate> {
  const result: Record<string, LikedDateEstimate> = {};
  const known = tracks.map(track => {
    const value = Date.parse(exact[track.id] ?? "");
    return Number.isFinite(value) && value <= now ? value : NaN;
  });
  let start = 0;
  let upper = now;
  while (start < tracks.length) {
    if (Number.isFinite(known[start])) { upper = known[start++]; continue; }
    let end = start;
    while (end < tracks.length && !Number.isFinite(known[end])) end++;
    let lower = end < tracks.length ? known[end] : NaN;
    // A re-like or reordered/version-substituted song can contradict chronology.
    // Do not bridge that gap with invented precision.
    if (!Number.isFinite(lower) || lower <= upper) {
      let usesPublication = false;
      for (let i = end - 1; i >= start; i--) {
        const publication = publications[tracks[i].id];
        const published = Date.parse(publication?.publishedAt ?? "");
        // A later publication may reflect a private video becoming public or a
        // replacement upload. It cannot override the known added-date bound.
        if (Number.isFinite(published) && published > upper) continue;
        if (Number.isFinite(published) && (!Number.isFinite(lower) || published > lower)) {
          lower = published;
          usesPublication = true;
        }
        if (Number.isFinite(lower) && lower <= upper) {
          result[tracks[i].id] = { earliest: lower, latest: upper, usesPublication };
        }
      }
    }
    start = end;
  }
  return result;
}

const month = new Intl.DateTimeFormat("en-US", { month: "short" });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
export function formatLikedEstimate(estimate: LikedDateEstimate): { label: string; title: string } {
  const from = new Date(estimate.earliest), to = new Date(estimate.latest);
  const year = from.getFullYear(), endYear = to.getFullYear();
  const firstMonth = from.getMonth(), lastMonth = to.getMonth();
  let label: string;
  if (from.toDateString() === to.toDateString()) label = day.format(from);
  else if (year !== endYear) label = `${year}–${endYear}`;
  else if (firstMonth === lastMonth) label = `${month.format(from)} ${year}`;
  else label = String(year);
  return {
    label,
    title: `Estimated added date: ${day.format(from)} through ${day.format(to)}. Based on YouTube Music's playlist order${estimate.usesPublication ? " and video publication dates" : " and neighboring known added dates"}. Not an exact date; re-likes, replacement uploads, or privacy changes can affect this estimate.`,
  };
}
