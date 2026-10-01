/** Read every page before replacing a saved playlist snapshot. */
export async function collectPlaylistSnapshot<Page extends { has_continuation?: boolean; getContinuation(): Promise<Page> }, Item extends { id: string }>(
  initialPage: Page,
  readItems: (page: Page) => Item[],
  onComplete?: (counts: { pageCount: number; rowCount: number; uniqueCount: number }) => void,
): Promise<Item[]> {
  const tracks: Item[] = [];
  const seen = new Set<string>();
  let page = initialPage;
  let rowCount = 0;
  for (let count = 0; count < 200; count += 1) {
    const items = readItems(page);
    rowCount += items.length;
    for (const track of items) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
    }
    if (!page.has_continuation) {
      onComplete?.({ pageCount: count + 1, rowCount, uniqueCount: tracks.length });
      return tracks;
    }
    page = await page.getContinuation();
  }
  throw new Error("The playlist did not finish loading. Refresh to try again.");
}

// Playlist order also positions songs whose exact timestamp is unavailable.
// Sorting just known dates incorrectly buries recent likes.
export function playlistDateOrder<T>(tracks: T[], direction: "asc" | "desc"): T[] {
  return direction === "desc" ? tracks : [...tracks].reverse();
}

/** Some music video types leave the parser's id unset but retain a play link. */
export function playlistItemVideoId(item: {
  id?: string;
  endpoint?: { payload?: { videoId?: string } };
  flex_columns?: Array<{ title?: { runs?: Array<{ endpoint?: unknown }> } }>;
}): string | undefined {
  const direct = item.id || item.endpoint?.payload?.videoId;
  if (direct) return direct;
  for (const run of item.flex_columns?.[0]?.title?.runs ?? []) {
    const endpoint = run.endpoint as { payload?: { videoId?: string } } | undefined;
    const id = endpoint?.payload?.videoId;
    if (typeof id === "string" && /^[\w-]{11}$/.test(id)) return id;
  }
  return undefined;
}
