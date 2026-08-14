import * as SQLite from "expo-sqlite";

let dbPromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

/**
 * Local cache + outbox. Every reading pulled from the band is written here
 * first (works fully offline), then `flushPendingToBackend` (src/ble/sync.ts)
 * uploads whatever hasn't been confirmed synced yet. `synced` rows are kept
 * (not deleted) so the app can render from cache without a network call.
 */
async function getDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync("h59-health.db").then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS health_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          deviceId TEXT NOT NULL,
          ts TEXT NOT NULL,
          metric TEXT NOT NULL,
          value REAL NOT NULL,
          value2 REAL,
          unit TEXT NOT NULL,
          source TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0,
          UNIQUE(deviceId, metric, ts)
        );
        CREATE INDEX IF NOT EXISTS idx_health_samples_synced ON health_samples(synced);

        CREATE TABLE IF NOT EXISTS sleep_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          deviceId TEXT NOT NULL,
          date TEXT NOT NULL,
          startTs TEXT NOT NULL,
          endTs TEXT NOT NULL,
          totalMinutes INTEGER NOT NULL,
          source TEXT NOT NULL,
          stagesJson TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0,
          UNIQUE(deviceId, date)
        );

        CREATE TABLE IF NOT EXISTS sync_meta (
          deviceId TEXT PRIMARY KEY,
          lastSyncedAt TEXT
        );
      `);
      return db;
    });
  }
  return dbPromise;
}

export interface LocalHealthSample {
  deviceId: string;
  ts: string;
  metric: string;
  value: number;
  value2?: number;
  unit: string;
  source: string;
}

export interface LocalSleepSession {
  deviceId: string;
  date: string;
  startTs: string;
  endTs: string;
  totalMinutes: number;
  source: string;
  stages: { stage: string; startTs: string; durationMin: number }[];
}

export const localDb = {
  async insertHealthSamples(samples: LocalHealthSample[]): Promise<void> {
    if (!samples.length) return;
    const db = await getDb();
    await db.withTransactionAsync(async () => {
      for (const s of samples) {
        // INSERT OR IGNORE: duplicates (same deviceId+metric+ts) are silently
        // skipped, matching the backend's own idempotent upsert — re-reading
        // an already-cached day from the device never creates duplicates.
        await db.runAsync(
          `INSERT OR IGNORE INTO health_samples (deviceId, ts, metric, value, value2, unit, source, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          s.deviceId, s.ts, s.metric, s.value, s.value2 ?? null, s.unit, s.source,
        );
      }
    });
  },

  async upsertSleepSession(session: LocalSleepSession): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO sleep_sessions (deviceId, date, startTs, endTs, totalMinutes, source, stagesJson, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(deviceId, date) DO UPDATE SET
         startTs=excluded.startTs, endTs=excluded.endTs, totalMinutes=excluded.totalMinutes,
         source=excluded.source, stagesJson=excluded.stagesJson, synced=0`,
      session.deviceId, session.date, session.startTs, session.endTs, session.totalMinutes,
      session.source, JSON.stringify(session.stages),
    );
  },

  async getUnsyncedHealthSamples(deviceId: string, limit = 5000): Promise<(LocalHealthSample & { id: number })[]> {
    const db = await getDb();
    return db.getAllAsync(
      `SELECT id, deviceId, ts, metric, value, value2, unit, source FROM health_samples
       WHERE deviceId = ? AND synced = 0 ORDER BY ts ASC LIMIT ?`,
      deviceId, limit,
    );
  },

  async getUnsyncedSleepSessions(deviceId: string): Promise<(LocalSleepSession & { id: number })[]> {
    const db = await getDb();
    const rows = await db.getAllAsync<{ id: number; deviceId: string; date: string; startTs: string; endTs: string; totalMinutes: number; source: string; stagesJson: string }>(
      `SELECT id, deviceId, date, startTs, endTs, totalMinutes, source, stagesJson FROM sleep_sessions
       WHERE deviceId = ? AND synced = 0`,
      deviceId,
    );
    return rows.map((r) => ({ ...r, stages: JSON.parse(r.stagesJson) }));
  },

  async markHealthSamplesSynced(ids: number[]): Promise<void> {
    if (!ids.length) return;
    const db = await getDb();
    await db.runAsync(`UPDATE health_samples SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  },

  async markSleepSessionsSynced(ids: number[]): Promise<void> {
    if (!ids.length) return;
    const db = await getDb();
    await db.runAsync(`UPDATE sleep_sessions SET synced = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  },

  async getLastSyncedAt(deviceId: string): Promise<Date | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ lastSyncedAt: string | null }>(
      `SELECT lastSyncedAt FROM sync_meta WHERE deviceId = ?`,
      deviceId,
    );
    return row?.lastSyncedAt ? new Date(row.lastSyncedAt) : null;
  },

  async setLastSyncedAt(deviceId: string, at: Date): Promise<void> {
    const db = await getDb();
    await db.runAsync(
      `INSERT INTO sync_meta (deviceId, lastSyncedAt) VALUES (?, ?)
       ON CONFLICT(deviceId) DO UPDATE SET lastSyncedAt = excluded.lastSyncedAt`,
      deviceId, at.toISOString(),
    );
  },
};
