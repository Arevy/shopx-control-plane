import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
// @ts-ignore
import oracle from "oracledb";
import { Platform, publicConfiguration, Problem } from "./domain";
import { DatabaseSettings, settings } from "./store";
import { gatewayConfiguration } from "./gateway";
const exec = promisify(execFile);
// Node fetch may discard a custom Host header. Probe the gateway virtual host
// explicitly using node:http; the destination and headers are worker-generated.
export function gatewayRequest(
	url: string,
	host: string,
	body?: string
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method: body ? "POST" : "GET",
				headers: {
					Host: host,
					...(body
						? {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(body),
						  }
						: {}),
				},
				signal: AbortSignal.timeout(5000),
			},
			(res) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				res.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 8 * 1024 * 1024)
						req.destroy(new Error("Probe body limit"));
					else chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () =>
					resolve(
						new Response(Buffer.concat(chunks), {
							status: res.statusCode || 502,
							headers: {
								"content-type": String(res.headers["content-type"] || ""),
							},
						})
					)
				);
			}
		);
		req.on("error", reject);
		req.end(body);
	});
}
export interface WorkerSettings {
	database: DatabaseSettings;
	provisioner: DatabaseSettings;
	stateDirectory: string;
	assetsDirectory: string;
	oracleNetwork: string;
	runtimeDatabase: string;
	release: {
		id: string;
		images: Record<
			"backend" | "storefront" | "admin" | "redis" | "gateway",
			string
		>;
	};
	releases?: Record<string, WorkerSettings["release"]>;
	minimumFreeBytes: number;
	probeNetwork: string;
}
export function writePrivate(file: string, value: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = file + ".tmp";
	fs.writeFileSync(temporary, value, { mode: 0o600 });
	fs.chmodSync(temporary, 0o600);
	fs.renameSync(temporary, file);
}
function assertPlatform(p: Platform) {
	if (
		!/^sx_[a-f0-9]{12}$/.test(p.id) ||
		p.schema !== p.id.replace("sx_", "SX_P_").toUpperCase() ||
		!Number.isInteger(p.port) ||
		p.port < 1024 ||
		p.port > 65535
	)
		throw new Problem(409, "INVALID_PLATFORM_IDENTITY");
}
export class ComposeProvider {
	constructor(private config: WorkerSettings) {}
	release(p: Platform) {
		const release =
			p.release === this.config.release.id
				? this.config.release
				: this.config.releases?.[p.release];
		if (!release) throw new Problem(409, "RELEASE_NOT_AVAILABLE");
		return release;
	}
	directory(p: Platform) {
		assertPlatform(p);
		return path.join(this.config.stateDirectory, p.id);
	}
	project(p: Platform) {
		return p.id.replace("_", "-");
	}
	private async docker(args: string[], timeout = 120000) {
		try {
			return (
				await exec("docker", args, {
					timeout,
					maxBuffer: 4 * 1024 * 1024,
					env: { ...process.env, COMPOSE_INTERACTIVE_NO_CLI: "1" },
				})
			).stdout.trim();
		} catch {
			throw new Problem(503, "DOCKER_OPERATION_FAILED");
		}
	}
	private async compose(p: Platform, args: string[], timeout?: number) {
		await this.checkOwnership(p);
		return this.docker(
			[
				"compose",
				"-p",
				this.project(p),
				"-f",
				path.join(this.directory(p), "compose.json"),
				...args,
			],
			timeout
		);
	}
	async checkOwnership(p: Platform) {
		assertPlatform(p);
		const ids = await this.docker([
			"ps",
			"-aq",
			"--filter",
			`label=com.docker.compose.project=${this.project(p)}`,
		]);
		if (ids) {
			const records = JSON.parse(
				await this.docker(["inspect", ...ids.split("\n")])
			);
			if (records.some((c: any) => c.Config.Labels["shopx.platform"] !== p.id))
				throw new Problem(409, "RESOURCE_OWNERSHIP_CONFLICT");
		}
		for (const kind of ["network", "volume"]) {
			const names = await this.docker([
				kind,
				"ls",
				"-q",
				"--filter",
				`label=com.docker.compose.project=${this.project(p)}`,
			]);
			if (names) {
				const records = JSON.parse(
					await this.docker([kind, "inspect", ...names.split("\n")])
				);
				if (records.some((c: any) => c.Labels?.["shopx.platform"] !== p.id))
					throw new Problem(409, "RESOURCE_OWNERSHIP_CONFLICT");
			}
		}
	}
	async preflight(p: Platform) {
		const release = this.release(p);
		const disk = fs.statfsSync(this.config.stateDirectory);
		if (disk.bavail * disk.bsize < this.config.minimumFreeBytes)
			throw new Problem(409, "INSUFFICIENT_DISK");
		const total = Number(
			await this.docker(["info", "--format", "{{.MemTotal}}"])
		);
		const usage = await this.docker([
			"stats",
			"--no-stream",
			"--format",
			"{{.MemUsage}}",
		]);
		const used = usage.split("\n").reduce((sum, line) => {
			const match = /^([\d.]+)(B|KiB|MiB|GiB|kB|MB|GB)\s/.exec(line);
			if (!match) throw new Problem(503, "CAPACITY_CHECK_UNAVAILABLE");
			const units: Record<string, number> = {
				B: 1,
				KiB: 1024,
				MiB: 1024 ** 2,
				GiB: 1024 ** 3,
				kB: 1000,
				MB: 1e6,
				GB: 1e9,
			};
			return sum + Number(match[1]) * units[match[2]];
		}, 0);
		if (!Number.isFinite(total) || total - used < 1.25 * 1024 ** 3)
			throw new Problem(409, "INSUFFICIENT_MEMORY");
		for (const image of Object.values(release.images)) {
			if (!/^sha256:[a-f0-9]{64}$/.test(image))
				throw new Problem(409, "UNPINNED_IMAGE");
			await this.docker(["image", "inspect", image, "--format", "{{.Id}}"]);
		}
		await this.docker([
			"network",
			"inspect",
			this.config.oracleNetwork,
			"--format",
			"{{.Name}}",
		]);
		await this.checkOwnership(p);
	}
	async render(p: Platform) {
		const dir = this.directory(p),
			file = path.join(dir, "setup.json");
		if (!fs.existsSync(file)) {
			const secret = () => randomBytes(32).toString("hex");
			writePrivate(
				file,
				JSON.stringify({
					schema: p.schema,
					pdb: this.config.provisioner.pdb,
					action: "bootstrap",
					configuration: publicConfiguration(p),
					seedMode: p.manifest.seedMode || "demo",
					ownerEmail: p.manifest.ownerEmail,
					ownerPassword: secret(),
					databasePassword: randomBytes(14).toString("hex"),
					jwtSecret: secret(),
					serviceSecret: secret(),
				})
			);
		}
		const setup = settings<any>(file);
		if (
			setup.schema !== p.schema ||
			JSON.stringify(setup.configuration) !==
				JSON.stringify(publicConfiguration(p))
		)
			throw new Problem(409, "MANIFEST_CONFLICT");
		if ((setup.seedMode || "demo") !== (p.manifest.seedMode || "demo"))
			throw new Problem(409, "MANIFEST_CONFLICT");
		writePrivate(path.join(dir, "db-password"), setup.databasePassword);
		writePrivate(path.join(dir, "jwt-secret"), setup.jwtSecret);
		writePrivate(
			path.join(dir, "services.env"),
			`SERVER_SERVICES_TOKEN=${setup.serviceSecret}\n`
		);
		const hostname = `${p.manifest.slug}.localhost`,
			origin = `http://${hostname}:${p.port}`;
		const labels = { "shopx.platform": p.id };
		const base = {
			init: true,
			restart: "unless-stopped",
			labels,
			logging: {
				driver: "json-file",
				options: { "max-size": "5m", "max-file": "2" },
			},
			cpus: 0.75,
		};
		const httpHealth = (url: string) => ({
			test: [
				"CMD",
				"node",
				"-e",
				`fetch('${url}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`,
			],
			interval: "20s",
			timeout: "5s",
			retries: 3,
			start_period: "30s",
		});
		const images = this.release(p).images;
		const compose = {
			services: {
				redis: {
					...base,
					image: images.redis,
					mem_limit: "96m",
					command: [
						"redis-server",
						"--appendonly",
						"yes",
						"--maxmemory",
						"64mb",
						"--maxmemory-policy",
						"noeviction",
					],
					volumes: ["redis-data:/data"],
					healthcheck: {
						test: ["CMD", "redis-cli", "ping"],
						interval: "10s",
						timeout: "3s",
						retries: 5,
					},
				},
				backend: {
					...base,
					image: images.backend,
					mem_limit: "256m",
					environment: {
						NODE_ENV: "production",
						PORT: "4000",
						NODE_OPTIONS: "--max-old-space-size=160",
						PLATFORM_ID: p.id,
						DB_USER: p.schema,
						DB_PASSWORD_FILE: "/run/platform/db-password",
						JWT_SECRET_FILE: "/run/platform/jwt-secret",
						DB_CONNECT_STRING: this.config.runtimeDatabase,
						DB_POOL_MIN: "0",
						DB_POOL_MAX: "2",
						REDIS_URL: "redis://redis:6379/0",
						PUBLIC_ASSET_RELATIVE: "true",
						FORCE_INSECURE_SESSION_COOKIES: "true",
						CORS_ALLOWED_ORIGINS: [
							origin,
							`http://admin.${hostname}:${p.port}`,
							`http://api.${hostname}:${p.port}`,
						].join(","),
					},
					networks: ["default", "oracle"],
					volumes: [
						`${dir}:/run/platform:ro`,
						`${this.config.assetsDirectory}:/run/catalog:ro`,
					],
					depends_on: { redis: { condition: "service_healthy" } },
					healthcheck: httpHealth("http://127.0.0.1:4000/health/ready"),
				},
				storefront: {
					...base,
					image: images.storefront,
					mem_limit: "320m",
					env_file: [path.join(dir, "services.env")],
					environment: {
						NODE_ENV: "production",
						NODE_OPTIONS: "--max-old-space-size=192",
						GRAPHQL_UPSTREAM_ENDPOINT: "http://backend:4000/graphql",
						SHOPX_PLATFORM_API_ORIGIN: "http://backend:4000",
						SHOPX_PLATFORM_ID: p.id,
						REDIS_URL: "redis://redis:6379/0",
						REDIS_CACHE_PREFIX: p.id + ":storefront",
						NEXT_TELEMETRY_DISABLED: "1",
					},
					healthcheck: httpHealth("http://127.0.0.1:3100"),
				},
				admin: {
					...base,
					image: images.admin,
					mem_limit: "256m",
					env_file: [path.join(dir, "services.env")],
					environment: {
						NODE_ENV: "production",
						NODE_OPTIONS: "--max-old-space-size=160",
						GRAPHQL_UPSTREAM_ENDPOINT: "http://backend:4000/graphql",
						GRAPHQL_PROXY_ORIGIN: "http://admin:3000",
						SHOPX_PLATFORM_API_ORIGIN: "http://backend:4000",
						SHOPX_PLATFORM_ID: p.id,
						REDIS_URL: "redis://redis:6379/0",
						REDIS_CACHE_PREFIX: p.id + ":admin",
						NEXT_TELEMETRY_DISABLED: "1",
					},
					healthcheck: httpHealth("http://127.0.0.1:3000/login"),
				},
				gateway: {
					...base,
					image: images.gateway,
					mem_limit: "32m",
					cpus: 0.25,
					ports: [`127.0.0.1:${p.port}:80`],
					networks: {
						default: {},
						probes: { aliases: ["gateway-" + this.project(p)] },
					},
					volumes: [`${dir}/nginx.conf:/etc/nginx/conf.d/default.conf:ro`],
					depends_on: ["backend", "storefront", "admin"],
				},
			},
			volumes: { "redis-data": { labels } },
			networks: {
				default: { labels },
				oracle: { external: true, name: this.config.oracleNetwork },
				probes: { external: true, name: this.config.probeNetwork },
			},
		};
		writePrivate(path.join(dir, "nginx.conf"), gatewayConfiguration(hostname));

		writePrivate(
			path.join(dir, "compose.json"),
			JSON.stringify(compose, null, 2)
		);
	}
	async schema(p: Platform) {
		const setup = settings<any>(path.join(this.directory(p), "setup.json"));
		if (!/^[a-f0-9]{28}$/.test(setup.databasePassword))
			throw new Problem(409, "INVALID_SECRET");
		const c = await oracle.getConnection(this.config.provisioner);
		try {
			const pdb = (
				await c.execute("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL")
			).rows[0][0];
			if (pdb !== this.config.provisioner.pdb || pdb === "CDB$ROOT")
				throw new Problem(409, "PDB_IDENTITY_MISMATCH");
			try {
				await c.execute(
					`CREATE USER ${p.schema} IDENTIFIED BY "${setup.databasePassword}" DEFAULT TABLESPACE USERS QUOTA 256M ON USERS`
				);
			} catch (e: any) {
				if (![1920, 1921].includes(e.errorNum)) throw e;
				// A collision never authorizes changes to an unowned user. A crash
				// before the first session grant needs explicit operator recovery.
				try {
					const own = await oracle.getConnection({
						user: p.schema,
						password: setup.databasePassword,
						connectString: this.config.provisioner.connectString,
					});
					await own.close();
				} catch {
					throw new Problem(409, "SCHEMA_OWNERSHIP_UNPROVEN");
				}
			}
			// Only the generated credential can prove ownership after a interrupted CREATE USER.
			// Granting CREATE SESSION again is harmless, but never reset an existing password.
			await c.execute(
				`GRANT CREATE SESSION, CREATE TABLE, CREATE SEQUENCE TO ${p.schema}`
			);
			const own = await oracle.getConnection({
				user: p.schema,
				password: setup.databasePassword,
				connectString: this.config.provisioner.connectString,
			});
			await own.close();
		} finally {
			await c.close();
		}
	}
	async install(p: Platform) {
		await this.compose(
			p,
			[
				"run",
				"--rm",
				"--no-deps",
				"-e",
				"PLATFORM_SETUP_FILE=/run/platform/setup.json",
				"-e",
				"PLATFORM_ASSETS_DIR=/run/catalog",
				"--entrypoint",
				"node",
				"backend",
				"scripts/provision-platform.cjs",
			],
			300000
		);
	}
	async start(p: Platform) {
		await this.compose(
			p,
			["up", "-d", "--wait", "--wait-timeout", "180"],
			210000
		);
	}
	async configure(p: Platform) {
		await this.checkOwnership(p);
		const dir = this.directory(p);
		const setup = settings<any>(path.join(dir, "setup.json"));
		if (setup.schema !== p.schema || setup.configuration.platformId !== p.id)
			throw new Problem(409, "MANIFEST_CONFLICT");
		const filename = `configure-${p.revision}.json`;
		writePrivate(
			path.join(dir, filename),
			JSON.stringify({
				...setup,
				action: "configure",
				configuration: publicConfiguration(p),
			})
		);
		await this.compose(
			p,
			[
				"run",
				"--rm",
				"--no-deps",
				"-e",
				`PLATFORM_SETUP_FILE=/run/platform/${filename}`,
				"--entrypoint",
				"node",
				"backend",
				"scripts/provision-platform.cjs",
			],
			120000
		);
	}
	async stop(p: Platform) {
		if (fs.existsSync(path.join(this.directory(p), "compose.json")))
			await this.compose(p, ["stop", "--timeout", "20"]);
	}
	async restart(p: Platform) {
		await this.compose(p, ["restart", "--timeout", "20"]);
	}
	async health(p: Platform): Promise<Record<string, boolean>> {
		const host = `${p.manifest.slug}.localhost:${p.port}`,
			url = `http://gateway-${this.project(p)}`;
		const probe = async (
			channel: string,
			pathname: string,
			check: (body: any) => boolean,
			json = true
		) => {
			try {
				const r = await gatewayRequest(
					url + pathname,
					channel ? channel + "." + host : host
				);
				return r.ok && check(json ? await r.json() : await r.text());
			} catch {
				return false;
			}
		};
		const [backend, storefront, admin] = await Promise.all([
			probe(
				"api",
				"/health/ready",
				(r) =>
					r.ready === true &&
					r.platformId === p.id &&
					r.configRevision === p.revision
			),
			probe(
				"",
				"/api/platform-config",
				(r) =>
					r.configuration?.platformId === p.id &&
					r.configuration?.revision === p.revision
			),
			probe(
				"admin",
				"/api/platform-config",
				(r) =>
					r.configuration?.platformId === p.id &&
					r.configuration?.revision === p.revision
			),
		]);
		let catalog = false,
			image = false,
			imageExpected = true;
		try {
			const r = await gatewayRequest(
				url + "/graphql",
				"api." + host,
				JSON.stringify({
					query: "{ getProducts(limit: 1) { id name price image { url } } }",
				})
			);
			const data: any = await r.json();
			const products = data.data?.getProducts;
			const empty = p.manifest.seedMode === "empty";
			catalog =
				r.ok &&
				!data.errors &&
				Array.isArray(products) &&
				(empty || products.length > 0);
			imageExpected = !(catalog && empty && products.length === 0);
			if (
				catalog &&
				products.length > 0 &&
				/^\/api\/products\/\d+\/image/.test(products[0].image?.url)
			) {
				const img = await gatewayRequest(url + products[0].image.url, host);
				image =
					img.ok &&
					/^image\//.test(img.headers.get("content-type") || "") &&
					(await img.arrayBuffer()).byteLength > 100;
			}
		} catch {}
		return {
			backend,
			storefront,
			admin,
			catalog,
			...(imageExpected ? { image } : {}),
		};
	}
}
