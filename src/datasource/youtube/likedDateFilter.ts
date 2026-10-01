export type LikedPeriod = "all" | "30" | "90" | "365" | "custom" | "unknown";

export interface LikedDateFilter {
  period: LikedPeriod;
  from: string;
  to: string;
}

// Date inputs are local calendar days; an inclusive end uses the next midnight
// so the final day includes all times, including on daylight-saving transitions.
function midnight(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}

export function invalidLikedDateRange(filter: LikedDateFilter): boolean {
  return filter.period === "custom" && Boolean(filter.from && filter.to && filter.from > filter.to);
}

export function matchesLikedDate(value: string | undefined, filter: LikedDateFilter, now = Date.now(), estimate?: { earliest: number; latest: number }): boolean {
  if (filter.period === "all") return true;
  const date = Date.parse(value ?? "");
  const known = Number.isFinite(date);
  if (filter.period === "unknown") return !known && !estimate;
  if ((!known && !estimate) || invalidLikedDateRange(filter)) return false;
  const earliest = known ? date : estimate!.earliest;
  const latest = known ? date : estimate!.latest;
  if (filter.period === "custom") {
    const end = filter.to ? new Date(midnight(filter.to)) : null;
    end?.setDate(end.getDate() + 1);
    return (!filter.from || latest >= midnight(filter.from)) && (!end || earliest < end.getTime());
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - Number(filter.period) + 1);
  return latest >= start.getTime() && earliest <= now;
}
