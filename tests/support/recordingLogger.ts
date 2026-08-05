import type { LogContext, Logger } from "../../src/logger.js";

/**
 * Captures log lines in memory so a test can assert that a degradation was actually
 * *reported*. "Degrade" means serve a useful result **and** warn — a silent
 * degradation is the failure mode where the corpus quietly fills with raw rows and
 * nobody finds out.
 */
export interface RecordedLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly context: LogContext;
  readonly message: string;
}

export interface RecordingLogger extends Logger {
  readonly lines: readonly RecordedLine[];
  /** Messages at a level, for asserting a specific degradation was reported. */
  messages(level: RecordedLine["level"]): string[];
}

export function createRecordingLogger(): RecordingLogger {
  const lines: RecordedLine[] = [];

  const record =
    (level: RecordedLine["level"]) =>
    (context: LogContext, message: string): void => {
      lines.push({ level, context, message });
    };

  const self: RecordingLogger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    // Child context is dropped rather than merged: nothing under test uses it, and a
    // half-right merge would make an assertion about context misleading.
    child: () => self,
    get lines() {
      return lines;
    },
    messages: (level) => lines.filter((line) => line.level === level).map((line) => line.message),
  };

  return self;
}
