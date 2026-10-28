const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
	emptyState,
	requestCreation,
	requestConfiguration,
	requestAction,
	publicConfiguration,
} = require("../dist/domain");
const admin = { id: "admin", role: "GLOBAL_ADMIN" };
function fixture() {
	const s = emptyState();
	const op = requestCreation(
		s,
		admin.id,
		admin.role,
		"creation_request_001",
		{
			slug: "sample",
			displayName: "Sample",
			ownerEmail: "owner@example.test",
			locale: "en",
			currency: "EUR",
			priceDisplay: "gross",
			template: "general-store-real-v1",
			seedMode: "empty",
			branding: {
				accent: "#c8ff5f",
				background: "#101112",
				surface: "#1a1d20",
			},
		},
		"release1",
		4
	);
	op.status = "succeeded";
	const p = s.platforms[0];
	p.provisionedAt = new Date().toISOString();
	return { s, p };
}
test("configuration publishes a revision without mutating current settings or provisioning identity", () => {
	const { s, p } = fixture(),
		original = structuredClone(p);
	p.desired = "stopped";
	const patch = {
		expectedRevision: 1,
		displayName: "New name",
		experience: {
			heroTitle: "Hello",
			fontFamily: "serif",
			showEditorial: false,
		},
	};
	const op = requestConfiguration(s, admin, "configuration_001", p.id, patch);
	assert.equal(p.manifest.displayName, original.manifest.displayName);
	assert.equal(p.desired, "stopped");
	assert.equal(op.configuration.revision, 2);
	assert.equal(
		op.configuration.manifest.ownerEmail,
		original.manifest.ownerEmail
	);
	assert.equal(op.configuration.manifest.seedMode, "empty");
	assert.equal(op.configuration.manifest.experience.showFeatured, true);
	assert.equal(
		requestConfiguration(s, admin, "configuration_001", p.id, patch),
		op
	);
	assert.throws(
		() => requestConfiguration(s, admin, "configuration_002", p.id, patch),
		/OPERATION_IN_PROGRESS/
	);
	// Simulate worker application, then a later edit to a field omitted by this patch.
	op.status = "succeeded";
	p.manifest = { ...op.configuration.manifest, locale: "de" };
	p.revision = 3;
	assert.equal(
		requestConfiguration(s, admin, "configuration_001", p.id, patch),
		op
	);
	assert.throws(
		() => requestConfiguration(s, admin, "configuration_003", p.id, patch),
		/REVISION_CONFLICT/
	);
	assert.equal(
		publicConfiguration({ ...p, ...op.configuration }).experience.heroTitle,
		"Hello"
	);
});
test("configuration rejects cross-owner access, infrastructure changes and unsafe public content", () => {
	const { s, p } = fixture();
	const write = (body, actor = admin) =>
		requestConfiguration(s, actor, "configuration_001", p.id, body);
	assert.throws(
		() =>
			write(
				{ expectedRevision: 1, displayName: "New" },
				{ id: "other", role: "PLATFORM_CREATOR" }
			),
		/PLATFORM_NOT_FOUND/
	);
	assert.throws(
		() =>
			write({ expectedRevision: 1 }, { id: "admin", role: "GLOBAL_OPERATOR" }),
		/FORBIDDEN/
	);
	for (const patch of [
		{ slug: "renamed" },
		{ ownerEmail: "other@example.test" },
		{ schema: "SYSTEM" },
		{ experience: { logoUrl: "http://example.test/logo.png" } },
		{ experience: { heroTitle: "<script>" } },
		{ experience: { showFeatured: "false" } },
		{ experience: { css: "body{}" } },
		{ experience: { fontFamily: "url(evil)" } },
	])
		assert.throws(() => write({ expectedRevision: 1, ...patch }));
	for (const value of [
		null,
		1,
		[],
		{ expectedRevision: 0 },
		{ expectedRevision: Number.MAX_SAFE_INTEGER },
	])
		assert.throws(() => write(value));
	delete p.configurationVersion;
	assert.throws(
		() => write({ expectedRevision: 1, experience: {} }),
		/RELEASE_CUSTOMIZATION_UNSUPPORTED/
	);
	assert.doesNotThrow(() => write({ expectedRevision: 1, displayName: "New" }));
});
test("failed configuration must be retried with its exact target before lifecycle operations", () => {
	const { s, p } = fixture();
	const op = requestConfiguration(s, admin, "configuration_001", p.id, {
		expectedRevision: 1,
		displayName: "New",
	});
	op.status = "failed";
	assert.throws(
		() =>
			requestConfiguration(s, admin, "configuration_002", p.id, {
				expectedRevision: 1,
				displayName: "Other",
			}),
		/RETRY_REQUIRED/
	);
	assert.throws(
		() =>
			requestAction(
				s,
				admin.id,
				admin.role,
				"operation_key_001",
				p.id,
				"start"
			),
		/RETRY_REQUIRED/
	);
	const retry = requestAction(
		s,
		admin.id,
		admin.role,
		"operation_key_002",
		p.id,
		"retry"
	);
	assert.equal(retry.action, "configure");
	assert.deepEqual(retry.configuration, op.configuration);
});

test("health failure after configuration commit permits lifecycle recovery and a corrective edit", () => {
	for (const action of ["start", "stop", "restart", "configure"]) {
		const { s, p } = fixture();
		const op = requestConfiguration(s, admin, "configuration_001", p.id, {
			expectedRevision: 1,
			displayName: "New",
		});
		Object.assign(p, op.configuration);
		op.status = "failed";
		op.step = "verify";
		op.error = "PLATFORM_NOT_READY";
		const recovery =
			action === "configure"
				? requestConfiguration(s, admin, "configuration_002", p.id, {
						expectedRevision: 2,
						displayName: "Recovered",
				  })
				: requestAction(
						s,
						admin.id,
						admin.role,
						"operation_recovery_001",
						p.id,
						action
				  );
		assert.equal(recovery.action, action);
		assert.equal(p.operationId, recovery.id);
		assert.equal(p.revision, 2);
	}
});
