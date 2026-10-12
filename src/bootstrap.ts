import { randomUUID } from "node:crypto";
import { OracleStore, DatabaseSettings, settings } from "./store";
import { encodePassword } from "./auth";
async function main() {
	const config = settings<{
		database: DatabaseSettings;
		email: string;
		password: string;
	}>(process.env.CONTROL_BOOTSTRAP_FILE || "");
	if (
		!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email) ||
		config.password.length < 24
	)
		throw new Error("Invalid bootstrap account");
	const store = new OracleStore(config.database);
	try {
		await store.connect();
		await store.initialize();
		const encoded = await encodePassword(config.password);
		await store.transaction(
			(s) => {
				if (s.users.length) {
					if (s.users[0].email !== config.email)
						throw new Error("Existing bootstrap identity differs");
					return;
				}
				s.users.push({
					id: randomUUID(),
					email: config.email,
					password: encoded,
					role: "GLOBAL_ADMIN",
				});
			},
			{ actor: "bootstrap", event: "bootstrap" }
		);
		console.log("Control registry initialized; existing accounts preserved");
	} finally {
		await store.close();
	}
}
main().catch((error) => {
	console.error(
		"Control bootstrap failed; existing data was not reset.",
		error.code ||
			error.errorNum ||
			"Check configuration permissions and schema identity."
	);
	process.exitCode = 1;
});
