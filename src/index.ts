/**
 * pi extension: JetBrains MCP Server bridge — multi-IDE edition.
 *
 * Each JetBrains IDE (PhpStorm, IntelliJ IDEA, WebStorm, …) exposes its MCP
 * Server on a different streamable-http port. We model that as a set of
 * "endpoints", each with a stable id used as a tool-name prefix
 * (`<id>__<sanitized_tool>`), so tools from different IDEs never collide.
 *
 * Lifecycle:
 *   - session_start: validate config, build one JetBrainsMcpClient per
 *     endpoint, connect+listTools, register every MCP tool as a pi tool.
 *   - session_shutdown (reason: "quit"): close every client.
 *
 * pi has no `unregisterTool`, so tools stay registered for the whole session.
 * On reconnect/listTools diff we mark stale entries "not live" — their execute
 * handler then returns a clear error until the endpoint re-syncs.
 *
 * Commands (under `/jetbrains`):
 *   status                                  — per-endpoint state + tool count
 *   reconnect [id]                          — close one or all, reconnect, re-sync
 *   disconnect [id]                         — close one or all
 *   set-url <id> <url>                      — change URL of one endpoint, persist
 *   add-endpoint <id> <url>                 — add a new endpoint, persist
 *   tools                                   — list tools grouped by endpoint
 *   use <id>                                — select an endpoint for this project (next session)
 *   unuse <id>                              — deselect an endpoint for this project (next session)
 *   selection                               — show the project selection state
 *
 * Per-project selection: a `.pi/jetbrains.json` file at the process cwd
 * holds a whitelist of endpoint ids. Missing file = all endpoints; present
 * file with an empty list = none. The selection defines the visible
 * perimeter for the whole session: only selected endpoints are connected
 * and registered.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JetBrainsMcpClient, type McpCallResult, type McpTool } from "./client.ts";
import {
	loadConfig,
	loadProjectSelection,
	saveEndpoints,
	saveProjectSelection,
	type EndpointConfig,
	type LoadedConfig,
} from "./config.ts";
import { jsonSchemaToTypebox, type JsonSchema } from "./schema.ts";

const STATUS_KEY = "jetbrains-mcp";
const ID_REGEX = /^[a-z][a-z0-9_]*$/;

/** A content item as pi expects it in a tool result. */
type PiContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

/** Bookkeeping for a tool we've registered, so we can flip "live" on re-syncs. */
interface RegisteredTool {
	endpointId: string;
	mcpName: string;
	/** False after the endpoint re-listed and this tool disappeared. */
	live: boolean;
}

function sanitizeToolName(name: string): string {
	const cleaned = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned || "tool";
}

function prefixedToolName(endpointId: string, rawName: string): string {
	return `${endpointId}__${sanitizeToolName(rawName)}`;
}

/** Map MCP content items to pi content items, coercing anything odd to text. */
function mapMcpContent(content: unknown): PiContent[] {
	if (!Array.isArray(content)) return [];
	return content
		.map((item): PiContent | null => {
			if (!item || typeof item !== "object") return null;
			const it = item as Record<string, unknown>;
			switch (it.type) {
				case "text":
					return { type: "text", text: String(it.text ?? "") };
				case "image":
					return {
						type: "image",
						data: (it.data as string) ?? "",
						mimeType: (it.mimeType as string) ?? "image/png",
					};
				case "resource": {
					const res = (it.resource as Record<string, unknown>) ?? {};
					if (res.text != null) return { type: "text", text: String(res.text) };
					return { type: "text", text: JSON.stringify(res) };
				}
				default:
					return { type: "text", text: JSON.stringify(it) };
			}
		})
		.filter((x): x is PiContent => x !== null);
}

/** Filter global endpoints down to the project selection, warning on unknown ids. */
function resolveSelection(
	globalEndpoints: EndpointConfig[],
	selection: { ids: string[] | null; warnings: string[] },
): EndpointConfig[] {
	if (selection.ids === null) return globalEndpoints.slice();
	const byId = new Map(globalEndpoints.map((ep) => [ep.id, ep]));
	const result: EndpointConfig[] = [];
	for (const id of selection.ids) {
		const ep = byId.get(id);
		if (ep) result.push(ep);
		else selection.warnings.push(`Project selection references unknown endpoint '${id}'; skipped.`);
	}
	return result;
}

function summarizeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export default function jetbrainsMcpExtension(pi: ExtensionAPI) {
	const loaded: LoadedConfig = loadConfig();
	/** Every endpoint known to the global config, regardless of selection. */
	const globalEndpoints: EndpointConfig[] = loaded.endpoints.slice();
	/** Endpoints selected for this project — the visible perimeter of the session. */
	const selection = loadProjectSelection();
	const endpoints: EndpointConfig[] = resolveSelection(globalEndpoints, selection);
	const clients = new Map<string, JetBrainsMcpClient>();
	const connectFailed = new Map<string, boolean>();
	/** Map toolName -> bookkeeping. Live tools are the ones the IDE currently exposes. */
	const registered = new Map<string, RegisteredTool>();

	// Build a client per validated endpoint. Endpoints with errors are skipped
	// — the extension will surface the error via a boot notification and the
	// corresponding endpoint simply does not exist for this session.
	for (const ep of endpoints) {
		clients.set(ep.id, new JetBrainsMcpClient({ url: ep.url, headers: ep.headers }));
	}

	function setStatus(ctx: ExtensionContext, message: string): void {
		try {
			ctx.ui.setStatus(STATUS_KEY, message);
		} catch {
			// UI not available in some modes.
		}
	}

	function notify(
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error",
	): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.notify(message, level);
		} catch {
			// ignore
		}
	}

	function buildStatusLine(): string {
		const parts: string[] = [];
		for (const ep of endpoints) {
			const c = clients.get(ep.id);
			const conn = c?.isConnected() ? "on" : "off";
			parts.push(`${ep.id}:${conn}`);
		}
		return parts.length === 0 ? "JetBrains MCP: no endpoints" : `JetBrains MCP [${parts.join(" ")}]`;
	}

	/** Connect one client. Notifies exactly once per endpoint until it succeeds. */
	async function ensureConnectedFor(
		ctx: ExtensionContext,
		id: string,
		opts: { notifyOnError?: boolean } = {},
	): Promise<boolean> {
		const c = clients.get(id);
		if (!c) return false;
		if (c.isConnected()) {
			connectFailed.set(id, false);
			return true;
		}
		try {
			const ep = endpoints.find((e) => e.id === id);
			await c.connect(ep?.connectTimeoutMs ?? 10_000);
			connectFailed.set(id, false);
			return true;
		} catch (err) {
			const wasFailed = connectFailed.get(id);
			connectFailed.set(id, true);
			if ((opts.notifyOnError ?? true) && !wasFailed) {
				notify(
					ctx,
					`JetBrains MCP endpoint '${id}' unreachable at ${c.getUrl()}: ${summarizeError(err)}. ` +
						`Start the IDE or run /jetbrains reconnect ${id}.`,
					"error",
				);
			}
			return false;
		}
	}

	async function connectAll(ctx: ExtensionContext): Promise<{ ok: string[]; failed: string[] }> {
		const ids = Array.from(clients.keys());
		const results = await Promise.all(
			ids.map(async (id) => ({
				id,
				// Suppress per-endpoint noise at boot; we report a summary.
				connected: await ensureConnectedFor(ctx, id, { notifyOnError: false }),
			})),
		);
		return {
			ok: results.filter((result) => result.connected).map((result) => result.id),
			failed: results.filter((result) => !result.connected).map((result) => result.id),
		};
	}

	/** Pick a unique, valid pi tool name. With prefix collisions are very rare. */
	function pickUniqueName(endpointId: string, rawName: string): string {
		const candidate = prefixedToolName(endpointId, rawName);
		const taken = new Set<string>();
		pi.getAllTools().forEach((t) => taken.add(t.name));
		registered.forEach((_, n) => taken.add(n));
		if (!taken.has(candidate)) return candidate;
		let i = 2;
		while (taken.has(`${candidate}_${i}`)) i++;
		return `${candidate}_${i}`;
	}

	function registerToolFromMcp(endpointId: string, mcpTool: McpTool): string {
		const name = pickUniqueName(endpointId, mcpTool.name);

		const inputSchema: JsonSchema =
			mcpTool.inputSchema && typeof mcpTool.inputSchema === "object"
				? (mcpTool.inputSchema as JsonSchema)
				: { type: "object", properties: {} };
		const parameters = jsonSchemaToTypebox(inputSchema);

		const description = (
			mcpTool.description?.trim() || `JetBrains MCP tool: ${mcpTool.name}`
		).slice(0, 1000);

		// We re-read `registered` inside the closure on every call so that
		// "live" flips after a re-sync are picked up without re-registering.
		pi.registerTool({
			name,
			label: mcpTool.name,
			description,
			promptSnippet: `[${endpointId}] ${description.split("\n")[0].slice(0, 140 - endpointId.length - 3)}`,
			parameters,
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const info = registered.get(name);
				if (!info || !info.live) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Tool '${mcpTool.name}' from endpoint '${endpointId}' is no longer available. ` +
									`The IDE may have reloaded. Run /jetbrains reconnect ${endpointId}.`,
							},
						],
						details: { endpoint: endpointId, tool: name, mcpName: mcpTool.name },
					};
				}
				const c = clients.get(info.endpointId);
				if (!c) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Endpoint '${info.endpointId}' is no longer configured. Edit config.json and /reload.`,
							},
						],
						details: { endpoint: info.endpointId, tool: name, mcpName: mcpTool.name },
					};
				}
				if (!c.isConnected()) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Endpoint '${info.endpointId}' is offline. Run /jetbrains reconnect ${info.endpointId}.`,
							},
						],
						details: { endpoint: info.endpointId, tool: name, mcpName: mcpTool.name },
					};
				}
				try {
					const result: McpCallResult = await c.callTool(
						mcpTool.name,
						params as Record<string, unknown>,
					);
					return {
						content: mapMcpContent(result.content),
						details: {
							endpoint: info.endpointId,
							tool: name,
							mcpName: mcpTool.name,
							structuredContent: result.structuredContent,
						},
						isError: Boolean(result.isError),
					};
				} catch (err) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `MCP call '${mcpTool.name}' (endpoint ${info.endpointId}) failed: ${summarizeError(err)}`,
							},
						],
						details: { endpoint: info.endpointId, tool: name, mcpName: mcpTool.name },
					};
				}
			},
		});

		registered.set(name, { endpointId, mcpName: mcpTool.name, live: true });
		return name;
	}

	/**
	 * Re-list tools for an endpoint. Existing entries with the same prefixed
	 * name are flipped back to `live: true` without re-registering; entries
	 * not present in the new list are flipped to `live: false` so further
	 * calls return a clear error.
	 */
	async function syncToolsFor(ctx: ExtensionContext, endpointId: string): Promise<number> {
		const c = clients.get(endpointId);
		if (!c || !c.isConnected()) return 0;

		// Mark all currently-known tools from this endpoint as stale.
		for (const info of registered.values()) {
			if (info.endpointId === endpointId) info.live = false;
		}

		let tools: McpTool[] = [];
		try {
			tools = await c.listTools();
		} catch (err) {
			notify(ctx, `listTools failed for endpoint '${endpointId}': ${summarizeError(err)}`, "warning");
			return 0;
		}

		let registeredCount = 0;
		for (const t of tools) {
			if (!t?.name) continue;
			const existing = Array.from(registered.values()).find(
				(info) => info.endpointId === endpointId && info.mcpName === t.name,
			);
			if (existing) {
				existing.live = true;
				registeredCount++;
				continue;
			}
			registerToolFromMcp(endpointId, t);
			registeredCount++;
		}
		return registeredCount;
	}

	function liveCountFor(endpointId: string): number {
		let n = 0;
		for (const info of registered.values()) {
			if (info.endpointId === endpointId && info.live) n++;
		}
		return n;
	}

	function formatEndpointList(): string {
		if (endpoints.length === 0) {
			return "No endpoints configured. Edit config.json or run /jetbrains add-endpoint <id> <url>.";
		}
		return endpoints
			.map((ep) => {
				const c = clients.get(ep.id);
				const conn = c?.isConnected() ? "connected" : "offline";
				const t = liveCountFor(ep.id);
				return `[${ep.id}] ${conn} @ ${ep.url} — ${t} live tool${t === 1 ? "" : "s"}`;
			})
			.join("\n");
	}

	function formatToolsByEndpoint(): string {
		if (registered.size === 0) return "No tools registered. Try /jetbrains reconnect.";
		const groups = new Map<string, string[]>();
		for (const [name, info] of registered) {
			const arr = groups.get(info.endpointId) ?? [];
			if (info.live) arr.push(name);
			groups.set(info.endpointId, arr);
		}
		const lines: string[] = [];
		for (const [id, names] of groups) {
			if (names.length === 0) continue;
			lines.push(`[${id}] ${names.length} tool${names.length === 1 ? "" : "s"}:`);
			names.sort().forEach((n) => lines.push(`  • ${n}`));
		}
		return lines.length === 0 ? "No live tools registered across endpoints." : lines.join("\n");
	}

	function persistConfig(): void {
		try {
			// Always persist the full global set, not the project-filtered view.
			saveEndpoints(globalEndpoints);
		} catch (err) {
			// Surfacing is the caller's job; here we just don't crash.
			throw err;
		}
	}

	// --- Lifecycle -------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Surface config diagnostics first so users see migration notices / errors.
		for (const w of loaded.warnings) notify(ctx, `JetBrains MCP: ${w}`, "info");
		for (const w of selection.warnings) notify(ctx, `JetBrains MCP: ${w}`, "info");
		for (const e of loaded.errors) notify(ctx, `JetBrains MCP config: ${e}`, "error");

		setStatus(ctx, buildStatusLine());

		if (clients.size === 0) {
			if (loaded.errors.length === 0) {
				if (selection.ids !== null && selection.ids.length === 0) {
					notify(
						ctx,
						"JetBrains MCP: project selection is empty (.pi/jetbrains.json); no endpoints active for this project.",
						"warning",
					);
				} else if (globalEndpoints.length > 0) {
					notify(
						ctx,
						"JetBrains MCP: no endpoints configured. Edit config.json or /jetbrains add-endpoint <id> <url>.",
						"warning",
					);
				}
			}
			return;
		}

		const { ok, failed } = await connectAll(ctx);
		let total = 0;
		for (const id of ok) total += await syncToolsFor(ctx, id);

		const summary = `JetBrains MCP ready: ${ok.length}/${clients.size} endpoint(s) connected, ${total} tool(s) loaded.`;
		if (failed.length > 0) {
			notify(ctx, `${summary} Failed: ${failed.join(", ")}.`, "warning");
			// Now that boot is done, surface a clean error per failed endpoint.
			for (const id of failed) await ensureConnectedFor(ctx, id, { notifyOnError: true });
		} else {
			notify(ctx, summary, "info");
		}
		setStatus(ctx, buildStatusLine());
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") {
			await Promise.all(Array.from(clients.values()).map((c) => c.close()));
		}
	});

	// --- Commands --------------------------------------------------------------

	pi.registerCommand("jetbrains", {
		description:
			"JetBrains MCP (multi-IDE): status | reconnect [id] | disconnect [id] | set-url <id> <url> | add-endpoint <id> <url> | tools | use <id> | unuse <id> | selection",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/);
			const sub = (parts[0] || "status").toLowerCase();

			if (sub === "reconnect" || sub === "connect") {
				const id = parts[1];
				if (id) {
					if (!clients.has(id)) {
						notify(
							ctx,
							`Unknown endpoint '${id}'. Known: ${Array.from(clients.keys()).join(", ") || "(none)"}`,
							"warning",
						);
						return;
					}
					await clients.get(id)!.close();
					connectFailed.set(id, false);
					const ok = await ensureConnectedFor(ctx, id);
					if (ok) {
						const n = await syncToolsFor(ctx, id);
						notify(ctx, `Endpoint '${id}' reconnected, ${n} tool(s) loaded.`, "info");
					}
					setStatus(ctx, buildStatusLine());
					return;
				}
				// Reconnect all.
				await Promise.all(Array.from(clients.values()).map((c) => c.close()));
				for (const id of clients.keys()) connectFailed.set(id, false);
				const { ok } = await connectAll(ctx);
				let total = 0;
				for (const id of ok) total += await syncToolsFor(ctx, id);
				notify(
					ctx,
					`Reconnected: ${ok.length}/${clients.size} endpoint(s), ${total} tool(s) loaded.`,
					"info",
				);
				setStatus(ctx, buildStatusLine());
				return;
			}

			if (sub === "disconnect") {
				const id = parts[1];
				if (id) {
					if (!clients.has(id)) {
						notify(ctx, `Unknown endpoint '${id}'.`, "warning");
						return;
					}
					await clients.get(id)!.close();
					notify(ctx, `Endpoint '${id}' disconnected.`, "info");
				} else {
					await Promise.all(Array.from(clients.values()).map((c) => c.close()));
					notify(ctx, "All endpoints disconnected.", "info");
				}
				setStatus(ctx, buildStatusLine());
				return;
			}

			if (sub === "set-url") {
				const id = parts[1];
				const url = parts.slice(2).join(" ").trim();
				if (!id || !url) {
					notify(ctx, "Usage: /jetbrains set-url <id> <url>", "warning");
					return;
				}
				if (!clients.has(id)) {
					notify(
						ctx,
						`Unknown endpoint '${id}'. Known: ${Array.from(clients.keys()).join(", ") || "(none)"}`,
						"warning",
					);
					return;
				}
				try {
					new URL(url);
				} catch {
					notify(ctx, `Invalid URL: ${url}`, "warning");
					return;
				}
				const epIdx = globalEndpoints.findIndex((e) => e.id === id);
				if (epIdx < 0) return;
				// Mutate in place: `endpoints` may alias the same object.
				Object.assign(globalEndpoints[epIdx], { url });
				try {
					persistConfig();
				} catch (err) {
					notify(ctx, `Could not save config.json: ${summarizeError(err)}`, "warning");
				}
				clients.get(id)!.updateConfig({ url, headers: globalEndpoints[epIdx].headers });
				await clients.get(id)!.close();
				connectFailed.set(id, false);
				const ok = await ensureConnectedFor(ctx, id);
				if (ok) {
					const n = await syncToolsFor(ctx, id);
					notify(ctx, `Endpoint '${id}' URL updated; ${n} tool(s) loaded.`, "info");
				}
				setStatus(ctx, buildStatusLine());
				return;
			}

			if (sub === "add-endpoint") {
				const id = parts[1];
				const url = parts.slice(2).join(" ").trim();
				if (!id || !url) {
					notify(ctx, "Usage: /jetbrains add-endpoint <id> <url>", "warning");
					return;
				}
				if (!ID_REGEX.test(id)) {
					notify(
						ctx,
						`Invalid id '${id}'. Must match /^[a-z][a-z0-9_]*$/ (lowercase, starts with a letter, only [a-z0-9_]).`,
						"warning",
					);
					return;
				}
				if (clients.has(id)) {
					notify(
						ctx,
						`Endpoint '${id}' already exists. Use /jetbrains set-url ${id} <url> to change its URL.`,
						"warning",
					);
					return;
				}
				try {
					new URL(url);
				} catch {
					notify(ctx, `Invalid URL: ${url}`, "warning");
					return;
				}
				const ep: EndpointConfig = {
					id,
					url,
					headers: {},
					connectTimeoutMs: 10_000,
				};
				globalEndpoints.push(ep);
				// A newly added endpoint is only active immediately in fallback mode;
				// with a project selection it must be opted in via /jetbrains use.
				if (selection.ids === null) endpoints.push(ep);
				try {
					persistConfig();
				} catch (err) {
					notify(ctx, `Could not save config.json: ${summarizeError(err)}`, "warning");
				}
				clients.set(id, new JetBrainsMcpClient({ url, headers: {} }));
				connectFailed.set(id, false);
				const ok = await ensureConnectedFor(ctx, id);
				if (ok) {
					const n = await syncToolsFor(ctx, id);
					notify(ctx, `Endpoint '${id}' added; ${n} tool(s) loaded.`, "info");
				} else {
					notify(
						ctx,
						`Endpoint '${id}' added (URL persisted) but initial connect failed. Use /jetbrains reconnect ${id} once the IDE is reachable.`,
						"warning",
					);
				}
				if (selection.ids !== null) {
					notify(
						ctx,
						`Note: this project has a selection file. Run /jetbrains use ${id} to activate it here.`,
						"info",
					);
				}
				setStatus(ctx, buildStatusLine());
				return;
			}

			if (sub === "tools") {
				notify(ctx, formatToolsByEndpoint(), "info");
				return;
			}

			if (sub === "use" || sub === "unuse") {
				const id = parts[1];
				if (!id) {
					notify(ctx, `Usage: /jetbrains ${sub} <id>`, "warning");
					return;
				}
				const currentIds =
					selection.ids === null ? globalEndpoints.map((e) => e.id) : [...selection.ids];
				if (sub === "use") {
					if (!globalEndpoints.some((e) => e.id === id)) {
						notify(
							ctx,
							`Unknown endpoint '${id}'. Known: ${globalEndpoints.map((e) => e.id).join(", ") || "(none)"}. Add it first with /jetbrains add-endpoint.`,
							"warning",
						);
						return;
					}
					if (!currentIds.includes(id)) currentIds.push(id);
				} else {
					if (!currentIds.includes(id)) {
						notify(ctx, `Endpoint '${id}' is not selected for this project.`, "warning");
						return;
					}
					currentIds.splice(currentIds.indexOf(id), 1);
				}
				try {
					saveProjectSelection(currentIds);
					selection.ids = currentIds;
					notify(
						ctx,
						`Project selection updated (${sub === "use" ? "+" : "-"}${id}). ` +
							(sub === "use" && !endpoints.some((e) => e.id === id)
								? "It will be active from the next session."
								: "Already active in this session."),
						"info",
					);
				} catch (err) {
					notify(ctx, `Could not write .pi/jetbrains.json: ${summarizeError(err)}`, "warning");
				}
				return;
			}

			if (sub === "selection") {
				const mode =
					selection.ids === null
						? "fallback (no .pi/jetbrains.json): all endpoints"
						: `project file: ${selection.ids.length ? selection.ids.join(", ") : "(empty — no endpoints)"}`;
				notify(ctx, `JetBrains MCP selection — ${mode}`, "info");
				return;
			}

			// default: status
			notify(ctx, formatEndpointList(), "info");
		},
	});
}
