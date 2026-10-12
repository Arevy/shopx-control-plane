import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export async function encodePassword(password: string) {
	const salt = randomBytes(16).toString("hex");
	const key = (await derive(password, salt, 64)) as Buffer;
	return `${salt}:${key.toString("hex")}`;
}
export async function checkPassword(password: string, encoded: string) {
	const [salt, digest] = encoded.split(":");
	const key = (await derive(password, salt, 64)) as Buffer;
	const expected = Buffer.from(digest, "hex");
	return key.length === expected.length && timingSafeEqual(key, expected);
}
