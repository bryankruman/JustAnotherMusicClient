import { useEffect, useMemo, useState } from "react";
import { IconDisc, IconMusic, IconPlaylist, IconUser } from "@tabler/icons-react";
import { getArtworkUrlCandidates, getVideoArtworkFallback } from "../../datasource/youtube/artwork";
import { tauriFetch } from "../../datasource/youtube/tauriFetch";
import styles from "./TrackArtwork.module.css";

const ARTWORK_RETRY_DELAYS_MS = [500, 1500];

interface TrackArtworkProps {
  artworkUrl?: string;
  videoId?: string;
  className?: string;
  iconSize?: number;
  loading?: "eager" | "lazy";
  retryOnError?: boolean;
  variant?: "track" | "album" | "artist" | "playlist";
}

export function TrackArtwork(props: TrackArtworkProps) {
  // Reset before rendering a new cover, including when a row is reused.
  return <ArtworkImage key={`${props.artworkUrl ?? ""}:${props.videoId ?? ""}`} {...props} />;
}

function ArtworkImage({
  artworkUrl, videoId, className, iconSize = 24, loading = "lazy",
  retryOnError = false, variant = "track",
}: TrackArtworkProps) {
  const artworkCandidates = useMemo(() => Array.from(new Set([
    ...getArtworkUrlCandidates(artworkUrl),
    ...getArtworkUrlCandidates(videoId ? getVideoArtworkFallback(videoId) : undefined),
  ])), [artworkUrl, videoId]);
  const [artworkIndex, setArtworkIndex] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [proxiedArtworkUrl, setProxiedArtworkUrl] = useState<string | null>(null);
  const [loadedArtworkUrl, setLoadedArtworkUrl] = useState<string | null>(null);
  const currentArtworkUrl = artworkCandidates[artworkIndex]
    ?? (artworkIndex === artworkCandidates.length ? proxiedArtworkUrl : null);
  const isArtworkLoaded = Boolean(currentArtworkUrl && loadedArtworkUrl === currentArtworkUrl);
  const FallbackIcon = variant === "artist" ? IconUser
    : variant === "album" ? IconMusic : variant === "playlist" ? IconPlaylist : IconDisc;

  useEffect(() => {
    if (!hasError) return;
    if (retryOnError && currentArtworkUrl && !currentArtworkUrl.startsWith("blob:")
      && retryCount < ARTWORK_RETRY_DELAYS_MS.length) {
      const timer = window.setTimeout(() => {
        setHasError(false);
        setRetryCount((count) => count + 1);
      }, ARTWORK_RETRY_DELAYS_MS[retryCount]);
      return () => window.clearTimeout(timer);
    }
    setHasError(false);
    setRetryCount(0);
    setArtworkIndex((index) => index + 1);
  }, [hasError, currentArtworkUrl, retryCount, retryOnError]);

  const proxySourceUrl = artworkCandidates[0];
  const needsProxy = Boolean(proxySourceUrl && artworkIndex === artworkCandidates.length);
  useEffect(() => {
    if (!needsProxy || !proxySourceUrl || !/^https?:\/\//.test(proxySourceUrl)) return;
    let objectUrl: string | null = null;
    let active = true;
    void tauriFetch(proxySourceUrl, {
      headers: { Accept: "image/webp,image/*,*/*;q=0.8" },
      timeoutMs: 10000,
    }).then((response) => {
      if (!response.ok) throw new Error(`Artwork request failed with HTTP ${response.status}.`);
      return response.blob();
    }).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setProxiedArtworkUrl(objectUrl);
    }).catch(() => {
      // Keep the visible icon when neither browser nor native fetch works.
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Do not depend on the generated URL: that would revoke it before it loads.
  }, [needsProxy, proxySourceUrl]);

  return (
    <span className={`${styles.root} ${className ?? ""}`}>
      <FallbackIcon className={`${styles.fallbackIcon} ${isArtworkLoaded ? styles.fallbackIconHidden : ""}`}
        size={iconSize} aria-hidden="true" />
      {currentArtworkUrl && !hasError && (
        <img key={`${currentArtworkUrl}:${retryCount}`}
          className={isArtworkLoaded ? styles.imageLoaded : ""}
          src={currentArtworkUrl} alt="" loading={loading} referrerPolicy="no-referrer"
          onLoad={() => setLoadedArtworkUrl(currentArtworkUrl)}
          onError={() => { setLoadedArtworkUrl(null); setHasError(true); }} />
      )}
    </span>
  );
}
