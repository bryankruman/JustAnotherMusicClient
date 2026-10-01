import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { Track } from "../types";
import { emptyLikedHistory, parseLikedHistory, reconcileLikedSongs, recordLikeAction, type LikedHistory } from "./likedHistoryModel";

interface HistoryState {
  history: LikedHistory;
  busy: boolean;
  error: string | null;
}
let state: HistoryState = { history: emptyLikedHistory(), busy: false, error: null };
let activeScope: string | null = null;
let generation = 0;
let revision = 0;
let hydration: Promise<void> = Promise.resolve();
let writes: Promise<unknown> = Promise.resolve();
let unreadable = false;
const listeners = new Set<() => void>();
const storageKey = (scope: string) => `liked-song-history:v1:${scope}`;
function publish(update: Partial<HistoryState>) {
  state = { ...state, ...update };
  listeners.forEach((listener) => listener());
}

export function deactivateLikedHistory(): void {
  ++generation;
  ++revision;
  activeScope = null;
  unreadable = false;
  hydration = Promise.resolve();
  publish({ history: emptyLikedHistory(), busy: false, error: null });
}

export async function activateLikedHistory(scope: string): Promise<void> {
  if (scope !== activeScope) {
    deactivateLikedHistory();
    activeScope = scope;
    const current = generation;
    publish({ busy: true });
    hydration = (async () => {
      try {
        await writes;
        const value = await invoke<unknown>("app_setting_get", { key: storageKey(scope) });
        const history = value === null ? emptyLikedHistory() : parseLikedHistory(value);
        if (current === generation) publish({ history, busy: false });
      } catch {
        // Never replace an unreadable archive with a new empty baseline.
        if (current === generation) {
          unreadable = true;
          publish({ busy: false, error: "Could not read saved liked-song history. The saved history has been kept. Restart the app to retry." });
        }
      }
    })();
  }
  await hydration;
}

export function beginLikedHistoryScan() {
  publish({ busy: true });
  return { scope: activeScope, generation, revision };
}
type Scan = ReturnType<typeof beginLikedHistoryScan>;

async function save(history: LikedHistory): Promise<void> {
  const scope = activeScope;
  const current = generation;
  if (!scope) return;
  const write = writes.then(() => invoke("app_setting_set", { key: storageKey(scope), value: history }));
  writes = write.catch(() => {});
  try {
    await write;
    if (current === generation) publish({ error: null });
  } catch {
    if (current === generation) publish({ error: "Could not save liked-song history. Keep the app open and check again to retry." });
  }
}

export async function finishLikedHistoryScan(scan: Scan, tracks: Track[]): Promise<void> {
  if (scan.generation !== generation || scan.scope !== activeScope) return;
  publish({ busy: false });
  // A like/unlike during pagination makes that response stale.
  if (scan.revision !== revision || unreadable) return;
  ++revision;
  const history = reconcileLikedSongs(state.history, tracks, Date.now());
  publish({ history });
  await save(history);
}

export function failLikedHistoryScan(scan: Scan): void {
  if (scan.generation === generation) publish({ busy: false, ...(unreadable ? {} : { error: "Could not complete the liked-song check. Previous history has been kept; try Check now again." }) });
}

export async function noteLikedSongAction(track: Track, liked: boolean): Promise<void> {
  const current = generation;
  ++revision;
  await hydration;
  if (current !== generation || !activeScope || unreadable) return;
  const history = recordLikeAction(state.history, track, liked, Date.now());
  publish({ history });
  await save(history);
}

export function useLikedHistory(): HistoryState {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state);
}
