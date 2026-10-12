const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { application } = require("../dist/api");
const { emptyState, hash } = require("../dist/domain");
test("API denies unauthenticated reads, CSRF, tenant roles and duplicate mutation effects", async () => {
	let state = emptyState();
	const token = randomBytes(32).toString("hex");
	state.users.push({
		id: "admin",
		email: "admin@example.test",
		role: "GLOBAL_ADMIN",
		password: "unused",
	});
	state.sessions.push({
		hash: hash(token),
		userId: "admin",
		expires: Date.now() + 10000,
	});
	const store = {
		read: async () => structuredClone(state),
		transaction: async (fn) => {
			const clone = structuredClone(state),
				result = fn(clone);
			state = clone;
			return result;
		},
	};
	const server = application(store, {
		origin: "http://localhost:3200",
		release: "v1",
		capacity: 4,
		gatewayPort: 9200,
	}).listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const url = "http://127.0.0.1:" + server.address().port;
	const manifest = {
		slug: "northstar",
		displayName: "Northstar",
		ownerEmail: "owner@example.test",
		locale: "en",
		currency: "EUR",
		priceDisplay: "gross",
		template: "general-store-real-v1",
		branding: { accent: "#c8ff5f", background: "#101112", surface: "#1a1d20" },
	};
	const request = (
		route,
		method = "GET",
		origin = "http://localhost:3200",
		cookie = "sx_control=" + token
	) =>
		fetch(url + route, {
			method,
			headers: {
				origin,
				cookie,
				"Content-Type": "application/json",
				"Idempotency-Key": "request_key_12345",
			},
			...(method === "POST" ? { body: JSON.stringify(manifest) } : {}),
		});
	try {
		assert.equal(
			(await request("/v1/platforms", "GET", undefined, "support_sid=" + token))
				.status,
			401
		);
		assert.equal(
			(await request("/v1/platforms", "POST", "http://evil.test")).status,
			403
		);
		assert.equal((await request("/v1/platforms", "POST")).status, 202);
		assert.equal((await request("/v1/platforms", "POST")).status, 202);
		assert.equal(state.platforms.length, 1);
		state.users[0].role = "GLOBAL_VIEWER";
		assert.equal((await request("/v1/platforms", "POST")).status, 403);
		const data = await (await request("/v1/platforms")).json();
		assert.equal(data.users, undefined);
		assert.equal(data.sessions, undefined);
		await fetch(url + "/v1/logout", {
			method: "POST",
			headers: {
				origin: "http://localhost:3200",
				cookie: "sx_control=" + token,
			},
		});
		assert.equal((await request("/v1/platforms")).status, 401);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
