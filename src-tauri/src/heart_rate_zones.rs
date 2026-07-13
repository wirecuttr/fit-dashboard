use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::database::Database;

pub const HEART_RATE_ZONE_PREFERENCES_KEY: &str = "heart_rate_zone_preferences";
pub const HEART_RATE_ZONE_PREFERENCES_VERSION: u8 = 1;
pub const MANUAL_HR_BOUND_MIN_BPM: i32 = 40;
pub const MANUAL_HR_BOUND_MAX_BPM: i32 = 260;
pub const MANUAL_HR_BOUND_MIN_GAP_BPM: i32 = 5;

#[derive(Debug, Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManualHeartRateZoneUsage {
    Fallback,
    Always,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct HeartRateZonePreferences {
    pub version: u8,
    pub bounds_bpm: Vec<i32>,
    pub usage: ManualHeartRateZoneUsage,
}

impl Default for HeartRateZonePreferences {
    fn default() -> Self {
        Self {
            version: HEART_RATE_ZONE_PREFERENCES_VERSION,
            bounds_bpm: vec![75, 95, 120, 150],
            usage: ManualHeartRateZoneUsage::Fallback,
        }
    }
}

impl HeartRateZonePreferences {
    pub fn validate(&self) -> Result<()> {
        if self.version != HEART_RATE_ZONE_PREFERENCES_VERSION {
            bail!("unsupported heart-rate-zone preference version");
        }
        if self.bounds_bpm.len() != 4 {
            bail!("heart-rate-zone preferences require exactly four boundaries");
        }
        if self.bounds_bpm.iter().any(|value| {
            !(MANUAL_HR_BOUND_MIN_BPM..=MANUAL_HR_BOUND_MAX_BPM).contains(value)
        }) {
            bail!(
                "heart-rate-zone boundaries must be between {} and {} bpm",
                MANUAL_HR_BOUND_MIN_BPM,
                MANUAL_HR_BOUND_MAX_BPM
            );
        }
        if self
            .bounds_bpm
            .windows(2)
            .any(|pair| pair[1] - pair[0] < MANUAL_HR_BOUND_MIN_GAP_BPM)
        {
            bail!(
                "heart-rate-zone boundaries must be strictly increasing with a gap of at least {} bpm",
                MANUAL_HR_BOUND_MIN_GAP_BPM
            );
        }
        Ok(())
    }
}

pub fn load_heart_rate_zone_preferences(db: &Database) -> Result<HeartRateZonePreferences> {
    let Some(raw) = db
        .get_setting(HEART_RATE_ZONE_PREFERENCES_KEY)
        .context("failed reading heart-rate-zone preferences")?
    else {
        return Ok(HeartRateZonePreferences::default());
    };

    match serde_json::from_str::<HeartRateZonePreferences>(&raw) {
        Ok(preferences) => match preferences.validate() {
            Ok(()) => Ok(preferences),
            Err(error) => {
                tracing::warn!(error = %error, "stored heart-rate-zone preferences are invalid; using defaults");
                Ok(HeartRateZonePreferences::default())
            }
        },
        Err(error) => {
            tracing::warn!(error = %error, "stored heart-rate-zone preferences could not be decoded; using defaults");
            Ok(HeartRateZonePreferences::default())
        }
    }
}

pub fn save_heart_rate_zone_preferences(
    db: &Database,
    preferences: HeartRateZonePreferences,
) -> Result<HeartRateZonePreferences> {
    preferences.validate()?;
    let encoded = serde_json::to_string(&preferences)
        .context("failed encoding heart-rate-zone preferences")?;
    db.set_setting(HEART_RATE_ZONE_PREFERENCES_KEY, &encoded)
        .context("failed writing heart-rate-zone preferences")?;
    Ok(preferences)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        HeartRateZonePreferences::default().validate().unwrap();
    }

    #[test]
    fn validates_bounds_and_minimum_gap() {
        let valid = HeartRateZonePreferences {
            bounds_bpm: vec![40, 100, 180, 260],
            ..HeartRateZonePreferences::default()
        };
        valid.validate().unwrap();

        for bounds_bpm in [
            vec![39, 100, 180, 240],
            vec![40, 100, 180, 261],
            vec![75, 95, 120],
            vec![75, 95, 95, 150],
            vec![75, 95, 120, 124],
        ] {
            let invalid = HeartRateZonePreferences {
                bounds_bpm,
                ..HeartRateZonePreferences::default()
            };
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn serializes_the_versioned_wire_format() {
        let encoded = serde_json::to_value(HeartRateZonePreferences::default()).unwrap();
        assert_eq!(encoded["version"], 1);
        assert_eq!(encoded["bounds_bpm"], serde_json::json!([75, 95, 120, 150]));
        assert_eq!(encoded["usage"], "fallback");
    }

    #[test]
    fn loads_defaults_when_preferences_are_missing() {
        let db = Database::new(":memory:").unwrap();

        assert_eq!(
            load_heart_rate_zone_preferences(&db).unwrap(),
            HeartRateZonePreferences::default()
        );
    }

    #[test]
    fn saves_and_reloads_preferences() {
        let db = Database::new(":memory:").unwrap();
        let preferences = HeartRateZonePreferences {
            bounds_bpm: vec![80, 105, 135, 165],
            usage: ManualHeartRateZoneUsage::Always,
            ..HeartRateZonePreferences::default()
        };

        assert_eq!(
            save_heart_rate_zone_preferences(&db, preferences.clone()).unwrap(),
            preferences
        );
        assert_eq!(
            load_heart_rate_zone_preferences(&db).unwrap(),
            preferences
        );
    }

    #[test]
    fn malformed_and_unsupported_stored_preferences_use_defaults() {
        let db = Database::new(":memory:").unwrap();
        db.set_setting(HEART_RATE_ZONE_PREFERENCES_KEY, "not json")
            .unwrap();
        assert_eq!(
            load_heart_rate_zone_preferences(&db).unwrap(),
            HeartRateZonePreferences::default()
        );

        let unsupported = serde_json::json!({
            "version": HEART_RATE_ZONE_PREFERENCES_VERSION + 1,
            "bounds_bpm": [80, 105, 135, 165],
            "usage": "always"
        });
        db.set_setting(
            HEART_RATE_ZONE_PREFERENCES_KEY,
            &unsupported.to_string(),
        )
        .unwrap();
        assert_eq!(
            load_heart_rate_zone_preferences(&db).unwrap(),
            HeartRateZonePreferences::default()
        );
    }

    #[test]
    fn invalid_save_preserves_previous_preferences() {
        let db = Database::new(":memory:").unwrap();
        let previous = HeartRateZonePreferences {
            bounds_bpm: vec![80, 105, 135, 165],
            usage: ManualHeartRateZoneUsage::Always,
            ..HeartRateZonePreferences::default()
        };
        save_heart_rate_zone_preferences(&db, previous.clone()).unwrap();

        let invalid = HeartRateZonePreferences {
            bounds_bpm: vec![80, 105, 135, 261],
            ..previous.clone()
        };
        assert!(save_heart_rate_zone_preferences(&db, invalid).is_err());
        assert_eq!(
            load_heart_rate_zone_preferences(&db).unwrap(),
            previous
        );
    }
}
