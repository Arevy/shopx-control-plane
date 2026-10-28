import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Experience, validateExperience } from "./customization";

export class Problem extends Error {
	constructor(public status: number, public code: string) {
		super(code);
	}
}
export const fail = (status: number, code: string): never => {
	throw new Problem(status, code);
};
export const hash = (text: string) =>
	createHash("sha256").update(text).digest("hex");
export type Role =
	| "GLOBAL_ADMIN"
	| "GLOBAL_OPERATOR"
	| "GLOBAL_VIEWER"
	| "PLATFORM_CREATOR";
export interface Account {
	id: string;
	email: string;
	password: string;
	role: Role;
	name?: string;
	disabled?: boolean;
	google?: { subject: string; email: string };
}
export interface Invitation {
	id: string;
	email: string;
	role: Exclude<Role, "GLOBAL_ADMIN">;
	hash: string;
	expires: number;
	createdBy: string;
	usedAt?: number;
	revokedAt?: number;
}
export type Action =
	| "create"
	| "start"
	| "stop"
	| "restart"
	| "retry"
	| "configure";
export interface Manifest {
	slug: string;
	displayName: string;
	ownerEmail: string;
	locale: string;
	currency: "EUR";
	priceDisplay: "gross";
	template: "general-store-real-v1";
	seedMode?: "demo" | "empty";
	branding: { accent: string; background: string; surface: string };
	experience?: Experience;
}
export interface Platform {
	id: string;
	schema: string;
	manifest: Manifest;
	revision: number;
	release: string;
	desired: "running" | "stopped";
	observed: "unknown" | "ready" | "degraded" | "stopped";
	createdAt: string;
	provisionedAt?: string;
	checkedAt?: string;
	port: number;
	services?: Record<string, boolean>;
	operationId: string;
	createdBy?: string;
	configurationVersion?: 2;
}
export interface Operation {
	id: string;
	platformId: string;
	actor: string;
	key: string;
	hash: string;
	action: Action;
	status: "queued" | "running" | "succeeded" | "failed";
	step: string;
	createdAt: string;
	updatedAt: string;
	error?: string;
	configuration?: { manifest: Manifest; revision: number };
}
export interface State {
	version: 1;
	platforms: Platform[];
	operations: Operation[];
	users: Account[];
	invitations?: Invitation[];
	sessions: { hash: string; userId: string; expires: number }[];
	loginAttempts: Record<string, { count: number; until: number }>;
	googleFlows?: {
		hash: string;
		browser: string;
		nonce: string;
		verifier: string;
		expires: number;
		userId?: string;
		session?: string;
		password?: string;
	}[];
}
export const emptyState = (): State => ({
	version: 1,
	platforms: [],
	operations: [],
	users: [],
	sessions: [],
	loginAttempts: {},
});
export function validateManifest(input: unknown): Manifest {
	if (!input || typeof input !== "object" || Array.isArray(input))
		fail(400, "INVALID_MANIFEST");
	const c = input as Record<string, any>;
	if (
		Object.keys(c).some(
			(k) =>
				![
					"slug",
					"displayName",
					"ownerEmail",
					"locale",
					"branding",
					"currency",
					"priceDisplay",
					"template",
					"seedMode",
					"experience",
				].includes(k)
		)
	)
		fail(400, "UNKNOWN_MANIFEST_FIELD");
	if (c.seedMode !== undefined && !["demo", "empty"].includes(c.seedMode))
		fail(400, "INVALID_SEED_MODE");
	if (
		typeof c.slug !== "string" ||
		!/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/.test(c.slug) ||
		["admin", "api", "control", "www", "mobile", "shopx"].includes(c.slug)
	)
		fail(400, "INVALID_SLUG");
	if (
		typeof c.displayName !== "string" ||
		!c.displayName.trim() ||
		c.displayName.length > 80 ||
		/[\x00-\x1f<>]/.test(c.displayName)
	)
		fail(400, "INVALID_NAME");
	if (
		typeof c.ownerEmail !== "string" ||
		c.ownerEmail.length > 254 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.ownerEmail)
	)
		fail(400, "INVALID_EMAIL");
	if (!["en", "ro", "de", "fr", "ar", "he"].includes(c.locale))
		fail(400, "INVALID_LOCALE");
	if (
		c.currency !== "EUR" ||
		c.priceDisplay !== "gross" ||
		c.template !== "general-store-real-v1"
	)
		fail(400, "UNSUPPORTED_TEMPLATE");
	if (
		!c.branding ||
		Object.keys(c.branding).sort().join(",") !== "accent,background,surface" ||
		!Object.values(c.branding).every(
			(v) => typeof v === "string" && /^#[a-fA-F0-9]{6}$/.test(v)
		)
	)
		fail(400, "INVALID_BRANDING");
	return {
		slug: c.slug,
		displayName: c.displayName.trim(),
		ownerEmail: c.ownerEmail.toLowerCase().trim(),
		locale: c.locale,
		currency: "EUR",
		priceDisplay: "gross",
		template: "general-store-real-v1",
		...(c.seedMode === undefined ? {} : { seedMode: c.seedMode }),
		branding: {
			accent: c.branding.accent.toLowerCase(),
			background: c.branding.background.toLowerCase(),
			surface: c.branding.surface.toLowerCase(),
		},
		...(c.experience === undefined
			? {}
			: {
					experience: (() => {
						try {
							return validateExperience(c.experience);
						} catch {
							return fail(400, "INVALID_EXPERIENCE");
						}
					})(),
			  }),
	};
}
export function authorize(role: Role, action: string) {
	if (role === "GLOBAL_ADMIN") return;
	if (
		role === "GLOBAL_OPERATOR" &&
		["start", "stop", "restart"].includes(action)
	)
		return;
	if (
		role === "PLATFORM_CREATOR" &&
		["create", "start", "stop", "restart", "retry", "configure"].includes(
			action
		)
	)
		return;
	fail(403, "FORBIDDEN");
}
function replay(s: State, actor: string, key: unknown, payload: unknown) {
	if (typeof key !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(key))
		fail(400, "IDEMPOTENCY_KEY_REQUIRED");
	const fingerprint = hash(JSON.stringify(payload));
	const existing = s.operations.find(
		(op) => op.actor === actor && op.key === key
	);
	if (existing && existing.hash !== fingerprint)
		fail(409, "IDEMPOTENCY_CONFLICT");
	return { existing, fingerprint, key: key as string };
}
export function requestCreation(
	s: State,
	actor: string,
	role: Role,
	key: unknown,
	input: unknown,
	release: string,
	capacity: number,
	firstPort = 9200
) {
	authorize(role, "create");
	const manifest = validateManifest(input);
	const {
		existing,
		fingerprint,
		key: validKey,
	} = replay(s, actor, key, { action: "create", manifest });
	if (existing) return existing;
	if (s.platforms.some((p) => p.manifest.slug === manifest.slug))
		fail(409, "SLUG_TAKEN");
	if (s.platforms.length >= capacity) fail(409, "CAPACITY_LIMIT");
	const suffix = randomBytes(6).toString("hex"),
		now = new Date().toISOString();
	const op: Operation = {
		id: randomUUID(),
		platformId: "sx_" + suffix,
		actor,
		key: validKey,
		hash: fingerprint,
		action: "create",
		status: "queued",
		step: "queued",
		createdAt: now,
		updatedAt: now,
	};
	s.platforms.push({
		id: op.platformId,
		schema: "SX_P_" + suffix.toUpperCase(),
		manifest,
		revision: 1,
		release,
		desired: "running",
		observed: "unknown",
		createdAt: now,
		createdBy: actor,
		configurationVersion: 2,
		operationId: op.id,
		port: firstPort + s.platforms.length,
	});
	s.operations.push(op);
	return op;
}
export function configurationApplied(p: Platform, op: Operation) {
	return Boolean(
		op.configuration &&
			p.revision === op.configuration.revision &&
			JSON.stringify(p.manifest) === JSON.stringify(op.configuration.manifest)
	);
}
export function requestAction(
	s: State,
	actor: string,
	role: Role,
	key: unknown,
	id: string,
	action: unknown,
	currentRelease?: string
) {
	if (!["start", "stop", "restart", "retry", "rebase"].includes(String(action)))
		fail(400, "UNSUPPORTED_ACTION");
	authorize(role, String(action));
	const {
		existing,
		fingerprint,
		key: validKey,
	} = replay(s, actor, key, { id, action });
	if (existing) return existing;
	const platform = s.platforms.find((p) => p.id === id);
	if (!platform) return fail(404, "PLATFORM_NOT_FOUND");
	if (role === "PLATFORM_CREATOR" && platform.createdBy !== actor)
		fail(404, "PLATFORM_NOT_FOUND");
	const last = s.operations.find((o) => o.id === platform.operationId);
	if (
		last?.action === "configure" &&
		last.status === "failed" &&
		!configurationApplied(platform, last) &&
		action !== "retry"
	)
		fail(409, "CONFIGURATION_RETRY_REQUIRED");
	if (
		s.operations.some(
			(o) => o.platformId === id && ["queued", "running"].includes(o.status)
		)
	)
		fail(409, "OPERATION_IN_PROGRESS");
	if (
		["retry", "rebase"].includes(String(action)) &&
		s.operations.find((o) => o.id === platform.operationId)?.status !== "failed"
	)
		fail(409, "NOT_FAILED");
	if (
		!platform.provisionedAt &&
		!["retry", "stop", "rebase"].includes(String(action))
	)
		fail(409, "NOT_PROVISIONED");
	if (action === "rebase" && (platform.provisionedAt || !currentRelease))
		fail(409, "RELEASE_REPLACEMENT_NOT_ALLOWED");
	const now = new Date().toISOString();
	const op: Operation = {
		id: randomUUID(),
		platformId: id,
		actor,
		key: validKey,
		hash: fingerprint,
		action: action as Action,
		status: "queued",
		step: "queued",
		createdAt: now,
		updatedAt: now,
	};
	if (action === "retry") {
		const failed = s.operations.find((o) => o.id === platform.operationId)!;
		op.action = failed.action; // Replay the failed intent, never infer a different one.
		op.configuration = failed.configuration;
	}
	if (action === "rebase") {
		platform.release = currentRelease!;
		op.action = "create";
	}
	if (op.action !== "configure")
		platform.desired = op.action === "stop" ? "stopped" : "running";
	platform.operationId = op.id;
	s.operations.push(op);
	return op;
}
export const publicConfiguration = (p: Platform) => ({
	platformId: p.id,
	revision: p.revision,
	displayName: p.manifest.displayName,
	locale: p.manifest.locale,
	currency: p.manifest.currency,
	priceDisplay: p.manifest.priceDisplay,
	branding: p.manifest.branding,
	...(p.manifest.experience ? { experience: p.manifest.experience } : {}),
});

export function requestConfiguration(
	s: State,
	actor: Account,
	key: unknown,
	id: string,
	input: unknown
) {
	authorize(actor.role, "configure");
	const p = s.platforms.find((v) => v.id === id && canReadPlatform(actor, v));
	if (!p) return fail(404, "PLATFORM_NOT_FOUND");
	const body = input as Record<string, unknown>;
	if (
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		Object.keys(body).some(
			(k) =>
				![
					"expectedRevision",
					"displayName",
					"locale",
					"branding",
					"experience",
				].includes(k)
		)
	)
		fail(400, "INVALID_CONFIGURATION_PATCH");
	if (
		!Number.isSafeInteger(body.expectedRevision) ||
		(body.expectedRevision as number) < 1 ||
		(body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER
	)
		fail(400, "EXPECTED_REVISION_REQUIRED");
	if (body.experience !== undefined && p.configurationVersion !== 2)
		fail(409, "RELEASE_CUSTOMIZATION_UNSUPPORTED");
	const { expectedRevision, ...changes } = body;
	const manifest = validateManifest({ ...p.manifest, ...changes });
	// Fingerprint only explicitly supplied fields: later edits must not change a replay.
	const patch = Object.fromEntries(
		(["displayName", "locale", "branding", "experience"] as const)
			.filter((k) => Object.hasOwn(changes, k))
			.map((k) => [k, manifest[k]])
	);
	const {
		existing,
		fingerprint,
		key: validKey,
	} = replay(s, actor.id, key, {
		id,
		action: "configure",
		expectedRevision,
		patch,
	});
	if (existing) return existing;
	if (!p.provisionedAt) fail(409, "NOT_PROVISIONED");
	if (p.revision !== expectedRevision)
		fail(409, "CONFIGURATION_REVISION_CONFLICT");
	if (
		s.operations.some(
			(o) => o.platformId === id && ["queued", "running"].includes(o.status)
		)
	)
		fail(409, "OPERATION_IN_PROGRESS");
	const previous = s.operations.find((o) => o.id === p.operationId);
	if (
		previous?.status === "failed" &&
		previous.action === "configure" &&
		!configurationApplied(p, previous)
	)
		fail(409, "CONFIGURATION_RETRY_REQUIRED");
	if (JSON.stringify(manifest) === JSON.stringify(p.manifest))
		fail(409, "CONFIGURATION_UNCHANGED");
	const now = new Date().toISOString();
	const op: Operation = {
		id: randomUUID(),
		platformId: id,
		actor: actor.id,
		key: validKey,
		hash: fingerprint,
		action: "configure",
		configuration: { manifest, revision: p.revision + 1 },
		status: "queued",
		step: "queued",
		createdAt: now,
		updatedAt: now,
	};
	p.operationId = op.id;
	s.operations.push(op);
	return op;
}
export const canReadPlatform = (account: Account, p: Platform) =>
	account.role !== "PLATFORM_CREATOR" || p.createdBy === account.id;
export function inventory(s: State, now = Date.now(), account?: Account) {
	const platforms = s.platforms
		.filter((p) => !account || canReadPlatform(account, p))
		.map((p) => ({
			...p,
			observed:
				!p.checkedAt || now - Date.parse(p.checkedAt) > 90000
					? "unknown"
					: p.observed,
			operation: s.operations.find((o) => o.id === p.operationId),
		}));
	return {
		platforms,
		counts: {
			registered: platforms.length,
			provisioned: platforms.filter((p) => p.provisionedAt).length,
			online: platforms.filter((p) => p.observed === "ready").length,
		},
	};
}
