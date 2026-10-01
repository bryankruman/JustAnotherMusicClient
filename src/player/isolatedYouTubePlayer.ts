export const YOUTUBE_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, CUED: 5 } as const;

export interface IsolatedYouTubePlayer {
  cueVideoById(videoId: string): void;
  loadVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  destroy(): void;
}

type PlayerEvents = {
  onStateChange: (state: number, videoId: string | null) => void;
  onError: (code: number) => void;
};

export function createIsolatedYouTubePlayer(events: PlayerEvents): Promise<IsolatedYouTubePlayer> {
  if (location.protocol !== "http:" || location.hostname !== "localhost" || !location.port) {
    return Promise.reject(new Error("The isolated player requires the localhost app origin."));
  }
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel("jamc-isolated-youtube-v1");
  let state = YOUTUBE_STATE.UNSTARTED;
  let videoId: string | null = null;
  let time = 0;
  let duration = 0;
  let volume = 100;
  let muted = false;
  let ready = false;
  let booted = false;
  let apiLoaded = false;
  let destroyed = false;
  let retryId = 0;
  let timeoutId = 0;

  const send = (kind: string, name?: string, args?: unknown[]) => {
    if (!destroyed) channel.postMessage({ source: "jamc-youtube-main", id, kind, name, args });
  };
  const command = (name: string, args: unknown[] = []) => send("command", name, args);
  const destroy = () => {
    if (destroyed) return;
    send("destroy");
    destroyed = true;
    clearInterval(retryId);
    clearTimeout(timeoutId);
    channel.close();
  };
  const player: IsolatedYouTubePlayer = {
    cueVideoById: (next) => { if (/^[\w-]{11}$/.test(next)) { videoId = next; command("cueVideoById", [next]); } },
    loadVideoById: (next) => { if (/^[\w-]{11}$/.test(next)) { videoId = next; command("loadVideoById", [next]); } },
    playVideo: () => command("playVideo"),
    pauseVideo: () => command("pauseVideo"),
    stopVideo: () => command("stopVideo"),
    seekTo: (seconds, allowSeekAhead) => { if (Number.isFinite(seconds)) command("seekTo", [Math.max(0, seconds), Boolean(allowSeekAhead)]); },
    setVolume: (value) => { if (Number.isFinite(value)) { volume = Math.max(0, Math.min(100, value)); command("setVolume", [volume]); } },
    getVolume: () => volume,
    mute: () => { muted = true; command("mute"); },
    unMute: () => { muted = false; command("unMute"); },
    isMuted: () => muted,
    getCurrentTime: () => time,
    getDuration: () => duration,
    getPlayerState: () => state,
    getVideoData: () => ({ video_id: videoId ?? undefined }),
    destroy,
  };

  return new Promise((resolve, reject) => {
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.source !== "jamc-youtube-shell" || data.id !== id || destroyed) return;
      if (data.kind === "boot") booted = true;
      else if (data.kind === "apiLoaded") apiLoaded = true;
      else if (data.kind === "ready") {
        if (ready) return;
        ready = true;
        clearInterval(retryId);
        clearTimeout(timeoutId);
        resolve(player);
      } else if (data.kind === "error" && Number.isInteger(data.value)) {
        if (!ready) {
          destroy();
          reject(new Error(`YouTube player setup error ${data.value}.`));
        } else events.onError(data.value);
      } else if (data.kind === "state" && ready && Number.isInteger(data.value?.state) && data.value.state >= -1 && data.value.state <= 5) {
        state = data.value.state;
        const next = data.value.videoId;
        if (typeof next === "string" && /^[\w-]{11}$/.test(next)) videoId = next;
        events.onStateChange(state, videoId);
      } else if (data.kind === "info" && ready) {
        const value = data.value;
        if (Number.isFinite(value?.time) && value.time >= 0) time = value.time;
        if (Number.isFinite(value?.duration) && value.duration >= 0) duration = value.duration;
        if (Number.isFinite(value?.volume)) volume = Math.max(0, Math.min(100, value.volume));
        if (typeof value?.muted === "boolean") muted = value.muted;
      }
    };
    retryId = window.setInterval(() => send("create"), 500);
    timeoutId = window.setTimeout(() => {
      destroy();
      reject(new Error(apiLoaded ? "YouTube iframe API loaded but player did not become ready." : booted ? "YouTube iframe API did not load." : "Isolated player shell did not boot."));
    }, 15_000);
    send("create");
  });
}
