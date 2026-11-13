/**
 * Connected browsers (kernel, hosted mode only). A signed-in user asks for a one-time connect code, the connect page
 * hands it to the extension, and the extension trades it for a device token that it sends as its bearer from then on.
 *
 *   code    `acc_` + 32 random bytes, base64url. Single use: the exchange deletes its row, and a code past its expiry
 *           (CONNECT_CODE_TTL_MS) is refused. Wrong codes are counted, and after `maxFailures` of them in a window the
 *           exchange refuses every code, the right one included, until the window ends.
 *   token   `acd_` + 32 random bytes, base64url, so it never looks like a session token (a JWT has dots).
 *
 * Only a SHA-256 of a code or a token is stored. Revoking a device keeps its row, so a revoked token stays refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { stableId } from "../shared/ids";
import type { DeviceId, UserId } from "../shared/ids";
import type { Db } from "./db";
import type { Migration } from "./migrations";

export const DEVICES_MIGRATION: Migration = {
  id: "004-devices",
  sql: `
-- A browser's extension, connected to one user. Only a hash of its device token is kept. revoked_ms is set once and never cleared.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  last_used_ms INTEGER,
  revoked_ms INTEGER
) STRICT;
CREATE INDEX devices_user ON devices (user_id, created_ms);
-- A one-time connect code. The exchange deletes its row, so a code works once. Only its hash is kept.
CREATE TABLE connect_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
) STRICT;`,
};

export const CONNECT_CODE_TTL_MS = 2 * 60 * 1000;
export const EXCHANGE_WINDOW_MS = 60 * 1000;
export const EXCHANGE_MAX_FAILURES = 20;
/** A device's last use is written at most this often, so an ingest every few seconds is not also a write every few seconds. */
const LAST_USED_GRANULARITY_MS = 60 * 1000;

const CODE = /^acc_[A-Za-z0-9_-]{43}$/;
const TOKEN = /^acd_[A-Za-z0-9_-]{43}$/;

/** Pure over the string: whether a bearer token is a device token rather than a session token. */
export const isDeviceToken = (token: string): boolean => TOKEN.test(token);

export type Exchange =
  | { readonly kind: "connected"; readonly token: string; readonly userId: UserId; readonly deviceId: DeviceId }
  | { readonly kind: "refused" }
  | { readonly kind: "limited"; readonly retryAfterS: number };

export type DeviceView = { readonly id: DeviceId; readonly label: string; readonly createdMs: number; readonly lastUsedMs: number | null };

export type Devices = {
  createCode(userId: UserId, label: string): { readonly code: string; readonly expiresMs: number };
  exchange(code: string): Exchange;
  /** The user's devices that are not revoked, oldest first. */
  list(userId: UserId): DeviceView[];
  /** False when the user has no such device, revoked or not; revoking a revoked device is true and changes nothing. */
  revoke(userId: UserId, deviceId: DeviceId): boolean;
  /** The user a device token belongs to, or null when it is not one, unknown, or revoked. */
  userFor(token: string): UserId | null;
};

export type DevicesOptions = { readonly now?: () => number; readonly maxFailures?: number; readonly windowMs?: number };

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const secret = (prefix: "acc_" | "acd_") => `${prefix}${randomBytes(32).toString("base64url")}`;

export function createDevices(db: Db, options: DevicesOptions = {}): Devices {
  const now = options.now ?? Date.now;
  const maxFailures = options.maxFailures ?? EXCHANGE_MAX_FAILURES;
  const windowMs = options.windowMs ?? EXCHANGE_WINDOW_MS;
  let attempts = { startMs: Number.NEGATIVE_INFINITY, failures: 0 };

  const sweep = db.sql.query("DELETE FROM connect_codes WHERE expires_ms <= ?");
  const insertCode = db.sql.query("INSERT INTO connect_codes (code_hash, user_id, label, expires_ms) VALUES (?, ?, ?, ?)");
  const takeCode = db.sql.query<{ user_id: UserId; label: string; expires_ms: number }, [string]>(
    "DELETE FROM connect_codes WHERE code_hash = ? RETURNING user_id, label, expires_ms",
  );
  const insertDevice = db.sql.query("INSERT INTO devices (id, user_id, token_hash, label, created_ms) VALUES (?, ?, ?, ?, ?)");
  const listDevices = db.sql.query<{ id: DeviceId; label: string; created_ms: number; last_used_ms: number | null }, [string]>(
    "SELECT id, label, created_ms, last_used_ms FROM devices WHERE user_id = ? AND revoked_ms IS NULL ORDER BY created_ms, id",
  );
  const owned = db.sql.query<{ id: string }, [string, string]>("SELECT id FROM devices WHERE id = ? AND user_id = ?");
  const revoke = db.sql.query("UPDATE devices SET revoked_ms = ? WHERE id = ? AND user_id = ? AND revoked_ms IS NULL");
  const byToken = db.sql.query<{ id: string; user_id: UserId; last_used_ms: number | null }, [string]>(
    "SELECT id, user_id, last_used_ms FROM devices WHERE token_hash = ? AND revoked_ms IS NULL",
  );
  const touch = db.sql.query("UPDATE devices SET last_used_ms = ? WHERE id = ?");

  function refuse(): Exchange {
    attempts.failures += 1;
    return { kind: "refused" };
  }

  return {
    createCode(userId, label) {
      const code = secret("acc_");
      const at = now();
      const expiresMs = at + CONNECT_CODE_TTL_MS;
      db.tx(() => {
        sweep.run(at);
        insertCode.run(hash(code), userId, label, expiresMs);
      });
      return { code, expiresMs };
    },

    exchange(code) {
      const at = now();
      if (at - attempts.startMs >= windowMs) attempts = { startMs: at, failures: 0 };
      if (attempts.failures >= maxFailures) return { kind: "limited", retryAfterS: Math.max(1, Math.ceil((attempts.startMs + windowMs - at) / 1000)) };
      if (!CODE.test(code)) return refuse();
      // One statement both finds and spends the code, so two exchanges of one code cannot both see it unspent.
      return db.tx((): Exchange => {
        const row = takeCode.get(hash(code));
        if (!row || row.expires_ms <= at) return refuse();
        const token = secret("acd_");
        const deviceId = stableId("dev", row.user_id, crypto.randomUUID());
        insertDevice.run(deviceId, row.user_id, hash(token), row.label, at);
        return { kind: "connected", token, userId: row.user_id, deviceId };
      });
    },

    list(userId) {
      return listDevices.all(userId).map((d) => ({ id: d.id, label: d.label, createdMs: d.created_ms, lastUsedMs: d.last_used_ms }));
    },

    revoke(userId, deviceId) {
      return db.tx(() => {
        if (!owned.get(deviceId, userId)) return false;
        revoke.run(now(), deviceId, userId);
        return true;
      });
    },

    userFor(token) {
      if (!isDeviceToken(token)) return null;
      const device = byToken.get(hash(token));
      if (!device) return null;
      const at = now();
      if (device.last_used_ms === null || at - device.last_used_ms >= LAST_USED_GRANULARITY_MS) touch.run(at, device.id);
      return device.user_id;
    },
  };
}
