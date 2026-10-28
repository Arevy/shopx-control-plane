import express, { Request, Response, NextFunction } from "express";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ObservabilitySettings, observabilityRoutes } from "./observability";
import { OracleStore, DatabaseSettings, settings } from "./store";
import { checkPassword, encodePassword } from "./auth";
import {
	googleProvider,
	googleRoutes,
	GoogleProvider,
	GoogleSettings,
} from "./google";
import {
	Problem,
	fail,
	hash,
	inventory,
	requestCreation,
	requestAction,
	requestConfiguration,
	validateManifest,
	authorize,
	State,
	canReadPlatform,
} from "./domain";
import {
	emailAddress,
	passwordPolicy,
	consumeAttempt,
	invite,
	acceptInvitation,
	publicAccount,
} from "./accounts";

export interface ApiSettings {
	database: DatabaseSettings;
	origin: string;
	release: string;
	capacity: number;
	domain: string;
	gatewayPort: number;
	port: number;
	host: string;
	initialShop?: { name: string; storefront: string; admin: string };
	google?: GoogleSettings;
	proxyKey?: string;
	observability?: ObservabilitySettings;
}
const wrap =
	(fn: (req: Request, res: Response) => Promise<unknown>) =>
	(req: Request, res: Response, next: NextFunction) => {
		fn(req, res).catch(next);
	};
function cookie(req: Request) {
	return (
		req.headers.cookie
			?.split(";")
			.map((s) => s.trim())
			.find((s) => s.startsWith("sx_control="))
			?.slice(11) || ""
	);
}
function user(s: State, req: Request) {
	const session = s.sessions.find(
		(v) => v.hash === hash(cookie(req)) && v.expires > Date.now()
	);
	const result = s.users.find((v) => v.id === session?.userId && !v.disabled);
	if (!result) return fail(401, "AUTHENTICATION_REQUIRED");
	return result;
}
export function application(
	store: OracleStore,
	config: ApiSettings,
	identityProvider?: GoogleProvider
) {
	const app = express();
	if (config.proxyKey && !/^[a-f0-9]{64}$/.test(config.proxyKey))
		throw new Error("Invalid control proxy key");
	app.disable("x-powered-by");
	app.use((req, res, next) => {
		const started = Date.now();
		const requestId = randomUUID();
		res.set("X-Request-ID", requestId);
		res.once("finish", () => {
			if (req.path.startsWith("/internal/") || req.path.startsWith("/health/"))
				return;
			console.log(
				JSON.stringify({
					level: "info",
					event: "http_request",
					message: "Control request completed",
					method: req.method,
					path: req.route?.path || "/unmatched",
					status: res.statusCode,
					duration_ms: Date.now() - started,
					request_id: requestId,
				})
			);
		});
		next();
	});
	app.use((req, res, next) => {
		res
			.set("Cache-Control", "no-store")
			.set("X-Content-Type-Options", "nosniff")
			.set("Referrer-Policy", "no-referrer")
			.set("X-Frame-Options", "DENY");
		if (
			!["GET", "HEAD"].includes(req.method) &&
			req.headers.origin !== config.origin
		)
			return res.status(403).json({ error: "ORIGIN_REJECTED" });
		next();
	});
	app.use(express.json({ limit: "16kb" }));
	app.use(observabilityRoutes(store, config.observability, user));
	const setSession = (res: Response, token: string) =>
		res.append(
			"Set-Cookie",
			`sx_control=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${
				config.origin.startsWith("https:") ? "; Secure" : ""
			}`
		);
	let derivations = 0;
	const passwordWork = async <T>(fn: () => Promise<T>) => {
		if (derivations >= 2) return fail(429, "TRY_LATER");
		derivations++;
		try {
			return await fn();
		} finally {
			derivations--;
		}
	};
	app.use(
		"/v1",
		googleRoutes(
			store,
			config.origin,
			identityProvider ||
				(config.google
					? googleProvider(config.google, config.origin)
					: undefined),
			{
				user,
				source: (req) => {
					const key = req.headers["x-shopx-proxy-key"];
					const address = req.headers["x-shopx-client-address"];
					if (
						config.proxyKey &&
						typeof key === "string" &&
						/^[a-f0-9]{64}$/.test(key) &&
						timingSafeEqual(Buffer.from(key), Buffer.from(config.proxyKey)) &&
						typeof address === "string" &&
						isIP(address)
					)
						return address;
					return req.socket.remoteAddress || "unknown";
				},
				password: (value, encoded) =>
					passwordWork(() => checkPassword(value, encoded)),
				session: setSession,
			}
		)
	);
	app.get(
		"/health/ready",
		wrap(async (_req, res) => {
			await store.read();
			res.json({ ready: true, service: "shopx-control-plane" });
		})
	);
	app.post(
		"/v1/login",
		wrap(async (req, res) => {
			const { email, password } = req.body || {};
			if (
				typeof email !== "string" ||
				email.length > 254 ||
				typeof password !== "string" ||
				password.length > 256
			)
				fail(400, "INVALID_CREDENTIALS");
			const normalized = email.trim().toLowerCase(),
				key = hash(normalized),
				now = Date.now();
			const account = await store.transaction((s) => {
				consumeAttempt(s, key);
				return s.users.find((u) => u.email === normalized);
			});
			const matches = await passwordWork(() =>
				checkPassword(
					password,
					account?.password || "0".repeat(32) + ":" + "0".repeat(128)
				)
			);
			if (!account || account.disabled || !matches)
				fail(401, "INVALID_CREDENTIALS");
			const token = randomBytes(32).toString("hex");
			await store.transaction(
				(s) => {
					const current = s.users.find((u) => u.id === account!.id);
					if (
						!current ||
						current.disabled ||
						current.password !== account!.password
					)
						fail(401, "INVALID_CREDENTIALS");
					s.sessions = s.sessions.filter((v) => v.expires > now);
					if (s.sessions.length >= 1000) fail(429, "SESSION_LIMIT");
					s.sessions.push({
						hash: hash(token),
						userId: account!.id,
						expires: now + 8 * 60 * 60 * 1000,
					});
					delete s.loginAttempts[key];
				},
				{ actor: account!.id, event: "login" }
			);
			setSession(res, token);
			res.json({ user: { email: account!.email, role: account!.role } });
		})
	);
	app.post(
		"/v1/invitations/accept",
		wrap(async (req, res) => {
			const { token, password, name } = req.body || {},
				email = emailAddress(req.body?.email);
			if (
				typeof token !== "string" ||
				!/^[a-f0-9]{64}$/.test(token) ||
				typeof name !== "string"
			)
				fail(400, "INVITATION_INVALID_OR_EXPIRED");
			passwordPolicy(password);
			await store.transaction((s) => {
				consumeAttempt(s, "accept:" + hash(email));
				consumeAttempt(s, "accept-total", 50);
			});
			const snapshot = await store.read();
			// Reject invalid links before doing expensive password work; recheck atomically afterward.
			acceptInvitation(snapshot, token, email, name, "validation-only");
			const encoded = await passwordWork(() => encodePassword(password));
			await store.transaction(
				(s) => {
					acceptInvitation(s, token, email, name, encoded);
				},
				{ actor: "invitation", event: "account.created" }
			);
			res.status(201).json({ ok: true }); // Explicit sign-in rotates into a new server session.
		})
	);
	app.post(
		"/v1/account/password",
		wrap(async (req, res) => {
			const { currentPassword, password } = req.body || {};
			if (typeof currentPassword !== "string" || currentPassword.length > 256)
				fail(400, "INVALID_CREDENTIALS");
			passwordPolicy(password);
			const account = await store.transaction((s) => {
				const actor = user(s, req);
				consumeAttempt(s, "password:" + actor.id);
				return actor;
			});
			if (
				!(await passwordWork(() =>
					checkPassword(currentPassword, account.password)
				))
			)
				fail(400, "CURRENT_PASSWORD_INCORRECT");
			const encoded = await passwordWork(() => encodePassword(password)),
				token = randomBytes(32).toString("hex");
			await store.transaction(
				(s) => {
					const actor = user(s, req);
					if (actor.password !== account.password) fail(409, "ACCOUNT_CHANGED");
					actor.password = encoded;
					s.sessions = s.sessions.filter(
						(v) => v.userId !== actor.id && v.expires > Date.now()
					);
					s.sessions.push({
						hash: hash(token),
						userId: actor.id,
						expires: Date.now() + 8 * 60 * 60 * 1000,
					});
					delete s.loginAttempts["password:" + actor.id];
				},
				{ actor: account.id, event: "password.changed" }
			);
			setSession(res, token);
			res.json({ ok: true });
		})
	);
	app.get(
		"/v1/accounts",
		wrap(async (req, res) => {
			const s = await store.read(),
				actor = user(s, req);
			authorize(actor.role, "accounts");
			res.json({
				users: s.users.map(publicAccount),
				invitations: (s.invitations || [])
					.filter((v) => !v.usedAt && !v.revokedAt && v.expires > Date.now())
					.map(({ id, email, role, expires }) => ({
						id,
						email,
						role,
						expires,
					})),
			});
		})
	);
	app.post(
		"/v1/invitations",
		wrap(async (req, res) => {
			const token = randomBytes(32).toString("hex"),
				actor = user(await store.read(), req);
			const record = await store.transaction(
				(s) => invite(s, user(s, req), req.body, token),
				{ actor: actor.id, event: "invitation.created" }
			);
			res.status(201).json({
				id: record.id,
				expires: record.expires,
				url: config.origin + "/platforms#invite=" + token,
			});
		})
	);
	app.post(
		"/v1/invitations/:id/revoke",
		wrap(async (req, res) => {
			const actor = user(await store.read(), req);
			await store.transaction(
				(s) => {
					authorize(user(s, req).role, "invite");
					const invitation = s.invitations?.find((v) => v.id === req.params.id);
					if (!invitation) return fail(404, "INVITATION_NOT_FOUND");
					invitation.revokedAt = Date.now();
				},
				{ actor: actor.id, event: "invitation.revoked", target: req.params.id }
			);
			res.json({ ok: true });
		})
	);
	app.post(
		"/v1/accounts/:id/status",
		wrap(async (req, res) => {
			const actor = user(await store.read(), req);
			if (typeof req.body?.disabled !== "boolean")
				fail(400, "INVALID_ACCOUNT_STATUS");
			await store.transaction(
				(s) => {
					authorize(user(s, req).role, "accounts");
					const target = s.users.find((u) => u.id === req.params.id);
					if (!target) return fail(404, "ACCOUNT_NOT_FOUND");
					if (target.role === "GLOBAL_ADMIN" || target.id === actor.id)
						fail(409, "PROTECTED_ACCOUNT");
					target.disabled = req.body.disabled;
					s.sessions = s.sessions.filter((v) => v.userId !== target.id);
				},
				{ actor: actor.id, event: "account.status", target: req.params.id }
			);
			res.json({ ok: true });
		})
	);
	app.post(
		"/v1/logout",
		wrap(async (req, res) => {
			await store.transaction((s) => {
				s.sessions = s.sessions.filter((v) => v.hash !== hash(cookie(req)));
			});
			res
				.set(
					"Set-Cookie",
					"sx_control=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
				)
				.json({ ok: true });
		})
	);
	app.get(
		"/v1/platforms",
		wrap(async (req, res) => {
			const s = await store.read(),
				actor = user(s, req);
			res.json({
				...inventory(s, Date.now(), actor),
				user: publicAccount(actor),
				domain: config.domain,
				gatewayPort: config.gatewayPort,
				capacity: config.capacity,
				remainingSlots: Math.max(0, config.capacity - s.platforms.length),
				initialShop:
					actor.role === "PLATFORM_CREATOR" ? null : config.initialShop || null,
			});
		})
	);
	app.post(
		"/v1/platform-plans",
		wrap(async (req, res) => {
			const s = await store.read(),
				actor = user(s, req);
			authorize(actor.role, "create");
			const manifest = validateManifest(req.body);
			if (s.platforms.some((p) => p.manifest.slug === manifest.slug))
				fail(409, "SLUG_TAKEN");
			if (s.platforms.length >= config.capacity) fail(409, "CAPACITY_LIMIT");
			res.json({
				manifest,
				release: config.release,
				services: ["backend", "redis", "storefront", "admin"],
				isolation:
					"Dedicated Oracle schema, Redis, session secret and application containers",
				addresses: {
					storefront: `http://${manifest.slug}.${config.domain}:${
						config.gatewayPort + s.platforms.length
					}`,
					admin: `http://admin.${manifest.slug}.${config.domain}:${
						config.gatewayPort + s.platforms.length
					}`,
				},
				native: "not_requested",
				notes: [
					manifest.seedMode === "empty"
						? "Empty catalog and CMS; one new owner account"
						: "45 reviewed catalog products and CMS; no copied customers or orders",
					"Owner credentials are delivered through the private operator handoff",
					"No payment provider or native app publication is provisioned",
				],
			});
		})
	);
	app.post(
		"/v1/platforms",
		wrap(async (req, res) => {
			const op = await store.transaction(
				(s) => {
					const actor = user(s, req);
					return requestCreation(
						s,
						actor.id,
						actor.role,
						req.header("Idempotency-Key"),
						req.body,
						config.release,
						config.capacity,
						config.gatewayPort
					);
				},
				{ actor: user(await store.read(), req).id, event: "request.create" }
			);
			res.status(202).json(op);
		})
	);
	app.post(
		"/v1/platforms/:id/operations",
		wrap(async (req, res) => {
			const op = await store.transaction(
				(s) => {
					const actor = user(s, req);
					return requestAction(
						s,
						actor.id,
						actor.role,
						req.header("Idempotency-Key"),
						req.params.id,
						req.body?.action,
						config.release
					);
				},
				{
					actor: user(await store.read(), req).id,
					event: "request.operation",
					target: req.params.id,
				}
			);
			res.status(202).json(op);
		})
	);
	app.get(
		"/v1/operations/:id",
		wrap(async (req, res) => {
			const s = await store.read(),
				actor = user(s, req);
			const op = s.operations.find((o) => o.id === req.params.id);
			if (
				!op ||
				!s.platforms.some(
					(p) => p.id === op.platformId && canReadPlatform(actor, p)
				)
			)
				fail(404, "OPERATION_NOT_FOUND");
			res.json(op);
		})
	);
	app.post(
		"/v1/platforms/:id/configuration",
		wrap(async (req, res) => {
			const actor = user(await store.read(), req);
			const operation = await store.transaction(
				(s) =>
					requestConfiguration(
						s,
						user(s, req),
						req.header("Idempotency-Key"),
						req.params.id,
						req.body
					),
				{
					actor: actor.id,
					event: "configuration.requested",
					target: req.params.id,
				}
			);
			res.status(202).json(operation);
		})
	);
	app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
	app.use(
		(error: unknown, _req: Request, res: Response, _next: NextFunction) => {
			if (error instanceof SyntaxError)
				return res.status(400).json({ error: "INVALID_JSON" });
			if ((error as { status?: number })?.status === 413)
				return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
			res.status(error instanceof Problem ? error.status : 503).json({
				error: error instanceof Problem ? error.code : "CONTROL_UNAVAILABLE",
			});
		}
	);
	return app;
}
async function main() {
	const config = settings<ApiSettings>(process.env.CONTROL_CONFIG_FILE || "");
	const origin = new URL(config.origin);
	if (
		!["localhost", "127.0.0.1"].includes(origin.hostname) ||
		origin.protocol !== "http:"
	)
		throw new Error(
			"Initial local provider requires a loopback console origin; production auth is not enabled"
		);
	const store = new OracleStore(config.database);
	await store.connect();
	const server = application(store, config).listen(
		config.port,
		config.host,
		() => console.log("Control API ready")
	);
	for (const signal of ["SIGINT", "SIGTERM"])
		process.on(signal, () =>
			server.close(() => {
				void store.close().then(() => process.exit(0));
			})
		);
}
if (require.main === module)
	main().catch(() => {
		console.error(
			"Control API startup failed; verify private configuration and Oracle readiness"
		);
		process.exitCode = 1;
	});
