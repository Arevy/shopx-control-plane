import { Router, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { Account, State, canReadPlatform, fail } from "./domain";

export interface ObservabilitySettings {
	token: string;
	lokiUrl: string;
	prometheusUrl: string;
	collectorUrl: string;
	grafanaUrl: string;
}
const quote = (v: string) => JSON.stringify(v);
export function telemetryMetrics(s: State, now = Date.now()) {
	const lines = [
		"# TYPE shopx_platform_ready gauge",
		"# TYPE shopx_platform_desired_running gauge",
		"# TYPE shopx_platform_checked_timestamp_seconds gauge",
		"# TYPE shopx_service_ready gauge",
	];
	for (const p of s.platforms) {
		if (!/^sx_[a-f0-9]{12}$/.test(p.id)) continue;
		const labels = `platform_id=${quote(p.id)}`;
		const checked = Date.parse(p.checkedAt || "") || 0;
		const fresh = now - checked < 90000;
		lines.push(
			`shopx_platform_ready{${labels}} ${
				fresh && p.observed === "ready" ? 1 : 0
			}`
		);
		lines.push(
			`shopx_platform_desired_running{${labels}} ${
				p.desired === "running" ? 1 : 0
			}`
		);
		lines.push(
			`shopx_platform_checked_timestamp_seconds{${labels}} ${checked / 1000}`
		);
		for (const [service, ready] of Object.entries(p.services || {}))
			if (/^[a-z_]+$/.test(service))
				lines.push(
					`shopx_service_ready{${labels},service=${quote(service)}} ${
						fresh && ready ? 1 : 0
					}`
				);
	}
	return lines.join("\n") + "\n";
}
export function telemetryAuthorized(req: Request, token: string) {
	const supplied = req.header("authorization") || "";
	const expected = "Bearer " + token;
	return (
		Buffer.byteLength(supplied) === Buffer.byteLength(expected) &&
		timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
	);
}
export function observabilityRoutes(
	store: { read(): Promise<State> },
	config: ObservabilitySettings | undefined,
	user: (s: State, req: Request) => Account
) {
	const router = Router();
	const budgets = new Map<string, { until: number; count: number }>();
	let concurrent = 0;
	if (
		config &&
		(!/^[a-f0-9]{64}$/.test(config.token) ||
			!["lokiUrl", "prometheusUrl", "collectorUrl", "grafanaUrl"].every((k) => {
				try {
					return ["http:", "https:"].includes(
						new URL(config[k as keyof ObservabilitySettings]).protocol
					);
				} catch {
					return false;
				}
			}))
	)
		throw new Error("Invalid private observability configuration");
	const wrap =
		(fn: (req: Request, res: Response) => Promise<unknown>) =>
		(req: Request, res: Response, next: NextFunction) => {
			fn(req, res).catch(next);
		};
	const getJson = async (
		base: string,
		path: string,
		params = new URLSearchParams(),
		tenant?: string
	) => {
		if (concurrent >= 4) return fail(429, "OBSERVABILITY_BUSY");
		concurrent++;
		try {
			const url = new URL(path, base);
			url.search = params.toString();
			const r = await fetch(url, {
				headers: {
					authorization: "Bearer " + config!.token,
					...(tenant ? { "X-Scope-OrgID": tenant } : {}),
				},
				signal: AbortSignal.timeout(8000),
				redirect: "error",
			});
			if (!r.ok) return fail(503, "OBSERVABILITY_UNAVAILABLE");
			const text = await r.text();
			if (text.length > 2 * 1024 * 1024)
				return fail(503, "OBSERVABILITY_RESPONSE_LIMIT");
			return JSON.parse(text);
		} catch {
			return fail(503, "OBSERVABILITY_UNAVAILABLE");
		} finally {
			concurrent--;
		}
	};
	router.get(
		"/internal/observability/:resource",
		wrap(async (req, res) => {
			if (!config || !telemetryAuthorized(req, config.token))
				return fail(401, "AUTHENTICATION_REQUIRED");
			const s = await store.read();
			if (req.params.resource === "metrics")
				return res.type("text/plain; version=0.0.4").send(telemetryMetrics(s));
			if (req.params.resource !== "inventory") return fail(404, "NOT_FOUND");
			return res.json({
				platforms: s.platforms.map((p) => ({
					id: p.id,
					desired: p.desired,
					checkedAt: p.checkedAt,
					observed: p.observed,
					services: p.services,
				})),
			});
		})
	);
	router.get(
		"/v1/observability",
		wrap(async (req, res) => {
			const actor = user(await store.read(), req);
			return res.json({
				enabled: !!config,
				grafanaUrl:
					config && actor.role === "GLOBAL_ADMIN" ? config.grafanaUrl : null,
			});
		})
	);
	router.get(
		"/v1/observability/:scope/:resource",
		wrap(async (req, res) => {
			const s = await store.read(),
				actor = user(s, req),
				scope = req.params.scope;
			const platform = s.platforms.find(
				(p) => p.id === scope && canReadPlatform(actor, p)
			);
			const system =
				["control", "legacy", "system"].includes(scope) &&
				actor.role === "GLOBAL_ADMIN";
			if (!platform && !system) return fail(404, "PLATFORM_NOT_FOUND");
			if (!config) return fail(503, "OBSERVABILITY_NOT_CONFIGURED");
			const now = Date.now();
			for (const [id, budget] of budgets)
				if (budget.until <= now) budgets.delete(id);
			const budget = budgets.get(actor.id) || { until: now + 60000, count: 0 };
			if (budget.count >= 60) return fail(429, "OBSERVABILITY_RATE_LIMIT");
			budget.count++;
			budgets.set(actor.id, budget);
			const service = req.query.service;
			if (
				service !== undefined &&
				(typeof service !== "string" ||
					!/^[a-z][a-z0-9_-]{0,39}$/.test(service))
			)
				return fail(400, "INVALID_SERVICE");
			const minutes =
				req.query.minutes === undefined ? 60 : Number(req.query.minutes);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
				return fail(400, "INVALID_TIME_RANGE");
			// No user-controlled LogQL/PromQL, URL, tenant header or arbitrary timestamps.
			if (
				Object.keys(req.query).some((k) => !["service", "minutes"].includes(k))
			)
				return fail(400, "INVALID_FILTER");
			if (req.params.resource === "logs") {
				const selector = `{platform_id=${quote(scope)}${
					service ? ",service=" + quote(service) : ""
				}}`;
				const result = await getJson(
					config.lokiUrl,
					"/loki/api/v1/query_range",
					new URLSearchParams({
						query: selector,
						start: String((Date.now() - minutes * 60000) * 1e6),
						end: String(Date.now() * 1e6),
						limit: "200",
						direction: "backward",
					}),
					scope
				);
				if (
					result.status !== "success" ||
					result.data?.resultType !== "streams"
				)
					return fail(503, "OBSERVABILITY_UNAVAILABLE");
				const entries = (result.data.result || [])
					.flatMap((stream: any) => {
						if (stream.stream?.platform_id !== scope) return [];
						return (stream.values || []).map(([timestamp, line]: string[]) => ({
							timestamp,
							service: stream.stream.service,
							line: String(line).slice(0, 4096),
						}));
					})
					.sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp))
					.slice(0, 200);
				return res.json({ entries, limit: 200, minutes });
			}
			if (req.params.resource === "status") {
				const runtime = await getJson(config.collectorUrl, "/inventory");
				const now = Date.now(),
					fresh = now - Date.parse(runtime.checkedAt || "") < 90000;
				const services = (runtime.services || [])
					.filter((v: any) => v.platform_id === scope)
					.map((v: any) => ({ ...v, state: fresh ? v.state : "unknown" }));
				const history = await getJson(
					config.prometheusUrl,
					"/api/v1/query_range",
					new URLSearchParams({
						query: `shopx_platform_ready{platform_id=${quote(scope)}}`,
						start: String(Math.floor(now / 1000) - minutes * 60),
						end: String(Math.floor(now / 1000)),
						step: String(Math.max(30, Math.ceil((minutes * 60) / 120))),
					})
				);
				const observationFresh =
					!platform || now - Date.parse(platform.checkedAt || "") < 90000;
				const complete =
					!platform ||
					["backend", "storefront", "admin", "gateway", "redis"].every((name) =>
						services.some((v: any) => v.service === name)
					);
				const state =
					!fresh || !observationFresh || !services.length
						? "UNKNOWN"
						: platform?.desired === "stopped" &&
						  services.every((v: any) => v.state === "stopped")
						? "STOPPED"
						: services.length &&
						  services.every((v: any) => v.state === "stopped")
						? "DOWN"
						: platform
						? platform.observed === "ready" &&
						  complete &&
						  services.every((v: any) => v.state === "running")
							? "UP"
							: "DEGRADED"
						: services.length &&
						  services.every((v: any) => v.state === "running")
						? "UP"
						: "DEGRADED";
				return res.json({
					state,
					checkedAt: runtime.checkedAt,
					fresh: fresh && observationFresh,
					desired: platform?.desired || null,
					observed: platform?.observed || null,
					services,
					history: history.data?.result?.[0]?.values || [],
				});
			}
			return fail(404, "NOT_FOUND");
		})
	);
	return router;
}
