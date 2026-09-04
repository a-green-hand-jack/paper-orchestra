/** Package version, recorded in run state and checkpoint trailers. */
export const PAPER_ORCHESTRA_VERSION = "2.0.0";

/** Schema version for `.po-run/run.json`. Bump on any breaking state change. */
export const RUN_SCHEMA_VERSION = "po-run-v3" as const;

/** Schema version for `.po-run/session.json`. */
export const SESSION_SCHEMA_VERSION = "po-session-v1" as const;
