import { randomUUID } from "node:crypto";
import { Account, State, Role, fail, hash, authorize } from "./domain";

export function emailAddress(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 254 ||
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
	)
		return fail(400, "INVALID_EMAIL");
	return value.trim().toLowerCase();
}
export function passwordPolicy(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length < 15 ||
		value.length > 128 ||
		!value.trim()
	)
		fail(400, "PASSWORD_LENGTH_15_TO_128");
}
export function consumeAttempt(
	s: State,
	key: string,
	limit = 10,
	now = Date.now()
) {
	for (const [k, v] of Object.entries(s.loginAttempts))
		if (v.until < now) delete s.loginAttempts[k];
	const entry = s.loginAttempts[key] || {
		count: 0,
		until: now + 15 * 60 * 1000,
	};
	if (entry.count >= limit || Object.keys(s.loginAttempts).length >= 1000)
		fail(429, "TRY_LATER");
	entry.count++;
	s.loginAttempts[key] = entry;
}
export function invite(
	s: State,
	actor: Account,
	input: unknown,
	token: string,
	now = Date.now()
) {
	authorize(actor.role, "invite");
	const body = input as { email?: unknown; role?: Role };
	const email = emailAddress(body?.email),
		role = body?.role;
	if (
		!role ||
		!["PLATFORM_CREATOR", "GLOBAL_OPERATOR", "GLOBAL_VIEWER"].includes(role)
	)
		fail(400, "INVALID_INVITATION_ROLE");
	if (s.users.some((u) => u.email === email)) fail(409, "ACCOUNT_EXISTS");
	s.invitations ||= [];
	s.invitations = s.invitations.filter(
		(v) => v.expires > now && !v.usedAt && !v.revokedAt
	);
	if (s.users.length >= 100 || s.invitations.length >= 100)
		fail(409, "ACCOUNT_CAPACITY");
	// Replacement invalidates the previous link for this email.
	s.invitations = s.invitations.filter((v) => v.email !== email);
	const invitation = {
		id: randomUUID(),
		email,
		role: role as Exclude<Role, "GLOBAL_ADMIN">,
		hash: hash(token),
		expires: now + 24 * 60 * 60 * 1000,
		createdBy: actor.id,
	};
	s.invitations.push(invitation);
	return invitation;
}
export function acceptInvitation(
	s: State,
	token: string,
	email: string,
	name: string,
	encoded: string,
	now = Date.now()
) {
	const invitation = s.invitations?.find(
		(v) =>
			v.hash === hash(token) &&
			v.email === email &&
			!v.usedAt &&
			!v.revokedAt &&
			v.expires > now
	);
	const inviter = s.users.find(
		(u) =>
			u.id === invitation?.createdBy && !u.disabled && u.role === "GLOBAL_ADMIN"
	);
	if (!invitation || !inviter)
		return fail(400, "INVITATION_INVALID_OR_EXPIRED");
	if (s.users.some((u) => u.email === email) || s.users.length >= 100)
		fail(409, "ACCOUNT_UNAVAILABLE");
	if (!name.trim() || name.length > 80 || /[\x00-\x1f<>]/.test(name))
		fail(400, "INVALID_NAME");
	const account: Account = {
		id: randomUUID(),
		email,
		name: name.trim(),
		password: encoded,
		role: invitation.role,
	};
	invitation.usedAt = now;
	s.users.push(account);
	return account;
}
export const publicAccount = (u: Account) => ({
	id: u.id,
	email: u.email,
	name: u.name || "",
	role: u.role,
	disabled: Boolean(u.disabled),
	googleConnected: Boolean(u.google),
});
