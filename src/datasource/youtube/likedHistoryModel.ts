import type { Track } from "../types";

export interface LikedSongRecord {
  track: Track;
  firstSeenAt: number;
  lastSeenAt: number;
  missingSince?: number;
  returnedAt?: number;
  removedByUserAt?: number;
}

export interface LikedHistory {
  version: 1;
  checkedAt: number;
  records: Record<string, LikedSongRecord>;
}

export function emptyLikedHistory(): LikedHistory {
  return { version: 1, checkedAt: 0, records: {} };
}

// Call only after every page has succeeded. Cached/partial lists are not evidence
// that a song disappeared. Keep metadata even when a song no longer has a page.
export function reconcileLikedSongs(history: LikedHistory, tracks: Track[], now: number): LikedHistory {
  const records = { ...history.records };
  const present = new Set(tracks.map((track) => track.id));
  for (const [id, record] of Object.entries(records)) {
    if (!present.has(id) && !record.missingSince && !record.removedByUserAt) {
      records[id] = { ...record, missingSince: now };
    }
  }
  for (const track of tracks) {
    const previous = records[track.id];
    records[track.id] = {
      track,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      returnedAt: previous?.missingSince ? now : previous?.returnedAt,
    };
  }
  return { version: 1, checkedAt: now, records };
}

export function recordLikeAction(history: LikedHistory, track: Track, liked: boolean, now: number): LikedHistory {
  const previous = history.records[track.id];
  return {
    ...history,
    records: {
      ...history.records,
      [track.id]: {
        track,
        firstSeenAt: previous?.firstSeenAt ?? now,
        lastSeenAt: liked ? now : previous?.lastSeenAt ?? now,
        returnedAt: liked && previous?.missingSince ? now : previous?.returnedAt,
        removedByUserAt: liked ? undefined : now,
      },
    },
  };
}

export function parseLikedHistory(value: unknown): LikedHistory {
  if (!value || typeof value !== "object") throw new Error("Invalid liked history");
  const history = value as LikedHistory;
  if (history.version !== 1 || !Number.isFinite(history.checkedAt) || !history.records
    || typeof history.records !== "object" || Array.isArray(history.records)) throw new Error("Invalid liked history");
  for (const [id, record] of Object.entries(history.records)) {
    if (!record || record.track?.id !== id || record.track.source !== "youtube"
      || typeof record.track.title !== "string" || typeof record.track.artist !== "string"
      || !Number.isFinite(record.firstSeenAt) || !Number.isFinite(record.lastSeenAt)
      || [record.missingSince, record.returnedAt, record.removedByUserAt]
        .some((time) => time !== undefined && !Number.isFinite(time))) throw new Error("Invalid liked history");
  }
  return history;
}
