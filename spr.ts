// spr.ts — read a Logos Storage signed peer record ("spr:…") into { peerId, addrs }.
//
// Scala's invites and settings carry the hub's Storage node as an SPR; Loam's Storage fetch wants
// peers as { peerId, addrs } (it dials them before asking the DHT). The record's signature is NOT
// checked here: the result is only a hint of whom to dial first, the content is still fetched by its
// CID and every snapshot event is re-verified.
//
// Layout (nim-libp2p SignedPeerRecord): "spr:" + base64url(Envelope)
//   Envelope   { 1: public_key, 2: payload_type, 3: payload (PeerRecord), 5: signature }
//   PeerRecord { 1: peer_id (multihash bytes), 2: seq, 3: repeated AddressInfo { 1: multiaddr bytes } }
import { toByteArray } from "base64-js";

export interface SprPeer { peerId: string; addrs: string[]; spr: string }

type Field = { no: number; wire: number; int?: number; bytes?: Uint8Array };

function varint(b: Uint8Array, i: number): [number, number] {
  let v = 0, mul = 1;
  for (let n = 0; n < 10; n++) {
    if (i >= b.length) throw new Error("truncated varint");
    const c = b[i++];
    v += (c & 0x7f) * mul;
    if (!(c & 0x80)) return [v, i];
    mul *= 128;
  }
  throw new Error("varint too long");
}

function fields(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    let key: number; [key, i] = varint(b, i);
    const no = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) { let v: number; [v, i] = varint(b, i); out.push({ no, wire, int: v }); }
    else if (wire === 2) {
      let len: number; [len, i] = varint(b, i);
      if (i + len > b.length) throw new Error("truncated field");
      out.push({ no, wire, bytes: b.subarray(i, i + len) }); i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error(`wire type ${wire}`);
  }
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(b: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of b) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = "";
  for (const byte of b) { if (byte !== 0) break; s += "1"; }
  for (let k = digits.length - 1; k >= 0; k--) s += B58[digits[k]];
  return s;
}

/** Binary multiaddr → text, for the protocols a Storage node announces. null if it holds anything else. */
export function multiaddrToString(b: Uint8Array): string | null {
  let i = 0, s = "";
  const td = (x: Uint8Array) => { let r = ""; for (const c of x) r += String.fromCharCode(c); return r; };
  while (i < b.length) {
    let code: number; [code, i] = varint(b, i);
    switch (code) {
      case 4: if (i + 4 > b.length) return null; s += `/ip4/${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`; i += 4; break;
      case 41: {
        if (i + 16 > b.length) return null;
        const parts: string[] = [];
        for (let k = 0; k < 16; k += 2) parts.push(((b[i + k] << 8) | b[i + k + 1]).toString(16));
        s += `/ip6/${compressV6(parts)}`; i += 16; break;
      }
      case 6: case 273: if (i + 2 > b.length) return null; s += `/${code === 6 ? "tcp" : "udp"}/${(b[i] << 8) | b[i + 1]}`; i += 2; break;
      case 53: case 54: case 55: case 56: {
        let len: number; [len, i] = varint(b, i);
        if (i + len > b.length) return null;
        s += `/${{ 53: "dns", 54: "dns4", 55: "dns6", 56: "dnsaddr" }[code]}/${td(b.subarray(i, i + len))}`; i += len; break;
      }
      case 460: s += "/quic"; break;
      case 461: s += "/quic-v1"; break;
      case 421: { let len: number; [len, i] = varint(b, i); s += `/p2p/${base58(b.subarray(i, i + len))}`; i += len; break; }
      default: return null;
    }
  }
  return s || null;
}

function compressV6(p: string[]): string {
  // longest run of "0" groups (length ≥ 2) becomes "::"
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (p[i] !== "0") { i++; continue; }
    let j = i; while (j < 8 && p[j] === "0") j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  if (best < 0) return p.join(":");
  return `${p.slice(0, best).join(":")}::${p.slice(best + bestLen).join(":")}`;
}

/** Decode an SPR. Returns null for anything that isn't a well-formed record (never throws). */
export function decodeSpr(spr: string): SprPeer | null {
  try {
    const m = /^spr:([A-Za-z0-9_-]{10,4000}={0,2})$/.exec(spr.trim());
    if (!m) return null;
    let b64 = m[1].replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const env = fields(toByteArray(b64));
    const payload = env.find((f) => f.no === 3 && f.bytes)?.bytes;
    if (!payload) return null;
    const rec = fields(payload);
    const id = rec.find((f) => f.no === 1 && f.bytes)?.bytes;
    if (!id || id.length < 10) return null;
    const addrs: string[] = [];
    for (const f of rec) {
      if (f.no !== 3 || !f.bytes) continue;
      const ma = fields(f.bytes).find((x) => x.no === 1 && x.bytes)?.bytes;
      const s = ma ? multiaddrToString(ma) : null;
      if (s && !addrs.includes(s)) addrs.push(s);
    }
    return { peerId: base58(id), addrs: addrs.slice(0, 4), spr: spr.trim() };
  } catch { return null; }
}
