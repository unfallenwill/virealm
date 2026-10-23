//! Structured diagnostics.
//!
//! Diagnostics are data, not log strings. The host application decides how to
//! present them; the runtime only guarantees that every event carries a stable
//! component name, a stable event code and machine-readable context.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Severity of a diagnostic event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// One structured event emitted by the runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    pub timestamp_unix_ms: u64,
    pub level: DiagnosticLevel,
    /// Runtime component that produced the event, e.g. `process.launch`.
    pub component: String,
    /// Stable event code, e.g. `containment_assignment_failed`.
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub context: BTreeMap<String, String>,
}

impl DiagnosticEvent {
    /// Build an event stamped with the current time.
    pub fn new(
        level: DiagnosticLevel,
        component: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            timestamp_unix_ms: now_unix_ms(),
            level,
            component: component.into(),
            code: code.into(),
            message: message.into(),
            context: BTreeMap::new(),
        }
    }

    /// Attach one context entry.
    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.insert(key.into(), value.into());
        self
    }
}

/// Destination for diagnostic events.
///
/// Implementations must be cheap to call from the launch path and must not
/// block indefinitely; the runtime makes no attempt to buffer events.
pub trait DiagnosticSink: Send + Sync {
    fn record(&self, event: DiagnosticEvent);
}

/// Sink that discards every event.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullDiagnosticSink;

impl DiagnosticSink for NullDiagnosticSink {
    fn record(&self, _event: DiagnosticEvent) {}
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_carries_context() {
        let event = DiagnosticEvent::new(
            DiagnosticLevel::Warn,
            "process.launch",
            "capability_missing",
            "AppContainer is unavailable",
        )
        .with_context("environment_id", "env-1");

        assert_eq!(event.context["environment_id"], "env-1");
    }

    #[test]
    fn null_sink_accepts_events() {
        let sink = NullDiagnosticSink;
        sink.record(DiagnosticEvent::new(
            DiagnosticLevel::Info,
            "runtime",
            "started",
            "runtime started",
        ));
    }
}
