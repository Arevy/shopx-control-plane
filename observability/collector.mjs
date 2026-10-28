import fs from "node:fs";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
	sanitizeLine,
	containerIdentity,
	decodeDockerLogs,
} from "./sanitize.mjs";
const config = JSON.parse(
	fs.readFileSync(
		process.env.OBSERVABILITY_CONFIG_FILE || "/run/observability/config.json",
		"utf8"
	)
);
if (
	!/^[a-f0-9]{64}$/.test(config.token) ||
	!/^[a-zA-Z0-9_-]+$/.test(config.oracleContainer)
)
	throw new Error("Invalid collector configuration");
const auth = "Bearer " + config.token,
	directory = "/data",
	cursorFile = directory + "/positions.json";
fs.mkdirSync(directory, { recursive: true });
let positions = {};
if (fs.existsSync(cursorFile))
	positions = JSON.parse(fs.readFileSync(cursorFile, "utf8"));
let inventory = { checkedAt: null, services: [] },
	tenants = ["control", "legacy", "system"],
	lastSuccess = 0,
	errors = 0,
	limited = 0,
	sent = 0;
const authorized = (req) =>
	typeof req.headers.authorization === "string" &&
	Buffer.byteLength(req.headers.authorization) === Buffer.byteLength(auth) &&
	timingSafeEqual(Buffer.from(req.headers.authorization), Buffer.from(auth));
const headers = { authorization: auth };
async function json(url) {
	const r = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(5000),
		redirect: "error",
	});
	if (!r.ok) throw new Error("Upstream unavailable");
	return r.json();
}
// This process is the sole monitoring component with Docker access. Only these
// GET operations are implemented; no public endpoint accepts Docker arguments.
function docker(path, maxBytes = 2 * 1024 * 1024) {
	if (
		!/^\/containers\/(json\?all=1|[a-f0-9]{64}\/(logs\?|stats\?stream=false))/.test(
			path
		)
	)
		throw new Error("Docker operation denied");
	return new Promise((resolve, reject) => {
		const req = http.get(
			{
				socketPath: config.dockerSocket || "/var/run/docker.sock",
				path,
				timeout: 4000,
			},
			(res) => {
				const chunks = [];
				let bytes = 0;
				res.on("data", (chunk) => {
					bytes += chunk.length;
					if (bytes > maxBytes) {
						limited++;
						req.destroy(new Error("Docker response limit"));
					} else chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () =>
					res.statusCode === 200
						? resolve(Buffer.concat(chunks))
						: reject(new Error("Docker read failed"))
				);
			}
		);
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("Docker timeout")));
	});
}
async function collect() {
	const registry = await json(
		config.controlUrl + "/internal/observability/inventory"
	);
	const platforms = new Set(
		registry.platforms
			.map((p) => p.id)
			.filter((id) => /^sx_[a-f0-9]{12}$/.test(id))
	);
	tenants = ["control", "legacy", "system", ...platforms];
	const containers = JSON.parse(
		(await docker("/containers/json?all=1")).toString()
	);
	const services = [];
	for (const container of containers.slice(0, 256)) {
		const identity = containerIdentity(
			container,
			platforms,
			config.oracleContainer
		);
		if (!identity) continue;
		const running = container.State === "running";
		const service = {
			...identity,
			state: running
				? container.Status?.includes("(unhealthy)")
					? "unhealthy"
					: "running"
				: "stopped",
			memory_bytes: null,
			cpu_percent: null,
		};
		services.push(service);
		if (running) {
			try {
				const stats = JSON.parse(
					(
						await docker(
							"/containers/" +
								container.Id +
								"/stats?stream=false&one-shot=true"
						)
					).toString()
				);
				service.memory_bytes = Math.max(
					0,
					(stats.memory_stats?.usage || 0) -
						(stats.memory_stats?.stats?.inactive_file || 0)
				);
				const cpu =
						(stats.cpu_stats?.cpu_usage?.total_usage || 0) -
						(stats.precpu_stats?.cpu_usage?.total_usage || 0),
					system =
						(stats.cpu_stats?.system_cpu_usage || 0) -
						(stats.precpu_stats?.system_cpu_usage || 0);
				service.cpu_percent =
					system > 0
						? Math.max(
								0,
								(cpu / system) * (stats.cpu_stats?.online_cpus || 1) * 100
						  )
						: 0;
			} catch {
				errors++;
			}
		}
		if (!running || identity.service === "collector") continue;
		const previous =
			positions[container.Id] || new Date(Date.now() - 60000).toISOString();
		const since = Math.floor(Date.parse(previous) / 1000);
		try {
			const raw = await docker(
				`/containers/${container.Id}/logs?stdout=true&stderr=true&timestamps=true&since=${since}&tail=1000`,
				1024 * 1024
			);
			let latest = previous,
				latestNanos = 0n;
			const values = [];
			for (const line of decodeDockerLogs(raw)) {
				const match = line.match(
					/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) (.*)$/
				);
				if (!match) continue;
				const stamp = match[1];
				const nanos =
					BigInt(Date.parse(stamp)) * 1000000n +
					BigInt((stamp.split(".")[1].slice(0, -1) + "000000000").slice(3, 9));
				const oldNanos =
					BigInt(Date.parse(previous)) * 1000000n +
					BigInt(
						((previous.split(".")[1] || "0Z").slice(0, -1) + "000000000").slice(
							3,
							9
						)
					);
				if (nanos <= oldNanos) continue;
				if (nanos > latestNanos) {
					latest = stamp;
					latestNanos = nanos;
				}
				values.push([String(nanos), JSON.stringify(sanitizeLine(match[2]))]);
			}
			if (values.length) {
				const r = await fetch(config.alloyUrl + "/loki/api/v1/push", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						streams: [
							{ stream: { ...identity, environment: "local" }, values },
						],
					}),
					signal: AbortSignal.timeout(5000),
				});
				if (!r.ok) throw new Error("Ingestion unavailable");
				sent += values.length;
				positions[container.Id] = latest;
			}
		} catch {
			errors++;
		}
	}
	// Persist only owned, still-existing container positions; never raw log text.
	const ids = new Set(containers.map((c) => c.Id));
	positions = Object.fromEntries(
		Object.entries(positions).filter(([id]) => ids.has(id))
	);
	fs.writeFileSync(cursorFile + ".tmp", JSON.stringify(positions), {
		mode: 0o600,
	});
	fs.renameSync(cursorFile + ".tmp", cursorFile);
	inventory = { checkedAt: new Date().toISOString(), services };
	lastSuccess = Date.now();
}
function metrics() {
	const lines = [
		`shopx_collector_checked_timestamp_seconds ${lastSuccess / 1000}`,
		`shopx_collector_errors_total ${errors}`,
		`shopx_collector_limited_total ${limited}`,
		`shopx_collector_sent_total ${sent}`,
	];
	try {
		const disk = fs.statfsSync(directory);
		lines.push(
			`shopx_telemetry_storage_available_bytes ${disk.bavail * disk.bsize}`
		);
	} catch {
		/* Missing filesystem metrics must not break collection. */
	}
	for (const service of inventory.services) {
		const labels = `platform_id="${service.platform_id}",service="${service.service}"`;
		lines.push(
			`shopx_container_running{${labels}} ${
				["running", "unhealthy"].includes(service.state) ? 1 : 0
			}`
		);
		lines.push(
			`shopx_container_healthy{${labels}} ${
				service.state === "running" ? 1 : 0
			}`
		);
		if (service.memory_bytes !== null)
			lines.push(
				`shopx_container_memory_bytes{${labels}} ${service.memory_bytes}`
			);
		if (service.cpu_percent !== null)
			lines.push(
				`shopx_container_cpu_percent{${labels}} ${service.cpu_percent}`
			);
	}
	return lines.join("\n") + "\n";
}
const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://collector");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	if (req.method !== "GET") {
		res.writeHead(405).end();
		return;
	}
	if (url.pathname === "/health") {
		res.writeHead(Date.now() - lastSuccess < 90000 ? 200 : 503).end();
		return;
	}
	if (!authorized(req)) {
		res.writeHead(401).end();
		return;
	}
	if (url.pathname === "/metrics") {
		res.setHeader("Content-Type", "text/plain; version=0.0.4");
		res.end(metrics());
		return;
	}
	if (url.pathname === "/inventory") {
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(inventory));
		return;
	}
	// Dedicated global Grafana datasource: its private credential is never sent
	// to platform owners. Tenant IDs come from the registry, not request headers.
	if (
		/^\/loki\/(?:loki\/api\/v1\/(?:query_range|query|labels|label\/[a-zA-Z_][a-zA-Z_0-9]*\/values|series)|ready)$/.test(
			url.pathname
		)
	) {
		try {
			if ((url.searchParams.get("query") || "").length > 4096)
				throw new Error("Query limit");
			url.searchParams.set("limit", "500");
			const r = await fetch(
				config.lokiUrl + url.pathname.slice(5) + url.search,
				{
					headers: { "X-Scope-OrgID": tenants.join("|") },
					signal: AbortSignal.timeout(10000),
					redirect: "error",
				}
			);
			res.writeHead(r.status, {
				"Content-Type": r.headers.get("content-type") || "application/json",
			});
			res.end(await r.text());
		} catch {
			res.writeHead(503).end('{"error":"OBSERVABILITY_UNAVAILABLE"}');
		}
		return;
	}
	res.writeHead(404).end();
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(4200, "0.0.0.0");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
	process.on(signal, () => {
		stopping = true;
		server.close();
	});
console.log(
	JSON.stringify({
		level: "info",
		event: "collector_started",
		message: "Private ShopX collector started",
	})
);
while (!stopping) {
	try {
		await collect();
	} catch {
		errors++;
	}
	if (!stopping) await new Promise((r) => setTimeout(r, 15000));
}
