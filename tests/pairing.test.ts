import { describe, expect, it } from "vitest";
import {
  establishPairing,
  pairingDisplayFingerprint,
  parseStoredPairingIdentity,
  serializePairingIdentity,
} from "../src/client/pairing.js";

const ROOM = "abcdefghijklmnopqrstuv";
const FULL_KEY = "A".repeat(64);
const OTHER_FULL_KEY = "B".repeat(64);
const VIEW_KEY = "C".repeat(43);

describe("exclusive OMP collaboration pairing", () => {
  it("accepts a full-control /collab link without retaining its bearer key in identity storage", async () => {
    const connection = await establishPairing(`${ROOM}.${FULL_KEY}`, "st", null);
    const stored = serializePairingIdentity(connection.identity);

    expect(connection.clientUrl).toBe(`https://my.omp.sh/#${ROOM}.${FULL_KEY}`);
    expect(connection.identity).toMatchObject({
      version: 1,
      ompProfile: "st",
      roomId: ROOM,
      relayOrigin: "wss://my.omp.sh",
    });
    expect(connection.identity.linkFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(pairingDisplayFingerprint(connection.identity)).toMatch(/^[A-F0-9]{12}$/);
    expect(stored).not.toContain(FULL_KEY);
    expect(parseStoredPairingIdentity(stored)).toEqual(connection.identity);
  });

  it("normalizes browser wrappers and secure custom relay links through the official OMP client", async () => {
    const wrapped = await establishPairing(`https://my.omp.sh/#${ROOM}.${FULL_KEY}`, "default", null);
    const custom = await establishPairing(
      `https://web.example/collab/#relay.example.com/r/${ROOM}.${FULL_KEY}`,
      "default",
      null,
    );

    expect(wrapped.clientUrl).toBe(`https://my.omp.sh/#${ROOM}.${FULL_KEY}`);
    expect(custom.clientUrl).toBe(`https://my.omp.sh/#relay.example.com/r/${ROOM}.${FULL_KEY}`);
    expect(custom.identity.relayOrigin).toBe("wss://relay.example.com");
  });

  it("rejects view-only, malformed, oversized, credentialed, and insecure remote links", async () => {
    await expect(establishPairing(`${ROOM}.${VIEW_KEY}`, "st", null)).rejects.toThrow("view-only");
    await expect(establishPairing("not-a-collab-link", "st", null)).rejects.toThrow("valid OMP");
    await expect(establishPairing("x".repeat(2_049), "st", null)).rejects.toThrow("bounded");
    await expect(
      establishPairing(`wss://user:secret@relay.example/r/${ROOM}.${FULL_KEY}`, "st", null),
    ).rejects.toThrow("credentials");
    await expect(establishPairing(`ws://relay.example/r/${ROOM}.${FULL_KEY}`, "st", null)).rejects.toThrow(
      "localhost",
    );
  });

  it("reconnects only to the exact remembered room and rejects a mismatched session", async () => {
    const firstConnection = await establishPairing(`${ROOM}.${FULL_KEY}`, "st", null);
    const reconnected = await establishPairing(`${ROOM}.${FULL_KEY}`, "st", firstConnection.identity);

    expect(reconnected.identity).toEqual(firstConnection.identity);
    await expect(
      establishPairing(`${ROOM}.${OTHER_FULL_KEY}`, "st", firstConnection.identity),
    ).rejects.toThrow("different OMP session");
    await expect(
      establishPairing(`${ROOM}.${FULL_KEY}`, "another-profile", firstConnection.identity),
    ).rejects.toThrow("bound to OMP profile st");
  });

  it("fails closed on malformed persisted pairing identity", () => {
    expect(parseStoredPairingIdentity(null)).toBeNull();
    expect(parseStoredPairingIdentity("not-json")).toBeNull();
    expect(
      parseStoredPairingIdentity(
        JSON.stringify({
          version: 1,
          ompProfile: "st",
          roomId: ROOM,
          relayOrigin: "ws://remote.example",
          linkFingerprint: "a".repeat(64),
        }),
      ),
    ).toBeNull();
  });
});
