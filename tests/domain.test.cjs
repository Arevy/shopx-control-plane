const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	emptyState,
	validateManifest,
	requestCreation,
	requestAction,
	inventory,
	authorize,
} = require("../dist/domain");
const manifest = () => ({
	slug: "northstar",
	displayName: "Northstar",
	ownerEmail: "owner@example.test",
	locale: "en",
	currency: "EUR",
	priceDisplay: "gross",
	template: "general-store-real-v1",
	branding: { accent: "#c8ff5f", background: "#101112", surface: "#1a1d20" },
});
const create = (s, key = "unique_request_0001", value = manifest()) =>
	requestCreation(s, "admin", "GLOBAL_ADMIN", key, value, "release1", 4);
test("creation is atomic and replay-safe; changed payload cannot reuse a key", () => {
	const s = emptyState(),
		first = create(s);
	assert.equal(create(s), first);
	assert.equal(s.platforms.length, 1);
	assert.equal(s.operations.length, 1);
	assert.throws(
		() =>
			create(s, "unique_request_0001", {
				...manifest(),
				displayName: "changed",
			}),
		/IDEMPOTENCY_CONFLICT/
	);
	assert.throws(() => create(s, "unique_request_0002"), /SLUG_TAKEN/);
	assert.match(s.platforms[0].schema, /^SX_P_[A-F0-9]{12}$/);
});
test("validation rejects SQL/routing escapes, arbitrary images, URLs and unsupported currency", () => {
	for (const change of [
		{ slug: "../root" },
		{ slug: "admin" },
		{ slug: "store;DROP USER X" },
		{ currency: "USD" },
		{ image: "attacker/image" },
		{ ownerEmail: "a\nb@example.test" },
		{
			branding: {
				accent: "url(http://evil)",
				background: "#101112",
				surface: "#1a1d20",
			},
		},
		{ displayName: "<script>" },
	])
		assert.throws(() => validateManifest({ ...manifest(), ...change }));
});
test("roles cannot inherit shop support privileges or create without global admin", () => {
	for (const role of [
		"SUPPORT",
		"CUSTOMER",
		"GLOBAL_VIEWER",
		"GLOBAL_OPERATOR",
	])
		assert.throws(
			() =>
				requestCreation(
					emptyState(),
					"x",
					role,
					"unique_request_0001",
					manifest(),
					"v1",
					4
				),
			/FORBIDDEN/
		);
	assert.doesNotThrow(() => authorize("GLOBAL_OPERATOR", "restart"));
	assert.throws(() => authorize("GLOBAL_VIEWER", "stop"), /FORBIDDEN/);
});
test("capacity reserves queued/failed/stopped platforms and never reuses their ports", () => {
	const s = emptyState();
	for (let i = 0; i < 4; i++)
		create(s, "unique_request_000" + i, { ...manifest(), slug: "store-" + i });
	s.platforms[0].desired = "stopped";
	assert.throws(
		() =>
			create(s, "unique_request_9999", { ...manifest(), slug: "fifth-store" }),
		/CAPACITY_LIMIT/
	);
	assert.deepEqual(
		s.platforms.map((p) => p.port),
		[9200, 9201, 9202, 9203]
	);
	assert.equal(
		create(s, "unique_request_0000", { ...manifest(), slug: "store-0" }),
		s.operations[0]
	);
});
test("conflicting operations serialize; retry preserves failed intent and retains records", () => {
	const s = emptyState(),
		op = create(s),
		id = op.platformId;
	assert.throws(
		() =>
			requestAction(
				s,
				"admin",
				"GLOBAL_ADMIN",
				"operation_key_0001",
				id,
				"stop"
			),
		/OPERATION_IN_PROGRESS/
	);
	op.status = "failed";
	const retry = requestAction(
		s,
		"admin",
		"GLOBAL_ADMIN",
		"operation_key_0002",
		id,
		"retry"
	);
	assert.equal(retry.action, "create");
	assert.equal(s.platforms.length, 1);
	retry.status = "succeeded";
	s.platforms[0].provisionedAt = new Date().toISOString();
	const stop = requestAction(
		s,
		"op",
		"GLOBAL_OPERATOR",
		"operation_key_0003",
		id,
		"stop"
	);
	assert.equal(s.platforms[0].desired, "stopped");
	stop.status = "failed";
	assert.equal(
		requestAction(s, "admin", "GLOBAL_ADMIN", "operation_key_0004", id, "retry")
			.action,
		"stop"
	);
	assert.throws(
		() =>
			requestAction(
				s,
				"admin",
				"GLOBAL_ADMIN",
				"operation_key_0005",
				id,
				"purge"
			),
		/UNSUPPORTED_ACTION/
	);
});
test("online counts expire when worker observations become stale", () => {
	const s = emptyState();
	create(s);
	s.platforms[0].observed = "ready";
	s.platforms[0].checkedAt = new Date(1000).toISOString();
	assert.equal(inventory(s, 2000).counts.online, 1);
	assert.equal(inventory(s, 100000).counts.online, 0);
	assert.equal(inventory(s, 100000).platforms[0].observed, "unknown");
});
test("only a failed initial deployment can explicitly adopt the current approved release", () => {
	const s = emptyState(),
		op = create(s);
	op.status = "failed";
	requestAction(
		s,
		"admin",
		"GLOBAL_ADMIN",
		"rebase_request_0001",
		op.platformId,
		"rebase",
		"release2"
	);
	assert.equal(s.platforms[0].release, "release2");
	assert.equal(s.operations[1].action, "create");
	s.operations[1].status = "failed";
	s.platforms[0].provisionedAt = new Date().toISOString();
	assert.throws(
		() =>
			requestAction(
				s,
				"admin",
				"GLOBAL_ADMIN",
				"rebase_request_0002",
				op.platformId,
				"rebase",
				"release3"
			),
		/RELEASE_REPLACEMENT_NOT_ALLOWED/
	);
});
