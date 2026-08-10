import { TcpSocket } from "@ac-essentials/misc-util";
import { beforeAll, expect, suite, test } from "vitest";
import { initSuite, openImapSession } from "./common";

function readFirstLine(client: TcpSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		client.stream.on("data", (chunk) => {
			buffer += chunk.toString();
			const newline = buffer.indexOf("\n");
			if (newline !== -1) {
				void client.end();
				resolve(buffer.slice(0, newline).trim());
			}
		});
		client.subscribe("error", reject);
		client.subscribe("close", () => resolve(buffer.trim()));
	});
}

suite("imap", () => {
	const { startContainer } = initSuite();
	let imapPort: number;
	let healthPort: number;

	beforeAll(async () => {
		({ imapPort, healthPort } = await startContainer());
	});

	test("presents an IMAP greeting on port 143", async () => {
		const client = TcpSocket.from();
		await client.connect(imapPort, "127.0.0.1");
		const banner = await readFirstLine(client);

		expect(banner).toMatch(/^\* OK /);
	});

	test("responds PONG to PING on the health check port", async () => {
		const client = TcpSocket.from();
		await client.connect(healthPort, "127.0.0.1");
		await client.write(Buffer.from("PING\n"));

		const response = await new Promise<string>((resolve, reject) => {
			let buffer = "";
			client.stream.on("data", (chunk) => {
				buffer += chunk.toString();
				if (buffer.includes("PONG")) {
					void client.end();
					resolve(buffer.trim());
				}
			});
			client.subscribe("error", reject);
			setTimeout(() => {
				void client.end();
				reject(new Error("PONG timeout"));
			}, 10_000);
		});

		expect(response).toBe("PONG");
	});
});

suite("auth", () => {
	const { createUser, startContainer } = initSuite();
	let imapPort: number;

	beforeAll(async () => {
		await createUser({
			local: "alice",
			domain: "example.com",
			password: "{PLAIN}alice123",
		});
		await createUser({
			local: "disabled",
			domain: "example.com",
			password: "{PLAIN}disabled123",
			enabled: false,
		});
		await createUser({
			local: "sendonly",
			domain: "example.com",
			password: "{PLAIN}sendonly123",
			sendonly: true,
		});
		({ imapPort } = await startContainer());
	});

	test("login with valid credentials succeeds", async () => {
		const session = await openImapSession(imapPort);
		try {
			const resp = await session.command(
				"A001",
				'LOGIN "alice@example.com" "alice123"',
			);
			expect(resp[resp.length - 1]).toMatch(/^A001 OK/);
		} finally {
			await session.close();
		}
	});

	test("login with wrong password is rejected", async () => {
		const session = await openImapSession(imapPort);
		try {
			const resp = await session.command(
				"A001",
				'LOGIN "alice@example.com" "wrongpassword"',
			);
			expect(resp[resp.length - 1]).toMatch(/^A001 NO/);
		} finally {
			await session.close();
		}
	});

	test("login with unknown user is rejected", async () => {
		const session = await openImapSession(imapPort);
		try {
			const resp = await session.command(
				"A001",
				'LOGIN "nobody@example.com" "somepassword"',
			);
			expect(resp[resp.length - 1]).toMatch(/^A001 NO/);
		} finally {
			await session.close();
		}
	});

	test("login with disabled user is rejected", async () => {
		const session = await openImapSession(imapPort);
		try {
			const resp = await session.command(
				"A001",
				'LOGIN "disabled@example.com" "disabled123"',
			);
			expect(resp[resp.length - 1]).toMatch(/^A001 NO/);
		} finally {
			await session.close();
		}
	});

	test("login with sendonly user is rejected", async () => {
		// Dovecot: passdb finds the user (enabled=true) but userdb excludes it (sendonly=true).
		// Depending on version it either sends A001 NO or closes the connection outright.
		const session = await openImapSession(imapPort);
		try {
			const resp = await session.command(
				"A001",
				'LOGIN "sendonly@example.com" "sendonly123"',
			);
			expect(resp[resp.length - 1]).toMatch(/^A001 NO/);
		} catch (err) {
			// Connection closed without a tagged response is also a rejection.
			expect((err as Error).message).toMatch(/Connection closed/);
		} finally {
			await session.close().catch(() => {});
		}
	});

	test("PLAIN auth before STARTTLS is rejected", async () => {
		// Dovecot sends * BAD [ALERT] and then closes the connection without a tagged response.
		const client = TcpSocket.from();
		await client.connect(imapPort, "127.0.0.1");

		let buffer = "";
		const readLine = () =>
			new Promise<string>((resolve, reject) => {
				const onData = (chunk: Buffer) => {
					buffer += chunk.toString();
					const i = buffer.indexOf("\n");
					if (i !== -1) {
						const line = buffer.slice(0, i).replace(/\r$/, "");
						buffer = buffer.slice(i + 1);
						client.stream.off("data", onData);
						client.stream.off("close", onClose);
						resolve(line);
					}
				};
				const onClose = () => reject(new Error("Connection closed"));
				client.stream.on("data", onData);
				client.stream.once("close", onClose);
			});

		await readLine(); // greeting
		await client.write(
			Buffer.from('A001 LOGIN "alice@example.com" "alice123"\r\n'),
		);
		// Dovecot sends * BAD [ALERT] then closes — no tagged response follows.
		const resp = await readLine();
		expect(resp).toMatch(/^\* (BAD|NO)/);
		client.stream.destroy();
	});
});

suite("mailbox", () => {
	const { createUser, startContainer } = initSuite();
	let imapPort: number;

	beforeAll(async () => {
		await createUser({
			local: "alice",
			domain: "example.com",
			password: "{PLAIN}alice123",
		});
		({ imapPort } = await startContainer());
	});

	test("default mailboxes are present after first login", async () => {
		const session = await openImapSession(imapPort);
		try {
			await session.command("A001", 'LOGIN "alice@example.com" "alice123"');
			const resp = await session.command("A002", 'LIST "" "*"');
			const listing = resp.join("\n");
			expect(listing).toMatch(/\* LIST.*INBOX/i);
			expect(listing).toMatch(/\* LIST.*Drafts/);
			expect(listing).toMatch(/\* LIST.*Sent/);
			expect(listing).toMatch(/\* LIST.*Junk/);
			expect(listing).toMatch(/\* LIST.*Trash/);
			expect(listing).toMatch(/\* LIST.*Archive/);
		} finally {
			await session.close();
		}
	});

	test("SELECT INBOX succeeds after login", async () => {
		const session = await openImapSession(imapPort);
		try {
			await session.command("A001", 'LOGIN "alice@example.com" "alice123"');
			const resp = await session.command("A002", "SELECT INBOX");
			expect(resp[resp.length - 1]).toMatch(/^A002 OK/);
		} finally {
			await session.close();
		}
	});
});
