//! Drop-in replacement for the `web-time` crate.
//!
//! acadrust only uses `Instant::now()` / `SystemTime::now()` / `UNIX_EPOCH`
//! for internal timing diagnostics (elapsed logs and sheet-set stamps). The
//! wasm32-unknown-unknown target has no clock access without JS imports, and
//! `std::time::Instant::now()` panics there, which aborts the whole wasm
//! instance (panic=unwind is not available). This shim therefore provides:
//! - on every target: the same names as web-time;
//! - on wasm32: a synthetic monotonic clock (each `now()` call advances by
//!   1 ms, `elapsed()` measures that counter) and a fixed `UNIX_EPOCH` —
//!   plenty for log timing, and the resulting .wasm has zero imports, so it
//!   loads as a plain WebAssembly module under any CSP.

#[cfg(not(target_arch = "wasm32"))]
pub use std::time::{Duration, Instant, SystemTime, SystemTimeError, UNIX_EPOCH};

#[cfg(target_arch = "wasm32")]
mod imp {
    use core::sync::atomic::{AtomicU64, Ordering};

    pub use core::time::Duration;

    /// Nanoseconds on the synthetic clock.
    static NOW: AtomicU64 = AtomicU64::new(0);

    /// Synthetic monotonic instant: each `now()` call advances the clock by
    /// 1 ms so elapsed durations are strictly positive (log timing only).
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct Instant {
        nanos: u64,
    }

    impl Instant {
        pub fn now() -> Self {
            Instant {
                nanos: NOW.fetch_add(1_000_000, Ordering::Relaxed),
            }
        }

        pub fn duration_since(&self, earlier: Instant) -> Duration {
            Duration::from_nanos(self.nanos.saturating_sub(earlier.nanos))
        }

        pub fn checked_duration_since(&self, earlier: Instant) -> Option<Duration> {
            self.nanos.checked_sub(earlier.nanos).map(Duration::from_nanos)
        }

        pub fn saturating_duration_since(&self, earlier: Instant) -> Duration {
            self.duration_since(earlier)
        }

        pub fn elapsed(&self) -> Duration {
            Duration::from_nanos(NOW.load(Ordering::Relaxed).saturating_sub(self.nanos))
        }

        pub fn checked_add(&self, d: Duration) -> Option<Instant> {
            self.nanos.checked_add(d.as_nanos() as u64).map(|nanos| Instant { nanos })
        }

        pub fn checked_sub(&self, d: Duration) -> Option<Instant> {
            self.nanos.checked_sub(d.as_nanos() as u64).map(|nanos| Instant { nanos })
        }
    }

    /// Fixed wall-clock stamp (the epoch itself) — sheet-set timestamps only.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
    pub struct SystemTime {
        secs: u64,
    }

    pub const UNIX_EPOCH: SystemTime = SystemTime { secs: 0 };

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct SystemTimeError {
        _priv: (),
    }

    impl core::fmt::Display for SystemTimeError {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            f.write_str("second time provided was later than self")
        }
    }

    impl std::error::Error for SystemTimeError {}

    impl SystemTime {
        pub const UNIX_EPOCH: SystemTime = UNIX_EPOCH;

        pub fn now() -> Self {
            UNIX_EPOCH
        }

        pub fn duration_since(&self, earlier: SystemTime) -> Result<Duration, SystemTimeError> {
            if self.secs >= earlier.secs {
                Ok(Duration::from_secs(self.secs - earlier.secs))
            } else {
                Err(SystemTimeError { _priv: () })
            }
        }

        pub fn elapsed(&self) -> Result<Duration, SystemTimeError> {
            Self::now().duration_since(*self)
        }

        pub fn checked_add_duration(&self, d: &Duration) -> Option<SystemTime> {
            self.secs.checked_add(d.as_secs()).map(|secs| SystemTime { secs })
        }

        pub fn checked_sub_duration(&self, d: &Duration) -> Option<SystemTime> {
            self.secs.checked_sub(d.as_secs()).map(|secs| SystemTime { secs })
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use imp::*;
