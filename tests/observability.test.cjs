const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { application } = require("../dist/api");
const { emptyState, hash } = require("../dist/domain");
const { telemetryMetrics } = require("../dist/observability");
const a = "sx_111111111111",
	b = "sx_222222222222",
	token = "a".repeat(64);
async function fixture(t) {
	const state = emptyState();
	state.users = [
		{
			id: "admin",
			email: "a@example.test",
			role: "GLOBAL_ADMIN",
			password: "unused",
		},
		{
			id: "owner",
			email: "b@example.test",
			role: "PLATFORM_CREATOR",
			password: "unused",
		},
	];
	state.sessions = state.users.map((u) => ({
		hash: hash(u.id),
		userId: u.id,
		expires: Date.now() + 60000,
	}));
	state.platforms = [a, b].map((id, i) => ({
		id,
		createdBy: i === 0 ? "owner" : "someone",
		desired: "running",
		observed: "ready",
		checkedAt: new Date().toISOString(),
		services: { backend: true },
	}));
	const calls = [];
	const behavior = { unavailable: false };
	const upstream = http
		.createServer((req, res) => {
			if (behavior.unavailable) return res.writeHead(503).end();
			calls.push({ url: req.url, tenant: req.headers["x-scope-orgid"] });
			res.setHeader("Content-Type", "application/json");
			if (req.url.startsWith("/inventory"))
				return res.end(
					JSON.stringify({
						checkedAt: new Date().toISOString(),
						services: [
							{ platform_id: a, service: "backend", state: "running" },
							{ platform_id: b, service: "backend", state: "running" },
						],
					})
				);
			if (req.url.startsWith("/api/v1/"))
				return res.end(
					JSON.stringify({ status: "success", data: { result: [] } })
				);
			res.end(
				JSON.stringify({
					status: "success",
					data: {
						resultType: "streams",
						result: [
							{
								stream: { platform_id: a, service: "backend" },
								values: [["1790000000000000000", "safe event"]],
							},
							{
								stream: { platform_id: b, service: "backend" },
								values: [["1790000000000000000", "other tenant"]],
							},
						],
					},
				})
			);
		})
		.listen(0, "127.0.0.1");
	await new Promise((r) => upstream.once("listening", r));
	const origin = "http://127.0.0.1:" + upstream.address().port;
	const settings = {
		origin: "http://localhost:3200",
		observability: {
			token,
			lokiUrl: origin,
			prometheusUrl: origin,
			collectorUrl: origin,
			grafanaUrl: "http://localhost:3201",
		},
	};
	const store = { read: async () => structuredClone(state) };
	const server = application(store, settings).listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	t.after(async () => {
		await Promise.all([
			new Promise((r) => server.close(r)),
			new Promise((r) => upstream.close(r)),
		]);
	});
	const request = (path, account = "owner", headers = {}) =>
		fetch("http://127.0.0.1:" + server.address().port + path, {
			headers: { cookie: account ? "sx_control=" + account : "", ...headers },
		});
	return { state, calls, request, behavior };
}
test("monitoring outage returns an explicit error without disabling the platform inventory", async (t) => {
	const f = await fixture(t);
	f.behavior.unavailable = true;
	for (const resource of ["logs", "status"]) {
		const response = await f.request(`/v1/observability/${a}/${resource}`);
		assert.equal(response.status, 503);
		assert.equal((await response.json()).error, "OBSERVABILITY_UNAVAILABLE");
	}
	assert.equal((await f.request("/v1/platforms")).status, 200);
});
test("logs are authenticated, owner-scoped, bounded and reject query/tenant injection", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(await f.request("/v1/observability/" + a + "/logs", "")).status,
		401
	);
	assert.equal(
		(await f.request("/v1/observability/" + b + "/logs")).status,
		404
	);
	assert.equal((await f.request("/v1/observability/system/logs")).status, 404);
	assert.equal(
		(await f.request("/v1/observability/" + a + "/logs?query=anything")).status,
		400
	);
	assert.equal(
		(await f.request("/v1/observability/" + a + "/logs?minutes=1441")).status,
		400
	);
	assert.equal(
		(await f.request("/v1/observability/" + a + "/logs?service=%22%7D")).status,
		400
	);
	const r = await f.request(
		"/v1/observability/" + a + "/logs?service=backend",
		"owner",
		{ "X-Scope-OrgID": b }
	);
	assert.equal(r.status, 200);
	const data = await r.json();
	assert.equal(data.entries.length, 1);
	assert.equal(data.entries[0].line, "safe event");
	assert.equal(f.calls.at(-1).tenant, a);
	const query = new URL(f.calls.at(-1).url, "http://upstream");
	assert.equal(query.searchParams.get("limit"), "200");
	assert.equal(
		query.searchParams.get("query"),
		`{platform_id="${a}",service="backend"}`
	);
	f.state.users[1].disabled = true;
	assert.equal(
		(await f.request("/v1/observability/" + a + "/logs")).status,
		401
	);
});
test("private metrics do not expose accounts; status hides other platforms; Grafana link is admin-only", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(await f.request("/internal/observability/metrics")).status,
		401
	);
	assert.equal(
		(
			await f.request("/internal/observability/metrics", "admin", {
				authorization: "Bearer wrong",
			})
		).status,
		401
	);
	const r = await f.request("/internal/observability/metrics", "", {
		authorization: "Bearer " + token,
	});
	assert.equal(r.status, 200);
	const text = await r.text();
	assert(!text.includes("@"));
	assert(text.includes("shopx_service_ready"));
	assert.equal(
		(await (await f.request("/v1/observability")).json()).grafanaUrl,
		null
	);
	assert.equal(
		(await (await f.request("/v1/observability", "admin")).json()).grafanaUrl,
		"http://localhost:3201"
	);
	const data = await (
		await f.request("/v1/observability/" + a + "/status")
	).json();
	assert.equal(data.services.length, 1);
	assert.equal(data.services[0].platform_id, a);
});
test("expired observations are never exported as ready", () => {
	const state = emptyState();
	state.platforms = [
		{
			id: a,
			desired: "stopped",
			observed: "ready",
			checkedAt: new Date(0).toISOString(),
			services: { backend: true },
		},
	];
	const text = telemetryMetrics(state);
	assert(text.includes(`shopx_platform_ready{platform_id="${a}"} 0`));
	assert(text.includes(`shopx_platform_desired_running{platform_id="${a}"} 0`));
	assert(!text.includes("NaN"));
});
test("a ready registry cannot mask missing containers or expired worker observations", async (t) => {
	const f = await fixture(t);
	const status = () =>
		f.request(`/v1/observability/${a}/status`).then((r) => r.json());
	assert.equal((await status()).state, "DEGRADED");
	f.state.platforms[0].checkedAt = new Date(0).toISOString();
	const stale = await status();
	assert.equal(stale.state, "UNKNOWN");
	assert.equal(stale.fresh, false);
});
test("log collector excludes unrelated containers and unstructured secrets", async () => {
	const { sanitizeLine, containerIdentity, decodeDockerLogs } = await import(
		"../observability/sanitize.mjs"
	);
	const safe = sanitizeLine(
		JSON.stringify({
			level: "error",
			message:
				"Failed token=secret123 for user@example.test /callback?code=secret456",
			password: "hidden",
			headers: { authorization: "Bearer hidden" },
			body: { address: "private" },
		})
	);
	const infrastructure = sanitizeLine(
		JSON.stringify({
			level: "info",
			msg: 'Request completed {"password":"infrastructure-secret"}',
			user: "private-account",
		})
	);
	assert(infrastructure.message.startsWith("Request completed"));
	assert(!JSON.stringify(infrastructure).includes("infrastructure-secret"));
	assert(!JSON.stringify(infrastructure).includes("private-account"));
	const text = JSON.stringify(safe);
	for (const secret of [
		"secret123",
		"secret456",
		"user@example.test",
		"private",
		"hidden",
	])
		assert(!text.includes(secret));
	assert(
		!JSON.stringify(sanitizeLine("password canary secret")).includes("canary")
	);
	const c = {
		Id: "f".repeat(64),
		Labels: {
			"shopx.platform": a,
			"com.docker.compose.project": a.replace("_", "-"),
			"com.docker.compose.service": "backend",
		},
	};
	assert.deepEqual(containerIdentity(c, new Set([a]), "oracle19"), {
		platform_id: a,
		service: "backend",
	});
	assert.equal(containerIdentity(c, new Set([b]), "oracle19"), null);
	c.Labels["com.docker.compose.project"] = "unrelated";
	assert.equal(containerIdentity(c, new Set([a]), "oracle19"), null);
	const payload = Buffer.from("2026-10-27T10:00:00.000000001Z hello\n"),
		header = Buffer.alloc(8);
	header[0] = 1;
	header.writeUInt32BE(payload.length, 4);
	assert.equal(
		decodeDockerLogs(Buffer.concat([header, payload]))[0],
		"2026-10-27T10:00:00.000000001Z hello"
	);
});
