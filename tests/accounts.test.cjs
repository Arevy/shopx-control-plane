const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { emptyState, hash } = require("../dist/domain");
const {
	invite,
	acceptInvitation,
	passwordPolicy,
} = require("../dist/accounts");
const { encodePassword } = require("../dist/auth");
const { application } = require("../dist/api");

test("invitation replacement, expiry, revocation and reuse cannot grant an account or escalate its role", () => {
	const s = emptyState(),
		admin = {
			id: "admin",
			email: "admin@example.test",
			password: "hash",
			role: "GLOBAL_ADMIN",
		};
	s.users.push(admin);
	const first = invite(
		s,
		admin,
		{ email: " User@Example.Test ", role: "PLATFORM_CREATOR" },
		"old-token",
		100
	);
	assert.equal(first.email, "user@example.test");
	assert.equal(first.hash, hash("old-token"));
	const second = invite(
		s,
		admin,
		{ email: first.email, role: "PLATFORM_CREATOR" },
		"new-token",
		200
	);
	assert.throws(
		() => acceptInvitation(s, "old-token", first.email, "Alex", "encoded", 201),
		/INVITATION_INVALID/
	);
	assert.throws(
		() =>
			acceptInvitation(
				s,
				"new-token",
				"other@example.test",
				"Alex",
				"encoded",
				201
			),
		/INVITATION_INVALID/
	);
	assert.throws(
		() =>
			acceptInvitation(
				s,
				"new-token",
				first.email,
				"Alex",
				"encoded",
				second.expires + 1
			),
		/INVITATION_INVALID/
	);
	second.revokedAt = 201;
	assert.throws(
		() => acceptInvitation(s, "new-token", first.email, "Alex", "encoded", 202),
		/INVITATION_INVALID/
	);
	delete second.revokedAt;
	const account = acceptInvitation(
		s,
		"new-token",
		first.email,
		"Alex",
		"encoded",
		202
	);
	assert.equal(account.role, "PLATFORM_CREATOR");
	assert.throws(
		() => acceptInvitation(s, "new-token", first.email, "Alex", "encoded", 203),
		/INVITATION_INVALID/
	);
	assert.throws(
		() =>
			invite(
				s,
				admin,
				{ email: "new@example.test", role: "GLOBAL_ADMIN" },
				"token"
			),
		/INVALID_INVITATION_ROLE/
	);
	assert.throws(
		() =>
			invite(
				s,
				account,
				{ email: "new@example.test", role: "GLOBAL_VIEWER" },
				"token"
			),
		/FORBIDDEN/
	);
	for (const password of ["", "short", " ".repeat(20), "x".repeat(129)])
		assert.throws(() => passwordPolicy(password));
	passwordPolicy("A long Unicode passphrase ✓");
});

test("HTTP onboarding, scoped platform access, session rotation, disabling and login throttling", async () => {
	let state = emptyState();
	const adminToken = randomBytes(32).toString("hex"),
		password = randomBytes(24).toString("hex");
	state.users.push({
		id: "admin",
		email: "admin@example.test",
		role: "GLOBAL_ADMIN",
		password: await encodePassword(password),
	});
	state.sessions.push({
		hash: hash(adminToken),
		userId: "admin",
		expires: Date.now() + 60000,
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
	const origin = "http://localhost:3200",
		server = application(store, {
			origin,
			release: "v1",
			capacity: 4,
			gatewayPort: 9200,
			domain: "localhost",
			initialShop: {
				name: "Initial",
				storefront: "http://localhost:3100",
				admin: "http://localhost:3000",
			},
		}).listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const url = "http://127.0.0.1:" + server.address().port;
	const request = (route, body, cookie = "sx_control=" + adminToken) =>
		fetch(url + "/v1/" + route, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				origin,
				cookie,
				"Content-Type": "application/json",
				"Idempotency-Key": randomBytes(16).toString("hex"),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const manifest = {
		slug: "initial-demo",
		displayName: "Demo",
		ownerEmail: "owner@example.test",
		locale: "en",
		currency: "EUR",
		priceDisplay: "gross",
		template: "general-store-real-v1",
		branding: { accent: "#c8ff5f", background: "#101112", surface: "#1a1d20" },
	};
	try {
		assert.equal(
			(
				await request("invitations", {
					email: "creator@example.test",
					role: "GLOBAL_ADMIN",
				})
			).status,
			400
		);
		const issued = await request("invitations", {
			email: "creator@example.test",
			role: "PLATFORM_CREATOR",
		});
		assert.equal(issued.status, 201);
		const token = new URLSearchParams(
			new URL((await issued.json()).url).hash.slice(1)
		).get("invite");
		assert.equal(
			(
				await request(
					"invitations/accept",
					{
						token,
						email: "creator@example.test",
						name: "Creator",
						password: "short",
					},
					""
				)
			).status,
			400
		);
		assert.equal(
			(
				await request(
					"invitations/accept",
					{
						token,
						email: "creator@example.test",
						name: "Creator",
						password,
						role: "GLOBAL_ADMIN",
					},
					""
				)
			).status,
			201
		);
		assert.equal(
			(
				await request(
					"invitations/accept",
					{ token, email: "creator@example.test", name: "Creator", password },
					""
				)
			).status,
			400
		);
		const login = await request(
			"login",
			{ email: " CREATOR@example.test ", password },
			""
		);
		assert.equal(login.status, 200);
		let creatorCookie = login.headers.get("set-cookie").split(";")[0];
		assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
		assert.equal((await login.json()).user.role, "PLATFORM_CREATOR");
		const initial = await request("platforms", manifest);
		assert.equal(initial.status, 202);
		const initialOp = await initial.json();
		assert.equal(
			(
				await request(
					"platforms",
					{ ...manifest, slug: "creators-empty", seedMode: "empty" },
					creatorCookie
				)
			).status,
			202
		);
		const inventory = await (
			await request("platforms", undefined, creatorCookie)
		).json();
		assert.equal(inventory.platforms.length, 1);
		assert.equal(inventory.platforms[0].manifest.seedMode, "empty");
		assert.equal(inventory.initialShop, null);
		assert.equal(
			(await request("operations/" + initialOp.id, undefined, creatorCookie))
				.status,
			404
		);
		state.operations.find((o) => o.id === initialOp.id).status = "failed";
		assert.equal(
			(
				await request(
					"platforms/" + initialOp.platformId + "/operations",
					{ action: "stop" },
					creatorCookie
				)
			).status,
			404
		);
		assert.equal(
			(await request("accounts", undefined, creatorCookie)).status,
			403
		);
		assert.equal(
			(
				await request(
					"invitations",
					{ email: "outsider@example.test", role: "PLATFORM_CREATOR" },
					creatorCookie
				)
			).status,
			403
		);
		const oldCookie = creatorCookie,
			newPassword = randomBytes(24).toString("hex");
		const changed = await request(
			"account/password",
			{ currentPassword: password, password: newPassword },
			creatorCookie
		);
		assert.equal(changed.status, 200);
		creatorCookie = changed.headers.get("set-cookie").split(";")[0];
		assert.notEqual(oldCookie, creatorCookie);
		assert.equal(
			(await request("platforms", undefined, oldCookie)).status,
			401
		);
		assert.equal(
			(await request("platforms", undefined, creatorCookie)).status,
			200
		);
		assert.equal(
			(await request("login", { email: "creator@example.test", password }, ""))
				.status,
			401
		);
		const creator = state.users.find((u) => u.email === "creator@example.test");
		assert.equal(
			(await request("accounts/" + creator.id + "/status", { disabled: true }))
				.status,
			200
		);
		assert.equal(
			(await request("platforms", undefined, creatorCookie)).status,
			401
		);
		assert.equal(
			(
				await request(
					"login",
					{ email: creator.email, password: newPassword },
					""
				)
			).status,
			401
		);
		assert.equal(
			(await request("accounts/admin/status", { disabled: true })).status,
			409
		);
		const accounts = JSON.stringify(await (await request("accounts")).json());
		assert(!accounts.includes(token));
		assert(!accounts.includes(creator.password));
		for (let i = 0; i < 10; i++)
			assert.equal(
				(
					await request(
						"login",
						{ email: "unknown@example.test", password },
						""
					)
				).status,
				401
			);
		assert.equal(
			(await request("login", { email: "unknown@example.test", password }, ""))
				.status,
			429
		);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});
