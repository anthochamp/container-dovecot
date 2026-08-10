import { beforeAll, expect, suite, test } from "vitest";
import { deliverMessage, initSuite, openImapSession } from "./common";

const FROM = "sender@external.example";

const PLAIN_MESSAGE = [
	"From: sender@external.example",
	"To: alice@example.com",
	"Subject: Test delivery",
	"Message-ID: <lmtp-test-plain@test>",
	"",
	"Hello, this is a test message.",
].join("\r\n");

const SPAM_MESSAGE = [
	"From: sender@external.example",
	"To: spamtest@example.com",
	"Subject: Spam test",
	"Message-ID: <lmtp-test-spam@test>",
	"X-Spam: YES",
	"",
	"This is spam.",
].join("\r\n");

suite("lmtp", () => {
	const { createUser, startContainer } = initSuite();
	let imapPort: number;
	let lmtpPort: number;

	beforeAll(async () => {
		await createUser({
			local: "alice",
			domain: "example.com",
			password: "{PLAIN}alice123",
		});
		await createUser({
			local: "sendonly",
			domain: "example.com",
			password: "{PLAIN}sendonly123",
			sendonly: true,
		});
		await createUser({
			local: "spamtest",
			domain: "example.com",
			password: "{PLAIN}spamtest123",
		});
		({ imapPort, lmtpPort } = await startContainer());
	});

	test("delivers message to valid user — message appears in INBOX", async () => {
		const { rcptResponse, dataResponse } = await deliverMessage(lmtpPort, {
			from: FROM,
			to: "alice@example.com",
			message: PLAIN_MESSAGE,
		});

		expect(rcptResponse).toMatch(/^250/);
		expect(dataResponse).toMatch(/^250/);

		// Verify the message is visible via IMAP
		const session = await openImapSession(imapPort);
		try {
			await session.command("A001", 'LOGIN "alice@example.com" "alice123"');
			const resp = await session.command("A002", "SELECT INBOX");
			expect(resp.join("\n")).toMatch(/\* 1 EXISTS/);
		} finally {
			await session.close();
		}
	});

	test("rejects delivery to unknown user with 5xx", async () => {
		const { rcptResponse } = await deliverMessage(lmtpPort, {
			from: FROM,
			to: "nobody@example.com",
			message: PLAIN_MESSAGE,
		});

		expect(rcptResponse).toMatch(/^5/);
	});

	test("rejects delivery to sendonly user with 5xx", async () => {
		const { rcptResponse } = await deliverMessage(lmtpPort, {
			from: FROM,
			to: "sendonly@example.com",
			message: PLAIN_MESSAGE,
		});

		expect(rcptResponse).toMatch(/^5/);
	});

	test("global-spam.sieve: message with X-Spam: YES is filed into Junk, not INBOX", async () => {
		const { rcptResponse, dataResponse } = await deliverMessage(lmtpPort, {
			from: FROM,
			to: "spamtest@example.com",
			message: SPAM_MESSAGE,
		});

		expect(rcptResponse).toMatch(/^250/);
		expect(dataResponse).toMatch(/^250/);

		const session = await openImapSession(imapPort);
		try {
			await session.command(
				"A001",
				'LOGIN "spamtest@example.com" "spamtest123"',
			);

			const inboxResp = await session.command("A002", "SELECT INBOX");
			expect(inboxResp.join("\n")).toMatch(/\* 0 EXISTS/);

			const junkResp = await session.command("A003", "SELECT Junk");
			expect(junkResp.join("\n")).toMatch(/\* 1 EXISTS/);
		} finally {
			await session.close();
		}
	});
});
