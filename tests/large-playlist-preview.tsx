// Synthetic performance fixture. No real credentials, songs, or network requests.
import { createRoot } from "react-dom/client";
import "../src/ui/styles/global.css";
const tracks = Array.from({ length: 5000 }, (_, i) => ({ id: `song${String(i).padStart(7, "0")}`, title: `Song ${String(i + 1).padStart(4, "0")}`, artist: "Sample artist", source: "youtube" as const }));
const dates = Object.fromEntries(tracks.slice(0, 1135).map(t => [t.id, "2026-09-23T16:40:17Z"]));
const lookupAfter = Object.fromEntries(tracks.map(t => [t.id, Date.now() / 1000 + 86400]));
const publications = Object.fromEntries([...tracks.map(t => t.id), "new00000000"].map(id => [id,
  { publishedAt: null, checkedAt: Date.now() / 1000, retryAfter: Date.now() / 1000 + 604800 }]));
if (new URLSearchParams(location.search).has("estimates")) {
  for (const id of Object.keys(dates)) delete dates[id];
  for (const [index, date] of [[0, "2023-08-01"], [2, "2022-12-31"], [4, "2022-01-01"],
    [5, "2021-08-31"], [7, "2021-06-01"], [8, "2021-05-31"], [10, "2021-05-01"],
    [11, "2021-04-15"], [13, "2021-04-15"]] as const) dates[tracks[index].id] = `${date}T12:00:00-04:00`;
  for (const [index, label] of [[1, "Year range"], [3, "Year"], [6, "Month range"], [9, "Month"], [12, "Day"]] as const) {
    tracks[index].title = `Estimate: ${label}`;
  }
}
const status = () => ({ connected: true, channelTitle: "Synthetic account", syncedAt: Date.now() / 1000, dates, lookupAfter, publications });
if (new URLSearchParams(location.search).has("timeline")) {
  tracks.forEach((track, index) => {
    dates[track.id] = new Date(Date.UTC(2026, 8 - Math.floor(index / 80), 15, 16)).toISOString();
  });
}
Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 0, unregisterCallback: () => {}, invoke: async (command: string, args: any) => {
  if (command === "liked_dates_read") return status();
  if (command === "liked_dates_lookup") { await new Promise(resolve => setTimeout(resolve, 15000)); for(const id of args.videoIds) lookupAfter[id] = Date.now() / 1000 + 86400; return status(); }
  if (command === "plugin:event|listen") return 1;
  if (command === "app_setting_get") return null;
  if (command === "cache_get") return null;
  return null;
} } });
window.fetch = async () => { throw new Error("Network disabled in synthetic fixture"); };
const { PlaylistView } = await import("../src/ui/pages/PlaylistView");
const { TrackContextMenuProvider } = await import("../src/ui/components/TrackContextMenu");
const { PlaylistContextMenuProvider } = await import("../src/ui/components/PlaylistContextMenu");
const { lookupMissingLikedDates } = await import("../src/datasource/youtube/likedDates");
const libraryController = { getPlaylistTrackPage: async () => ({ tracks, hasMore: false }) } as any;
const playerController = { playTrackById: async (id: string, queue: typeof tracks) => {
  document.getElementById("played")!.textContent = `Selected ${id}; queue contains ${queue.length} songs`; return true;
} } as any;
createRoot(document.getElementById("root")!).render(<main data-page-scroll-root style={{ height: "100vh", overflowY: "auto" }}>
  <p>Synthetic performance check · 5,000 songs</p>
  <button onClick={() => void lookupMissingLikedDates(["new00000000"])}>Simulate slow date lookup</button>
  <p id="played" role="status" />
  <TrackContextMenuProvider libraryController={libraryController}><PlaylistContextMenuProvider libraryController={libraryController}>
    <PlaylistView playlist={{ id: "LM", kind: "liked-songs", title: "Liked Songs", owner: "Synthetic account" }} libraryController={libraryController} playerController={playerController} />
  </PlaylistContextMenuProvider></TrackContextMenuProvider>
</main>);
