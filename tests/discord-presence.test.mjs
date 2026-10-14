import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Keep the real controllers and Discord service; replace audio and native I/O.
const result = await build({
  stdin: {
    contents: `export { PlayerController } from './src/player/PlayerController';
      export { TabManager } from './src/player/TabManager';
      export { DiscordRpcService } from './src/player/DiscordRPC';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "esm", platform: "browser",
  plugins: [{ name: "playback-test-double", setup(builder) {
    builder.onResolve({ filter: /\/logging$|@tauri-apps\/api\/core$|\/AudioEngine$|\/downloaderStore$/ }, (args) => ({
      path: args.path, namespace: "test-double",
    }));
    builder.onLoad({ filter: /.*/, namespace: "test-double" }, (args) => ({ contents:
      args.path.endsWith("logging")
        ? `export const logInternalDebug = () => {}; export const logInternalWarn = () => {};
           export const logInternalInfo = () => {}; export const logInternalError = () => {};`
        : args.path.endsWith("AudioEngine")
          ? `export class AudioEngine {
              volume = 1; muted = false; time = 0;
              setOnEnded(callback) { this.onEnded = callback; }
              setVolume(value) { this.volume = value; }
              setMuted(value) { this.muted = value; }
              getVolume() { return this.volume; }
              isMuted() { return this.muted; }
              getCurrentTime() { return this.time; }
              getDuration() { return 180; }
              usesNativeAudio() { return false; }
              async loadNativeFallback() {}
              async loadTrack() {}
              async play() { return true; }
              pause() {} stop() {} suspend() {} dispose() {}
              seekTo(value) { this.time = value; }
            }`
          : args.path.endsWith("downloaderStore")
            ? `export const getDownloaderPlaybackSource = async () => undefined;`
            : `export const invoke = async (command, args) => {
                 globalThis.discordTestCalls.push({ command, args });
               };`,
    }));
  } }],
});
const { PlayerController, TabManager, DiscordRpcService } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`,
);

const track = { id: "local-song", source: "local", title: "A song", artist: "An artist", durationSec: 180 };
const source = {
  getTrack: async () => track,
  getStreamData: async () => ({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" }),
};
const presenceCalls = () => globalThis.discordTestCalls.filter(({ command }) => command.startsWith("discord_rpc_"));
const resetCalls = () => { globalThis.discordTestCalls = []; };
const session = (status) => ({
  currentTrack: track, history: [], queue: [track], queueIndex: 0, status,
  positionSec: 30, volume: 1, muted: false, autoplayEnabled: false, playbackOrderMode: "in-order",
});

test("selected songs stay hidden; play publishes, pause clears, and resume publishes", async () => {
  resetCalls();
  const player = new PlayerController(source);
  try {
    await player.resumeFromTabSwitch();
    await player.loadTrack(track);
    assert.ok(presenceCalls().every(({ command }) => command === "discord_rpc_clear"));
    await player.play();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_update");
    assert.equal(presenceCalls().at(-1).args.isPlaying, true);
    await player.pause();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
    await player.play();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_update");
  } finally { player.dispose(); }
  assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
});

test("loading and failed playback remove the previous activity", async () => {
  resetCalls();
  let rejectLoad;
  const player = new PlayerController({ ...source, getStreamData: () => new Promise((_, reject) => { rejectLoad = reject; }) });
  try {
    await player.resumeFromTabSwitch();
    await player.loadTrack(track);
    const playing = player.play();
    assert.equal(player.getState().status, "loading");
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
    rejectLoad(new Error("Audio unavailable"));
    await playing;
    assert.equal(player.getState().status, "error");
    assert.ok(presenceCalls().every(({ command }) => command === "discord_rpc_clear"));
  } finally { player.dispose(); }
});

test("restored playback waits for audio to start before publishing", async () => {
  resetCalls();
  const player = new PlayerController(source);
  try {
    player.restoreSession(session("playing"));
    assert.equal(presenceCalls().length, 0);
    const resuming = player.resumeFromTabSwitch();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
    await resuming;
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_update");
  } finally { player.dispose(); }
});

test("an ended queue clears presence before waiting for recommendations", async () => {
  resetCalls();
  const player = new PlayerController(source);
  try {
    await player.resumeFromTabSwitch();
    await player.loadTrack(track);
    await player.play();
    const ended = player.handleTrackEnded();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
    await ended;
    assert.equal(player.getState().status, "paused");
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
  } finally { player.dispose(); }
});

test("only the playback owner controls presence across music tabs", async () => {
  resetCalls();
  const tabs = new TabManager(source);
  const first = tabs.createTab("first").player;
  const second = tabs.createTab("second").player;
  try {
    await first.loadTrack(track);
    await first.play();
    resetCalls();
    await second.loadTrack(track);
    assert.equal(presenceCalls().length, 0);
    await tabs.setActive("second");
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_clear");
    await second.play();
    resetCalls();
    await first.pause();
    assert.equal(presenceCalls().length, 0);
    await tabs.setActive("first");
    await first.play();
    assert.equal(presenceCalls().at(-1).command, "discord_rpc_update");
    resetCalls();
    second.dispose();
    assert.equal(presenceCalls().length, 0);
  } finally { first.dispose(); second.dispose(); }
});

test("Discord service clears paused updates and respects the disable setting", async () => {
  resetCalls();
  const presence = { title: track.title, artist: track.artist, album: "", duration: 180, currentTime: 10, isPlaying: true };
  await DiscordRpcService.updatePresence(presence);
  await DiscordRpcService.updatePresence({ ...presence, isPlaying: false });
  assert.deepEqual(presenceCalls().map(({ command }) => command), ["discord_rpc_update", "discord_rpc_clear"]);
  await DiscordRpcService.setEnabled(false);
  resetCalls();
  try {
    await DiscordRpcService.updatePresence(presence);
    assert.equal(presenceCalls().length, 0);
  } finally { await DiscordRpcService.setEnabled(true); }
});
