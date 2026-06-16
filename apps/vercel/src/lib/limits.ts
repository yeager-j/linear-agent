// Timing and loop-cap policy for the session workflow and webhook replay guard. These are
// deliberate constants (not env-tunable), kept apart from env.ts so that file stays purely about
// reading environment variables. Durations are Workflow `sleep()` strings; ms values are numbers.

// Reject webhooks whose `webhookTimestamp` is older than this (replay protection, API §3/§7).
export const WEBHOOK_MAX_AGE_MS = 60_000;

// Loop / lifecycle caps (plan §7 — a MAX_REVISION_ROUNDS-style cap on every workflow loop).
export const MAX_REVISION_ROUNDS = 8;

// Cap on mid-run AskUserQuestion rounds per job, so a misbehaving agent that asks endlessly
// can't loop the workflow forever.
export const MAX_QUESTION_ROUNDS = 20;

// waitForJob timeout backstop: a silently dead mini job surfaces as a Linear error instead of
// a workflow paused forever (plan §3, contract §5 failure/timeout path).
export const JOB_TIMEOUT = "45m";

// Sweeper schedule (plan §7): after an elicitation, race promptHook against these sleeps.
export const SWEEP_NUDGE_AFTER = "3 days";
export const SWEEP_REAP_AFTER = "4 days";

// Brief grace period to let the mini deliver the `aborted` callback after we POST /abort.
export const ABORT_GRACE = "30s";
