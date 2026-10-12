// One locked aggregate is deliberate for the first single-host provider.
// Jobs and desired state commit atomically; no external queue can lose a request.
import fs from "node:fs";
// @ts-ignore node-oracledb ships without TypeScript declarations in this release.
import oracle from "oracledb";
import { State, emptyState } from "./domain";
oracle.fetchAsString = [oracle.CLOB];
export const settings = <T>(file: string): T => {
	if (!file || fs.statSync(file).mode & 0o077)
		throw new Error("Private configuration must have mode 0600");
	return JSON.parse(fs.readFileSync(file, "utf8"));
};
export interface DatabaseSettings {
	user: string;
	password: string;
	connectString: string;
	pdb: string;
}
export class OracleStore {
	private pool: any;
	constructor(private config: DatabaseSettings) {}
	async connect() {
		this.pool = await oracle.createPool({
			...this.config,
			poolMin: 0,
			poolMax: 2,
			queueTimeout: 5000,
		});
		const c = await this.pool.getConnection();
		try {
			const [user, pdb] = (
				await c.execute(
					"SELECT SYS_CONTEXT('USERENV','SESSION_USER'),SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL"
				)
			).rows[0];
			if (user !== "SX_CONTROL" || pdb !== this.config.pdb)
				throw new Error("Control schema identity mismatch");
		} finally {
			await c.close();
		}
	}
	async initialize() {
		const c = await this.pool.getConnection();
		try {
			const names = (
				await c.execute("SELECT TABLE_NAME FROM USER_TABLES")
			).rows.map((r: string[]) => r[0]);
			if (names.some((n: string) => !["SX_REGISTRY", "SX_AUDIT"].includes(n)))
				throw new Error("Control schema contains unrelated tables");
			if (!names.includes("SX_REGISTRY"))
				await c.execute(
					"CREATE TABLE SX_REGISTRY (ID NUMBER PRIMARY KEY, DOCUMENT CLOB NOT NULL CHECK (DOCUMENT IS JSON))"
				);
			if (!names.includes("SX_AUDIT"))
				await c.execute(
					"CREATE TABLE SX_AUDIT (ID NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP, ACTOR VARCHAR2(100), EVENT VARCHAR2(100), TARGET VARCHAR2(100))"
				);
			if (
				!(await c.execute("SELECT ID FROM SX_REGISTRY WHERE ID=1")).rows.length
			)
				await c.execute("INSERT INTO SX_REGISTRY VALUES(1,:value)", {
					value: JSON.stringify(emptyState()),
				});
			await c.commit();
		} finally {
			await c.close();
		}
	}
	async read(): Promise<State> {
		const c = await this.pool.getConnection();
		try {
			const s = JSON.parse(
				(await c.execute("SELECT DOCUMENT FROM SX_REGISTRY WHERE ID=1"))
					.rows[0][0]
			);
			if (s.version !== 1) throw new Error("Unsupported registry version");
			return s;
		} finally {
			await c.close();
		}
	}
	async transaction<T>(
		fn: (s: State) => T,
		audit?: { actor: string; event: string; target?: string }
	): Promise<T> {
		const c = await this.pool.getConnection();
		try {
			const s: State = JSON.parse(
				(
					await c.execute(
						"SELECT DOCUMENT FROM SX_REGISTRY WHERE ID=1 FOR UPDATE WAIT 5"
					)
				).rows[0][0]
			);
			if (s.version !== 1) throw new Error("Unsupported registry version");
			const result = fn(s);
			if (result instanceof Promise)
				throw new Error("No external I/O inside registry transaction");
			await c.execute("UPDATE SX_REGISTRY SET DOCUMENT=:value WHERE ID=1", {
				value: { val: JSON.stringify(s), type: oracle.CLOB },
			});
			if (audit)
				await c.execute(
					"INSERT INTO SX_AUDIT (ACTOR,EVENT,TARGET) VALUES(:actor,:event,:target)",
					{ ...audit, target: audit.target || null }
				);
			await c.commit();
			return result;
		} catch (e) {
			await c.rollback();
			throw e;
		} finally {
			await c.close();
		}
	}
	async close() {
		await this.pool?.close(0);
	}
}
