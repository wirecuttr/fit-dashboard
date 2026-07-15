use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result};
use duckdb::{params, Connection};

use crate::models::{Activity, ActivitySegment, OverviewStats, ParsedActivity, RecordPoint};

pub struct Database {
    conn: Mutex<Connection>,
    db_path: String,
}

const WAL_LIMIT_BYTES: u64 = 25 * 1024 * 1024;

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        tracing::info!(db_path = %path, "opening duckdb database");
        let conn = match Connection::open(path) {
            Ok(conn) => conn,
            Err(open_err) => {
                if !is_wal_replay_internal_error(&open_err) {
                    return Err(open_err).context("failed to open DuckDB");
                }

                let wal_path = PathBuf::from(format!("{path}.wal"));
                if !wal_path.exists() {
                    return Err(open_err).context("failed to open DuckDB");
                }

                let quarantined = quarantine_wal_file(&wal_path)
                    .context("failed to quarantine broken WAL file")?;
                tracing::warn!(
                    db_path = %path,
                    wal_path = %wal_path.display(),
                    quarantined_path = %quarantined.display(),
                    "detected broken WAL replay during startup; quarantined WAL and retrying open"
                );

                Connection::open(path)
                    .context("failed to open DuckDB after quarantining broken WAL")?
            }
        };
        let db = Self {
            conn: Mutex::new(conn),
            db_path: path.to_string(),
        };
        db.init_schema()?;
        tracing::info!(db_path = %path, "duckdb initialized successfully");
        Ok(db)
    }

    fn wal_path(&self) -> std::path::PathBuf {
        std::path::PathBuf::from(format!("{}.wal", self.db_path))
    }

    pub fn flush_wal_to_disk(&self) -> Result<()> {
        tracing::debug!(db_path = %self.db_path, "running duckdb checkpoint");
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute_batch("CHECKPOINT")
            .context("duckdb checkpoint failed")?;
        tracing::info!(db_path = %self.db_path, "duckdb checkpoint completed");
        Ok(())
    }

    pub fn checkpoint_if_wal_exceeds_limit(&self) -> Result<bool> {
        let wal_size = std::fs::metadata(self.wal_path())
            .map(|m| m.len())
            .unwrap_or(0);
        if wal_size <= WAL_LIMIT_BYTES {
            return Ok(false);
        }
        tracing::warn!(
            db_path = %self.db_path,
            wal_size_bytes = wal_size,
            wal_limit_bytes = WAL_LIMIT_BYTES,
            "wal size exceeded threshold; forcing checkpoint"
        );
        self.flush_wal_to_disk()?;
        Ok(true)
    }

    fn init_schema(&self) -> Result<()> {
        tracing::debug!(db_path = %self.db_path, "initializing database schema");
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT PRIMARY KEY,
                username VARCHAR NOT NULL UNIQUE,
                password_hash VARCHAR NOT NULL,
                created_at TIMESTAMP DEFAULT now()
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token VARCHAR PRIMARY KEY,
                user_id BIGINT NOT NULL,
                created_at TIMESTAMP DEFAULT now(),
                expires_at TIMESTAMP NOT NULL
            );

            CREATE TABLE IF NOT EXISTS activities (
                id BIGINT PRIMARY KEY,
                file_hash VARCHAR NOT NULL UNIQUE,
                file_name VARCHAR NOT NULL,
                activity_name VARCHAR NOT NULL,
                sport VARCHAR,
                device VARCHAR,
                start_ts_utc TIMESTAMP,
                end_ts_utc TIMESTAMP,
                duration_s REAL,
                distance_m REAL,
                start_latitude DOUBLE,
                start_longitude DOUBLE,
                source VARCHAR,
                imported_at TIMESTAMP DEFAULT now(),
                metadata_json VARCHAR,
                activity_kind VARCHAR
            );

            CREATE TABLE IF NOT EXISTS records (
                activity_id BIGINT NOT NULL,
                timestamp_ms BIGINT NOT NULL,
                latitude DOUBLE,
                longitude DOUBLE,
                altitude_m REAL,
                distance_m REAL,
                speed_m_s REAL,
                cadence BIGINT,
                heart_rate BIGINT,
                power BIGINT,
                temperature_c REAL,
                raw_fields_json VARCHAR,
                segment_index BIGINT
            );

            CREATE TABLE IF NOT EXISTS activity_segments (
                activity_id BIGINT NOT NULL,
                segment_index BIGINT NOT NULL,
                segment_type VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                sport VARCHAR,
                sub_sport VARCHAR,
                start_ts_utc TIMESTAMP,
                end_ts_utc TIMESTAMP,
                timer_duration_s REAL,
                elapsed_duration_s REAL,
                distance_m REAL,
                record_distance_offset_m REAL,
                start_latitude DOUBLE,
                start_longitude DOUBLE,
                metadata_json VARCHAR,
                PRIMARY KEY (activity_id, segment_index)
            );

            CREATE INDEX IF NOT EXISTS idx_records_activity_time ON records(activity_id, timestamp_ms);
            CREATE INDEX IF NOT EXISTS idx_activity_segments_activity ON activity_segments(activity_id, segment_index);
            CREATE INDEX IF NOT EXISTS idx_activities_start_time ON activities(start_ts_utc);

            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR PRIMARY KEY,
                value VARCHAR NOT NULL
            );

            CREATE TABLE IF NOT EXISTS file_hash_blacklist (
                file_hash VARCHAR PRIMARY KEY,
                created_at TIMESTAMP DEFAULT now()
            );
            "#,
        )?;

        conn.execute(
            "ALTER TABLE activities ADD COLUMN IF NOT EXISTS activity_kind VARCHAR",
            [],
        )?;
        conn.execute(
            "ALTER TABLE records ADD COLUMN IF NOT EXISTS segment_index BIGINT",
            [],
        )?;
        conn.execute(
            "ALTER TABLE activities ADD COLUMN IF NOT EXISTS start_latitude DOUBLE",
            [],
        )?;
        conn.execute(
            "ALTER TABLE activities ADD COLUMN IF NOT EXISTS start_longitude DOUBLE",
            [],
        )?;
        conn.execute(
            "UPDATE activities SET activity_kind = ?1 WHERE activity_kind IS NULL",
            params!["single"],
        )?;

        self.migrate_numeric_types_if_needed(&conn)?;
        conn.execute(
            r#"
                        UPDATE activities
                        SET
                                start_latitude = (
                                        SELECT CAST(r.latitude AS DOUBLE)
                                        FROM records r
                                        WHERE r.activity_id = activities.id
                                            AND r.latitude IS NOT NULL
                                            AND r.longitude IS NOT NULL
                                        ORDER BY r.timestamp_ms ASC
                                        LIMIT 1
                                ),
                                start_longitude = (
                                        SELECT CAST(r.longitude AS DOUBLE)
                                        FROM records r
                                        WHERE r.activity_id = activities.id
                                            AND r.latitude IS NOT NULL
                                            AND r.longitude IS NOT NULL
                                        ORDER BY r.timestamp_ms ASC
                                        LIMIT 1
                                )
                        WHERE start_latitude IS NULL OR start_longitude IS NULL
                        "#,
            [],
        )?;

        // Re-assert indexes after any table rebuild migration.
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_records_activity_time ON records(activity_id, timestamp_ms)",
            [],
        );
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_records_activity_segment_time ON records(activity_id, segment_index, timestamp_ms)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_activity_segments_activity ON activity_segments(activity_id, segment_index)",
            [],
        )?;
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_activities_start_time ON activities(start_ts_utc)",
            [],
        );
        Ok(())
    }

    fn migrate_numeric_types_if_needed(&self, conn: &Connection) -> Result<()> {
        let activities_needs_migration =
            !column_type_matches(conn, "activities", "duration_s", "REAL")?
                || !column_type_matches(conn, "activities", "distance_m", "REAL")?;

        if activities_needs_migration {
            tracing::info!("migrating activities numeric column types");
            conn.execute_batch(
                r#"
                CREATE TABLE activities_migrated (
                    id BIGINT PRIMARY KEY,
                    file_hash VARCHAR NOT NULL UNIQUE,
                    file_name VARCHAR NOT NULL,
                    activity_name VARCHAR NOT NULL,
                    sport VARCHAR,
                    device VARCHAR,
                    start_ts_utc TIMESTAMP,
                    end_ts_utc TIMESTAMP,
                    duration_s REAL,
                    distance_m REAL,
                    start_latitude DOUBLE,
                    start_longitude DOUBLE,
                    source VARCHAR,
                    imported_at TIMESTAMP DEFAULT now(),
                    metadata_json VARCHAR,
                    activity_kind VARCHAR
                );

                INSERT INTO activities_migrated (
                    id, file_hash, file_name, activity_name, sport, device,
                    start_ts_utc, end_ts_utc, duration_s, distance_m,
                    start_latitude, start_longitude, source, imported_at,
                    metadata_json, activity_kind
                )
                SELECT
                    id,
                    file_hash,
                    file_name,
                    activity_name,
                    sport,
                    device,
                    start_ts_utc,
                    end_ts_utc,
                    CAST(duration_s AS REAL),
                    CAST(distance_m AS REAL),
                    start_latitude,
                    start_longitude,
                    source,
                    imported_at,
                    metadata_json,
                    activity_kind
                FROM activities;

                DROP TABLE activities;
                ALTER TABLE activities_migrated RENAME TO activities;
                "#,
            )?;
            tracing::info!("activities numeric type migration completed");
        }

        let records_needs_migration = !column_type_matches(conn, "records", "latitude", "DOUBLE")?
            || !column_type_matches(conn, "records", "longitude", "DOUBLE")?
            || !column_type_matches(conn, "records", "altitude_m", "REAL")?
            || !column_type_matches(conn, "records", "distance_m", "REAL")?
            || !column_type_matches(conn, "records", "speed_m_s", "REAL")?
            || !column_type_matches(conn, "records", "temperature_c", "REAL")?;

        if records_needs_migration {
            tracing::info!("migrating records numeric column types");
            conn.execute_batch(
                r#"
                CREATE TABLE records_migrated (
                    activity_id BIGINT NOT NULL,
                    timestamp_ms BIGINT NOT NULL,
                    latitude DOUBLE,
                    longitude DOUBLE,
                    altitude_m REAL,
                    distance_m REAL,
                    speed_m_s REAL,
                    cadence BIGINT,
                    heart_rate BIGINT,
                    power BIGINT,
                    temperature_c REAL,
                    raw_fields_json VARCHAR,
                    segment_index BIGINT
                );

                INSERT INTO records_migrated (
                    activity_id, timestamp_ms, latitude, longitude, altitude_m,
                    distance_m, speed_m_s, cadence, heart_rate, power,
                    temperature_c, raw_fields_json, segment_index
                )
                SELECT
                    activity_id,
                    timestamp_ms,
                    CAST(latitude AS DOUBLE),
                    CAST(longitude AS DOUBLE),
                    CAST(altitude_m AS REAL),
                    CAST(distance_m AS REAL),
                    CAST(speed_m_s AS REAL),
                    cadence,
                    heart_rate,
                    power,
                    CAST(temperature_c AS REAL),
                    raw_fields_json,
                    segment_index
                FROM records;

                DROP TABLE records;
                ALTER TABLE records_migrated RENAME TO records;
                "#,
            )?;
            tracing::info!("records numeric type migration completed");
        }

        Ok(())
    }

    pub fn has_user(&self) -> Result<bool> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM users")?;
        let count: i64 = stmt.query_row([], |r| r.get(0))?;
        Ok(count > 0)
    }

    pub fn create_user(&self, username: &str, password_hash: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute(
                "INSERT INTO users (id, username, password_hash) VALUES (?1, ?2, ?3)",
                params![1_i64, username, password_hash],
            )?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    pub fn get_password_hash(&self) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT password_hash FROM users LIMIT 1")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(row.get(0)?));
        }
        Ok(None)
    }

    pub fn insert_session(&self, token: &str, expiry_iso: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, 1, ?2)",
                params![token, expiry_iso],
            )?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    pub fn delete_sessions_for_user(&self, user_id: i64) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute("DELETE FROM sessions WHERE user_id = ?1", params![user_id])?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    pub fn purge_expired_sessions(&self) -> Result<usize> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let deleted = conn.execute("DELETE FROM sessions WHERE expires_at <= now()", [])?;
        Ok(deleted)
    }

    #[cfg(all(feature = "web", not(feature = "tauri-app")))]
    pub fn session_valid(&self, token: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt =
            conn.prepare("SELECT COUNT(*) FROM sessions WHERE token = ?1 AND expires_at > now()")?;
        let count: i64 = stmt.query_row(params![token], |r| r.get(0))?;
        Ok(count > 0)
    }

    #[cfg(all(feature = "web", not(feature = "tauri-app")))]
    pub fn delete_session(&self, token: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute("DELETE FROM sessions WHERE token = ?1", params![token])?;
        Ok(())
    }

    pub fn is_file_imported(&self, file_hash: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM activities WHERE file_hash = ?1")?;
        let count: i64 = stmt.query_row(params![file_hash], |r| r.get(0))?;
        Ok(count > 0)
    }

    pub fn activity_exists_with_exact_times(
        &self,
        start_ts_utc: &str,
        end_ts_utc: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT COUNT(*) FROM activities WHERE start_ts_utc = CAST(?1 AS TIMESTAMP) AND end_ts_utc = CAST(?2 AS TIMESTAMP)",
        )?;
        let count: i64 = stmt.query_row(params![start_ts_utc, end_ts_utc], |r| r.get(0))?;
        Ok(count > 0)
    }

    pub fn insert_activity(&self, p: ParsedActivity) -> Result<i64> {
        let activity_id: i64;
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            let tx = conn.unchecked_transaction()?;
            activity_id = tx.query_row(
                "SELECT COALESCE(MAX(id), 0) + 1 FROM activities",
                [],
                |row| row.get(0),
            )?;

            tx.execute(
                "INSERT INTO activities (id, file_hash, file_name, activity_name, sport, device, start_ts_utc, end_ts_utc, duration_s, distance_m, start_latitude, start_longitude, source, metadata_json, activity_kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    activity_id,
                    p.file_hash,
                    p.file_name,
                    p.activity_name,
                    p.sport,
                    p.device,
                    p.start_ts_utc,
                    p.end_ts_utc,
                    round_6_to_f32(p.duration_s),
                    round_6_to_f32(p.distance_m),
                    p.start_latitude,
                    p.start_longitude,
                    p.source_format,
                    p.metadata_json,
                    p.activity_kind
                ],
            )?;

            {
                let mut stmt = tx.prepare(
                    "INSERT INTO activity_segments (activity_id, segment_index, segment_type, name, sport, sub_sport, start_ts_utc, end_ts_utc, timer_duration_s, elapsed_duration_s, distance_m, record_distance_offset_m, start_latitude, start_longitude, metadata_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                )?;
                for segment in p.segments {
                    stmt.execute(params![
                        activity_id,
                        segment.segment_index,
                        segment.segment_type,
                        segment.name,
                        segment.sport,
                        segment.sub_sport,
                        segment.start_ts_utc,
                        segment.end_ts_utc,
                        round_6_to_f32(segment.timer_duration_s),
                        round_6_to_f32(segment.elapsed_duration_s),
                        round_6_to_f32(segment.distance_m),
                        round_6_to_f32(segment.record_distance_offset_m),
                        segment.start_latitude,
                        segment.start_longitude,
                        segment.metadata_json
                    ])?;
                }
            }

            {
                let mut stmt = tx.prepare(
                    "INSERT INTO records (activity_id, timestamp_ms, latitude, longitude, altitude_m, distance_m, speed_m_s, cadence, heart_rate, power, temperature_c, raw_fields_json, segment_index)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                )?;
                for record in p.records {
                    insert_record(&mut stmt, activity_id, record)?;
                }
            }
            tx.commit()?;
        }

        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(activity_id)
    }

    pub fn list_activities(&self) -> Result<Vec<Activity>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut segments_by_activity: HashMap<i64, Vec<ActivitySegment>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "SELECT activity_id, segment_index, segment_type, name, sport, sub_sport, CAST(start_ts_utc AS VARCHAR), CAST(end_ts_utc AS VARCHAR), CAST(COALESCE(timer_duration_s, 0) AS DOUBLE), CAST(COALESCE(elapsed_duration_s, 0) AS DOUBLE), CAST(COALESCE(distance_m, 0) AS DOUBLE), CAST(COALESCE(record_distance_offset_m, 0) AS DOUBLE), CAST(start_latitude AS DOUBLE), CAST(start_longitude AS DOUBLE), metadata_json
                 FROM activity_segments ORDER BY activity_id, segment_index",
            )?;
            let rows = stmt.query_map([], activity_segment_from_row)?;
            for row in rows {
                let segment = row?;
                segments_by_activity
                    .entry(segment.activity_id)
                    .or_default()
                    .push(segment);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT id, file_name, activity_name, sport, device, CAST(start_ts_utc AS VARCHAR), CAST(end_ts_utc AS VARCHAR), CAST(COALESCE(duration_s,0) AS DOUBLE), CAST(COALESCE(distance_m,0) AS DOUBLE), CAST(start_latitude AS DOUBLE), CAST(start_longitude AS DOUBLE), metadata_json, activity_kind
             FROM activities ORDER BY start_ts_utc DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let id = row.get(0)?;
            Ok(Activity {
                id,
                file_name: row.get(1)?,
                activity_name: row.get(2)?,
                sport: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                device: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                start_ts_utc: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                end_ts_utc: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                duration_s: row.get(7)?,
                distance_m: row.get(8)?,
                start_latitude: row.get(9)?,
                start_longitude: row.get(10)?,
                metadata_json: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
                activity_kind: row
                    .get::<_, Option<String>>(12)?
                    .unwrap_or_else(|| "single".to_string()),
                segments: segments_by_activity.remove(&id).unwrap_or_default(),
            })
        })?;

        let mut out = Vec::new();
        for item in rows {
            out.push(item?);
        }
        Ok(out)
    }

    pub fn list_activity_segments(&self, activity_id: i64) -> Result<Vec<ActivitySegment>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT activity_id, segment_index, segment_type, name, sport, sub_sport, CAST(start_ts_utc AS VARCHAR), CAST(end_ts_utc AS VARCHAR), CAST(COALESCE(timer_duration_s, 0) AS DOUBLE), CAST(COALESCE(elapsed_duration_s, 0) AS DOUBLE), CAST(COALESCE(distance_m, 0) AS DOUBLE), CAST(COALESCE(record_distance_offset_m, 0) AS DOUBLE), CAST(start_latitude AS DOUBLE), CAST(start_longitude AS DOUBLE), metadata_json
             FROM activity_segments WHERE activity_id = ?1 ORDER BY segment_index",
        )?;
        let rows = stmt.query_map(params![activity_id], activity_segment_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn rename_activity(&self, activity_id: i64, name: &str) -> Result<bool> {
        let changed = {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute(
                "UPDATE activities SET activity_name = ?1 WHERE id = ?2",
                params![name, activity_id],
            )?
        };
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(changed > 0)
    }

    pub fn delete_activity(&self, activity_id: i64) -> Result<bool> {
        let changed = {
            let conn = self.conn.lock().expect("db mutex poisoned");
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "DELETE FROM records WHERE activity_id = ?1",
                params![activity_id],
            )?;
            tx.execute(
                "DELETE FROM activity_segments WHERE activity_id = ?1",
                params![activity_id],
            )?;
            let changed =
                tx.execute("DELETE FROM activities WHERE id = ?1", params![activity_id])?;
            tx.commit()?;
            changed
        };
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(changed > 0)
    }

    pub fn overview(&self) -> Result<OverviewStats> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT COUNT(*), CAST(COALESCE(SUM(distance_m),0) AS DOUBLE), CAST(COALESCE(SUM(duration_s),0) AS DOUBLE) FROM activities",
        )?;
        stmt.query_row([], |r| {
            Ok(OverviewStats {
                activity_count: r.get(0)?,
                total_distance_m: r.get(1)?,
                total_duration_s: r.get(2)?,
            })
        })
        .map_err(Into::into)
    }

    pub fn records_downsampled(
        &self,
        activity_id: i64,
        resolution_ms: i64,
        segment_index: Option<i64>,
    ) -> Result<Vec<RecordPoint>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let distance_offset = if let Some(segment_index) = segment_index {
            let mut stmt = conn.prepare(
                "SELECT CAST(COALESCE(record_distance_offset_m, 0) AS DOUBLE)
                 FROM activity_segments WHERE activity_id = ?1 AND segment_index = ?2",
            )?;
            let mut rows = stmt.query(params![activity_id, segment_index])?;
            rows.next()?
                .map(|row| row.get(0))
                .transpose()?
                .unwrap_or(0.0)
        } else {
            0.0
        };
        let query = r#"
            SELECT
              MIN(timestamp_ms) AS timestamp_ms,
              CAST(AVG(latitude) AS DOUBLE) AS latitude,
              CAST(AVG(longitude) AS DOUBLE) AS longitude,
              CAST(AVG(altitude_m) AS DOUBLE) AS altitude_m,
              CAST(MAX(distance_m) AS DOUBLE) AS distance_m,
              CAST(AVG(speed_m_s) AS DOUBLE) AS speed_m_s,
              AVG(cadence) AS cadence,
              AVG(heart_rate) AS heart_rate,
              AVG(power) AS power,
              CAST(AVG(temperature_c) AS DOUBLE) AS temperature_c
            FROM records
            WHERE activity_id = ?1 AND (?3 IS NULL OR segment_index = ?3)
            GROUP BY (timestamp_ms / ?2)
            ORDER BY timestamp_ms
        "#;

        let mut stmt = conn.prepare(query)?;
        let rows = stmt.query_map(
            params![activity_id, resolution_ms.max(1000), segment_index],
            |row| {
                let distance_m = row
                    .get::<_, Option<f64>>(4)?
                    .map(|distance| (distance - distance_offset).max(0.0));
                Ok(RecordPoint {
                    timestamp_ms: row.get(0)?,
                    latitude: row.get(1)?,
                    longitude: row.get(2)?,
                    altitude_m: row.get(3)?,
                    distance_m,
                    speed_m_s: row.get(5)?,
                    cadence: row.get::<_, Option<f64>>(6)?.map(|value| value as i64),
                    heart_rate: row.get::<_, Option<f64>>(7)?.map(|value| value as i64),
                    power: row.get::<_, Option<f64>>(8)?.map(|value| value as i64),
                    temperature_c: row.get(9)?,
                    segment_index,
                })
            },
        )?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

fn activity_segment_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<ActivitySegment> {
    Ok(ActivitySegment {
        activity_id: row.get(0)?,
        segment_index: row.get(1)?,
        segment_type: row.get(2)?,
        name: row.get(3)?,
        sport: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        sub_sport: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        start_ts_utc: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        end_ts_utc: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        timer_duration_s: row.get(8)?,
        elapsed_duration_s: row.get(9)?,
        distance_m: row.get(10)?,
        record_distance_offset_m: row.get(11)?,
        start_latitude: row.get(12)?,
        start_longitude: row.get(13)?,
        metadata_json: row.get::<_, Option<String>>(14)?.unwrap_or_default(),
    })
}

fn is_wal_replay_internal_error(err: &duckdb::Error) -> bool {
    let msg = err.to_string().to_lowercase();
    msg.contains("failure while replaying wal file")
        || msg.contains("databasemanager::getdefaultdatabase")
}

fn quarantine_wal_file(wal_path: &Path) -> Result<PathBuf> {
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let target = wal_path.with_extension(format!("wal.broken.{ts}"));

    if std::fs::rename(wal_path, &target).is_err() {
        std::fs::copy(wal_path, &target)?;
        std::fs::remove_file(wal_path)?;
    }

    Ok(target)
}

fn column_type_matches(
    conn: &Connection,
    table: &str,
    column: &str,
    expected: &str,
) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info('{}')", table))?;
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        let col_type: String = row.get(2)?;
        Ok((name, col_type))
    })?;

    for row in rows {
        let (name, col_type) = row?;
        if name == column {
            return Ok(type_equivalent(&col_type, expected));
        }
    }

    Ok(false)
}

fn type_equivalent(actual: &str, expected: &str) -> bool {
    let a = actual.trim().to_ascii_uppercase();
    let e = expected.trim().to_ascii_uppercase();
    match e.as_str() {
        "REAL" => matches!(a.as_str(), "REAL" | "FLOAT" | "FLOAT4"),
        "DOUBLE" => matches!(a.as_str(), "DOUBLE" | "FLOAT8"),
        _ => a == e,
    }
}

fn insert_record(stmt: &mut duckdb::Statement<'_>, activity_id: i64, r: RecordPoint) -> Result<()> {
    // Keep max available precision for coordinates.
    let latitude = r.latitude;
    let longitude = r.longitude;
    // Keep up to 6 decimals for remaining high-cardinality numeric telemetry fields.
    let altitude_m = r.altitude_m.map(round_6_to_f32);
    let distance_m = r.distance_m.map(round_6_to_f32);
    let speed_m_s = r.speed_m_s.map(round_6_to_f32);
    let temperature_c = r.temperature_c.map(round_6_to_f32);
    let cadence = r.cadence;

    stmt.execute(params![
        activity_id,
        r.timestamp_ms,
        latitude,
        longitude,
        altitude_m,
        distance_m,
        speed_m_s,
        cadence,
        r.heart_rate,
        r.power,
        temperature_c,
        "{}",
        r.segment_index
    ])?;
    Ok(())
}

fn round_6_to_f32(value: f64) -> f32 {
    (((value as f32) * 1_000_000.0).round()) / 1_000_000.0
}

impl Database {
    pub fn get_activity_hash(&self, activity_id: i64) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT file_hash FROM activities WHERE id = ?1")?;
        let mut rows = stmt.query(params![activity_id])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(row.get(0)?));
        }
        Ok(None)
    }

    pub fn add_blacklisted_hash(&self, file_hash: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute(
                "DELETE FROM file_hash_blacklist WHERE file_hash = ?1",
                params![file_hash],
            )?;
            conn.execute(
                "INSERT INTO file_hash_blacklist (file_hash) VALUES (?1)",
                params![file_hash],
            )?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    pub fn remove_blacklisted_hash(&self, file_hash: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute(
                "DELETE FROM file_hash_blacklist WHERE file_hash = ?1",
                params![file_hash],
            )?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    pub fn is_hash_blacklisted(&self, file_hash: &str) -> Result<bool> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt =
            conn.prepare("SELECT COUNT(*) FROM file_hash_blacklist WHERE file_hash = ?1")?;
        let count: i64 = stmt.query_row(params![file_hash], |r| r.get(0))?;
        Ok(count > 0)
    }

    pub fn clear_blacklisted_hashes(&self) -> Result<usize> {
        let removed = {
            let conn = self.conn.lock().expect("db mutex poisoned");
            conn.execute("DELETE FROM file_hash_blacklist", [])?
        };
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(removed)
    }

    pub fn blacklisted_hash_count(&self) -> Result<usize> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT COUNT(*) FROM file_hash_blacklist")?;
        let count: i64 = stmt.query_row([], |r| r.get(0))?;
        Ok(count.max(0) as usize)
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        if let Some(row) = rows.next()? {
            return Ok(Some(row.get(0)?));
        }
        Ok(None)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        {
            let conn = self.conn.lock().expect("db mutex poisoned");
            // DuckDB doesn't support INSERT OR REPLACE; delete then insert
            conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                params![key, value],
            )?;
        }
        self.checkpoint_if_wal_exceeds_limit()?;
        Ok(())
    }

    #[cfg(all(feature = "web", not(feature = "tauri-app")))]
    pub fn delete_setting(&self, key: &str) -> Result<()> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }
}

#[cfg(test)]
mod multisport_tests {
    use super::*;
    use crate::models::ParsedActivitySegment;

    fn segment(segment_index: i64, sport: &str, offset: f64) -> ParsedActivitySegment {
        ParsedActivitySegment {
            segment_index,
            segment_type: "sport".to_string(),
            name: sport.to_string(),
            sport: sport.to_lowercase(),
            sub_sport: String::new(),
            start_ts_utc: format!("2026-01-01T00:00:0{}Z", segment_index - 1),
            end_ts_utc: format!("2026-01-01T00:00:0{}Z", segment_index),
            timer_duration_s: 1.0,
            elapsed_duration_s: 1.0,
            distance_m: 40.0,
            record_distance_offset_m: offset,
            start_latitude: None,
            start_longitude: None,
            metadata_json: "{}".to_string(),
        }
    }

    fn record(timestamp_ms: i64, distance_m: f64, segment_index: i64) -> RecordPoint {
        RecordPoint {
            timestamp_ms,
            latitude: None,
            longitude: None,
            altitude_m: None,
            distance_m: Some(distance_m),
            speed_m_s: None,
            cadence: None,
            heart_rate: None,
            power: None,
            temperature_c: None,
            segment_index: Some(segment_index),
        }
    }

    fn parsed_activity() -> ParsedActivity {
        ParsedActivity {
            file_name: "multi.fit".to_string(),
            source_format: "fit".to_string(),
            activity_name: "Multisport".to_string(),
            sport: "multisport".to_string(),
            device: "Test Device".to_string(),
            start_ts_utc: "2026-01-01T00:00:00Z".to_string(),
            end_ts_utc: "2026-01-01T00:00:03Z".to_string(),
            duration_s: 3.0,
            distance_m: 130.0,
            start_latitude: None,
            start_longitude: None,
            file_hash: "multisport-test-hash".to_string(),
            records: vec![
                record(0, 0.0, 1),
                record(1_000, 90.0, 1),
                record(2_000, 100.0, 2),
                record(3_000, 130.0, 2),
            ],
            metadata_json: "{}".to_string(),
            activity_kind: "multisport_parent".to_string(),
            segments: vec![segment(1, "Cycling", 0.0), segment(2, "Running", 90.0)],
        }
    }

    #[test]
    fn stores_lists_scopes_and_deletes_multisport_activity() {
        let db = Database::new(":memory:").expect("database");
        let activity_id = db.insert_activity(parsed_activity()).expect("insert");

        let activities = db.list_activities().expect("activities");
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].activity_kind, "multisport_parent");
        assert_eq!(activities[0].segments.len(), 2);

        let records = db
            .records_downsampled(activity_id, 1_000, Some(2))
            .expect("segment records");
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].distance_m, Some(10.0));
        assert_eq!(records[1].distance_m, Some(40.0));
        assert!(records.iter().all(|record| record.segment_index == Some(2)));

        assert!(db.delete_activity(activity_id).expect("delete"));
        assert!(db
            .list_activities()
            .expect("activities after delete")
            .is_empty());
        assert!(db
            .list_activity_segments(activity_id)
            .expect("segments after delete")
            .is_empty());
        assert!(db
            .records_downsampled(activity_id, 1_000, None)
            .expect("records after delete")
            .is_empty());
    }

    #[test]
    fn duplicate_segment_rolls_back_parent_and_records() {
        let db = Database::new(":memory:").expect("database");
        let mut parsed = parsed_activity();
        parsed.segments.push(parsed.segments[0].clone());

        assert!(db.insert_activity(parsed).is_err());
        assert!(db.list_activities().expect("activities").is_empty());
        assert!(db.list_activity_segments(1).expect("segments").is_empty());
        assert!(db
            .records_downsampled(1, 1_000, None)
            .expect("records")
            .is_empty());
    }

    #[test]
    fn migrates_pre_multisport_schema_before_numeric_rebuild() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fit-dashboard-multisport-migration-{}-{nonce}.duckdb",
            std::process::id(),
        ));
        {
            let conn = Connection::open(&path).expect("old database");
            conn.execute_batch(
                r#"
                CREATE TABLE activities (
                    id BIGINT PRIMARY KEY, file_hash VARCHAR NOT NULL UNIQUE,
                    file_name VARCHAR NOT NULL, activity_name VARCHAR NOT NULL,
                    sport VARCHAR, device VARCHAR, start_ts_utc TIMESTAMP,
                    end_ts_utc TIMESTAMP, duration_s DOUBLE, distance_m DOUBLE,
                    source VARCHAR, imported_at TIMESTAMP DEFAULT now(),
                    metadata_json VARCHAR
                );
                CREATE TABLE records (
                    activity_id BIGINT NOT NULL, timestamp_ms BIGINT NOT NULL,
                    latitude REAL, longitude REAL, altitude_m DOUBLE,
                    distance_m DOUBLE, speed_m_s DOUBLE, cadence BIGINT,
                    heart_rate BIGINT, power BIGINT, temperature_c DOUBLE,
                    raw_fields_json VARCHAR
                );
                INSERT INTO activities (
                    id, file_hash, file_name, activity_name, sport, device,
                    start_ts_utc, end_ts_utc, duration_s, distance_m, source,
                    metadata_json
                ) VALUES (
                    1, 'old-hash', 'old.fit', 'Old activity', 'running', '',
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z',
                    1.0, 2.0, 'fit', '{}'
                );
                INSERT INTO records (activity_id, timestamp_ms, latitude, longitude, distance_m)
                VALUES (1, 0, 51.0, -114.0, 2.0);
                "#,
            )
            .expect("old schema");
        }

        let db = Database::new(path.to_str().expect("database path")).expect("migration");
        let activities = db.list_activities().expect("activities");
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].activity_kind, "single");
        assert!(activities[0].segments.is_empty());
        assert_eq!(activities[0].start_latitude, Some(51.0));
        {
            let conn = db.conn.lock().expect("database lock");
            assert!(
                column_type_matches(&conn, "activities", "duration_s", "REAL")
                    .expect("activity type")
            );
            assert!(
                column_type_matches(&conn, "records", "latitude", "DOUBLE").expect("record type")
            );
            assert!(
                column_type_matches(&conn, "records", "segment_index", "BIGINT")
                    .expect("segment column")
            );
        }
        drop(db);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.wal", path.display()));
    }
}
