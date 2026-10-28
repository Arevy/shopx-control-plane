import fs from "node:fs";
import { OracleStore, settings } from "./store";
import { ComposeProvider, WorkerSettings } from "./provider";
import { Problem, Platform } from "./domain";

// Compose starts the worker under flock on its shared state directory. The kernel
// releases the lock on process death, so running operations resume after a crash.
async function main() {
	const config = settings<WorkerSettings>(
		process.env.CONTROL_WORKER_FILE || ""
	);
	fs.mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
	if (process.env.SHOPX_WORKER_LOCK_HELD !== "1")
		throw new Error("Start the worker through its flock supervisor");
	const store = new OracleStore(config.database),
		provider = new ComposeProvider(config);
	let stopping = false;
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () => {
			stopping = true;
		});
	const observe = async (p: Platform) => {
		const services = await provider.health(p);
		await store.transaction((s) => {
			const current = s.platforms.find((v) => v.id === p.id)!;
			current.services = services;
			current.checkedAt = new Date().toISOString();
			current.observed = Object.values(services).every(Boolean)
				? "ready"
				: current.desired === "stopped" &&
				  !Object.values(services).some(Boolean)
				? "stopped"
				: "degraded";
		});
		return Object.values(services).every(Boolean);
	};
	try {
		await store.connect();
		do {
			const op = await store.transaction((s) => {
				const job =
					s.operations.find((v) => v.status === "running") ||
					s.operations.find((v) => v.status === "queued");
				if (job) {
					job.status = "running";
					job.updatedAt = new Date().toISOString();
				}
				return job;
			});
			if (op) {
				const p = (await store.read()).platforms.find(
					(v) => v.id === op.platformId
				)!;
				const step = async (name: string, fn: () => Promise<unknown>) => {
					await store.transaction((s) => {
						const o = s.operations.find((v) => v.id === op.id)!;
						o.step = name;
						o.updatedAt = new Date().toISOString();
					});
					await fn();
				};
				try {
					if (op.action === "configure") {
						if (!op.configuration)
							throw new Problem(409, "CONFIGURATION_MISSING");
						const target = { ...p, ...op.configuration };
						await step("configuration", () => provider.configure(target));
						await store.transaction(
							(s) => {
								const current = s.platforms.find((v) => v.id === p.id)!;
								current.manifest = target.manifest;
								current.revision = target.revision;
							},
							{ actor: "worker", event: "configuration.applied", target: p.id }
						);
						p.manifest = target.manifest;
						p.revision = target.revision;
					}
					if (op.action === "create") {
						await step("preflight", () => provider.preflight(p));
						await step("secrets-and-template", () => provider.render(p));
						await step("schema", () => provider.schema(p));
						await step("catalog-and-owner", () => provider.install(p));
					}
					if (op.action === "stop") await step("stop", () => provider.stop(p));
					else if (op.action === "restart")
						await step("restart", () => provider.restart(p));
					else if (op.action !== "configure" || p.desired === "running")
						await step("start", () => provider.start(p));
					await step("verify", async () => {
						for (let attempt = 0; attempt < 12; attempt++) {
							const healthy = await observe(p);
							const record = (await store.read()).platforms.find(
								(v) => v.id === p.id
							)!;
							if (
								p.desired === "stopped"
									? record.observed === "stopped"
									: healthy
							)
								return;
							await new Promise((resolve) => setTimeout(resolve, 2500));
						}
						throw new Problem(503, "PLATFORM_NOT_READY");
					});
					await store.transaction(
						(s) => {
							const o = s.operations.find((v) => v.id === op.id)!,
								platform = s.platforms.find((v) => v.id === p.id)!;
							o.status = "succeeded";
							o.step = "complete";
							o.updatedAt = new Date().toISOString();
							if (op.action !== "stop") platform.provisionedAt ||= o.updatedAt;
						},
						{ actor: "worker", event: "operation.succeeded", target: op.id }
					);
				} catch (e) {
					await store.transaction(
						(s) => {
							const o = s.operations.find((v) => v.id === op.id)!;
							o.status = "failed";
							o.error = e instanceof Problem ? e.code : "PROVISIONING_FAILED";
							o.updatedAt = new Date().toISOString();
						},
						{ actor: "worker", event: "operation.failed", target: op.id }
					);
					console.error(
						JSON.stringify({
							operation: op.id,
							error: e instanceof Problem ? e.code : "PROVISIONING_FAILED",
						})
					);
				}
			}
			for (const p of (await store.read()).platforms) await observe(p);
			if (process.argv.includes("--once")) break;
			if (!stopping) await new Promise((resolve) => setTimeout(resolve, 10000));
		} while (!stopping);
	} finally {
		await store.close();
	}
}
main().catch(() => {
	console.error(
		"Worker stopped. Inspect private configuration, Oracle/Docker availability and the exclusive worker lock."
	);
	process.exitCode = 1;
});
