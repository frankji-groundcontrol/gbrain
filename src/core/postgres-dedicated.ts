/**
 * Dedicated groundcontrol Postgres schema mode (2026-07).
 *
 * One responsibility: translate an explicit `postgres_schema: 'groundcontrol'`
 * signal + primary/direct URLs into validated canonical URLs carrying the
 * authoritative startup search path, or throw a redacted configuration error.
 *
 * The module is PURE — no I/O, no pool construction. It is called from:
 *   - `loadConfig()` after env/file merge (primary gate, every reader);
 *   - `db.connect()` and `ConnectionManager` constructor (defensive boundary);
 *   - `PostgresEngine.connect()` (resolved-config capture, Task 2).
 *
 * Legacy installations (no `postgres_schema` field) are byte-compatible:
 * `normalizeDedicatedPostgresConfig` returns its input unchanged when the
 * field is absent or not exactly `'groundcontrol'`.
 *
 * @see docs/superpowers/specs/2026-07-12-groundcontrol-dedicated-schema-design.md
 */

import { redactConnectionInfo } from './audit/redact-connection-info.ts';

/** The single accepted dedicated schema value. */
export const DEDICATED_SCHEMA = 'groundcontrol' as const;

/**
 * Authoritative startup search path for dedicated mode.
 *
 * `pg_catalog` is always implicit-first in PostgreSQL; `public` is
 * deliberately excluded so the restricted role cannot resolve or create
 * objects there by accident. `extensions` holds the dependency extensions
 * (`vector`) that the role has USAGE-only on.
 */
export const DEDICATED_SEARCH_PATH = 'groundcontrol,extensions';

/** Minimal shape `normalizeDedicatedPostgresConfig` consumes. */
export type DedicatedEngineConfig = {
  database_url?: string;
  direct_database_url?: string;
  postgres_schema?: string;
};

/**
 * True iff `config.postgres_schema` is exactly `'groundcontrol'`.
 * Used both as the mode gate and as the validator for load-time values.
 */
export function isDedicatedSchemaMode(cfg: { postgres_schema?: string } | null | undefined): boolean {
  return !!cfg && cfg.postgres_schema === DEDICATED_SCHEMA;
}

/**
 * Build a redacted error (never leaks userinfo/password) and throw it.
 * `redactConnectionInfo()` strips any postgres URL, `password=...`,
 * `user=...`, `host=...`, and IPv4 octets the message may have picked up.
 */
function dedicatedError(message: string): never {
  throw new Error(`[groundcontrol] ${redactConnectionInfo(message)}`);
}

/**
 * Validate and canonicalize a raw `search_path` query value.
 *
 * Decodes URL-encoding, splits on `,`, trims whitespace, drops empties, then
 * requires exactly `['groundcontrol', 'extensions']`. Returns the canonical
 * literal (never a user-spaced variant) so callers compare against a fixed
 * string.
 */
function canonicalizeSearchPath(raw: string): string {
  const parts = decodeURIComponent(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 2 || parts[0] !== DEDICATED_SCHEMA || parts[1] !== 'extensions') {
    dedicatedError(
      `search_path must be exactly "${DEDICATED_SEARCH_PATH}" (got ${JSON.stringify(raw)})`,
    );
  }
  return DEDICATED_SEARCH_PATH;
}

/**
 * Normalize one URL: ensure it carries exactly the canonical `search_path`.
 *
 * - Absent `search_path` → insert it.
 * - Present `search_path` → must canonicalize to the fixed value (else throw).
 * - Duplicate `search_path` keys → throw (ambiguous intent).
 * - Other query params are preserved. The URL scheme round-trips.
 *
 * Returns `undefined` when `url` is undefined (caller may not have a direct URL).
 */
function normalizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  // WHATWG URL needs an http(s) scheme to parse. Same shim as
  // connection-manager.ts:110/134 and db.ts:92.
  const schemeMatch = url.match(/^postgres(ql)?:\/\//);
  const scheme = schemeMatch?.[0] ?? 'postgres://';
  const http = url.replace(/^postgres(ql)?:\/\//, 'http://');
  const parsed = new URL(http);

  // Detect duplicate search_path keys BEFORE reading (URLSearchParams.get
  // silently returns the first). Use the raw searchParams iterator.
  const searchPathKeys = [...parsed.searchParams.keys()].filter((k) => k === 'search_path');
  if (searchPathKeys.length > 1) {
    dedicatedError('duplicate search_path query parameter in database URL');
  }

  const existing = parsed.searchParams.get('search_path');
  if (existing !== null) {
    // Must canonicalize; if it already equals the literal, no rewrite needed.
    const canonical = canonicalizeSearchPath(existing);
    if (existing !== canonical) {
      parsed.searchParams.set('search_path', canonical);
    }
  } else {
    parsed.searchParams.set('search_path', DEDICATED_SEARCH_PATH);
  }

  // Re-serialize under the original postgres(ql) scheme.
  const serialized = parsed.toString();
  // WHATWG URLSearchParams encodes the comma in `groundcontrol,extensions`
  // as `%2C`. libpq accepts both, but the canonical literal is the value we
  // validate against and the form the design spec mandates. Decode it back
  // (the value is fixed and known-safe — comma is a sub-delim in RFC 3986
  // and unreserved in a query value).
  const withLiteralComma = serialized.replace(
    'search_path=groundcontrol%2Cextensions',
    'search_path=groundcontrol,extensions',
  );
  return scheme + withLiteralComma.replace(/^https?:\/\//, '');
}

/**
 * Normalize a config carrying optional dedicated-mode fields.
 *
 * When `postgres_schema` is absent or not `'groundcontrol'`, the input is
 * returned unchanged (legacy byte-compatibility). When dedicated mode is
 * active, both `database_url` and `direct_database_url` (if present) are
 * normalized; a throw on either closes both before any pool opens.
 */
export function normalizeDedicatedPostgresConfig<C extends DedicatedEngineConfig>(config: C): C {
  if (!isDedicatedSchemaMode(config)) return config;
  const database_url = normalizeUrl(config.database_url);
  const direct_database_url = config.direct_database_url
    ? normalizeUrl(config.direct_database_url)
    : config.direct_database_url;
  return { ...config, database_url, direct_database_url };
}

/**
 * Contract row returned by the dedicated preflight catalog probe. Every field
 * is asserted by {@link evaluateDedicatedPreflight}; a mismatch yields a
 * redacted, human-readable error naming the violated invariant.
 */
export interface DedicatedPreflightRow {
  current_user: string;
  current_schema: string;
  pg_version: number;
  schema_owner: string | null;
  has_connect: boolean;
  has_usage_public: boolean;
  has_usage_extensions: boolean;
  can_create_public: boolean;
  can_create_extensions: boolean;
  has_create_groundcontrol: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

/** Extension placement row from the preflight probe. */
export interface DedicatedPreflightExtension {
  extname: string;
  schema: string;
}

/**
 * Required extension placement for dedicated mode.
 * `vector` must live in `extensions`; `pg_trgm` must live in `public`.
 */
export const DEDICATED_EXTENSION_PLACEMENT: Record<string, string> = {
  vector: 'extensions',
  pg_trgm: 'public',
};

/**
 * Pure evaluator for the dedicated preflight catalog snapshot. Takes the row
 * returned by the catalog probe + the extension-placement rows and returns
 * `null` when the contract holds, or a redacted error string when it doesn't.
 *
 * Extracted as a pure function so the full contract is unit-testable with
 * fakes (no real Postgres needed). The engine method
 * `PostgresEngine.runDedicatedPreflight()` runs the catalog probe and calls
 * this; on a non-null return it throws.
 */
export function evaluateDedicatedPreflight(
  r: DedicatedPreflightRow,
  extensions: DedicatedPreflightExtension[],
): string | null {
  const checks: [boolean, string][] = [
    [r.current_user === 'groundcontrol_app', 'current_user must be groundcontrol_app'],
    [r.current_schema === DEDICATED_SCHEMA, `current_schema must be ${DEDICATED_SCHEMA}`],
    [r.schema_owner === 'groundcontrol_app', `${DEDICATED_SCHEMA} must be owned by groundcontrol_app`],
    [r.pg_version >= 13, 'PostgreSQL 13+ required'],
    [r.has_connect, 'role lacks CONNECT'],
    [r.has_usage_public, 'role lacks USAGE on public'],
    [r.has_usage_extensions, 'role lacks USAGE on extensions'],
    [!r.can_create_public, 'role must not have CREATE on public'],
    [!r.can_create_extensions, 'role must not have CREATE on extensions'],
    [r.has_create_groundcontrol, `role lacks CREATE on ${DEDICATED_SCHEMA}`],
    [!r.rolsuper, 'role must not be superuser'],
    [!r.rolbypassrls, 'role must not have BYPASSRLS'],
    [!r.rolcreatedb, 'role must not have CREATEDB'],
    [!r.rolcreaterole, 'role must not have CREATEROLE'],
    [!r.rolreplication, 'role must not have REPLICATION'],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) return `[groundcontrol] preflight: ${redactConnectionInfo(msg)}`;
  }
  for (const [extname, requiredSchema] of Object.entries(DEDICATED_EXTENSION_PLACEMENT)) {
    const found = extensions.find((e) => e.extname === extname);
    if (!found || found.schema !== requiredSchema) {
      return `[groundcontrol] preflight: ${extname} must be in ${requiredSchema}`;
    }
  }
  return null;
}
