# Dovecot Container Images

Container images based on the official [Dovecot](https://www.dovecot.org/) IMAP/POP3 server, configured for MySQL-based virtual domains with LMTP delivery, SASL authentication, Sieve filtering, quota management, and optional Rspamd spam learning integration.

Sources are available on [GitHub](https://github.com/anthochamp/container-dovecot).

See [README.md](README.md) for full documentation and configuration reference.

## Image tags

- `x.y.z-dovecotA.B.C`: Container image version `x.y.z` with Dovecot `A.B.C`.
- `edge-dovecotA.B.C`: Latest commit build with Dovecot `A.B.C`.

**Tag aliases:**

- `x.y-dovecotA.B.C`: Latest patch of `x.y` with Dovecot `A.B.C`.
- `x-dovecotA.B.C`: Latest minor+patch of `x` with Dovecot `A.B.C`.
- `x.y.z-dovecotA.B`: Version `x.y.z` with latest patch of Dovecot `A.B` (only latest container version updated).
- `x.y-dovecotA.B`: Latest patch of `x.y` with latest patch of Dovecot `A.B`.
- `x-dovecotA.B`: Latest minor+patch of `x` with latest patch of Dovecot `A.B`.
- `x.y.z-dovecotA`: Version `x.y.z` with latest minor+patch of Dovecot `A` (only latest container version updated).
- `x.y-dovecotA`: Latest patch of `x.y` with latest minor+patch of Dovecot `A`.
- `x-dovecotA`: Latest minor+patch of `x` with latest minor+patch of Dovecot `A`.
- `x.y.z`: Version `x.y.z` with latest Dovecot (only latest container version updated).
- `x.y`: Latest patch of `x.y` with latest Dovecot.
- `x`: Latest minor+patch of `x` with latest Dovecot.
- `dovecotA.B.C`: Latest container with Dovecot `A.B.C`.
- `dovecotA.B`: Latest container with latest patch of Dovecot `A.B`.
- `dovecotA`: Latest container with latest minor+patch of Dovecot `A`.
- `latest`: Latest `x.y.z-dovecotA.B.C` tag.
- `edge-dovecotA.B`: Latest commit build with latest patch of Dovecot `A.B`.
- `edge-dovecotA`: Latest commit build with latest minor+patch of Dovecot `A`.
- `edge`: Latest `edge-dovecotA.B.C` tag.
