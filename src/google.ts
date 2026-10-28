import { Router, Request, Response, NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { Account, State, fail, hash } from "./domain";
import { consumeAttempt } from "./accounts";
import { OracleStore } from "./store";

export interface GoogleSettings {
	clientId: string;
	clientSecret: string;
}
export interface GoogleIdentity {
	subject: string;
	email: string;
}
export interface GoogleProvider {
	authorize(state: string, nonce: string, verifier: string): string;
	identity(
		code: string,
		nonce: string,
		verifier: string
	): Promise<GoogleIdentity>;
}
export function googleProvider(
	config: GoogleSettings,
	origin: string
): GoogleProvider {
	if (
		!config.clientId.endsWith(".apps.googleusercontent.com") ||
		!config.clientSecret
	)
		throw new Error("Invalid Google OAuth configuration");
	const client = new OAuth2Client({
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		redirectUri: origin + "/api/control/auth/google/callback",
		transporterOptions: { timeout: 8000, retry: false },
	});
	return {
		authorize: (state, nonce, verifier) => {
			const url = new URL(
				client.generateAuthUrl({
					scope: ["openid", "email"],
					state,
					prompt: "select_account",
					code_challenge_method: CodeChallengeMethod.S256,
					code_challenge: createHash("sha256")
						.update(verifier)
						.digest("base64url"),
				})
			);
			url.searchParams.set("nonce", nonce);
			return url.toString();
		},
		identity: async (code, nonce, verifier) => {
			const { tokens } = await client.getToken({
				code,
				codeVerifier: verifier,
			});
			if (!tokens.id_token) throw new Error("Missing identity token");
			const ticket = await client.verifyIdToken({
				idToken: tokens.id_token,
				audience: config.clientId,
			});
			const payload = ticket.getPayload() as ReturnType<
				typeof ticket.getPayload
			> & { nonce?: string };
			if (
				!payload?.sub ||
				!payload.email ||
				payload.email_verified !== true ||
				payload.nonce !== nonce
			)
				throw new Error("Invalid verified identity");
			return {
				subject: payload.sub,
				email: payload.email.trim().toLowerCase(),
			};
		},
	};
}
export const readCookie = (req: Request, name: string) =>
	req.headers.cookie
		?.split(";")
		.map((v) => v.trim())
		.find((v) => v.startsWith(name + "="))
		?.slice(name.length + 1) || "";
const wrap =
	(fn: (req: Request, res: Response) => Promise<unknown>) =>
	(req: Request, res: Response, next: NextFunction) => {
		fn(req, res).catch(next);
	};

export function googleRoutes(
	store: OracleStore,
	origin: string,
	provider: GoogleProvider | undefined,
	hooks: {
		user: (state: State, req: Request) => Account;
		password: (value: string, encoded: string) => Promise<boolean>;
		session: (res: Response, token: string) => unknown;
		source: (req: Request) => string;
	}
) {
	const router = Router();
	const flowCookie = (res: Response, value: string) =>
		res.append(
			"Set-Cookie",
			`sx_google=${value}; HttpOnly; SameSite=Lax; Path=/api/control/auth/google; Max-Age=${
				value ? 300 : 0
			}${origin.startsWith("https:") ? "; Secure" : ""}`
		);
	const rotateSession = (
		s: State,
		account: Account,
		token: string,
		old?: string
	) => {
		s.sessions = s.sessions.filter(
			(v) => v.expires > Date.now() && v.hash !== old
		);
		if (s.sessions.length >= 1000) fail(429, "SESSION_LIMIT");
		s.sessions.push({
			hash: hash(token),
			userId: account.id,
			expires: Date.now() + 8 * 60 * 60 * 1000,
		});
	};
	router.get("/auth/methods", (_req, res) =>
		res.json({
			password: true,
			google: Boolean(provider),
			registration: "invitation-only",
		})
	);
	router.post(
		"/auth/google/start",
		wrap(async (req, res) => {
			if (!provider) return fail(503, "GOOGLE_NOT_CONFIGURED");
			const purpose = req.body?.purpose;
			if (!["login", "connect"].includes(purpose))
				fail(400, "INVALID_AUTH_PURPOSE");
			let account: Account | undefined;
			if (purpose === "connect") {
				account = await store.transaction((s) => {
					const actor = hooks.user(s, req);
					consumeAttempt(s, "google:connect:" + actor.id);
					return actor;
				});
				const password = req.body?.currentPassword;
				if (
					typeof password !== "string" ||
					password.length > 256 ||
					!(await hooks.password(password, account.password))
				)
					fail(400, "CURRENT_PASSWORD_INCORRECT");
			} else {
				// Never let rejected account-link requests consume another user's login quota.
				// Only the authenticated console proxy may forward the client address.
				await store.transaction((s) => {
					consumeAttempt(s, "google:login:" + hash(hooks.source(req)), 10);
				});
			}
			const state = randomBytes(32).toString("hex"),
				browser = randomBytes(32).toString("hex"),
				nonce = randomBytes(32).toString("hex"),
				verifier = randomBytes(32).toString("base64url");
			await store.transaction((s) => {
				if (account) {
					const actor = hooks.user(s, req);
					if (actor.password !== account.password || actor.google)
						fail(409, "ACCOUNT_CHANGED");
				}
				s.googleFlows = (s.googleFlows || []).filter(
					(v) => v.expires > Date.now() && (!account || v.userId !== account.id)
				);
				// Keep login and password-confirmed linking capacity separate.
				if (
					s.googleFlows.filter((v) => Boolean(v.userId) === Boolean(account))
						.length >= 100
				)
					fail(429, "TRY_LATER");
				s.googleFlows.push({
					hash: hash(state),
					browser: hash(browser),
					nonce,
					verifier,
					expires: Date.now() + 300000,
					...(account
						? {
								userId: account.id,
								session: hash(readCookie(req, "sx_control")),
								password: account.password,
						  }
						: {}),
				});
			});
			flowCookie(res, browser);
			res.json({ url: provider.authorize(state, nonce, verifier) });
		})
	);
	router.get(
		"/auth/google/callback",
		wrap(async (req, res) => {
			flowCookie(res, "");
			let outcome = "failed";
			try {
				if (
					!provider ||
					typeof req.query.state !== "string" ||
					!/^[a-f0-9]{64}$/.test(req.query.state)
				)
					throw new Error("Invalid state");
				const stateHash = hash(req.query.state),
					browser = hash(readCookie(req, "sx_google"));
				const flow = await store.transaction((s) => {
					const candidate = s.googleFlows?.find(
						(v) =>
							v.hash === stateHash &&
							v.browser === browser &&
							v.expires > Date.now()
					);
					if (!candidate) return fail(400, "GOOGLE_FLOW_EXPIRED");
					s.googleFlows = s.googleFlows!.filter(
						(v) => v.hash !== candidate.hash && v.expires > Date.now()
					);
					return candidate;
				});
				if (req.query.error) throw new Error("Cancelled");
				if (
					typeof req.query.code !== "string" ||
					!req.query.code ||
					req.query.code.length > 4096
				)
					throw new Error("Invalid code");
				const identity = await provider.identity(
					req.query.code,
					flow.nonce,
					flow.verifier
				);
				const token = randomBytes(32).toString("hex");
				await store.transaction(
					(s) => {
						const linked = s.users.find(
							(u) => u.google?.subject === identity.subject
						);
						if (flow.userId) {
							const actor = s.users.find(
								(u) => u.id === flow.userId && !u.disabled
							);
							if (
								!actor ||
								actor.password !== flow.password ||
								actor.google ||
								linked ||
								actor.email !== identity.email ||
								!s.sessions.some(
									(v) =>
										v.hash === flow.session &&
										v.userId === actor.id &&
										v.expires > Date.now()
								)
							)
								return fail(403, "GOOGLE_LINK_REJECTED");
							actor.google = {
								subject: identity.subject,
								email: identity.email,
							};
							rotateSession(s, actor, token, flow.session);
						} else {
							if (
								!linked ||
								linked.disabled ||
								linked.google?.email !== identity.email
							)
								return fail(403, "GOOGLE_LOGIN_REJECTED");
							rotateSession(s, linked, token);
						}
					},
					{
						actor: flow.userId || "google",
						event: flow.userId ? "google.connected" : "google.login",
					}
				);
				hooks.session(res, token);
				outcome = flow.userId ? "connected" : "signed-in";
			} catch {
				/* Never echo provider tokens, authorization codes or account details. */
			}
			res.redirect(303, origin + "/platforms?google=" + outcome);
		})
	);
	router.post(
		"/account/google/disconnect",
		wrap(async (req, res) => {
			const account = await store.transaction((s) => {
				const actor = hooks.user(s, req);
				consumeAttempt(s, "google:disconnect:" + actor.id);
				return actor;
			});
			const password = req.body?.currentPassword;
			if (
				typeof password !== "string" ||
				password.length > 256 ||
				!(await hooks.password(password, account.password))
			)
				fail(400, "CURRENT_PASSWORD_INCORRECT");
			const token = randomBytes(32).toString("hex");
			await store.transaction(
				(s) => {
					const actor = hooks.user(s, req);
					if (actor.password !== account.password) fail(409, "ACCOUNT_CHANGED");
					delete actor.google;
					s.googleFlows = (s.googleFlows || []).filter(
						(v) => v.userId !== actor.id
					);
					s.sessions = s.sessions.filter((v) => v.userId !== actor.id);
					rotateSession(s, actor, token);
				},
				{ actor: account.id, event: "google.disconnected" }
			);
			hooks.session(res, token);
			res.json({ ok: true });
		})
	);
	return router;
}
