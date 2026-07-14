use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::database::Database;

pub const POWER_ZONE_PREFERENCES_KEY: &str = "power_zone_preferences";
pub const POWER_ZONE_PREFERENCES_VERSION: u8 = 2;
pub const POWER_ZONE_BOUND_COUNT: usize = 6;
const LEGACY_POWER_ZONE_PREFERENCES_VERSION: u8 = 1;
const LEGACY_POWER_ZONE_BOUND_COUNT: usize = 7;
pub const POWER_ZONE_BOUND_MIN_PERCENT: i32 = 1;
pub const POWER_ZONE_BOUND_MAX_PERCENT: i32 = 300;
pub const POWER_ZONE_BOUND_MIN_GAP_PERCENT: i32 = 5;

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PowerZoneTimeSource {
    Fit,
    Calculated,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct PowerZonePreferences {
    pub version: u8,
    pub bounds_percent_ftp: Vec<i32>,
    pub zone_time_source: PowerZoneTimeSource,
}

impl Default for PowerZonePreferences {
    fn default() -> Self {
        Self {
            version: POWER_ZONE_PREFERENCES_VERSION,
            bounds_percent_ftp: vec![55, 75, 90, 105, 120, 150],
            zone_time_source: PowerZoneTimeSource::Fit,
        }
    }
}

fn validate_power_zone_bounds(bounds: &[i32], expected_count: usize) -> Result<()> {
    if bounds.len() != expected_count {
        bail!("power-zone preferences require exactly {expected_count} boundaries");
    }
    if bounds.iter().any(|value| {
        !(POWER_ZONE_BOUND_MIN_PERCENT..=POWER_ZONE_BOUND_MAX_PERCENT).contains(value)
    }) {
        bail!(
            "power-zone boundaries must be between {} and {} percent FTP",
            POWER_ZONE_BOUND_MIN_PERCENT,
            POWER_ZONE_BOUND_MAX_PERCENT
        );
    }
    if bounds
        .windows(2)
        .any(|pair| pair[1] - pair[0] < POWER_ZONE_BOUND_MIN_GAP_PERCENT)
    {
        bail!(
            "power-zone boundaries must be strictly increasing with a gap of at least {} percent FTP",
            POWER_ZONE_BOUND_MIN_GAP_PERCENT
        );
    }
    Ok(())
}

impl PowerZonePreferences {
    pub fn validate(&self) -> Result<()> {
        if self.version != POWER_ZONE_PREFERENCES_VERSION {
            bail!("unsupported power-zone preference version");
        }
        validate_power_zone_bounds(&self.bounds_percent_ftp, POWER_ZONE_BOUND_COUNT)
    }
}

fn migrate_legacy_power_zone_preferences(
    preferences: &PowerZonePreferences,
) -> Option<PowerZonePreferences> {
    if preferences.version != LEGACY_POWER_ZONE_PREFERENCES_VERSION
        || validate_power_zone_bounds(
            &preferences.bounds_percent_ftp,
            LEGACY_POWER_ZONE_BOUND_COUNT,
        )
        .is_err()
    {
        return None;
    }

    let mut bounds_percent_ftp = preferences.bounds_percent_ftp.clone();
    bounds_percent_ftp.truncate(POWER_ZONE_BOUND_COUNT);
    let migrated = PowerZonePreferences {
        version: POWER_ZONE_PREFERENCES_VERSION,
        bounds_percent_ftp,
        zone_time_source: preferences.zone_time_source,
    };
    migrated.validate().ok()?;
    Some(migrated)
}

pub fn load_power_zone_preferences(db: &Database) -> Result<PowerZonePreferences> {
    let Some(raw) = db
        .get_setting(POWER_ZONE_PREFERENCES_KEY)
        .context("failed reading power-zone preferences")?
    else {
        return Ok(PowerZonePreferences::default());
    };

    match serde_json::from_str::<PowerZonePreferences>(&raw) {
        Ok(preferences) => {
            if let Some(migrated) = migrate_legacy_power_zone_preferences(&preferences) {
                if let Err(error) = save_power_zone_preferences(db, migrated.clone()) {
                    tracing::warn!(error = %error, "could not persist migrated power-zone preferences");
                }
                return Ok(migrated);
            }

            match preferences.validate() {
                Ok(()) => Ok(preferences),
                Err(error) => {
                    tracing::warn!(error = %error, "stored power-zone preferences are invalid; using defaults");
                    Ok(PowerZonePreferences::default())
                }
            }
        },
        Err(error) => {
            tracing::warn!(error = %error, "stored power-zone preferences could not be decoded; using defaults");
            Ok(PowerZonePreferences::default())
        }
    }
}

pub fn save_power_zone_preferences(
    db: &Database,
    preferences: PowerZonePreferences,
) -> Result<PowerZonePreferences> {
    preferences.validate()?;
    let encoded = serde_json::to_string(&preferences)
        .context("failed encoding power-zone preferences")?;
    db.set_setting(POWER_ZONE_PREFERENCES_KEY, &encoded)
        .context("failed writing power-zone preferences")?;
    Ok(preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        PowerZonePreferences::default().validate().unwrap();
    }

    #[test]
    fn validates_bounds_and_minimum_gap() {
        let valid = PowerZonePreferences {
            bounds_percent_ftp: vec![1, 50, 100, 150, 200, 300],
            ..PowerZonePreferences::default()
        };
        valid.validate().unwrap();

        for bounds_percent_ftp in [
            vec![0, 50, 100, 150, 200, 300],
            vec![1, 50, 100, 150, 200, 301],
            vec![55, 75, 90, 105, 120],
            vec![55, 75, 90, 105, 120, 150, 200],
            vec![55, 75, 90, 105, 120, 120],
            vec![55, 75, 90, 105, 120, 124],
        ] {
            let invalid = PowerZonePreferences {
                bounds_percent_ftp,
                ..PowerZonePreferences::default()
            };
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn serializes_the_versioned_wire_format() {
        let encoded = serde_json::to_value(PowerZonePreferences::default()).unwrap();
        assert_eq!(encoded["version"], 2);
        assert_eq!(
            encoded["bounds_percent_ftp"],
            serde_json::json!([55, 75, 90, 105, 120, 150])
        );
        assert_eq!(encoded["zone_time_source"], "fit");
    }

    #[test]
    fn saves_and_reloads_preferences() {
        let db = Database::new(":memory:").unwrap();
        let preferences = PowerZonePreferences {
            bounds_percent_ftp: vec![50, 70, 85, 100, 115, 140],
            zone_time_source: PowerZoneTimeSource::Calculated,
            ..PowerZonePreferences::default()
        };

        assert_eq!(
            save_power_zone_preferences(&db, preferences.clone()).unwrap(),
            preferences
        );
        assert_eq!(load_power_zone_preferences(&db).unwrap(), preferences);
    }

    #[test]
    fn migrates_version_one_preferences_and_preserves_source() {
        let db = Database::new(":memory:").unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "bounds_percent_ftp": [50, 70, 85, 100, 115, 140, 190],
            "zone_time_source": "calculated"
        });
        db.set_setting(POWER_ZONE_PREFERENCES_KEY, &legacy.to_string())
            .unwrap();

        let expected = PowerZonePreferences {
            version: POWER_ZONE_PREFERENCES_VERSION,
            bounds_percent_ftp: vec![50, 70, 85, 100, 115, 140],
            zone_time_source: PowerZoneTimeSource::Calculated,
        };
        assert_eq!(load_power_zone_preferences(&db).unwrap(), expected);

        let stored = db
            .get_setting(POWER_ZONE_PREFERENCES_KEY)
            .unwrap()
            .expect("migrated preferences should be stored");
        assert_eq!(
            serde_json::from_str::<PowerZonePreferences>(&stored).unwrap(),
            expected
        );
    }

    #[test]
    fn loads_defaults_when_preferences_are_missing() {
        let db = Database::new(":memory:").unwrap();

        assert_eq!(
            load_power_zone_preferences(&db).unwrap(),
            PowerZonePreferences::default()
        );
    }

    #[test]
    fn malformed_and_unsupported_stored_preferences_use_defaults() {
        let db = Database::new(":memory:").unwrap();
        db.set_setting(POWER_ZONE_PREFERENCES_KEY, "not json")
            .unwrap();
        assert_eq!(
            load_power_zone_preferences(&db).unwrap(),
            PowerZonePreferences::default()
        );

        let unsupported = serde_json::json!({
            "version": POWER_ZONE_PREFERENCES_VERSION + 1,
            "bounds_percent_ftp": [50, 70, 85, 100, 115, 140],
            "zone_time_source": "calculated"
        });
        db.set_setting(POWER_ZONE_PREFERENCES_KEY, &unsupported.to_string())
            .unwrap();
        assert_eq!(
            load_power_zone_preferences(&db).unwrap(),
            PowerZonePreferences::default()
        );
    }

    #[test]
    fn invalid_save_preserves_previous_preferences() {
        let db = Database::new(":memory:").unwrap();
        let previous = PowerZonePreferences::default();
        save_power_zone_preferences(&db, previous.clone()).unwrap();

        let invalid = PowerZonePreferences {
            bounds_percent_ftp: vec![55, 75, 90, 105, 120, 301],
            ..previous.clone()
        };
        assert!(save_power_zone_preferences(&db, invalid).is_err());
        assert_eq!(load_power_zone_preferences(&db).unwrap(), previous);
    }
}
