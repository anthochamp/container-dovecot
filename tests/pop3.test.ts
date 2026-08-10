import type { Duplex } from "node:stream";
import * as tls from "node:tls";
import { TcpSocket } from "@ac-essentials/misc-util";
import { beforeAll, expect, suite, test } from "vitest";
import { initSuite } from "./common";

suite("pop3", () => {
	const { createUser, startContainer } = initSuite();
	let pop3Port: number;

	beforeAll(async () => {
		await createUser({
			local: "alice",
			domain: "example.com",
			password: "{PLAIN}alice123",
		});
		({ pop3Port } = await startContainer());
	});

	test("presents a POP3 greeting on port 110", async () => {
		const client = TcpSocket.from();
		await client.connect(pop3Port, "127.0.0.1");

		const greeting = await new Promise<string>((resolve, reject) => {
			let buf = "";
			client.stream.on("data", (chunk: Buffer) => {
				buf += chunk.toString();
				if (buf.includes("\n")) {
					void client.end();
					resolve(buf.slice(0, buf.indexOf("\n")).replace(/\r$/, ""));
				}
			});
			client.subscribe("error", reject);
		});

		expect(greeting).toMatch(/^\+OK/);
	});

	test("CAPA advertises STLS before TLS negotiation", async () => {
		const client = TcpSocket.from();
		await client.connect(pop3Port, "127.0.0.1");

		let buf = "";
		// Eagerly checks buf before adding a listener — avoids stalls when the server
		// sends multiple lines in a single TCP segment.
		const readLine = () =>
			new Promise<string>((resolve, reject) => {
				const tryResolve = () => {
					const i = buf.indexOf("\n");
					if (i !== -1) {
						const line = buf.slice(0, i).replace(/\r$/, "");
						buf = buf.slice(i + 1);
						resolve(line);
						return true;
					}
					return false;
				};
				if (tryResolve()) return;
				const onData = (chunk: Buffer) => {
					buf += chunk.toString();
					if (tryResolve()) {
						client.stream.off("data", onData);
						client.stream.off("close", onClose);
					}
				};
				const onClose = () => reject(new Error("Connection closed"));
				client.stream.on("data", onData);
				client.stream.once("close", onClose);
			});

		const readUntilDot = async (): Promise<string[]> => {
			const lines: string[] = [];
			// biome-ignore lint/suspicious/noUnnecessaryConditions: false positive
			while (true) {
				const line = await readLine();
				if (line === ".") break;
				lines.push(line);
			}
			return lines;
		};

		await readLine(); // greeting
		await client.write(Buffer.from("CAPA\r\n"));
		await readLine(); // +OK capability list follows
		const caps = await readUntilDot();
		await client.end();

		expect(caps).toContain("STLS");
	});

	test("USER/PASS login succeeds after STLS", async () => {
		const client = TcpSocket.from();
		await client.connect(pop3Port, "127.0.0.1");

		let buf = "";
		const readLine = (stream: Duplex) =>
			new Promise<string>((resolve) => {
				const onData = (chunk: Buffer) => {
					buf += chunk.toString();
					const i = buf.indexOf("\n");
					if (i !== -1) {
						const line = buf.slice(0, i).replace(/\r$/, "");
						buf = buf.slice(i + 1);
						stream.off("data", onData);
						resolve(line);
					}
				};
				stream.on("data", onData);
			});

		await readLine(client.stream as never); // greeting

		await client.write(Buffer.from("STLS\r\n"));
		const stlsResp = await readLine(client.stream as never);
		expect(stlsResp).toMatch(/^\+OK/);

		const tlsSocket = tls.connect({
			socket: client.stream,
			rejectUnauthorized: false,
		});
		await new Promise<void>((resolve, reject) => {
			tlsSocket.once("secureConnect", resolve);
			tlsSocket.once("error", reject);
		});

		const tlsWrite = (data: string) =>
			new Promise<void>((resolve, reject) => {
				tlsSocket.write(`${data}\r\n`, (err) =>
					err ? reject(err) : resolve(),
				);
			});

		await tlsWrite("USER alice@example.com");
		const userResp = await readLine(tlsSocket);
		expect(userResp).toMatch(/^\+OK/);

		await tlsWrite("PASS alice123");
		const passResp = await readLine(tlsSocket);
		expect(passResp).toMatch(/^\+OK/);

		tlsSocket.end();
	});
});
