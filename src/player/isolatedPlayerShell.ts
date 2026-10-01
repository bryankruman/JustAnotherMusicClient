// The official iframe API runs only in this top-level, capability-free webview.
export {};

type PlayerEvent = { data: number };
type PlayerApi = {
  cueVideoById(id: string): void;
  loadVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVolume(): number;
  isMuted(): boolean;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  getIframe(): HTMLIFrameElement;
  destroy(): void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, options: {
        width: number;
        height: number;
        playerVars: Record<string, number | string>;
        events: {
          onReady: () => void;
          onStateChange: (event: PlayerEvent) => void;
          onError: (event: PlayerEvent) => void;
        };
      }) => PlayerApi;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const channel = new BroadcastChannel("jamc-isolated-youtube-v1");
const root = document.getElementById("players");
const players = new Map<string, {
  host: HTMLElement;
  player: PlayerApi | null;
  ready: boolean;
  infoTimer: number | null;
}>();
const idPattern = /^[a-f0-9-]{36}$/i;
let apiPromise: Promise<void> | null = null;

type MainMessage = {
  source?: string;
  kind?: string;
  id?: string;
  name?: string;
  args?: unknown[];
};

function send(id: string, kind: string, value: unknown = null): void {
  channel.postMessage({ source: "jamc-youtube-shell", id, kind, value });
}

function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve();
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      script.remove();
      reject(new Error("YouTube iframe API did not load."));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

function destroyPlayer(id: string): void {
  const entry = players.get(id);
  if (!entry) return;
  if (entry.infoTimer !== null) clearInterval(entry.infoTimer);
  entry.player?.destroy();
  entry.host.remove();
  players.delete(id);
}

function createPlayer(id: string): void {
  const existing = players.get(id);
  send(id, "boot");
  if (existing) {
    if (existing.ready) send(id, "ready");
    return;
  }
  if (!root) return;

  const host = document.createElement("div");
  host.className = "player-host";
  const target = document.createElement("div");
  host.appendChild(target);
  root.appendChild(host);
  const entry = {
    host,
    player: null as PlayerApi | null,
    ready: false,
    infoTimer: null as number | null,
  };
  players.set(id, entry);

  void loadApi().then(() => {
    if (players.get(id) !== entry || !window.YT?.Player) return;
    send(id, "apiLoaded");
    entry.player = new window.YT.Player(target, {
      width: 200,
      height: 200,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        enablejsapi: 1,
        origin: location.origin,
        playsinline: 1,
        widget_referrer: "https://music.youtube.com/",
      },
      events: {
        onReady: () => {
          if (players.get(id) !== entry || !entry.player) return;
          entry.player.getIframe()?.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
          entry.ready = true;
          entry.infoTimer = window.setInterval(() => {
            if (!entry.player) return;
            try {
              send(id, "info", {
                time: entry.player.getCurrentTime(),
                duration: entry.player.getDuration(),
                volume: entry.player.getVolume(),
                muted: entry.player.isMuted(),
                state: entry.player.getPlayerState(),
                videoId: entry.player.getVideoData().video_id,
              });
            } catch { /* Data may be unavailable during a video transition. */ }
          }, 500);
          send(id, "ready");
        },
        onStateChange: (event) => {
          send(id, "state", { state: event.data, videoId: entry.player?.getVideoData().video_id });
        },
        onError: (event) => send(id, "error", event.data),
      },
    });
  }).catch(() => {
    if (players.get(id) !== entry) return;
    send(id, "error", -2);
    destroyPlayer(id);
  });
}

function validCommand(name: string, args: unknown[]): boolean {
  if (["playVideo", "pauseVideo", "stopVideo", "mute", "unMute"].includes(name)) return args.length === 0;
  if (["cueVideoById", "loadVideoById"].includes(name)) return args.length === 1 && typeof args[0] === "string" && /^[\w-]{11}$/.test(args[0]);
  if (name === "seekTo") return args.length === 2 && typeof args[0] === "number" && Number.isFinite(args[0]) && args[0] >= 0 && typeof args[1] === "boolean";
  if (name === "setVolume") return args.length === 1 && typeof args[0] === "number" && Number.isFinite(args[0]) && args[0] >= 0 && args[0] <= 100;
  return false;
}

function runCommand(player: PlayerApi, name: string, args: unknown[]): void {
  if (!validCommand(name, args)) return;
  try {
    switch (name) {
      case "cueVideoById": player.cueVideoById(args[0] as string); break;
      case "loadVideoById": player.loadVideoById(args[0] as string); break;
      case "playVideo": player.playVideo(); break;
      case "pauseVideo": player.pauseVideo(); break;
      case "stopVideo": player.stopVideo(); break;
      case "mute": player.mute(); break;
      case "unMute": player.unMute(); break;
      case "seekTo": player.seekTo(args[0] as number, args[1] as boolean); break;
      case "setVolume": player.setVolume(args[0] as number); break;
    }
  } catch { /* Playback failures arrive through YouTube's onError. */ }
}

if (root && location.protocol === "http:" && location.hostname === "localhost" && location.port) {
  channel.onmessage = (event: MessageEvent<MainMessage>) => {
    const data = event.data;
    if (data?.source !== "jamc-youtube-main" || typeof data.id !== "string" || !idPattern.test(data.id)) return;
    if (data.kind === "create") createPlayer(data.id);
    else if (data.kind === "destroy") destroyPlayer(data.id);
    else if (data.kind === "command" && typeof data.name === "string" && Array.isArray(data.args)) {
      const player = players.get(data.id)?.player;
      if (player) runCommand(player, data.name, data.args);
    }
  };
}
