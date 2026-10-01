export const PLAYLIST_ROW_HEIGHT = 58;
export const PLAYLIST_OVERSCAN = 8;

export function playlistWindow(count: number, scrollTop: number, height: number) {
  const start = Math.max(0, Math.min(count, Math.floor(Math.max(0, scrollTop) / PLAYLIST_ROW_HEIGHT) - PLAYLIST_OVERSCAN));
  const end = Math.max(start, Math.min(count, Math.ceil((Math.max(0, scrollTop) + height) / PLAYLIST_ROW_HEIGHT) + PLAYLIST_OVERSCAN));
  return { start, end };
}
