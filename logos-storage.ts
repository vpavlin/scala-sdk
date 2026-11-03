// logos-storage.ts — Logos Storage for Scala, through Loam (loam-transport ADR 0020).
//
// The phone runs no Storage node of its own any more: Loam runs ONE fetch client for every app and
// fetches a CID as a background job that survives this app being closed. We ask for a CID, poll the
// job, then copy the finished file out of Loam's cache (saveTo). Loam also recovers from network
// changes (Wi-Fi <-> mobile data) by itself (Loam 0.0.68). Without Loam (or with Storage switched off
// in Loam) available() is false: attachments and snapshots are skipped and normal sync still runs.
//
// Fetch-only, as before: writing snapshots and uploading attachments is the desktop/hub's job.
// Loam knows CIDs, not file types: what the bytes are (sealed with the calendar key) is checked here.
//
// File helpers (filesDir, read/write as base64, save to Downloads) come from the app's small native
// module ScalaFiles; an older app that still bundles the LogosStorage module provides the same calls.
import { NativeModules } from "react-native";
import * as loam from "./loam-transport-pkg/src/loam-storage";
import { decodeSpr } from "./spr";

const FILES: any = (NativeModules as any).ScalaFiles ?? (NativeModules as any).LogosStorage;
const need = () => { if (!FILES) throw new Error("this build has no file helper module (ScalaFiles)"); return FILES; };

export type { JobStatus, StorageInfo } from "./loam-transport-pkg/src/loam-storage";

/** Loam is installed, this app may use it and its Storage is on. Re-checked at most every 30 s. */
let avail: { at: number; ok: boolean } | null = null;
export async function available(): Promise<boolean> {
  if (avail && Date.now() - avail.at < 30_000) return avail.ok;
  let ok = false;
  try { ok = await loam.available(); } catch { ok = false; }
  avail = { at: Date.now(), ok };
  return ok;
}

/** Loam's Storage state (node, cache, this app's jobs), or null without Loam. */
export async function info(): Promise<loam.StorageInfo | null> {
  try { return await loam.info(); } catch { return null; }
}

/** The app-internal writable base dir. */
export async function filesDir(): Promise<string> { return need().filesDir(); }
/** Read a file as base64 (binary-safe: sealed blobs are not UTF-8). */
export async function readFileB64(path: string): Promise<string> { return need().readFileB64(path); }
/** Write base64 bytes to a file. Returns the path. */
export async function writeFileB64(path: string, b64: string): Promise<string> { return need().writeFileB64(path, b64); }
/** Save bytes into the device's public Downloads folder. Returns a user-facing location. */
export async function saveToDownloads(fileName: string, mime: string, b64: string): Promise<string> {
  return need().saveToDownloads(fileName, mime, b64);
}
/** Size of a file in bytes, or -1 if it doesn't exist. */
export async function fileSize(path: string): Promise<number> {
  try { return Number(await need().fileSize(path)); } catch { return -1; }
}

export interface Progress { bytes: number; total: number; state: string; restarts?: number }
export interface FetchOpts {
  /** Storage nodes known to hold the CID, as SPRs (an invite's hub, the attachment hub setting). */
  sprs?: string[];
  onProgress?: (p: Progress) => void;
  /** Checked every second; true = cancel Loam's job and throw "cancelled". */
  isCancelled?: () => boolean;
  /** Give up after this long without any change in the job (default 10 min). */
  idleLimitMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch `cid` through Loam into `path` (a file this app owns). Resolves the byte count.
 * Same loop as Backpack's (storage.ts getViaLoam): a job Loam forgot ("none", Loam restarted) or one
 * that failed as stalled is asked for again, up to 3 times.
 */
export async function fetchToFile(cid: string, path: string, opts: FetchOpts = {}): Promise<number> {
  if (!(await available())) throw new Error("Loam with Storage is not available (install Loam, or turn Storage on in Loam)");
  const peers = (opts.sprs ?? []).map((s) => decodeSpr(s)).filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => ({ peerId: p.peerId, addrs: p.addrs, spr: p.spr }));
  const idleLimit = opts.idleLimitMs ?? 600_000;
  let st = await loam.fetch(cid, peers);
  if (!st) throw new Error("Loam didn't answer");
  if (st.state === "failed" && !st.cid) throw new Error(`Loam: ${st.error ?? "refused"}`);
  let restarts = 0, seen = "", changedAt = Date.now();
  while (st && (st.state === "queued" || st.state === "fetching")) {
    if (opts.isCancelled?.()) { try { await loam.cancel(cid); } catch { /* */ } throw new Error("cancelled"); }
    opts.onProgress?.({ bytes: st.bytes ?? 0, total: st.total ?? 0, state: st.state, restarts: (st as any).restarts });
    const now = `${st.state}/${st.bytes ?? 0}`;
    if (now !== seen) { seen = now; changedAt = Date.now(); }
    else if (Date.now() - changedAt > idleLimit) { try { await loam.cancel(cid); } catch { /* */ } throw new Error(`no progress for ${Math.round(idleLimit / 60000)} min`); }
    await sleep(1000);
    try { st = await loam.status(cid); } catch { st = null; }
    const lost = !st || st.state === "none" || (st.state === "failed" && /^stalled/.test(st.error ?? ""));
    if (lost && restarts++ < 3) {
      await sleep(2000);
      if (opts.isCancelled?.()) throw new Error("cancelled");
      try { st = await loam.fetch(cid, peers); } catch { st = null; }
    }
  }
  if (!st || st.state !== "done") {
    if (st?.state === "cancelled") throw new Error("cancelled");
    throw new Error(`Loam: ${st?.error ?? st?.state ?? "no answer"}`);
  }
  opts.onProgress?.({ bytes: st.bytes ?? st.total ?? 0, total: st.total ?? st.bytes ?? 0, state: "done" });
  return loam.saveTo(cid, path);
}

/** Withdraw this app's interest in a CID (Loam stops the download when no app wants it). */
export async function cancel(cid: string): Promise<void> { try { await loam.cancel(cid); } catch { /* */ } }
