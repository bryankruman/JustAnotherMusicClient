import assert from "node:assert/strict";
import test from "node:test";
import { transform } from "esbuild";
import { readFileSync } from "node:fs";
import { emptyLikedHistory, parseLikedHistory, reconcileLikedSongs, recordLikeAction } from "../src/datasource/youtube/likedHistoryModel.ts";
import { matchesLikedDate, invalidLikedDateRange } from "../src/datasource/youtube/likedDateFilter.ts";

const a = { id: "song-a", title: "A saved title", artist: "An artist", album: "An album", source: "youtube" };
const b = { id: "song-b", title: "Another song", artist: "Another artist", source: "youtube" };

test("baseline, disappearance, persistence, return, and repeated disappearance", () => {
  const baseline = reconcileLikedSongs(emptyLikedHistory(), [a, b, a], 100);
  assert.equal(Object.keys(baseline.records).length, 2);
  assert.equal(baseline.records[a.id].missingSince, undefined);
  const missing = reconcileLikedSongs(baseline, [b], 200);
  assert.deepEqual(missing.records[a.id].track, a);
  assert.equal(missing.records[a.id].lastSeenAt, 100);
  assert.equal(missing.records[a.id].missingSince, 200);
  const persisted = parseLikedHistory(JSON.parse(JSON.stringify(missing)));
  const stillMissing = reconcileLikedSongs(persisted, [b], 300);
  assert.equal(stillMissing.records[a.id].missingSince, 200);
  const returned = reconcileLikedSongs(stillMissing, [a, b], 400);
  assert.equal(returned.records[a.id].missingSince, undefined);
  assert.equal(returned.records[a.id].returnedAt, 400);
  assert.equal(returned.records[a.id].firstSeenAt, 100);
  assert.equal(reconcileLikedSongs(returned, [b], 500).records[a.id].missingSince, 500);
  assert.equal(baseline.records[a.id].lastSeenAt, 100, "input snapshot is immutable");
});

test("intentional unlikes remain separate and re-likes start tracking again", () => {
  const baseline = reconcileLikedSongs(emptyLikedHistory(), [a, b], 100);
  const removed = recordLikeAction(baseline, a, false, 150);
  const checked = reconcileLikedSongs(removed, [b], 200);
  assert.equal(checked.records[a.id].missingSince, undefined);
  assert.equal(checked.records[a.id].removedByUserAt, 150);
  const reliked = recordLikeAction(checked, a, true, 250);
  assert.equal(reliked.records[a.id].removedByUserAt, undefined);
  assert.equal(reconcileLikedSongs(reliked, [b], 300).records[a.id].missingSince, 300);
});

test("verified empty list retains metadata for every missing song", () => {
  const history = reconcileLikedSongs(reconcileLikedSongs(emptyLikedHistory(), [a, b], 100), [], 200);
  assert.equal(history.records[a.id].missingSince, 200);
  assert.equal(history.records[b.id].missingSince, 200);
  assert.throws(() => parseLikedHistory({ version: 1, checkedAt: 3, records: { a: {} } }));
  assert.throws(() => parseLikedHistory({ version: 2, checkedAt: 3, records: {} }));
});

test("date filtering includes end of day and supports open bounds, unknown dates, and bad ranges", () => {
  const filter = { period: "custom", from: "2026-09-01", to: "2026-09-25" };
  assert.equal(matchesLikedDate("2026-09-25T23:59:59.999", filter), true);
  assert.equal(matchesLikedDate("2026-09-26T00:00:00", filter), false);
  assert.equal(matchesLikedDate("2026-08-31T23:59:59", filter), false);
  assert.equal(matchesLikedDate(undefined, filter), false);
  assert.equal(matchesLikedDate("invalid", { ...filter, period: "unknown" }), true);
  assert.equal(matchesLikedDate(undefined, { ...filter, period: "all" }), true);
  assert.equal(matchesLikedDate("2025-01-01", { ...filter, from: "" }), true);
  assert.equal(matchesLikedDate("2027-01-01", { ...filter, to: "" }), true);
  assert.equal(invalidLikedDateRange({ ...filter, from: "2026-09-26" }), true);
  assert.equal(matchesLikedDate("2026-09-25", { ...filter, from: "2026-09-26" }), false);
});

test("relative dates cover the named calendar days and exclude future timestamps", () => {
  const now = new Date("2026-09-25T12:00:00").getTime();
  for (const period of ["30", "90", "365"]) {
    const filter = { period, from: "", to: "" };
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - Number(period) + 1);
    assert.equal(matchesLikedDate(start.toISOString(), filter, now), true);
    assert.equal(matchesLikedDate(new Date(start.getTime() - 1).toISOString(), filter, now), false);
    assert.equal(matchesLikedDate(new Date(now + 1).toISOString(), filter, now), false);
  }
});

// Exercise the real store with an in-memory native-command boundary, including
// write failures and stale async responses. No YouTube credentials are used.
const modelUrl = new URL("../src/datasource/youtube/likedHistoryModel.ts", import.meta.url).href;
const source = readFileSync(new URL("../src/datasource/youtube/likedHistory.ts", import.meta.url), "utf8")
  .replace('import { invoke } from "@tauri-apps/api/core";', "const invoke = (...args) => globalThis.historyTestInvoke(...args);")
  .replace('import { useSyncExternalStore } from "react";', "const useSyncExternalStore = (_, snapshot) => snapshot();")
  .replace('from "./likedHistoryModel"', `from ${JSON.stringify(modelUrl)}`);
const compiled = await transform(source, { loader: "ts", format: "esm" });
const store = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);

test("store preserves archive after failed scan and rejects stale account/like responses", async () => {
  const disk = new Map();
  let failWrite = false;
  globalThis.historyTestInvoke = async (command, { key, value }) => {
    if (command === "app_setting_get") return disk.get(key) ?? null;
    if (failWrite) throw new Error("Disk full");
    disk.set(key, structuredClone(value));
  };
  await store.activateLikedHistory("account-a");
  await store.finishLikedHistoryScan(store.beginLikedHistoryScan(), [a, b]);
  const beforeFailure = structuredClone(store.useLikedHistory().history);
  store.failLikedHistoryScan(store.beginLikedHistoryScan());
  assert.deepEqual(store.useLikedHistory().history, beforeFailure);
  const staleLikeScan = store.beginLikedHistoryScan();
  await store.noteLikedSongAction(a, false);
  await store.finishLikedHistoryScan(staleLikeScan, [a, b]);
  assert.ok(store.useLikedHistory().history.records[a.id].removedByUserAt);
  const staleAccountScan = store.beginLikedHistoryScan();
  await store.activateLikedHistory("account-b");
  await store.finishLikedHistoryScan(staleAccountScan, [a]);
  assert.deepEqual(store.useLikedHistory().history.records, {});
  await store.finishLikedHistoryScan(store.beginLikedHistoryScan(), [b]);
  await store.activateLikedHistory("account-a");
  assert.ok(store.useLikedHistory().history.records[a.id].removedByUserAt);
  failWrite = true;
  await store.finishLikedHistoryScan(store.beginLikedHistoryScan(), []);
  assert.match(store.useLikedHistory().error, /Could not save/);
  assert.equal(disk.get("liked-song-history:v1:account-a").records[b.id].missingSince, undefined);
  failWrite = false;
  await store.finishLikedHistoryScan(store.beginLikedHistoryScan(), []);
  assert.equal(store.useLikedHistory().error, null);
  assert.ok(disk.get("liked-song-history:v1:account-a").records[b.id].missingSince);
  store.deactivateLikedHistory();
  await store.activateLikedHistory("account-a");
  assert.ok(store.useLikedHistory().history.records[b.id].missingSince, "archive survives session restart");
});

test("unreadable archive cannot be overwritten by a subsequent successful or failed check", async () => {
  let writes = 0;
  globalThis.historyTestInvoke = async (command) => {
    if (command === "app_setting_get") return { corrupt: true };
    writes += 1;
  };
  await store.activateLikedHistory("corrupt-account");
  store.failLikedHistoryScan(store.beginLikedHistoryScan());
  await store.finishLikedHistoryScan(store.beginLikedHistoryScan(), [a]);
  await store.noteLikedSongAction(a, true);
  assert.equal(writes, 0);
  assert.match(store.useLikedHistory().error, /Could not read/);
});
