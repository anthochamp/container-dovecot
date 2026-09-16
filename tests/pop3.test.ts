import { Pop3Client } from "@ac-kit/net-pop3";
import { DuplexTransport } from "@ac-kit/net-transport-node";
import { TcpSocket, TlsSocket } from "@ac-kit/node";
import { beforeAll, expect, describe, it } from "vitest";

import { initSuite } from "./common";

describe("pop3", () => {
	const { createUser, useContainer } = initSuite();

	beforeAll(async () => {
		await createUser({
			local: "alice",
			domain: "example.com",
			password: "{PLAIN}alice123",
		});
	});

	const { pop3Port } = useContainer();

	it("presents a POP3 greeting on port 110", async () => {
		const socket = TcpSocket.from();
		const client = new Pop3Client(new DuplexTransport(socket.stream));
		const greeting = client.wait("push");
		await socket.connect(pop3Port, { host: "127.0.0.1" });
		try {
			const [response] = await greeting;
			expect(response.ok).toBe(true);
		} finally {
			if (!socket.closed && !socket.destroyed) {
				await socket.end();
			}
		}
	});

	it("CAPA advertises STLS before TLS negotiation", async () => {
		const socket = TcpSocket.from();
		const client = new Pop3Client(new DuplexTransport(socket.stream));
		const greeting = client.wait("push");
		await socket.connect(pop3Port, { host: "127.0.0.1" });
		try {
			await greeting;
			const capabilities = await client.capa();
			expect(capabilities.lines).toContain("STLS");
		} finally {
			if (!socket.closed && !socket.destroyed) {
				await client.quit();
			}
			if (!socket.closed && !socket.destroyed) {
				await socket.end();
			}
		}
	});

	it("USER/PASS login succeeds after STLS", async () => {
		const socket = TcpSocket.from();
		const client = new Pop3Client(new DuplexTransport(socket.stream));
		const greeting = client.wait("push");
		await socket.connect(pop3Port, { host: "127.0.0.1" });
		await greeting;

		const stlsResp = await client.command("STLS");
		expect(stlsResp.ok).toBe(true);

		const tlsSocket = await TlsSocket.connect(socket.stream, {
			rejectUnauthorized: false,
		});

		client.upgradeTransport(new DuplexTransport(tlsSocket.stream));

		expect((await client.user("alice@example.com")).ok).toBe(true);
		expect((await client.pass("alice123")).ok).toBe(true);

		if (!tlsSocket.closed && !tlsSocket.destroyed) {
			await client.quit();
		}
		if (!tlsSocket.closed && !tlsSocket.destroyed) {
			await tlsSocket.end();
		}
	});
});
