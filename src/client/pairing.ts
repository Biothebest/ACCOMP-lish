const OFFICIAL_OMP_CLIENT = "https://my.omp.sh";
const DEFAULT_RELAY = "wss://my.omp.sh";
const MAX_LINK_LENGTH = 2_048;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export const PAIRING_IDENTITY_STORAGE_KEY = "oacc.paired-room.v1";

export interface PairingIdentity {
  version: 1;
  ompProfile: string;
  roomId: string;
  relayOrigin: string;
  linkFingerprint: string;
}

export interface PairingConnection {
  identity: PairingIdentity;
  clientUrl: string;
}

interface ParsedPairingLink {
  roomId: string;
  roomKey: string;
  relayOrigin: string;
  relayLink: string;
}

export async function establishPairing(
  input: string,
  ompProfile: string,
  expectedIdentity: PairingIdentity | null,
): Promise<PairingConnection> {
  if (!PROFILE_PATTERN.test(ompProfile)) {
    throw new Error("The configured OMP profile is invalid. Run setup again before pairing.");
  }
  const parsed = parsePairingLink(input);
  const linkFingerprint = await sha256Hex(`${parsed.relayOrigin}\n${parsed.roomId}\n${parsed.roomKey}`);
  const identity: PairingIdentity = {
    version: 1,
    ompProfile,
    roomId: parsed.roomId,
    relayOrigin: parsed.relayOrigin,
    linkFingerprint,
  };

  if (expectedIdentity) {
    if (expectedIdentity.ompProfile !== ompProfile) {
      throw new Error(
        `This browser is bound to OMP profile ${expectedIdentity.ompProfile}. Forget that pairing before using profile ${ompProfile}.`,
      );
    }
    if (
      expectedIdentity.roomId !== identity.roomId ||
      expectedIdentity.relayOrigin !== identity.relayOrigin ||
      expectedIdentity.linkFingerprint !== identity.linkFingerprint
    ) {
      throw new Error(
        "A different OMP session is already bound to this control center. Forget that pairing before selecting another session.",
      );
    }
  }

  return {
    identity,
    clientUrl: `${OFFICIAL_OMP_CLIENT}/#${parsed.relayLink}`,
  };
}

export function serializePairingIdentity(identity: PairingIdentity): string {
  return JSON.stringify(identity);
}

export function parseStoredPairingIdentity(value: string | null): PairingIdentity | null {
  if (!value || value.length > 1_024) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PairingIdentity>;
    if (
      parsed.version !== 1 ||
      typeof parsed.ompProfile !== "string" ||
      !PROFILE_PATTERN.test(parsed.ompProfile) ||
      typeof parsed.roomId !== "string" ||
      !ROOM_PATTERN.test(parsed.roomId) ||
      typeof parsed.relayOrigin !== "string" ||
      !isSafeRelayOrigin(parsed.relayOrigin) ||
      typeof parsed.linkFingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(parsed.linkFingerprint)
    ) {
      return null;
    }
    return {
      version: 1,
      ompProfile: parsed.ompProfile,
      roomId: parsed.roomId,
      relayOrigin: parsed.relayOrigin,
      linkFingerprint: parsed.linkFingerprint,
    };
  } catch {
    return null;
  }
}

export function pairingDisplayFingerprint(identity: PairingIdentity): string {
  return identity.linkFingerprint.slice(0, 12).toUpperCase();
}

function parsePairingLink(input: string): ParsedPairingLink {
  const normalized = input.trim();
  if (!normalized || normalized.length > MAX_LINK_LENGTH) {
    throw new Error("Paste one bounded OMP /collab link.");
  }
  return parsePairingCandidate(normalized, 0);
}

function parsePairingCandidate(value: string, depth: number): ParsedPairingLink {
  if (depth > 3) throw new Error("The OMP collaboration link is nested too deeply.");
  const candidate = decodeFragment(value.trim());

  if (/^https?:\/\//i.test(candidate)) {
    const url = parseUrl(candidate);
    if (url.hash.length > 1) {
      const fragment = decodeFragment(url.hash.slice(1));
      try {
        return parsePairingCandidate(fragment, depth + 1);
      } catch (error) {
        if (!url.pathname.startsWith("/r/")) throw error;
      }
    }
    return parseDirectRelayUrl(url);
  }

  if (/^wss?:\/\//i.test(candidate)) {
    return parseDirectRelayUrl(parseUrl(candidate));
  }

  if (candidate.includes("/r/")) {
    return parseDirectRelayUrl(parseUrl(`wss://${candidate}`));
  }

  return parseRoomSecret(candidate, DEFAULT_RELAY);
}

function parseDirectRelayUrl(url: URL): ParsedPairingLink {
  if (url.username || url.password || url.search) {
    throw new Error("OMP collaboration relay links cannot contain credentials or query parameters.");
  }
  const relayOrigin = normalizeRelayOrigin(url);
  const pathMatch = /^\/r\/([^/]+)$/.exec(url.pathname);
  const roomTarget = pathMatch?.[1];
  if (!roomTarget) {
    throw new Error("The OMP collaboration relay path must contain exactly one /r/<room> target.");
  }
  const secret = url.hash.length > 1 ? `${roomTarget}#${url.hash.slice(1)}` : roomTarget;
  return parseRoomSecret(decodeFragment(secret), relayOrigin);
}

function parseRoomSecret(value: string, relayOrigin: string): ParsedPairingLink {
  const match = /^([A-Za-z0-9_-]{8,128})[.#]([A-Za-z0-9_-]+)$/.exec(value);
  const roomId = match?.[1];
  const roomKey = match?.[2];
  if (!roomId || !roomKey || !ROOM_PATTERN.test(roomId) || !KEY_PATTERN.test(roomKey)) {
    throw new Error("This is not a valid OMP collaboration link.");
  }
  if (roomKey.length === 43) {
    throw new Error("This is a view-only OMP link. Use the 48-byte full-control link from /collab.");
  }
  if (roomKey.length !== 64) {
    throw new Error("The OMP link does not contain a 48-byte full-control key.");
  }

  const normalizedRoom = `${roomId}.${roomKey}`;
  const relayLink =
    relayOrigin === DEFAULT_RELAY
      ? normalizedRoom
      : relayOrigin.startsWith("ws://")
        ? `${relayOrigin}/r/${normalizedRoom}`
        : `${relayOrigin.slice("wss://".length)}/r/${normalizedRoom}`;
  return { roomId, roomKey, relayOrigin, relayLink };
}

function normalizeRelayOrigin(url: URL): string {
  let protocol: "ws:" | "wss:";
  if (url.protocol === "https:" || url.protocol === "wss:") {
    protocol = "wss:";
  } else if (url.protocol === "http:" || url.protocol === "ws:") {
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error("Plain WebSocket OMP relays are allowed only on localhost.");
    }
    protocol = "ws:";
  } else {
    throw new Error("The OMP relay must use WSS, HTTPS, or loopback WS.");
  }
  return `${protocol}//${url.host}`;
}

function isSafeRelayOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.pathname !== "/") return false;
    if (url.protocol === "wss:") return true;
    return url.protocol === "ws:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error("This is not a valid OMP collaboration URL.");
  }
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("The OMP collaboration link contains invalid URL encoding.");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
