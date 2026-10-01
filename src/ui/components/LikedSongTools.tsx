import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLikedHistory } from "../../datasource/youtube/likedHistory";
import { invalidLikedDateRange, type LikedDateFilter, type LikedPeriod } from "../../datasource/youtube/likedDateFilter";
import styles from "./LikedSongTools.module.css";

interface Props {
  filter: LikedDateFilter;
  onFilterChange: (filter: LikedDateFilter) => void;
  onRefresh: () => Promise<void>;
  refreshing: boolean;
  datesConnected: boolean;
  unknownCount: number;
  visibleCount: number;
  totalCount: number;
}

function formatDate(time: number): string {
  return new Date(time).toLocaleString("en-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short",
  }) + " ET";
}

export function LikedSongTools({ filter, onFilterChange, onRefresh, refreshing, datesConnected, unknownCount, visibleCount, totalCount }: Props) {
  const { history, busy, error } = useLikedHistory();
  const [historyView, setHistoryView] = useState("missing");
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const missingCount = useMemo(() => Object.values(history.records).filter((record) => record.missingSince).length, [history.records]);
  const shown = useMemo(() => Object.values(history.records).filter((record) => {
    const matchesStatus = historyView === "missing" ? record.missingSince
      : historyView === "removed" ? record.removedByUserAt
      : record.returnedAt && !record.missingSince && !record.removedByUserAt;
    return matchesStatus && `${record.track.title} ${record.track.artist} ${record.track.album ?? ""}`
      .toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }).sort((a, b) => (b.missingSince ?? b.removedByUserAt ?? b.returnedAt ?? 0)
    - (a.missingSince ?? a.removedByUserAt ?? a.returnedAt ?? 0)), [history, historyView, query]);

  const open = (url: string) => {
    setActionError(null);
    void openUrl(url).catch(() => setActionError("Could not open the browser. Try again."));
  };

  return <section className={styles.tools} aria-label="Liked song filters and history">
    <div className={styles.controls}>
      <label>Liked during
        <select value={filter.period} onChange={(event) => onFilterChange({ ...filter, period: event.target.value as LikedPeriod })}>
          <option value="all">All time</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last 365 days</option>
          <option value="custom">Custom dates</option>
          <option value="unknown">Unknown date</option>
        </select>
      </label>
      {filter.period === "custom" && <>
        <label>From<input type="date" value={filter.from} max={filter.to || undefined}
          onChange={(event) => onFilterChange({ ...filter, from: event.target.value })} /></label>
        <label>Through<input type="date" value={filter.to} min={filter.from || undefined}
          onChange={(event) => onFilterChange({ ...filter, to: event.target.value })} /></label>
      </>}
      {filter.period !== "all" && <button type="button" onClick={() => onFilterChange({ period: "all", from: "", to: "" })}>Clear dates</button>}
      <span className={styles.count} role="status">{visibleCount} of {totalCount} songs</span>
    </div>
    {invalidLikedDateRange(filter) && <p role="alert">The start date must be on or before the end date.</p>}
    {filter.period !== "all" && <p>
      Filters include exact dates and estimates overlapping the selected period. {unknownCount} {unknownCount === 1 ? "song has" : "songs have"} no usable date;
      choose “Unknown date” to see them.
      {!datesConnected && " Connect liked song dates in Settings → About to load historical dates."}
    </p>}
    <div className={styles.checkStatus}>
      <span>{history.checkedAt ? `Last complete check: ${formatDate(history.checkedAt)}` : "The first complete check starts your song history."}</span>
      <button type="button" disabled={refreshing || busy} onClick={() => {
        setActionError(null);
        void onRefresh().catch(() => setActionError("Could not refresh Liked Songs. Previous history has been kept."));
      }}>{refreshing || busy ? "Checking…" : "Check now"}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    <details className={styles.history}>
      <summary>Song history · {missingCount} missing from Liked Songs</summary>
      <p>Saved on this device after complete checks. “Missing” means absent from the returned playlist;
        it can mean an unlike on another device, a YouTube limit, or an unavailable song. It does not prove deletion.
        Songs removed before tracking began cannot be recovered here.</p>
      <div className={styles.controls}>
        <label>Show<select value={historyView} onChange={(event) => setHistoryView(event.target.value)}>
          <option value="missing">Missing ({missingCount})</option>
          <option value="returned">Returned</option>
          <option value="removed">Removed in this app</option>
        </select></label>
        <label>Search history<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Song or artist" /></label>
      </div>
      {shown.length === 0 && <p>No songs match this history view.</p>}
      <ul className={styles.records}>
        {shown.map((record) => <li key={record.track.id}>
          <div className={styles.song}>
            <strong>{record.track.title}</strong>
            <span>{record.track.artist}{record.track.album ? ` · ${record.track.album}` : ""}</span>
            <small>Last seen: {formatDate(record.lastSeenAt)}</small>
            <small>{record.missingSince ? `Missing since: ${formatDate(record.missingSince)}`
              : record.removedByUserAt ? `Removed in this app: ${formatDate(record.removedByUserAt)}`
              : `Returned: ${formatDate(record.returnedAt!)}`}</small>
          </div>
          <div className={styles.recordActions}>
            <button type="button" onClick={() => open(`https://music.youtube.com/watch?v=${encodeURIComponent(record.track.id)}`)}>Open song</button>
            <button type="button" onClick={() => open(`https://music.youtube.com/search?q=${encodeURIComponent(`${record.track.title} ${record.track.artist}`)}`)}>Find replacement</button>
          </div>
        </li>)}
      </ul>
    </details>
  </section>;
}
