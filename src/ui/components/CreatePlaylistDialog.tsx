import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconLoader2, IconPlaylist, IconX } from "@tabler/icons-react";
import type { Playlist, PlaylistPrivacy, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import { TrackArtwork } from "./TrackArtwork";
import styles from "./CreatePlaylistDialog.module.css";

const privacyOptions: Array<{ value: PlaylistPrivacy; label: string; hint: string }> = [
  { value: "PRIVATE", label: "Private", hint: "Only you can see this playlist." },
  { value: "UNLISTED", label: "Unlisted", hint: "Anyone with the link can listen." },
  { value: "PUBLIC", label: "Public", hint: "Anyone can find and listen to this playlist." },
];

export function CreatePlaylistDialog({ libraryController, initialTrack, onClose, onCreated }: {
  libraryController: LibraryController;
  initialTrack?: Track;
  onClose: () => void;
  onCreated: (playlist: Playlist) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>("PRIVATE");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef(false);
  const activeRef = useRef(true);
  const canCreate = Boolean(libraryController.getState().library)
    && libraryController.getState().status !== "signed-out";

  useEffect(() => {
    activeRef.current = true;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (nameRef.current && !nameRef.current.matches(":disabled")) nameRef.current.focus();
    else panelRef.current?.focus();
    return () => {
      activeRef.current = false;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (isCreating) panelRef.current?.focus();
  }, [isCreating]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingRef.current || !title.trim() || !canCreate) return;
    pendingRef.current = true;
    setIsCreating(true);
    setError(null);
    try {
      const playlist = await libraryController.createPlaylist({
        title: title.trim(), description: description.trim(), privacy, initialTrack,
      });
      if (activeRef.current) onCreated(playlist);
    } catch (creationError) {
      if (activeRef.current) setError(creationError instanceof Error
        ? creationError.message : "Unable to create the playlist. Please try again.");
    } finally {
      pendingRef.current = false;
      if (activeRef.current) setIsCreating(false);
    }
  };

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pendingRef.current) onClose();
    }}>
      <form ref={panelRef} className={styles.panel} onSubmit={(event) => void submit(event)}
        role="dialog" aria-modal="true" aria-labelledby="create-playlist-title"
        tabIndex={-1}
        aria-describedby="create-playlist-subtitle" aria-busy={isCreating}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!pendingRef.current) onClose();
          }
          if (event.key === "Tab") {
            const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ) ?? []);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (!first) { event.preventDefault(); panelRef.current?.focus(); }
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault(); last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault(); first?.focus();
            }
          }
        }}>
        <header className={styles.header}>
          <span className={styles.mark}><IconPlaylist size={28} aria-hidden="true" /></span>
          <div><h2 id="create-playlist-title">Create playlist</h2>
            <p id="create-playlist-subtitle">A home for your next favorite songs.</p></div>
          <button type="button" className={styles.close} aria-label="Close create playlist"
            disabled={isCreating} onClick={onClose}><IconX size={20} /></button>
        </header>
        <fieldset disabled={isCreating || !canCreate} className={styles.fields}>
          <label className={styles.field}>Name
            <input ref={nameRef} value={title} onChange={(event) => setTitle(event.target.value)}
              placeholder="Give your playlist a name" required maxLength={150} autoComplete="off" />
          </label>
          <label className={styles.field}>Description <span className={styles.optional}>(optional)</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)}
              placeholder="Set the mood, tell a story…" maxLength={5000} rows={3} />
          </label>
          <label className={styles.field}>Privacy
            <select aria-label="Privacy" value={privacy} onChange={(event) => setPrivacy(event.target.value as PlaylistPrivacy)}>
              {privacyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <p className={styles.hint}>{privacyOptions.find((option) => option.value === privacy)?.hint}</p>
        </fieldset>
        {initialTrack && <div className={styles.seed}>
          <TrackArtwork artworkUrl={initialTrack.artworkUrl} videoId={initialTrack.id}
            className={styles.seedArtwork} loading="eager" />
          <div><small>First song</small><strong>{initialTrack.title}</strong><span>{initialTrack.artist}</span></div>
        </div>}
        {!canCreate && <p className={styles.hint} role="status">Sign in to YouTube Music to create playlists in your account.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        <footer className={styles.footer}>
          <button type="button" className={styles.cancel} disabled={isCreating} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.submit} disabled={isCreating || !canCreate || !title.trim()}>
            {isCreating && <IconLoader2 className={styles.spinner} size={18} aria-hidden="true" />}
            {isCreating ? "Creating…" : initialTrack ? "Create and add song" : "Create playlist"}
          </button>
        </footer>
      </form>
    </div>, document.body,
  );
}
