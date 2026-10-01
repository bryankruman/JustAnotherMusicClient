import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowsShuffle,
  IconHeart,
  IconLoader2,
  IconPlayerPlay,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { formatLikedDate, lookupMissingLikedDates, syncLikedDates, useLikedDates } from "../../datasource/youtube/likedDates";
import { playlistDateOrder } from "../../datasource/youtube/playlistSnapshot";
import { estimateLikedDates, formatLikedEstimate } from "../../datasource/youtube/likedDateEstimates";
import { usePlaylistWindow } from "./usePlaylistWindow";
import { buildLikedTimeline } from "./likedTimeline";
import { LikedTimeline } from "../components/LikedTimeline";
import { matchesLikedDate, type LikedDateFilter } from "../../datasource/youtube/likedDateFilter";
import { LikedSongTools } from "../components/LikedSongTools";
import type { Playlist, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { markPlaylistPlayed } from "../../player/recentPlaylists";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { isLocalPlaylist, reorderLocalPlaylistTracks } from "../../player/localPlaylists";
import styles from "./AlbumView.module.css";
import { ArtistLinks } from "../components/ArtistLinks";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { TrackArtwork } from "../components/TrackArtwork";
import { useKeyboardShortcuts } from "../settings/keyboardShortcuts";
import { shouldStartPageSearch } from "./pageSearchKeyboard";
import { PlaylistDownloadButton } from "../components/PlaylistDownloadButton";
import { DownloaderStatusBadge } from "../components/DownloaderStatusBadge";

interface PlaylistViewProps {
  playlist?: Playlist;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

type PlaylistSort = "dateAdded" | "name" | "album";
type SortDirection = "asc" | "desc";

const playlistSorts: Array<{ value: PlaylistSort; label: string }> = [
  { value: "name", label: "Name" },
  { value: "album", label: "Album" },
  { value: "dateAdded", label: "Date Added" },
];

function compareText(left: string | undefined, right: string | undefined): number {
  return (left || "\uffff").localeCompare(right || "\uffff", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function getDirectionLabel(sort: PlaylistSort, direction: SortDirection): string {
  if (sort === "dateAdded") return direction === "desc" ? "Newest" : "Oldest";
  return direction === "asc" ? "Asc" : "Desc";
}

function SortDirectionIcon({ direction }: { direction: SortDirection }) {
  return direction === "asc"
    ? <IconArrowUp size={13} stroke={2.2} aria-hidden="true" />
    : <IconArrowDown size={13} stroke={2.2} aria-hidden="true" />;
}

function getTrackKey(track: Track): string {
  return track.playlistItemId ?? track.id;
}

function getTrackRenderKey(track: Track, index: number): string {
  return track.playlistItemId ?? `${track.id}:${index}`;
}

function getUniqueNewTracks(current: Track[], next: Track[]): Track[] {
  const existingIds = new Set(current.map((track) => track.id));
  return next.filter((track) => {
    if (existingIds.has(track.id)) return false;
    existingIds.add(track.id);
    return true;
  });
}

function PlaylistLoadingSpinner({ label }: { label: string }) {
  return (
    <div className={styles.loadingState} role="status" aria-live="polite" aria-label={label}>
      <IconLoader2 className={styles.loadingIcon} size={30} aria-hidden="true" />
    </div>
  );
}

export function PlaylistView({ playlist, playerController, libraryController }: PlaylistViewProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu } = usePlaylistContextMenu();
  const keyboardShortcuts = useKeyboardShortcuts();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreTracks, setHasMoreTracks] = useState(false);
  const [nextPageKey, setNextPageKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [enteringTrackKeys, setEnteringTrackKeys] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<PlaylistSort>("dateAdded");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [playlistSearchQuery, setPlaylistSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<LikedDateFilter>({ period: "all", from: "", to: "" });
  const [isCheckingLikes, setIsCheckingLikes] = useState(false);
  const [dropTargetIndex, setDropTargetIndex] = useState<{ localPath: string; insertAfter: boolean } | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const playlistSearchInputRef = useRef<HTMLInputElement | null>(null);
  const playlistIdRef = useRef<string | undefined>(undefined);
  const isLoadingMoreRef = useRef(false);
  const tracksRef = useRef<Track[]>([]);
  const pointerDragRef = useRef<{
    pointerId: number;
    localPath: string;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const dropTargetRef = useRef<{ localPath: string; insertAfter: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  playlistIdRef.current = playlist?.id;
  isLoadingMoreRef.current = isLoadingMore;
  tracksRef.current = tracks;

  const isLocalPlaylistView = playlist ? isLocalPlaylist(playlist) : false;
  const isLikedPlaylist = playlist?.kind === "liked-songs" || playlist?.id === "LM";
  const likedDates = useLikedDates(isLikedPlaylist);
  const knownDateCount = useMemo(() => tracks.filter((track) =>
    Number.isFinite(Date.parse(likedDates.dates[track.id] ?? ""))).length, [tracks, likedDates.dates]);
  const estimates = useMemo(() => isLikedPlaylist
    ? estimateLikedDates(tracks, likedDates.dates, likedDates.publications) : {},
    [isLikedPlaylist, tracks, likedDates.dates, likedDates.publications, likedDates.syncedAt]);
  const estimatedCount = Object.keys(estimates).length;

  useEffect(() => {
    if (!isLikedPlaylist) return;
    void syncLikedDates();
    const timer = window.setInterval(() => { void syncLikedDates(); }, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [isLikedPlaylist]);

  useEffect(() => {
    if (!isLikedPlaylist || isLoading || isCheckingLikes || likedDates.busy || !likedDates.connected) return;
    void lookupMissingLikedDates(tracks.map((track) => track.id));
  }, [isLikedPlaylist, isLoading, isCheckingLikes, tracks, likedDates.busy, likedDates.connected, likedDates.syncedAt]);

  useEffect(() => {
    if (!playlist) return;
    let active = true;
    setSort("dateAdded");
    setSortDirection("desc");
    setPlaylistSearchQuery("");
    setDateFilter({ period: "all", from: "", to: "" });
    setTracks([]);
    setIsLoading(true);
    setIsCheckingLikes(isLikedPlaylist);
    setIsLoadingMore(false);
    setHasMoreTracks(false);
    setNextPageKey(undefined);
    setError(null);
    setLoadMoreError(null);
    setEnteringTrackKeys(new Set());
    let showedPage = false;
    const showPage = (page: { tracks: Track[]; hasMore: boolean; nextPageKey?: string }) => {
      if (!active) return;
      showedPage = true;
      setTracks(page.tracks);
      setEnteringTrackKeys(new Set(page.tracks.map(getTrackKey)));
      setHasMoreTracks(page.hasMore);
      setNextPageKey(page.nextPageKey);
      setIsLoading(false);
    };
    void libraryController.getPlaylistTrackPage(playlist, undefined, (page) => {
      if (page.tracks.length > 0) showPage(page);
    })
      .then((page) => {
        showPage(page);
      })
      .catch(() => {
        if (active && !showedPage) setError("Unable to load this playlist.");
        if (active && showedPage) setLoadMoreError("Could not refresh all songs. Showing the previous saved list; use Check now to retry.");
      })
      .finally(() => {
        if (active) { setIsLoading(false); setIsCheckingLikes(false); }
      });
    return () => {
      active = false;
    };
  }, [playlist, libraryController]);

  const loadMoreTracks = useCallback(async () => {
    if (!playlist || !hasMoreTracks || !nextPageKey || isLoading || isLoadingMoreRef.current) return;
    const loadingPlaylistId = playlist.id;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await libraryController.getPlaylistTrackPage(playlist, nextPageKey);
      if (playlistIdRef.current !== loadingPlaylistId) return;
      const uniqueNewTracks = getUniqueNewTracks(tracksRef.current, page.tracks);
      setEnteringTrackKeys(new Set(uniqueNewTracks.map(getTrackKey)));
      if (uniqueNewTracks.length > 0) {
        setTracks((current) => [...current, ...uniqueNewTracks]);
      }
      setHasMoreTracks(page.hasMore);
      setNextPageKey(page.nextPageKey);
    } catch {
      if (playlistIdRef.current === loadingPlaylistId) {
        setLoadMoreError("Could not load more songs.");
      }
    } finally {
      if (playlistIdRef.current === loadingPlaylistId) {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [hasMoreTracks, isLoading, libraryController, nextPageKey, playlist]);

  useEffect(() => {
    if (!hasMoreTracks) return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const scrollRoot = sentinel.closest("[data-page-scroll-root]");

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMoreTracks();
      }
    }, {
      root: scrollRoot instanceof Element ? scrollRoot : null,
      rootMargin: "700px 0px",
    });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreTracks, loadMoreTracks, tracks.length]);

  useEffect(() => {
    if (!playlist || isLoading || error || tracks.length === 0) return;

    const handlePageSearchKeyDown = (event: KeyboardEvent) => {
      if (!shouldStartPageSearch(event, keyboardShortcuts)) return;
      event.preventDefault();
      setPlaylistSearchQuery((current) => `${current}${event.key}`);
      window.requestAnimationFrame(() => playlistSearchInputRef.current?.focus());
    };

    window.addEventListener("keydown", handlePageSearchKeyDown);
    return () => window.removeEventListener("keydown", handlePageSearchKeyDown);
  }, [error, isLoading, keyboardShortcuts, playlist, tracks.length]);

  const sortedTracks = useMemo(() => {
    if (sort === "dateAdded") {
      return playlistDateOrder(tracks, sortDirection);
    }
    const sorted = [...tracks].sort((left, right) => {
      if (sort === "name") {
        return compareText(left.title, right.title)
          || compareText(left.artist, right.artist)
          || compareText(left.album, right.album);
      }
      return compareText(left.album, right.album)
        || compareText(left.title, right.title)
        || compareText(left.artist, right.artist);
    });
    return sortDirection === "asc" ? sorted : sorted.reverse();
  }, [sort, sortDirection, tracks]);

  const sortedTracksRef = useRef(sortedTracks);
  sortedTracksRef.current = sortedTracks;

  const visibleTracks = useMemo(() => {
    const query = playlistSearchQuery.trim().toLocaleLowerCase();
    return sortedTracks.filter((track) => (!isLikedPlaylist || matchesLikedDate(likedDates.dates[track.id], dateFilter, undefined, estimates[track.id])) && (!query || [
      track.title,
      track.artist,
      track.album,
      ...(track.artists?.map((artist) => artist.name) ?? []),
    ].some((value) => value?.toLocaleLowerCase().includes(query))));
  }, [playlistSearchQuery, sortedTracks, isLikedPlaylist, likedDates.dates, dateFilter, estimates]);

  const virtualized = !isLocalPlaylistView && visibleTracks.length > 100;
  const showTimeline = isLikedPlaylist && sort === "dateAdded" && visibleTracks.length > 0;
  const timeline = useMemo(() => buildLikedTimeline(visibleTracks, likedDates.dates, estimates),
    [visibleTracks, likedDates.dates, estimates]);
  const windowed = usePlaylistWindow(visibleTracks.length, virtualized,
    `${playlist?.id}:${sort}:${sortDirection}:${playlistSearchQuery}:${dateFilter.period}:${dateFilter.from}:${dateFilter.to}`, showTimeline);
  const renderedTracks = visibleTracks.slice(windowed.start, windowed.end);

  const enteringTrackDelayIndexes = useMemo(() => {
    const delayIndexes = new Map<string, number>();
    visibleTracks.forEach((track) => {
      const key = getTrackKey(track);
      if (enteringTrackKeys.has(key)) {
        delayIndexes.set(key, delayIndexes.size);
      }
    });
    return delayIndexes;
  }, [enteringTrackKeys, visibleTracks]);

  // Drag to reorder for local playlists
  useEffect(() => {
    if (!isLocalPlaylistView) return;

    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.abs(event.clientY - drag.startY);
        if (distance < 6) return;
        drag.isDragging = true;
      }

      event.preventDefault();
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-playlist-track-path]");
      if (!target) {
        setDropTargetIndex(null);
        dropTargetRef.current = null;
        return;
      }

      const bounds = target.getBoundingClientRect();
      const nextTarget = {
        localPath: target.dataset.playlistTrackPath ?? "",
        insertAfter: event.clientY >= bounds.top + bounds.height / 2,
      };
      dropTargetRef.current = nextTarget;
      setDropTargetIndex(nextTarget);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.isDragging && dropTargetRef.current && playlist) {
        const fromPath = drag.localPath;
        const toPath = dropTargetRef.current.localPath;
        if (!fromPath || !toPath) {
          pointerDragRef.current = null;
          setDropTargetIndex(null);
          return;
        }

        const sorted = sortedTracksRef.current;
        const fromIndex = sorted.findIndex((t) => (t.localPath ?? t.id) === fromPath);
        const toIndex = sorted.findIndex((t) => (t.localPath ?? t.id) === toPath);
        if (fromIndex < 0 || toIndex < 0) return;

        const clampedToIndex = dropTargetRef.current.insertAfter
          ? Math.min(toIndex + 1, sorted.length)
          : toIndex;
        const insertIndex = fromIndex < clampedToIndex
          ? clampedToIndex - 1
          : clampedToIndex;

        if (fromIndex !== insertIndex) {
          reorderLocalPlaylistTracks(playlist.id, fromIndex, clampedToIndex);
          setTracks((current) => {
            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(insertIndex, 0, moved);
            return next;
          });
        }
      }

      if (drag.isDragging) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      dropTargetRef.current = null;
      pointerDragRef.current = null;
      setDropTargetIndex(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isLocalPlaylistView, playlist]);

  if (!playlist) return null;

  const playPlaylistTrack = async (track: Track) => {
    const started = await playerController.playTrackById(track.id, visibleTracks);
    if (started) markPlaylistPlayed(playlist.id);
  };

  const playShuffled = async () => {
    const shuffledTracks = shuffleTracks(visibleTracks);
    const firstTrack = shuffledTracks[0];
    if (!firstTrack) return;

    const started = await playerController.playTrackById(firstTrack.id, shuffledTracks);
    if (started) markPlaylistPlayed(playlist.id);
  };

  const removeTrackFromList = (removedTrack: Track) => {
    setTracks((current) => current.filter((item) =>
      playlist.kind === "liked-songs" || playlist.id === "LM"
        ? item.id !== removedTrack.id
        : removedTrack.localPath
          ? item.localPath !== removedTrack.localPath
          : item.playlistItemId !== removedTrack.playlistItemId
    ));
  };

  const selectSort = (nextSort: PlaylistSort) => {
    if (nextSort === sort) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSort(nextSort);
    setSortDirection(nextSort === "dateAdded" ? "desc" : "asc");
  };

  const loadEntirePlaylistForDownload = async (): Promise<Track[]> => {
    if (!playlist) return tracks;
    let collected = tracks;
    let pageKey = nextPageKey;
    let more = hasMoreTracks;
    const seen = new Set(collected.map((track) => track.id));

    for (let page = 0; more && pageKey && page < 100; page += 1) {
      const result = await libraryController.getPlaylistTrackPage(playlist, pageKey);
      const fresh = result.tracks.filter((track) => {
        if (seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      });
      if (fresh.length === 0 && result.nextPageKey === pageKey) break;
      if (fresh.length > 0) collected = [...collected, ...fresh];
      more = result.hasMore;
      pageKey = result.nextPageKey;
    }

    setTracks(collected);
    setHasMoreTracks(more);
    setNextPageKey(pageKey);
    return collected;
  };

  const handlePlaylistSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Backspace" || playlistSearchQuery) return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  const handlePointerDown = (event: React.PointerEvent, track: Track) => {
    if (!isLocalPlaylistView || event.button !== 0) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      localPath: track.localPath ?? track.id,
      startY: event.clientY,
      isDragging: false,
    };
  };

  return (
    <div className={`${styles.root} ${showTimeline ? styles.timelineRoot : ""}`}>
      <header
        className={styles.header}
        onContextMenu={(event) => openPlaylistMenu(event, playlist)}
      >
        {playlist.kind === "liked-songs" || playlist.id === "LM" ? (
          <div className={`${styles.cover} ${styles.coverFrame}`}>
            <IconHeart size={80} stroke={1.6} aria-hidden="true" />
          </div>
        ) : (
          <TrackArtwork
            className={`${styles.cover} ${styles.coverFrame}`}
            artworkUrl={playlist.artworkUrl}
            iconSize={80}
            loading="eager"
            variant="playlist"
          />
        )}
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Playlist</span>
          <h1 className={styles.title}>{playlist.title}</h1>
          <p className={styles.artist}>{playlist.owner}</p>
        </div>
        <div className={styles.headerActions}>
          <PlaylistDownloadButton
            playlist={playlist}
            tracks={tracks}
            disabled={isLoading || Boolean(error) || tracks.length === 0}
            onBeforeStart={loadEntirePlaylistForDownload}
          />
          <button
            className={styles.shuffleButton}
            type="button"
            disabled={isLoading || Boolean(error) || visibleTracks.length === 0}
            onClick={() => void playShuffled()}
          >
            <IconArrowsShuffle size={18} aria-hidden="true" />
            <span>Shuffle</span>
          </button>
        </div>
      </header>
      {isLikedPlaylist && <LikedSongTools
        filter={dateFilter}
        onFilterChange={setDateFilter}
        datesConnected={likedDates.connected}
        unknownCount={tracks.length - knownDateCount - estimatedCount}
        visibleCount={visibleTracks.length}
        totalCount={tracks.length}
        refreshing={isLoading || isCheckingLikes}
        onRefresh={async () => {
          const id = playlist.id;
          setIsCheckingLikes(true);
          try {
            const page = await libraryController.getPlaylistTrackPage(playlist);
            if (playlistIdRef.current !== id) return;
            setTracks(page.tracks);
            setHasMoreTracks(page.hasMore);
            setNextPageKey(page.nextPageKey);
            setError(null);
            setLoadMoreError(null);
          } finally {
            setIsCheckingLikes(false);
          }
        }}
      />}
      {isLoading && <PlaylistLoadingSpinner label="Loading songs" />}
      {error && <p className={styles.message}>{error}</p>}
      {isLikedPlaylist && likedDates.connected && tracks.length > 0 && <p className={styles.message} role="status">
        {likedDates.lookupProgress
          ? `${likedDates.lookupProgress.kind === "publications" ? "Loading publication dates for estimates" : "Checking additional dates"}: ${likedDates.lookupProgress.checked} of ${likedDates.lookupProgress.total} songs in this batch. `
          : likedDates.busy ? "Refreshing saved dates… " : ""}
        Exact dates for {knownDateCount} of {tracks.length} songs; estimated dates for {estimatedCount}.
        {" "}{tracks.length - knownDateCount - estimatedCount} remain unknown. Estimates use playlist order and available publication dates.
        {likedDates.error && ` ${likedDates.error}`}
      </p>}
      {!isLoading && !error && !hasMoreTracks && tracks.length === 0 && (
        <p className={styles.message}>This playlist is empty.</p>
      )}
      {!isLoading && !error && (tracks.length > 0 || hasMoreTracks) && (
        <>
          <div
            className={styles.sortOptions}
            role="group"
            aria-label="Playlist song tools"
          >
            {playlistSorts.map((item) => (
              <button
                key={item.value}
                type="button"
                className={sort === item.value ? styles.activeSortOption : ""}
                aria-pressed={sort === item.value}
                aria-label={`Sort by ${item.label} ${
                  sort === item.value ? getDirectionLabel(item.value, sortDirection) : ""
                }`.trim()}
                onClick={() => selectSort(item.value)}
              >
                <span>{item.label}</span>
                {sort === item.value && (
                  <span
                    className={`${styles.sortDirection} ${
                      item.value === "dateAdded" ? styles.dateSortDirection : ""
                    }`}
                    aria-hidden="true"
                  >
                    <span className={styles.sortArrow}>
                      <SortDirectionIcon direction={sortDirection} />
                    </span>
                    {item.value === "dateAdded" && (
                      <span className={styles.sortHoverLabel}>
                        {getDirectionLabel(item.value, sortDirection)}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
            <div
              className={`${styles.playlistSearch} ${
                playlistSearchQuery ? styles.playlistSearchActive : ""
              }`}
              role="search"
              onClick={() => playlistSearchInputRef.current?.focus()}
            >
              <span className={styles.playlistSearchIcon}>
                <IconSearch size={16} aria-hidden="true" />
              </span>
              <input
                ref={playlistSearchInputRef}
                type="text"
                value={playlistSearchQuery}
                aria-label="Search songs in playlist"
                placeholder="Search playlist"
                onChange={(event) => setPlaylistSearchQuery(event.target.value)}
                onKeyDown={handlePlaylistSearchKeyDown}
              />
              {playlistSearchQuery && (
                <button
                  className={styles.playlistSearchClear}
                  type="button"
                  aria-label="Clear playlist search"
                  onClick={() => setPlaylistSearchQuery("")}
                >
                  <IconX size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {isLikedPlaylist && !likedDates.connected && (
            <p className={styles.message}>Connect liked song dates in Settings → About to show historical added dates.</p>
          )}
          {visibleTracks.length === 0 && (playlistSearchQuery.trim() || (isLikedPlaylist && dateFilter.period !== "all")) ? (
            <p className={styles.message}>No songs match these filters.</p>
          ) : (
          <div className={showTimeline ? styles.listWithTimeline : undefined}>
          <div ref={windowed.listRef} className={styles.trackList}>
            {windowed.before > 0 && <div aria-hidden="true" style={{ height: windowed.before, flexShrink: 0 }} />}
            {renderedTracks.map((track, renderedIndex) => {
              const index = windowed.start + renderedIndex;
              const estimate = estimates[track.id];
              const addedDate = estimate ? formatLikedEstimate(estimate) : formatLikedDate(likedDates.dates[track.id]);
              const trackKey = getTrackKey(track);
              const trackPath = track.localPath ?? track.id;
              const isDragged = pointerDragRef.current?.localPath === trackPath && pointerDragRef.current.isDragging;
              const isDropBefore = dropTargetIndex
                && dropTargetIndex.localPath === trackPath
                && !dropTargetIndex.insertAfter;
              const isDropAfter = dropTargetIndex
                && dropTargetIndex.localPath === trackPath
                && dropTargetIndex.insertAfter;
              return (
                <button
                  key={getTrackRenderKey(track, index)}
                  data-playlist-track-path={trackPath}
                  className={`${styles.track} ${isLikedPlaylist ? styles.trackWithDate : ""} ${
                    !virtualized && enteringTrackDelayIndexes.has(trackKey) ? styles.trackEntering : ""
                  }`}
                  style={{
                    "--track-enter-delay": `${Math.min(
                      enteringTrackDelayIndexes.get(trackKey) ?? 0,
                      18,
                    ) * 28}ms`,
                    opacity: isDragged ? 0.4 : undefined,
                    position: "relative" as const,
                    height: virtualized || showTimeline ? 58 : undefined,
                    flexShrink: 0,
                  } as CSSProperties}
                  onContextMenu={(event) => openTrackMenu(event, track, {
                    playlist,
                    onRemove: removeTrackFromList,
                  })}
                  onPointerDown={(event) => handlePointerDown(event, track)}
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    void playPlaylistTrack(track);
                  }}
                >
                  {isDropBefore && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        height: "2px",
                        background: "var(--color-accent)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  {isDropAfter && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: -1,
                        left: 0,
                        right: 0,
                        height: "2px",
                        background: "var(--color-accent)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                  <span className={styles.trackIndex}>{index + 1}</span>
                  <TrackArtwork artworkUrl={track.artworkUrl} className={styles.trackArtwork} iconSize={20} />
                  <span className={styles.trackText}>
                    <span className={styles.trackTitle}>{track.title}</span>
                    <ArtistLinks
                      className={styles.trackArtist}
                      artists={track.artists}
                      fallback={track.artist}
                    />
                  </span>
                  {isLikedPlaylist && (
                    <span className={styles.trackAddedDate} title={addedDate.title} aria-label={addedDate.title}>
                      <span className={styles.trackAddedLabel}>{estimate ? "Estimated" : "Added"}</span>
                      {addedDate.label}
                    </span>
                  )}
                  <DownloaderStatusBadge track={track} />
                  <IconPlayerPlay className={styles.trackPlayIcon} size={18} />
                </button>
              );
            })}
            {windowed.after > 0 && <div aria-hidden="true" style={{ height: windowed.after, flexShrink: 0 }} />}
          </div>
          {showTimeline && <LikedTimeline years={timeline.years} active={timeline.positions[windowed.activeIndex]} onJump={windowed.jumpToIndex} viewportHeight={windowed.viewportHeight} />}
          </div>
          )}
          <div ref={loadMoreRef} className={styles.loadMoreStatus} aria-live="polite">
            {isLoadingMore ? (
              <PlaylistLoadingSpinner label="Loading more songs" />
            ) : loadMoreError ? (
              loadMoreError
            ) : hasMoreTracks ? (
              ""
            ) : (
              ""
            )}
          </div>
        </>
      )}
    </div>
  );
}
