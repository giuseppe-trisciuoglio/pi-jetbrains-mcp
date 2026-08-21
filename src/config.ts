/**
 * Config loading for the JetBrains MCP extension.
 *
 * Schema:
 *   {
 *     "endpoints": [
 *       { "id": "<id>", "url": "<streamable-http url>", "headers": {...}?,
 *         "connectTimeoutMs"?: <number> },
 *       ...
 *     ]
 *   }
 *
 * - id must match /^[a-z][a-z0-9_]*$/. Duplicates are rejected.
 * - urls must parse.
 * - If `config.json` still uses the legacy { url, headers, connectTimeoutMs }
 *   single-endpoint shape, we auto-migrate it to endpoints[] with id="default"
 *   and rewrite the file on disk so the migration is durable.
 *
 * Resolution order at load time:
 *   1. defaults  (none — empty endpoints[])
 *   2. config.json (auto-migrated if needed)
 *   3. JETBRAINS_MCP_URL env var (applies to / adds the "default" endpoint)
 *
 * Errors are returned (not thrown) so the extension can surface them at boot
 * and decide whether to continue with a partial config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EndpointConfig {
	id: string;
	url: string;
	headers: Record<string, string>;
	connectTimeoutMs: number;
}

export interface LoadedConfig {
	endpoints: EndpointConfig[];
	/** Non-fatal info messages (e.g. migrations, env-var overrides). */
	warnings: string[];
	/** Fatal config problems. Empty means config is usable. */
	errors: string[];
}

const ID_REGEX = /^[a-z][a-z0-9_]*$/;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

function configFilePath(): string {
	// src/config.ts -> extension root / config.json
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "config.json");
}

function readRawConfig(): { value: unknown; error?: string } {
	const path = configFilePath();
	if (!existsSync(path)) return { value: null };
	try {
		return { value: JSON.parse(readFileSync(path, "utf8")) };
	} catch (err) {
		return {
			value: null,
			error: `could not read or parse ${path}: ${summarize(err)}`,
		};
	}
}

/** Normalize one endpoint entry. Returns null when id/url are missing. */
function normalizeEndpoint(raw: unknown, fallbackTimeout: number): EndpointConfig | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id.trim() : "";
	const url = typeof r.url === "string" ? r.url.trim() : "";
	if (!id || !url) return null;

	const headers: Record<string, string> = {};
	if (r.headers && typeof r.headers === "object" && !Array.isArray(r.headers)) {
		for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
			if (typeof v === "string") headers[k] = v;
		}
	}

	let connectTimeoutMs = fallbackTimeout;
	if (typeof r.connectTimeoutMs === "number" && Number.isFinite(r.connectTimeoutMs) && r.connectTimeoutMs > 0) {
		connectTimeoutMs = r.connectTimeoutMs;
	}

	return { id, url, headers, connectTimeoutMs };
}

/** Detect the legacy {url, headers, connectTimeoutMs} single-endpoint shape. */
function isLegacyShape(parsed: unknown): boolean {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const r = parsed as Record<string, unknown>;
	if (Array.isArray(r.endpoints)) return false;
	return (
		typeof r.url === "string" ||
		(typeof r.headers === "object" && r.headers !== null && !Array.isArray(r.headers)) ||
		typeof r.connectTimeoutMs === "number"
	);
}

/** Apply JETBRAINS_MCP_URL: overrides the "default" endpoint or adds one. */
function applyEnvOverrides(
	endpoints: EndpointConfig[],
	warnings: string[],
	errors: string[],
): EndpointConfig[] {
	const raw = process.env.JETBRAINS_MCP_URL;
	const envUrl = raw?.trim();
	if (!envUrl) return endpoints;
	try {
		new URL(envUrl);
	} catch {
		errors.push(`JETBRAINS_MCP_URL must be a valid URL: '${envUrl}'.`);
		return endpoints;
	}

	const idx = endpoints.findIndex((e) => e.id === "default");
	if (idx >= 0) {
		const updated = endpoints.slice();
		updated[idx] = { ...updated[idx], url: envUrl };
		warnings.push(`JETBRAINS_MCP_URL applied to endpoint 'default': ${envUrl}`);
		return updated;
	}
	warnings.push(`JETBRAINS_MCP_URL added endpoint 'default': ${envUrl}`);
	return [
		...endpoints,
		{ id: "default", url: envUrl, headers: {}, connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS },
	];
}

export interface ProjectSelection {
  /** Selected endpoint ids, or null when no selection file exists (fallback: all). */
  ids: string[] | null;
  /** Non-fatal messages (unknown ids, malformed file). */
  warnings: string[];
}

const PROJECT_SELECTION_FILENAME = ".pi/jetbrains.json";

/**
 * Load the per-project endpoint selection from `<cwd>/.pi/jetbrains.json`.
 * The file holds a whitelist of endpoint ids defined in the global config:
 *   { "endpoints": ["phpstorm", ...] }
 * Missing file -> { ids: null } meaning "use all endpoints".
 * Present file with an empty list -> { ids: [] } meaning "use none".
 * Unknown or invalid entries are reported as warnings and skipped; they do
 * not invalidate the remaining ids.
 */
export function loadProjectSelection(cwd: string = process.cwd()): ProjectSelection {
  const warnings: string[] = [];
  const path = join(cwd, PROJECT_SELECTION_FILENAME);
  if (!existsSync(path)) return { ids: null, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(
      `${PROJECT_SELECTION_FILENAME} could not be parsed (${summarize(err)}); using all endpoints.`,
    );
    return { ids: null, warnings };
  }

  const raw = (parsed as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(raw)) {
    warnings.push(
      `${PROJECT_SELECTION_FILENAME} has no 'endpoints' array; using all endpoints.`,
    );
    return { ids: null, warnings };
  }

  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const id = typeof raw[i] === "string" ? raw[i].trim() : "";
    if (!id) {
      warnings.push(`${PROJECT_SELECTION_FILENAME}: endpoints[${i}] is not a valid id; skipped.`);
      continue;
    }
    if (ids.includes(id)) {
      warnings.push(`${PROJECT_SELECTION_FILENAME}: duplicate id '${id}'; skipped.`);
      continue;
    }
    ids.push(id);
  }
  return { ids, warnings };
}

/** Persist the per-project selection file in the given directory. */
export function saveProjectSelection(ids: string[], cwd: string = process.cwd()): string {
  const path = join(cwd, PROJECT_SELECTION_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ endpoints: ids }, null, 2) + "\n", "utf8");
  return path;
}

export function loadConfig(): LoadedConfig {
	const warnings: string[] = [];
	const errors: string[] = [];
	let endpoints: EndpointConfig[] = [];

	const { value: raw, error: readError } = readRawConfig();
	if (readError) errors.push(readError);

	if (raw) {
		if (isLegacyShape(raw)) {
			warnings.push(
				"Legacy config schema detected ({url, headers, connectTimeoutMs}); " +
					"auto-migrating to {endpoints: [{id: \"default\", ...}]} and rewriting config.json.",
			);
			const r = raw as Record<string, unknown>;
			const migrated = normalizeEndpoint(
				{
					id: "default",
					url: r.url,
					headers: r.headers,
					connectTimeoutMs:
						typeof r.connectTimeoutMs === "number"
							? r.connectTimeoutMs
							: DEFAULT_CONNECT_TIMEOUT_MS,
				},
				DEFAULT_CONNECT_TIMEOUT_MS,
			);
			if (migrated) {
				endpoints = [migrated];
				try {
					saveEndpoints(endpoints);
				} catch (err) {
					warnings.push(`Migration succeeded but could not rewrite config.json: ${summarize(err)}`);
				}
			} else {
				errors.push(
					"Legacy config detected but could not extract url/headers/connectTimeoutMs.",
				);
			}
		} else if (Array.isArray((raw as { endpoints?: unknown }).endpoints)) {
			const list = (raw as { endpoints: unknown[] }).endpoints;
			const seen = new Set<string>();
			for (let i = 0; i < list.length; i++) {
				const ep = normalizeEndpoint(list[i], DEFAULT_CONNECT_TIMEOUT_MS);
				if (!ep) {
					errors.push(`endpoints[${i}]: missing or invalid 'id' / 'url'.`);
					continue;
				}
				if (!ID_REGEX.test(ep.id)) {
					errors.push(
						`endpoints[${i}]: id '${ep.id}' must match /^[a-z][a-z0-9_]*$/ (lowercase, starts with a letter, only [a-z0-9_]).`,
					);
					continue;
				}
				if (seen.has(ep.id)) {
					errors.push(`endpoints[${i}]: duplicate id '${ep.id}'.`);
					continue;
				}
				try {
					// eslint-disable-next-line no-new
					new URL(ep.url);
				} catch {
					errors.push(`endpoints[${i}] (${ep.id}): invalid url '${ep.url}'.`);
					continue;
				}
				seen.add(ep.id);
				endpoints.push(ep);
			}
		} else {
			warnings.push("config.json has no 'endpoints' array and no legacy fields; treating as empty.");
		}
	}

	endpoints = applyEnvOverrides(endpoints, warnings, errors);

	// Fail-fast: if validation surfaced any errors, drop every endpoint so the
	// extension does not half-connect with an inconsistent config. The
	// per-endpoint errors are already collected; we just add a summary.
	if (errors.length > 0) {
		warnings.push(
			`Config has ${errors.length} validation error(s); aborting all endpoints. Fix config.json and /reload.`,
		);
		endpoints = [];
	}

	return { endpoints, warnings, errors };
}

/** Persist endpoints to config.json (canonical {endpoints: [...]} shape). */
export function saveEndpoints(endpoints: EndpointConfig[]): void {
	writeFileSync(
		configFilePath(),
		JSON.stringify({ endpoints }, null, 2) + "\n",
		"utf8",
	);
}

function summarize(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
