// Typed configuration read from the environment (Bun auto-loads .env — no dotenv).
//
// Every external integration is gated behind a *_DRY_RUN / USE_* flag so the whole service
// runs hermetically in tests and in a no-infra dev environment, while the real code path is
// present and selected by config in production.

function bool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true";
}

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export interface Config {
  port: number;

  // Seam: Vercel callback
  vercelCallbackUrl: string | undefined;
  callbackSecret: string | undefined;

  // App-layer auth: shared bearer secret Vercel must present on EVERY mini request. Independent
  // of Cloudflare Access — every endpoint fails closed when this is unset (see server.ts authOk).
  miniAuthSecret: string | undefined;

  // Seam: Cloudflare Access (defense-in-depth; Cloudflare already enforces at the edge)
  cfAccessClientId: string | undefined;
  cfAccessClientSecret: string | undefined;
  enforceCfAccess: boolean; // require the CF headers locally too (off by default)

  // Linear (streamed activities)
  linearAccessToken: string | undefined;
  linearApiUrl: string;

  // GitHub (push + PR)
  githubToken: string | undefined;
  githubApiUrl: string;
  prBaseBranch: string;

  // Workspace
  workRoot: string;
  defaultRepoUrl: string | undefined; // fallback when an issue carries no repo hint

  // Concurrency
  maxConcurrentExecutions: number;
  maxConcurrentPlans: number;

  // Timeouts / heartbeats (ms)
  heartbeatIntervalMs: number;
  activityThrottleMs: number;

  // SQLite
  dbPath: string;

  // Dry-run / gating flags
  dryRunJobs: boolean;     // skip the SDK entirely; run a fast fake job (Phase A scaffolding/tests)
  linearDryRun: boolean;   // log Linear calls instead of POSTing
  prDryRun: boolean;       // synthesize a PR url/branch instead of pushing
  useContainer: boolean;   // run execute jobs inside an OrbStack container
}

export function loadConfig(): Config {
  return {
    port: int("PORT", 3001),

    vercelCallbackUrl: process.env.VERCEL_CALLBACK_URL,
    callbackSecret: process.env.CALLBACK_SECRET,

    miniAuthSecret: process.env.MINI_AUTH_SECRET,

    cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
    enforceCfAccess: bool("ENFORCE_CF_ACCESS", false),

    linearAccessToken: process.env.LINEAR_ACCESS_TOKEN,
    linearApiUrl: process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql",

    githubToken: process.env.GITHUB_TOKEN,
    githubApiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    prBaseBranch: process.env.PR_BASE_BRANCH ?? "main",

    workRoot: process.env.WORK_ROOT ?? `${process.env.HOME ?? "/tmp"}/work`,
    defaultRepoUrl: process.env.DEFAULT_REPO_URL,

    maxConcurrentExecutions: int("MAX_CONCURRENT_EXECUTIONS", 2),
    maxConcurrentPlans: int("MAX_CONCURRENT_PLANS", 3),

    heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 20 * 60 * 1000), // < 30 min stale window
    activityThrottleMs: int("ACTIVITY_THROTTLE_MS", 1500),

    dbPath: process.env.DB_PATH ?? `${process.env.WORK_ROOT ?? `${process.env.HOME ?? "/tmp"}/work`}/mini.sqlite`,

    dryRunJobs: bool("DRY_RUN", false),
    linearDryRun: bool("LINEAR_DRY_RUN", false),
    prDryRun: bool("PR_DRY_RUN", false),
    useContainer: bool("USE_CONTAINER", false),
  };
}

// Process-wide singleton, lazily built so tests can set env before first use.
let _config: Config | undefined;
export function config(): Config {
  if (!_config) _config = loadConfig();
  return _config;
}

// Test helper: force a fresh read (after mutating process.env) or inject overrides.
export function resetConfig(overrides?: Partial<Config>): Config {
  _config = { ...loadConfig(), ...overrides };
  return _config;
}
