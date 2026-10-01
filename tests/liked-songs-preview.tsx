// Synthetic fixture: no network calls, credentials, or real library changes.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LikedSongTools } from "../src/ui/components/LikedSongTools";
import { activateLikedHistory, beginLikedHistoryScan, finishLikedHistoryScan } from "../src/datasource/youtube/likedHistory";
import { emptyLikedHistory, reconcileLikedSongs, recordLikeAction } from "../src/datasource/youtube/likedHistoryModel";
import { matchesLikedDate, type LikedDateFilter } from "../src/datasource/youtube/likedDateFilter";
import "../src/ui/styles/global.css";

const now = Date.now();
const tracks = [
  { id: "fixture-one", title: "Recent favorite", artist: "Sample artist", source: "youtube" as const },
  { id: "fixture-two", title: "Older favorite", artist: "Second artist", source: "youtube" as const },
  { id: "fixture-three", title: "Undated favorite", artist: "Third artist", source: "youtube" as const },
];
const lost = { id: "fixture-lost", title: "A missing recording with a long title", artist: "Remembered artist", album: "Saved album", source: "youtube" as const };
const removed = { id: "fixture-removed", title: "Deliberately removed", artist: "Sample artist", source: "youtube" as const };
let history = reconcileLikedSongs(emptyLikedHistory(), [...tracks, lost, removed], now - 86400000);
history = recordLikeAction(history, removed, false, now - 3600000);
history = reconcileLikedSongs(history, tracks, now);
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: { value?: unknown; url?: string }) => {
  if (command === "app_setting_get") return history;
  if (command === "app_setting_set") { history = args.value as typeof history; return; }
  if (command === "plugin:opener|open_url") document.getElementById("opened")!.textContent = `Opened: ${args.url}`;
} } });
await activateLikedHistory("synthetic-preview");

const dates: Record<string, string> = { "fixture-one": new Date(now - 86400000).toISOString(), "fixture-two": "2020-01-01T12:00:00Z" };
function Preview() {
  const [filter, setFilter] = useState<LikedDateFilter>({ period: "all", from: "", to: "" });
  const visible = tracks.filter((track) => matchesLikedDate(dates[track.id], filter));
  return <main style={{ maxWidth: 940, margin: "auto", padding: 28, overflow: "auto", height: "100vh" }}>
    <h1>Liked Songs</h1><p>Synthetic preview</p>
    <LikedSongTools filter={filter} onFilterChange={setFilter} datesConnected unknownCount={1}
      totalCount={tracks.length} visibleCount={visible.length} refreshing={false}
      onRefresh={async () => { await finishLikedHistoryScan(beginLikedHistoryScan(), [...tracks, lost]); }} />
    <ul aria-label="Filtered songs">{visible.map((track) => <li key={track.id}>{track.title}</li>)}</ul>
    <p id="opened" role="status" />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
