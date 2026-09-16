import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	dockerContainerExec,
	dockerContainerRm,
	dockerContainerRun,
	type DockerContainerRunOptions,
	dockerContainerStop,
	dockerNetworkCreate,
	dockerNetworkRm,
} from "@ac-kit/cmd-docker";
import { getRandomEphemeralPort } from "@ac-kit/core";
import type { EnvVariables } from "@ac-kit/format-shell";
import { initDockerSuite } from "@ac-kit/integration-test-util";
import { ImapClient } from "@ac-kit/net-imap";
import { LmtpClient, type SmtpResponse } from "@ac-kit/net-smtp";
import { DuplexTransport } from "@ac-kit/net-transport-node";
import { execAsync, TcpSocket, TlsSocket } from "@ac-kit/node";
import { beforeAll, vi } from "vitest";

const srcPath = path.resolve(path.join(__dirname, "..", "src"));

export type ImapSession = {
	/**
	 * Sends TAG CMD and collects all server lines up to and including the TAG
	 * response.
	 */
	command(tag: string, cmd: string): Promise<string[]>;
	close(): Promise<void>;
};

function formatSmtpResponse(response: SmtpResponse): string {
	return `${response.code} ${response.lines.join(" ")}`;
}

/** Opens an IMAP session over STARTTLS (port 143). */
export async function openImapSession(port: number): Promise<ImapSession> {
	const tcp = TcpSocket.from();
	const client = new ImapClient(new DuplexTransport(tcp.stream), {
		defaultTimeoutMs: 30_000,
	});
	const greeting = client.wait("push");
	await tcp.connect(port, { host: "127.0.0.1" });
	const [greetingLine] = await greeting;
	if (!greetingLine.startsWith("* OK")) {
		throw new Error(`Unexpected IMAP greeting: ${greetingLine}`);
	}

	const starttlsResp = await client.command("T001", "STARTTLS");
	if (starttlsResp.status !== "OK") {
		throw new Error(
			`STARTTLS rejected: ${starttlsResp.status} ${starttlsResp.text}`,
		);
	}

	const tlsSocket = await TlsSocket.connect(tcp.stream, {
		rejectUnauthorized: false,
	});
	client.upgradeTransport(new DuplexTransport(tlsSocket.stream));
	let usable = true;
	tlsSocket.subscribe("close", () => {
		usable = false;
	});

	return {
		command: async (tag: string, cmd: string) => {
			try {
				const response = await client.command(tag, cmd);
				return [
					...response.untagged,
					`${tag} ${response.status} ${response.text}`,
				];
			} catch (error) {
				usable = false;
				throw error;
			}
		},
		close: async () => {
			if (usable && !tlsSocket.closed && !tlsSocket.destroyed) {
				await client.logout();
			}
			tlsSocket.destroy();
		},
	};
}

export type TestUserSpec = {
	local: string;
	domain: string;
	/**
	 * Store as '{PLAIN}password' for tests; scheme prefix overrides
	 * default_password_scheme.
	 */
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
	const client = new LmtpClient(new DuplexTransport(tcp.stream), {
		defaultTimeoutMs: 5000,
	});
	const greeting = client.wait("push");
	await tcp.connect(lmtpPort, { host: "127.0.0.1" });
	const [greetingResponse] = await greeting;
	if (greetingResponse.code !== 220) {
		throw new Error(
			`Unexpected LMTP greeting: ${formatSmtpResponse(greetingResponse)}`,
		);
	}

	await client.lhlo("test.local");
	await client.mailFrom(opts.from);
	const rcptResponse = await client.rcptTo(opts.to);

	if (rcptResponse.code < 200 || rcptResponse.code >= 300) {
		if (!tcp.closed && !tcp.destroyed) {
			await client.quit();
		}
		if (!tcp.closed && !tcp.destroyed) {
			await tcp.end();
		}
		return { rcptResponse: formatSmtpResponse(rcptResponse), dataResponse: "" };
	}

	const [dataResponse] = await client.dataMulti(opts.message, 1);

	if (!tcp.closed && !tcp.destroyed) {
		await client.quit();
	}
	if (!tcp.closed && !tcp.destroyed) {
		await tcp.end();
	}

	return {
		rcptResponse: formatSmtpResponse(rcptResponse),
		dataResponse: formatSmtpResponse(dataResponse!),
	};
}

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

async function feedSqlToMariadb(
	containerName: string,
	sql: string,
): Promise<void> {
	await dockerContainerExec(containerName, "mariadb", {
		commandArgs: ["-u", "root", "-proot", DB_NAME, "-e", sql],
	});
}

/** Waits for the IMAP port to send its greeting banner. */
async function isImapReady(port: number): Promise<boolean> {
	const client = TcpSocket.from();
	try {
		await client.connect(port, { host: "127.0.0.1" });
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
}

type ContainerRunOptions = Omit<
	DockerContainerRunOptions,
	"name" | "context" | "detach"
>;

export function initSuite() {
	const suffix = randomBytes(8).toString("hex");
	const mariadbName = `test-dovecot-db-${suffix}`;
	const networkName = `test-dovecot-net-${suffix}`;
	let tlsCertDir: string;

	let pendingRunOptions: ContainerRunOptions = {};
	let pendingWaitReady: () => Promise<void> = async () => {};

	const { containerImageName } = initDockerSuite(srcPath, {
		containerNamePrefix: `test-dovecot-${suffix}-`,
		reuseContainerInstance: true,
		containerRunOptions: () => pendingRunOptions,
		onContainerStarted: () => pendingWaitReady(),
		onContainerStopped: async () => {
			// Runs right after the suite's own container is gone, so the network
			// removal below never races its still-attached endpoint. Every step
			// runs even when an earlier one throws, or a container that refuses to
			// die would strand the network for the rest of the suite.
			const failures: unknown[] = [];

			for (const step of [
				() => dockerContainerStop([mariadbName]),
				() => dockerContainerRm([mariadbName], { force: true }),
				() => dockerNetworkRm([networkName]),
			]) {
				try {
					await step();
				} catch (error) {
					failures.push(error);
				}
			}

			if (failures.length === 1) {
				throw failures[0];
			}
			if (failures.length > 1) {
				throw new AggregateError(failures, "dovecot suite cleanup failed");
			}
		},
	});

	beforeAll(async () => {
		// Dovecot requires ssl = required, so generate a self-signed cert.
		tlsCertDir = await mkdtemp(path.join(os.tmpdir(), "dovecot-tls-"));
		await execAsync(
			`openssl req -x509 -newkey rsa:2048 -keyout ${tlsCertDir}/key.pem -out ${tlsCertDir}/fullchain.pem -days 1 -nodes -subj '/CN=dovecot-test'`,
			{ encoding: "utf-8" },
		);

		// Create an isolated Docker network so dovecot can reach mariadb by name.
		// Dovecot 2.4 MySQL block syntax only accepts a plain hostname, not host:port.
		await dockerNetworkCreate(networkName);

		await dockerContainerRun("mariadb:11", {
			detach: true,
			name: mariadbName,
			network: networkName,
			env: {
				MARIADB_DATABASE: DB_NAME,
				MARIADB_USER: DB_USER,
				MARIADB_PASSWORD: DB_PASSWORD,
				MARIADB_ROOT_PASSWORD: "root",
				MARIADB_INITDB_SKIP_TZINFO: "1",
			},
		});

		// Wait until the `mail` database is reachable, not just the server.
		// MARIADB_DATABASE initialization runs after server startup, so
		// mariadb-admin ping can succeed while the database is not yet created.
		await vi.waitUntil(
			async () => {
				try {
					await dockerContainerExec(mariadbName, "mariadb", {
						commandArgs: ["-u", "root", "-proot", DB_NAME, "-e", "SELECT 1"],
					});
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 60_000, interval: 1000 },
		);

		await feedSqlToMariadb(mariadbName, INIT_SQL);
	});

	return {
		containerImageName,
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
		/** Registers the container's env for every test in this describe. */
		useContainer: (env?: EnvVariables) => {
			const imapPort = getRandomEphemeralPort();
			const healthPort = getRandomEphemeralPort();
			const lmtpPort = getRandomEphemeralPort();
			const pop3Port = getRandomEphemeralPort();
			const managesievePort = getRandomEphemeralPort();

			beforeAll(() => {
				const baseEnv: EnvVariables = {
					DOVECOT_MYSQL_HOST: mariadbName,
					DOVECOT_MYSQL_USER: DB_USER,
					DOVECOT_MYSQL_PASSWORD: DB_PASSWORD,
					DOVECOT_MYSQL_DATABASE: DB_NAME,
					DOVECOT_ADMIN_EMAIL: "admin@example.com",
					DOVECOT_POSTMASTER_EMAIL: "postmaster@example.com",
				};

				pendingRunOptions = {
					network: networkName,
					volume: [`${tlsCertDir}:/etc/dovecot/tls:ro,z`],
					publish: [
						`${imapPort}:143`,
						`${healthPort}:5001`,
						`${lmtpPort}:24`,
						`${pop3Port}:110`,
						`${managesievePort}:4190`,
					],
					env: { ...baseEnv, ...env },
				};
				pendingWaitReady = async () => {
					// Wait until IMAP is ready to send the greeting banner.
					await vi.waitUntil(() => isImapReady(imapPort), {
						timeout: 30_000,
						interval: 1000,
					});
				};
			});

			return { imapPort, healthPort, lmtpPort, pop3Port, managesievePort };
		},
	};
}
