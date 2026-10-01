import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import { createIsolatedYouTubePlayer, YOUTUBE_STATE, type IsolatedYouTubePlayer } from "./isolatedYouTubePlayer";
const audioEngines = new Set<AudioEngine>();
let playbackClaimId = 0;
let playbackOwner: AudioEngine | null = null;

function shouldUseNativeAudio(): boolean {
  // Native audio playback is disabled for remote YouTube tracks because the
  // backend download path can fail with 403 errors. v1.2.65 used the iframe
  // player on every platform, including Linux.
  return false;
}

function isPlayerStateTimeout(error: unknown): boolean {
  return error instanceof Error
    && /^Timed out waiting for YouTube player state: /.test(error.message);
}

function detectAudioMimeType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) {
    return "audio/mp4";
  }
  return "audio/mp4";
}

export class AudioEngine {
  private readonly useNativeAudio = shouldUseNativeAudio();
  private player: IsolatedYouTubePlayer | null = null;
  private playerPromise: Promise<IsolatedYouTubePlayer> | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private currentVideoId: string | null = null;
  private volume = 1;
  private muted = false;
  private onEnded: (() => void) | null = null;
  private loadRequestId = 0;
  private stateWaiters = new Set<{
    states: Set<number>;
    videoId: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>();

  constructor() {
    audioEngines.add(this);
  }

  usesNativeAudio(): boolean {
    return this.useNativeAudio;
  }

  async loadTrack(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
  ): Promise<void> {
    if (this.useNativeAudio) {
      if (!audioData && !sourceUrl) {
        throw new Error("Native playback requires downloaded audio data.");
      }
      await this.loadNativeAudio(videoId, audioData, mimeType, sourceUrl);
      return;
    }

    const requestId = ++this.loadRequestId;
    this.releaseNativeAudio();
    const player = await this.ensurePlayer();
    if (requestId !== this.loadRequestId) return;
    if (this.currentVideoId === videoId) return;

    this.currentVideoId = videoId;
    // A previous track may already have left the player in CUED. Wait for the
    // state event from this cue request instead of accepting that stale state.
    const cued = this.waitForPlayerState(
      [YOUTUBE_STATE.CUED],
      15_000,
      false,
      videoId,
    );
    player.cueVideoById(videoId);
    try {
      await cued;
    } catch (error) {
      if (requestId === this.loadRequestId && this.currentVideoId === videoId) {
        this.currentVideoId = null;
      }
      throw error;
    }
    if (requestId !== this.loadRequestId || this.currentVideoId !== videoId) return;
    logInternalInfo("AudioEngine.loadTrack cued", { videoId });
  }

  async loadNativeFallback(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
  ): Promise<void> {
    this.player?.stopVideo();
    await this.loadNativeAudio(videoId, audioData, mimeType, sourceUrl);
  }

  setOnEnded(listener: (() => void) | null): void {
    this.onEnded = listener;
  }

  async play(): Promise<boolean> {
    const claimId = this.claimPlayback();
    if (this.useNativeAudio || this.audio) {
      if (!this.audio || !this.currentVideoId) {
        throw new Error("No audio track is loaded.");
      }
      this.applyNativeAudioSettings();
      await this.audio.play();
      return claimId === playbackClaimId && playbackOwner === this;
    }

    const player = await this.ensurePlayer();
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    if (!this.currentVideoId) {
      throw new Error("No YouTube track is loaded.");
    }

    if (this.muted) {
      player.mute();
    } else {
      player.unMute();
    }
    player.setVolume(this.getOutputVolumePercent());
    const videoId = this.currentVideoId;
    const playing = this.waitForPlayerState(
      [YOUTUBE_STATE.PLAYING],
      15_000,
      true,
      videoId,
    );
    const playerState = player.getPlayerState();
    if (
      playerState === YOUTUBE_STATE.CUED
      || playerState === YOUTUBE_STATE.UNSTARTED
    ) {
      logInternalInfo("AudioEngine.play starting cued YouTube video", {
        videoId,
        playerState,
        method: "loadVideoById",
      });
      player.loadVideoById(videoId);
    } else {
      logInternalInfo("AudioEngine.play starting YouTube video", {
        videoId,
        playerState,
        method: "playVideo",
      });
      player.playVideo();
    }
    try {
      await playing;
    } catch (error) {
      if (
        !isPlayerStateTimeout(error)
        || claimId !== playbackClaimId
        || playbackOwner !== this
      ) {
        throw error;
      }

      logInternalWarn("AudioEngine.play continuing after slow YouTube start", {
        videoId: this.currentVideoId,
        playerState: player.getPlayerState(),
        playerVideoId: player.getVideoData().video_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    logInternalInfo("AudioEngine.play requested", {
      videoId: this.currentVideoId,
      muted: this.muted,
      volume: this.volume,
    });
    return true;
  }

  pause(): void {
    this.audio?.pause();
    this.player?.pauseVideo();
  }

  suspend(): void {
    this.pause();
  }

  async resume(): Promise<boolean> {
    if (this.currentVideoId) {
      return this.play();
    }
    return false;
  }

  stop(): void {
    this.loadRequestId += 1;
    if (playbackOwner === this) {
      playbackOwner = null;
      playbackClaimId += 1;
    }
    this.releaseNativeAudio();
    this.player?.stopVideo();
    this.currentVideoId = null;
    this.rejectStateWaiters(new Error("Playback was stopped."));
  }

  silenceCompetingPlayback(): void {
    this.claimPlayback();
  }

  dispose(): void {
    this.stop();
    this.player?.destroy();
    this.player = null;
    audioEngines.delete(this);
  }

  seekTo(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    if (this.audio) {
      this.audio.currentTime = Math.min(
        Math.max(0, seconds),
        Number.isFinite(this.audio.duration) ? this.audio.duration : seconds,
      );
    }
    this.player?.seekTo(Math.max(0, seconds), true);
  }

  setVolume(level: number): void {
    const nextVolume = Math.min(1, Math.max(0, level));
    const beforePlayerVolume = this.player ? this.player.getVolume() : null;
    const beforeAudioVolume = this.audio?.volume ?? null;
    this.volume = nextVolume;
    this.applyOutputVolume();
    logInternalDebug("AudioEngine.setVolume", {
      requestedLevel: level,
      volume: this.volume,
      hasNativeAudio: Boolean(this.audio),
      hasYouTubePlayer: Boolean(this.player),
      beforeAudioVolume,
      afterAudioVolume: this.audio?.volume ?? null,
      beforePlayerVolume,
      afterPlayerVolume: this.player ? this.player.getVolume() : null,
      muted: this.muted,
      playerMuted: this.player?.isMuted() ?? null,
      currentVideoId: this.currentVideoId,
    });
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(isMuted: boolean): void {
    const beforeAudioMuted = this.audio?.muted ?? null;
    const beforePlayerMuted = this.player?.isMuted() ?? null;
    this.muted = isMuted;
    if (this.audio) this.audio.muted = isMuted;
    if (isMuted) {
      this.player?.mute();
    } else {
      this.player?.unMute();
    }
    this.applyOutputVolume();
    logInternalDebug("AudioEngine.setMuted", {
      muted: this.muted,
      hasNativeAudio: Boolean(this.audio),
      hasYouTubePlayer: Boolean(this.player),
      beforeAudioMuted,
      afterAudioMuted: this.audio?.muted ?? null,
      beforePlayerMuted,
      afterPlayerMuted: this.player?.isMuted() ?? null,
      currentVideoId: this.currentVideoId,
    });
  }

  isMuted(): boolean {
    return this.muted;
  }

  getCurrentTime(): number {
    if (this.audio) return this.audio.currentTime;
    return this.player?.getCurrentTime() ?? 0;
  }

  getDuration(): number {
    if (this.audio) return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    return this.player?.getDuration() ?? 0;
  }

  private async loadNativeAudio(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
  ): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.releaseNativeAudio();

    const bytes = audioData ? new Uint8Array(audioData) : null;
    const detectedMimeType = mimeType || (bytes ? detectAudioMimeType(bytes) : "audio/mp4");
    const objectUrl = sourceUrl ?? URL.createObjectURL(new Blob([bytes ?? new Uint8Array()], {
      type: detectedMimeType,
    }));
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = objectUrl;
    audio.addEventListener("ended", () => this.onEnded?.());
    audio.addEventListener("error", () => {
      logInternalError(
        "AudioEngine native audio error",
        new Error(`Native audio failed with media error ${audio.error?.code ?? "unknown"}.`),
        { videoId },
      );
    });
    this.audio = audio;
    this.audioObjectUrl = sourceUrl ? null : objectUrl;
    this.currentVideoId = videoId;
    this.applyNativeAudioSettings();

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading native audio."));
      }, 30_000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        audio.removeEventListener("canplay", handleReady);
        audio.removeEventListener("error", handleError);
      };
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Unable to decode native audio (${audio.error?.code ?? "unknown"}).`));
      };
      audio.addEventListener("canplay", handleReady, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      audio.load();
    });

    if (requestId !== this.loadRequestId) return;
    logInternalInfo("AudioEngine native audio loaded", {
      videoId,
      byteLength: audioData?.byteLength ?? null,
      mimeType: detectedMimeType,
      hasSourceUrl: Boolean(sourceUrl),
    });
  }

  private applyNativeAudioSettings(): void {
    if (!this.audio) return;
    this.audio.volume = this.muted ? 0 : this.volume;
    this.audio.muted = this.muted;
  }

  private applyOutputVolume(): void {
    if (this.audio) {
      this.audio.volume = this.muted ? 0 : this.volume;
    }
    this.player?.setVolume(this.getOutputVolumePercent());
  }

  private getOutputVolumePercent(): number {
    return this.muted ? 0 : Math.round(this.volume * 100);
  }

  private releaseNativeAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  private async ensurePlayer(): Promise<IsolatedYouTubePlayer> {
    if (this.player) return this.player;
    if (this.playerPromise) return this.playerPromise;

    this.playerPromise = this.createPlayer();
    try {
      this.player = await this.playerPromise;
      return this.player;
    } finally {
      this.playerPromise = null;
    }
  }

  private claimPlayback(): number {
    const claimId = ++playbackClaimId;
    playbackOwner = this;

    for (const engine of audioEngines) {
      if (engine !== this) engine.pauseForPlaybackClaim();
    }
    for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
      media.pause();
    }

    return claimId;
  }

  private pauseForPlaybackClaim(): void {
    this.audio?.pause();
    this.player?.pauseVideo();
  }

  private async createPlayer(): Promise<IsolatedYouTubePlayer> {
    const player = await createIsolatedYouTubePlayer({
      onStateChange: (state, playerVideoId) => {
        logInternalInfo("AudioEngine isolated YouTube player state", {
          state,
          videoId: this.currentVideoId,
          playerVideoId,
        });
        this.resolveStateWaiters(state, playerVideoId);
        if (state === YOUTUBE_STATE.ENDED) this.onEnded?.();
      },
      onError: (code) => {
        const error = new Error(`YouTube player error ${code}`);
        this.rejectStateWaiters(error);
        logInternalError("AudioEngine isolated YouTube player error", error, {
          videoId: this.currentVideoId,
        });
      },
    });
    player.setVolume(this.getOutputVolumePercent());
    if (this.muted) player.mute();
    else player.unMute();
    logInternalInfo("AudioEngine isolated YouTube player ready");
    return player;
  }

  private waitForPlayerState(
    states: number[],
    timeoutMs: number,
    acceptCurrentState = true,
    videoId: string | null = null,
  ): Promise<void> {
    if (acceptCurrentState) {
      const currentState = this.player?.getPlayerState();
      const currentVideoId = this.player?.getVideoData().video_id ?? null;
      if (
        currentState !== undefined
        && states.includes(currentState)
        && (!videoId || currentVideoId === videoId)
      ) {
        return Promise.resolve();
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        states: new Set(states),
        videoId,
        resolve,
        reject,
        timeoutId: 0,
      };

      waiter.timeoutId = window.setTimeout(() => {
        this.stateWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for YouTube player state: ${states.join(", ")}.`));
      }, timeoutMs);

      this.stateWaiters.add(waiter);
    });
  }

  private resolveStateWaiters(state: number, videoId: string | null): void {
    for (const waiter of this.stateWaiters) {
      if (
        !waiter.states.has(state)
        || (waiter.videoId !== null && waiter.videoId !== videoId)
      ) {
        continue;
      }
      window.clearTimeout(waiter.timeoutId);
      this.stateWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectStateWaiters(error: Error): void {
    for (const waiter of this.stateWaiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }
}
