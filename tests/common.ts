import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import {
	dockerBuildxBuild,
	dockerContainerRm,
	dockerContextShow,
	dockerContextUse,
	dockerImageRm,
} from "@ac-essentials/cli";
import {
	type EnvVariables,
	escapeCommandArg,
	execAsync,
	getRandomEphemeralPort,
	TcpSocket,
} from "@ac-essentials/misc-util";
import { afterAll, beforeAll, vi } from "vitest";

const srcPath = path.resolve(path.join(__dirname, "..", "src"));

// Buffers raw socket data into complete protocol lines (CRLF or LF terminated).
class LineBuffer {
	private buf = "";
	private readonly queued: string[] = [];
	private readonly waiters: Array<{
		resolve: (line: string) => void;
		reject: (err: Error) => void;
	}> = [];

	onData(chunk: Buffer): void {
		this.buf += chunk.toString("utf8");
		let i: number;
		while ((i = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, i).replace(/\r$/, "");
			this.buf = this.buf.slice(i + 1);
			const waiter = this.waiters.shift();
			if (waiter) {
				waiter.resolve(line);
			} else {
				this.queued.push(line);
			}
		}
	}

	// Rejects all pending nextLine() calls — call when the underlying connection closes.
	onEnd(err = new Error("Connection closed")): void {
		for (const waiter of this.waiters.splice(0)) {
			waiter.reject(err);
		}
	}

	nextLine(): Promise<string> {
		if (this.queued.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: test
			return Promise.resolve(this.queued.shift()!);
		}
		return new Promise<string>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}
}

export type ImapSession = {
	readLine(): Promise<string>;
	send(line: string): Promise<void>;
	/** Sends TAG CMD and collects all server lines up to and including the TAG response. */
	command(tag: string, cmd: string): Promise<string[]>;
	close(): Promise<void>;
};

/** Opens an IMAP session over STARTTLS (port 143). */
export async function openImapSession(port: number): Promise<ImapSession> {
	const tcp = TcpSocket.from();
	await tcp.connect(port, "127.0.0.1");

	const lb1 = new LineBuffer();
	const onTcpData = (chunk: Buffer) => lb1.onData(chunk);
	tcp.stream.on("data", onTcpData);

	const greeting = await lb1.nextLine();
	if (!greeting.startsWith("* OK")) {
		throw new Error(`Unexpected IMAP greeting: ${greeting}`);
	}

	await tcp.write(Buffer.from("T001 STARTTLS\r\n"));
	const starttlsResp = await lb1.nextLine();
	if (!starttlsResp.startsWith("T001 OK")) {
		throw new Error(`STARTTLS rejected: ${starttlsResp}`);
	}

	tcp.stream.off("data", onTcpData);

	// tls.connect() with an existing socket triggers the ClientHello immediately,
	// which is required for STARTTLS (new tls.TLSSocket() does not auto-initiate).
	const rawTls = tls.connect({ socket: tcp.stream, rejectUnauthorized: false });
	await new Promise<void>((resolve, reject) => {
		rawTls.once("secureConnect", resolve);
		rawTls.once("error", reject);
	});

	const lb2 = new LineBuffer();
	rawTls.on("data", (chunk: Buffer) => lb2.onData(chunk));
	rawTls.once("close", () => lb2.onEnd());
	rawTls.once("error", (err: Error) => lb2.onEnd(err));

	const tlsWrite = (line: string): Promise<void> =>
		new Promise((resolve, reject) => {
			rawTls.write(`${line}\r\n`, (err) => (err ? reject(err) : resolve()));
		});

	async function command(tag: string, cmd: string): Promise<string[]> {
		await tlsWrite(`${tag} ${cmd}`);
		const lines: string[] = [];
		// biome-ignore lint/suspicious/noUnnecessaryConditions: false positive
		while (true) {
			const line = await lb2.nextLine();
			lines.push(line);
			if (line.startsWith(`${tag} `)) {
				return lines;
			}
		}
	}

	return {
		readLine: () => lb2.nextLine(),
		send: tlsWrite,
		command,
		close: () => new Promise((resolve) => rawTls.end(resolve)),
	};
}

export type TestUserSpec = {
	local: string;
	domain: string;
	/** Store as '{PLAIN}password' for tests; scheme prefix overrides default_password_scheme. */
	password: string;
	enabled?: boolean;
	sendonly?: boolean;
	quotaBytes?: number;
};

export type LmtpResult = { rcptResponse: string; dataResponse: string };

/** Delivers a single message via LMTP. Returns the RCPT TO and DATA responses. */
export async function deliverMessage(
	lmtpPort: number,
	opts: { from: string; to: string; message: string },
): Promise<LmtpResult> {
	const tcp = TcpSocket.from();
	await tcp.connect(lmtpPort, "127.0.0.1");

	const lb = new LineBuffer();
	tcp.stream.on("data", (chunk: Buffer) => lb.onData(chunk));

	const greeting = await lb.nextLine();
	if (!greeting.startsWith("220")) {
		throw new Error(`Unexpected LMTP greeting: ${greeting}`);
	}

	await tcp.write(Buffer.from("LHLO test.local\r\n"));
	let lhloLine: string;
	do {
		lhloLine = await lb.nextLine();
	} while (lhloLine.startsWith("250-"));

	await tcp.write(Buffer.from(`MAIL FROM:<${opts.from}>\r\n`));
	await lb.nextLine();

	await tcp.write(Buffer.from(`RCPT TO:<${opts.to}>\r\n`));
	const rcptResponse = await lb.nextLine();

	if (!rcptResponse.startsWith("2")) {
		await tcp.write(Buffer.from("QUIT\r\n"));
		await tcp.end();
		return { rcptResponse, dataResponse: "" };
	}

	await tcp.write(Buffer.from("DATA\r\n"));
	await lb.nextLine();

	await tcp.write(Buffer.from(`${opts.message}\r\n.\r\n`));
	const dataResponse = await lb.nextLine();

	await tcp.write(Buffer.from("QUIT\r\n"));
	await tcp.end();

	return { rcptResponse, dataResponse };
}

export const docker = (cmd: string) =>
	execAsync(`docker --context default ${cmd}`, { encoding: "utf-8" });

const DB_NAME = "mail";
const DB_USER = "dovecot";
const DB_PASSWORD = "dovecot";

// Minimal DDL matching dovecot-sql.conf.ext.j2 queries:
//   passdb: SELECT email AS user, password FROM mail_users WHERE local=... AND domain=... AND enabled=true
//   userdb: SELECT CONCAT(quota_bytes,'M') AS quota_storage_size, ... FROM mail_users WHERE ...
//   iterate: SELECT local AS username, domain FROM mail_users
const INIT_SQL = `
CREATE TABLE mail_users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  local VARCHAR(255) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  email VARCHAR(510) GENERATED ALWAYS AS (CONCAT(local, '@', domain)) STORED,
  password VARCHAR(255) NOT NULL DEFAULT '',
  sendonly TINYINT(1) NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  quota_bytes INT NOT NULL DEFAULT 1024
);
`;

// Feed SQL via stdin to a container's mariadb CLI.
function feedSqlToMariadb(containerName: string, sql: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const proc = spawn("docker", [
			"--context",
			"default",
			"exec",
			"-i",
			containerName,
			"mariadb",
			"-u",
			"root",
			"-proot",
			DB_NAME,
		]);

		proc.stdin.write(sql);
		proc.stdin.end();

		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`mariadb exited with code ${code}`));
			}
		});

		proc.on("error", reject);
	});
}

type StartContainerOptions = {
	env?: EnvVariables;
};

export function initSuite() {
	let initialContext: string;
	const suffix = randomBytes(8).toString("hex");
	const containerName = `test-dovecot-${suffix}`;
	const containerImageName = `${containerName}-img`;
	const mariadbName = `test-dovecot-db-${suffix}`;
	const networkName = `test-dovecot-net-${suffix}`;
	let tlsCertDir: string;

	async function stopContainer() {
		try {
			await dockerContainerRm([containerName], { force: true });
		} catch (_) {}
	}

	async function stopMariadb() {
		try {
			await docker(`stop ${mariadbName}`);
		} catch (_) {}
		try {
			await docker(`rm -f ${mariadbName}`);
		} catch (_) {}
	}

	async function removeNetwork() {
		try {
			await docker(`network rm ${networkName}`);
		} catch (_) {}
	}

	beforeAll(async () => {
		initialContext = await dockerContextShow();
		await dockerContextUse("default");

		// Clean up any leftover containers/network from a previous interrupted run.
		await stopContainer();
		await stopMariadb();
		try {
			await dockerImageRm([containerImageName], { force: true });
		} catch (_) {}
		await removeNetwork();

		// Dovecot requires ssl = required, so generate a self-signed cert.
		tlsCertDir = await mkdtemp(path.join(os.tmpdir(), "dovecot-tls-"));
		await execAsync(
			`openssl req -x509 -newkey rsa:2048 -keyout ${tlsCertDir}/key.pem -out ${tlsCertDir}/fullchain.pem -days 1 -nodes -subj '/CN=dovecot-test'`,
			{ encoding: "utf-8" },
		);

		// Create an isolated Docker network so dovecot can reach mariadb by name.
		// Dovecot 2.4 MySQL block syntax only accepts a plain hostname, not host:port.
		await docker(`network create ${networkName}`);

		await docker(
			`run -d --name ${mariadbName} --network ${networkName}` +
				` -e MARIADB_DATABASE=${DB_NAME}` +
				` -e MARIADB_USER=${DB_USER}` +
				` -e MARIADB_PASSWORD=${DB_PASSWORD}` +
				` -e MARIADB_ROOT_PASSWORD=root` +
				` -e MARIADB_INITDB_SKIP_TZINFO=1` +
				" mariadb:11",
		);

		// Wait until the `mail` database is reachable, not just the server.
		// MARIADB_DATABASE initialization runs after server startup, so
		// mariadb-admin ping can succeed while the database is not yet created.
		await vi.waitUntil(
			() =>
				docker(
					`exec ${mariadbName} mariadb -u root -proot ${DB_NAME} -e "SELECT 1"`,
				).then(
					() => true,
					() => false,
				),
			{ timeout: 60_000, interval: 1000 },
		);

		await feedSqlToMariadb(mariadbName, INIT_SQL);

		await dockerBuildxBuild(srcPath, { tags: [containerImageName] });
	});

	afterAll(async () => {
		await stopContainer();
		try {
			await dockerImageRm([containerImageName], { force: true });
		} catch (_) {}
		await stopMariadb();
		await removeNetwork();
		try {
			await dockerContextUse(initialContext);
		} catch (_) {}
	});

	return {
		createUser: async (user: TestUserSpec) => {
			const {
				local,
				domain,
				password,
				enabled = true,
				sendonly = false,
				quotaBytes = 1024,
			} = user;
			await feedSqlToMariadb(
				mariadbName,
				`INSERT INTO mail_users (local, domain, password, enabled, sendonly, quota_bytes) VALUES ('${local}', '${domain}', '${password}', ${enabled ? 1 : 0}, ${sendonly ? 1 : 0}, ${quotaBytes});`,
			);
		},
		startContainer: async (options?: StartContainerOptions) => {
			// Retry on port-already-in-use: the host OS may not release TIME_WAIT ports
			// instantly after a previous container stops.
			for (let attempt = 0; ; attempt++) {
				const imapPort = getRandomEphemeralPort();
				const healthPort = getRandomEphemeralPort();
				const lmtpPort = getRandomEphemeralPort();
				const pop3Port = getRandomEphemeralPort();
				const managesievePort = getRandomEphemeralPort();

				const baseEnv: EnvVariables = {
					DOVECOT_MYSQL_HOST: mariadbName,
					DOVECOT_MYSQL_USER: DB_USER,
					DOVECOT_MYSQL_PASSWORD: DB_PASSWORD,
					DOVECOT_MYSQL_DATABASE: DB_NAME,
					DOVECOT_ADMIN_EMAIL: "admin@example.com",
					DOVECOT_POSTMASTER_EMAIL: "postmaster@example.com",
				};

				const env = { ...baseEnv, ...options?.env };
				const envArgs = Object.entries(env)
					.map(([k, v]) => `-e ${escapeCommandArg(`${k}=${v}`)}`)
					.join(" ");

				try {
					await docker(
						`run -d --name ${containerName}` +
							` --network ${networkName}` +
							` -v '${tlsCertDir}:/etc/dovecot/tls:ro,z'` +
							` -p ${imapPort}:143` +
							` -p ${healthPort}:5001` +
							` -p ${lmtpPort}:24` +
							` -p ${pop3Port}:110` +
							` -p ${managesievePort}:4190` +
							` ${envArgs}` +
							` ${containerImageName}`,
					);
				} catch (err) {
					// Port already in use: remove the (partially created) container and retry.
					if (
						attempt < 3 &&
						String((err as { stderr?: string }).stderr).includes(
							"address already in use",
						)
					) {
						await stopContainer();
						continue;
					}
					throw err;
				}

				// Wait until IMAP is ready to send the greeting banner.
				await vi.waitUntil(
					async () => {
						const client = TcpSocket.from();
						try {
							await client.connect(imapPort, "127.0.0.1");
							client.timeout = 1000;
							return await new Promise<boolean>((resolve) => {
								let received = "";
								let done = false;
								client.stream.on("data", (chunk) => {
									received += chunk.toString();
									if (!done && received.includes("* OK")) {
										done = true;
										void client.end();
										resolve(true);
									}
								});
								client.subscribe("timeout", () => {
									if (!done) {
										done = true;
										void client.end();
										resolve(false);
									}
								});
								client.subscribe("error", () => {
									if (!done) {
										done = true;
										resolve(false);
									}
								});
								client.subscribe("close", () => {
									if (!done) {
										done = true;
										resolve(false);
									}
								});
							});
						} catch {
							return false;
						}
					},
					{ timeout: 30_000, interval: 1000 },
				);

				return { imapPort, healthPort, lmtpPort, pop3Port, managesievePort };
			}
		},
	};
}
