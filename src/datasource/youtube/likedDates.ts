import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import type { PublicationDate } from "./likedDateEstimates";

interface DateStatus {
  connected: boolean;
  channelTitle: string | null;
  syncedAt: number;
  dates: Record<string, string>;
  lookupAfter?: Record<string, number>;
  publications?: Record<string, PublicationDate>;
}
interface DateState extends DateStatus {
  busy: boolean;
  error: string | null;
  lookupProgress?: { checked: number; total: number; kind?: "publications" } | null;
}
const empty: DateState = { connected: false, channelTitle: null, syncedAt: 0, dates: {}, busy: false, error: null };
let state = empty;
let generation = 0;
let hydration: Promise<void> | null = null;
let sync: Promise<void> | null = null;
let lookup: Promise<void> | null = null;
const listeners = new Set<() => void>();
function publish(update: Partial<DateState>): void {
  state = { ...state, ...update };
  listeners.forEach((listener) => listener());
}
function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message : "Could not load liked dates. Try again from Settings.";
}
export function hydrateLikedDates(): Promise<void> {
  if (!hydration) {
    const current = generation;
    hydration = invoke<DateStatus>("liked_dates_read").then((result) => {
      if (current === generation) publish(result);
    }).catch((error: unknown) => {
      if (current === generation) publish({ error: errorMessage(error) });
    });
  }
  return hydration;
}
export async function syncLikedDates(): Promise<void> {
  await hydrateLikedDates();
  if (!state.connected || state.busy) return sync ?? undefined;
  if (state.syncedAt && Date.now() / 1000 - state.syncedAt >= 29 * 86_400) {
    publish({ dates: {}, syncedAt: 0 });
  }
  // Avoid even an IPC check when the daily snapshot is fresh. Rust enforces
  // the same limit plus persisted failure backoff and single-flight fetching.
  if (state.syncedAt && Date.now() / 1000 - state.syncedAt < 86_400) return;
  if (!sync) {
    const current = generation;
    publish({ busy: true, error: null });
    sync = invoke<DateStatus>("liked_dates_sync").then((result) => {
      if (current === generation) publish(result);
    }).catch((error: unknown) => {
      if (current === generation) publish({ error: errorMessage(error) });
    }).finally(() => {
      if (current === generation) { sync = null; publish({ busy: false }); }
    });
  }
  return sync;
}
export async function connectLikedDates(): Promise<void> {
  if (state.busy) return;
  const current = ++generation;
  publish({ busy: true, error: null });
  let connected = false;
  try {
    const result = await invoke<DateStatus>("liked_dates_connect");
    if (current === generation) { publish(result); connected = true; }
  } catch (error) {
    if (current === generation) publish({ error: errorMessage(error) });
  } finally {
    if (current === generation) publish({ busy: false });
  }
  if (connected) await syncLikedDates();
}
export async function lookupMissingLikedDates(videoIds: string[]): Promise<void> {
  await syncLikedDates();
  if (lookup) await lookup;
  if (!state.connected || state.busy || !state.syncedAt) return;
  const now = Date.now() / 1000;
  const ids = [...new Set(videoIds)].filter((id) => /^[\w-]{11}$/.test(id));
  const publicationIds = ids.filter(id => !state.publications?.[id]?.publishedAt
    && (state.publications?.[id]?.retryAfter ?? 0) <= now).slice(0, 500);
  const kind = publicationIds.length ? "publications" : undefined;
  const missing = kind ? publicationIds : ids.filter((id) =>
    !state.dates[id] && (state.lookupAfter?.[id] ?? 0) <= now).slice(0, 200);
  if (!missing.length) return;
  const current = generation;
  // Retry throttling also survives failures that cannot return DateStatus.
  publish({ busy: true, error: null, lookupProgress: { checked: 0, total: missing.length, kind },
    ...(kind ? { publications: { ...state.publications, ...Object.fromEntries(missing.map(id => [id, {
      ...state.publications?.[id], publishedAt: state.publications?.[id]?.publishedAt ?? null,
      checkedAt: state.publications?.[id]?.checkedAt ?? 0, retryAfter: now + 30 * 60,
    }])) } } : { lookupAfter: { ...state.lookupAfter, ...Object.fromEntries(missing.map(id => [id, now + 30 * 60])) } }),
  });
  lookup = (async () => {
    let stopProgress = () => {};
    try {
      stopProgress = await listen<{ checked: number; total: number; kind?: "publications" }>("liked-dates-progress", ({ payload }) => {
        if (current === generation) publish({ lookupProgress: payload });
      });
      if (current !== generation) return;
      const result = await invoke<DateStatus>(kind ? "liked_dates_publications" : "liked_dates_lookup", { videoIds: missing });
      if (current === generation) publish(result);
    } catch (error: unknown) {
      if (current === generation) publish({ error: errorMessage(error) });
    } finally {
      stopProgress();
      if (current === generation) { lookup = null; publish({ busy: false, lookupProgress: null }); }
    }
  })();
  await lookup;
}
export async function disconnectLikedDates(): Promise<void> {
  ++generation;
  state = empty;
  hydration = null;
  sync = null;
  lookup = null;
  publish({ busy: true });
  try {
    await invoke("liked_dates_disconnect");
  } catch (error) {
    publish({ error: errorMessage(error) });
    throw error;
  } finally {
    publish({ busy: false });
  }
}
export async function invalidateLikedDate(videoId: string): Promise<void> {
  const current = generation;
  const dates = { ...state.dates };
  const lookupAfter = { ...state.lookupAfter };
  delete dates[videoId];
  delete lookupAfter[videoId];
  publish({ dates, lookupAfter });
  try {
    await invoke("liked_dates_invalidate", { videoId });
    // A pending scan may have completed while the invalidation waited for it.
    if (current === generation) {
      const latest = { ...state.dates };
      const latestLookup = { ...state.lookupAfter };
      delete latest[videoId];
      delete latestLookup[videoId];
      publish({ dates: latest, lookupAfter: latestLookup });
    }
  } catch (error) {
    if (current === generation) publish({ error: errorMessage(error) });
  }
}
export function useLikedDates(enabled = true): DateState {
  const snapshot = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state, () => empty);
  useEffect(() => {
    if (!enabled) return;
    if (state.syncedAt && Date.now() / 1000 - state.syncedAt >= 29 * 86_400) {
      publish({ dates: {}, syncedAt: 0 });
      hydration = null;
    }
    void hydrateLikedDates();
  }, [enabled]);
  return snapshot;
}

const dateLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const dateDetail = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });
export function formatLikedDate(value: string | undefined): { label: string; title: string } {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return { label: "—", title: "YouTube has not returned a date for this song. It remains in YouTube Music's playlist order." };
  return {
    label: dateLabel.format(date),
    title: `Added ${dateDetail.format(date)}`,
  };
}
