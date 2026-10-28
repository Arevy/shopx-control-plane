const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, createHash } = require("node:crypto");
const { application } = require("../dist/api");
const { emptyState, hash } = require("../dist/domain");
const { encodePassword } = require("../dist/auth");
const { googleProvider } = require("../dist/google");
const origin = "http://localhost:3200";
async function fixture(t, enabled = true) {
	let state = emptyState();
	const password = randomBytes(24).toString("hex"),
		token = randomBytes(32).toString("hex");
	state.users.push({
		id: "admin",
		email: "owner@example.test",
		role: "GLOBAL_ADMIN",
		password: await encodePassword(password),
	});
	state.sessions.push({
		hash: hash(token),
		userId: "admin",
		expires: Date.now() + 60000,
	});
	const provider = {
		identity: async () => ({
			subject: "verified-google-subject",
			email: "owner@example.test",
		}),
		authorize: (s, n, v) => {
			provider.challenge = { state: s, nonce: n, verifier: v };
			return "https://accounts.google.com/o/oauth2/v2/auth?state=" + s;
		},
	};
	const store = {
		read: async () => structuredClone(state),
		transaction: async (fn) => {
			const next = structuredClone(state),
				result = fn(next);
			state = next;
			return result;
		},
	};
	const server = application(
		store,
		{
			origin,
			release: "v1",
			capacity: 4,
			gatewayPort: 9200,
			proxyKey: "a".repeat(64),
		},
		enabled ? provider : undefined
	).listen(0, "127.0.0.1");
	await new Promise((r) => server.once("listening", r));
	t.after(() => new Promise((r) => server.close(r)));
	const url = "http://127.0.0.1:" + server.address().port;
	const request = (route, body, cookie = "sx_control=" + token, headers = {}) =>
		fetch(url + "/v1/" + route, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				origin,
				cookie,
				"Content-Type": "application/json",
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: "manual",
		});
	const start = async (purpose = "login", cookie) => {
		const r = await request(
			"auth/google/start",
			{ purpose, currentPassword: password },
			cookie
		);
		assert.equal(r.status, 200);
		const data = await r.json();
		return {
			state: new URL(data.url).searchParams.get("state"),
			cookie: r.headers.getSetCookie()[0].split(";")[0],
		};
	};
	const callback = (flow, code = "test-code", cookie = flow.cookie) =>
		request(
			"auth/google/callback?state=" + flow.state + "&code=" + code,
			undefined,
			cookie
		);
	return {
		request,
		start,
		callback,
		provider,
		password,
		get state() {
			return state;
		},
	};
}
test("Google stays optional and authorization uses PKCE, nonce and a fixed callback", async (t) => {
	const f = await fixture(t, false);
	assert.deepEqual(await (await f.request("auth/methods")).json(), {
		password: true,
		google: false,
		registration: "invitation-only",
	});
	assert.equal(
		(await f.request("auth/google/start", { purpose: "login" })).status,
		503
	);
	const p = googleProvider(
		{ clientId: "test.apps.googleusercontent.com", clientSecret: "test-only" },
		origin
	);
	const u = new URL(p.authorize("state", "nonce", "verifier"));
	assert.equal(u.origin, "https://accounts.google.com");
	assert.equal(
		u.searchParams.get("redirect_uri"),
		origin + "/api/control/auth/google/callback"
	);
	assert.equal(u.searchParams.get("code_challenge_method"), "S256");
	assert.equal(
		u.searchParams.get("code_challenge"),
		createHash("sha256").update("verifier").digest("base64url")
	);
	assert.equal(u.searchParams.get("nonce"), "nonce");
	assert.equal(u.searchParams.get("scope"), "openid email");
});
test("Google login never creates or automatically links an invited account by email", async (t) => {
	const f = await fixture(t),
		flow = await f.start();
	const r = await f.callback(flow);
	assert.match(r.headers.get("location"), /google=failed$/);
	assert.equal(f.state.users.length, 1);
	assert.equal(f.state.users[0].google, undefined);
	assert.equal(f.state.googleFlows.length, 0);
});
test("password-confirmed linking enables Google login; state is browser-bound, single-use and disconnect revokes sessions", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(
			await f.request("auth/google/start", {
				purpose: "connect",
				currentPassword: "wrong",
			})
		).status,
		400
	);
	assert.equal(
		(
			await f.request(
				"auth/google/start",
				{ purpose: "connect", currentPassword: f.password },
				""
			)
		).status,
		401
	);
	const flow = await f.start("connect");
	const saved = f.provider.challenge;
	f.provider.identity = async (code, nonce, verifier) => {
		assert.equal(code, "test-code");
		assert.equal(nonce, saved.nonce);
		assert.equal(verifier, saved.verifier);
		return { subject: "verified-google-subject", email: "owner@example.test" };
	};
	assert.match(
		(await f.callback(flow, "test-code", "")).headers.get("location"),
		/failed$/
	);
	const connected = await f.callback(flow);
	assert.match(connected.headers.get("location"), /connected$/);
	assert.equal(connected.headers.getSetCookie().length, 2);
	assert.equal(f.state.users[0].google.subject, "verified-google-subject");
	assert.match((await f.callback(flow)).headers.get("location"), /failed$/);
	const login = await f.start();
	f.provider.identity = async () => ({
		subject: "verified-google-subject",
		email: "owner@example.test",
	});
	const logged = await f.callback(login);
	assert.match(logged.headers.get("location"), /signed-in$/);
	const cookie = logged.headers
		.getSetCookie()
		.find((v) => v.startsWith("sx_control="))
		.split(";")[0];
	const inventory = await (
		await f.request("platforms", undefined, cookie)
	).json();
	assert.equal(inventory.user.googleConnected, true);
	assert.equal(inventory.user.google, undefined);
	assert.equal(inventory.user.password, undefined);
	assert.equal(
		(
			await f.request(
				"account/google/disconnect",
				{ currentPassword: f.password },
				cookie
			)
		).status,
		200
	);
	assert.equal(f.state.users[0].google, undefined);
	assert.equal(f.state.sessions.length, 1);
	assert.equal((await f.request("platforms", undefined, cookie)).status, 401);
});
test("Google rejects expired flows, provider failures, mismatched email, disabled accounts and revoked linking sessions", async (t) => {
	for (const scenario of [
		"expired",
		"provider",
		"email",
		"disabled",
		"session",
		"password",
	]) {
		await t.test(scenario, async (t) => {
			const f = await fixture(t),
				flow = await f.start("connect");
			if (scenario === "expired") f.state.googleFlows[0].expires = 0;
			if (scenario === "provider")
				f.provider.identity = async () => {
					throw new Error("rejected identity token");
				};
			if (scenario === "email")
				f.provider.identity = async () => ({
					subject: "different",
					email: "other@example.test",
				});
			if (scenario === "disabled") f.state.users[0].disabled = true;
			if (scenario === "session") f.state.sessions = [];
			if (scenario === "password") f.state.users[0].password = "changed";
			const response = await f.callback(flow);
			assert.match(response.headers.get("location"), /failed$/);
			assert.equal(f.state.users[0].google, undefined);
			assert(
				!response.headers
					.getSetCookie()
					.some((v) => v.startsWith("sx_control="))
			);
		});
	}
});

test("Google identity requires a verified email and matching nonce after library token verification", async () => {
	const { OAuth2Client } = require("google-auth-library");
	const originalToken = OAuth2Client.prototype.getToken,
		originalVerify = OAuth2Client.prototype.verifyIdToken;
	let payload = {
		sub: "subject",
		email: "OWNER@example.test",
		email_verified: true,
		nonce: "expected",
	};
	OAuth2Client.prototype.getToken = async function (options) {
		assert.equal(options.codeVerifier, "verifier");
		return { tokens: { id_token: "signed-token" } };
	};
	OAuth2Client.prototype.verifyIdToken = async function (options) {
		assert.equal(options.audience, "test.apps.googleusercontent.com");
		return { getPayload: () => payload };
	};
	try {
		const p = googleProvider(
			{
				clientId: "test.apps.googleusercontent.com",
				clientSecret: "test-only",
			},
			origin
		);
		assert.deepEqual(await p.identity("code", "expected", "verifier"), {
			subject: "subject",
			email: "owner@example.test",
		});
		for (const invalid of [
			{ email_verified: false },
			{ nonce: "wrong" },
			{ sub: "" },
			{ email: "" },
		]) {
			const good = payload;
			payload = { ...good, ...invalid };
			await assert.rejects(
				p.identity("code", "expected", "verifier"),
				/Invalid verified identity/
			);
			payload = good;
		}
	} finally {
		OAuth2Client.prototype.getToken = originalToken;
		OAuth2Client.prototype.verifyIdToken = originalVerify;
	}
});

test("unauthenticated link requests do not exhaust Google login capacity", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 100; i++) {
		const r = await f.request("auth/google/start", { purpose: "connect" }, "");
		assert.equal(r.status, 401);
		await r.text();
	}
	assert.equal(
		(await f.request("auth/google/start", { purpose: "login" }, "")).status,
		200
	);
});

test("Google login throttles each source and rejects spoofed forwarded addresses", async (t) => {
	const f = await fixture(t);
	const start = (headers) =>
		f.request("auth/google/start", { purpose: "login" }, "", headers);
	for (let i = 0; i < 10; i++) {
		const r = await start({});
		assert.equal(r.status, 200);
		await r.text();
	}
	assert.equal((await start({})).status, 429);
	assert.equal(
		(
			await start({
				"x-shopx-client-address": "192.0.2.2",
				"x-shopx-proxy-key": "b".repeat(64),
			})
		).status,
		429
	);
	assert.equal(
		(
			await start({
				"x-shopx-client-address": "192.0.2.2",
				"x-shopx-proxy-key": "a".repeat(64),
			})
		).status,
		200
	);
	assert.equal(
		(
			await start({
				"x-shopx-client-address": "not-an-ip",
				"x-shopx-proxy-key": "a".repeat(64),
			})
		).status,
		429
	);
	assert.equal(
		(
			await start({
				"x-shopx-client-address": "192.0.2.3",
				"x-shopx-proxy-key": "é".repeat(64),
			})
		).status,
		429
	);
	// A saturated anonymous source can still link its authenticated account with its password.
	assert.equal(
		(
			await f.request("auth/google/start", {
				purpose: "connect",
				currentPassword: f.password,
			})
		).status,
		200
	);
});
