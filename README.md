# Dovecot container

![GitHub License](https://img.shields.io/github/license/anthochamp/container-dovecot?style=for-the-badge)
![GitHub Release](https://img.shields.io/github/v/release/anthochamp/container-dovecot?style=for-the-badge&color=457EC4)
![GitHub Release Date](https://img.shields.io/github/release-date/anthochamp/container-dovecot?style=for-the-badge&display_date=published_at&color=457EC4)

Container images based on the official [Dovecot](https://www.dovecot.org/) IMAP/POP3 server, configured for MySQL-based virtual domains with LMTP delivery, SASL authentication for Postfix, Sieve filtering, quota management, and optional Rspamd spam learning integration.

<!-- TOC tocDepth:2..3 chapterDepth:2..6 -->

- [How to use this image](#how-to-use-this-image)
- [Volumes](#volumes)
- [Ports](#ports)
- [MySQL Database Schema](#mysql-database-schema)
- [Configuration](#configuration)
  - [DOVECOT_MYSQL_HOST](#dovecot_mysql_host)
  - [DOVECOT_MYSQL_USER](#dovecot_mysql_user)
  - [DOVECOT_MYSQL_PASSWORD](#dovecot_mysql_password)
  - [DOVECOT_MYSQL_DATABASE](#dovecot_mysql_database)
  - [DOVECOT_MYSQL_TABLE](#dovecot_mysql_table)
  - [DOVECOT_ADMIN_EMAIL](#dovecot_admin_email)
  - [DOVECOT_POSTMASTER_EMAIL](#dovecot_postmaster_email)
  - [DOVECOT_RSPAMD_HOST](#dovecot_rspamd_host)
  - [DOVECOT_RSPAMD_PORT](#dovecot_rspamd_port)
  - [DOVECOT_RSPAMD_TLS](#dovecot_rspamd_tls)
  - [DOVECOT_RSPAMD_TLS_SKIP_VERIFY](#dovecot_rspamd_tls_skip_verify)
  - [DOVECOT_RSPAMD_TLS_CA_FILE](#dovecot_rspamd_tls_ca_file)
  - [DOVECOT_RSPAMD_TLS_CERT_FILE](#dovecot_rspamd_tls_cert_file)
  - [DOVECOT_RSPAMD_TLS_CERT_KEY_FILE](#dovecot_rspamd_tls_cert_key_file)
  - [DOVECOT_RSPAMD_FUZZY_WHITE_TAG](#dovecot_rspamd_fuzzy_white_tag)
  - [DOVECOT_RSPAMD_FUZZY_DENIED_TAG](#dovecot_rspamd_fuzzy_denied_tag)
  - [VMAIL_UID](#vmail_uid)
  - [VMAIL_GID](#vmail_gid)
  - [DOVECOT_DEBUG](#dovecot_debug)

<!-- /TOC -->

## How to use this image

Start a Dovecot container with MySQL-backed virtual users:

```shell
docker run -d \
  -p 993:993 \
  -p 4190:4190 \
  -v /path/to/certs:/etc/dovecot/tls:ro \
  -v dovecot-mail:/var/vmail \
  -e DOVECOT_MYSQL_HOST=mysql \
  -e DOVECOT_MYSQL_USER=dovecot \
  -e DOVECOT_MYSQL_PASSWORD=secret \
  -e DOVECOT_MYSQL_DATABASE=mailserver \
  -e DOVECOT_ADMIN_EMAIL=admin@example.com \
  -e DOVECOT_POSTMASTER_EMAIL=postmaster@example.com \
  anthochamp/dovecot
```

With Rspamd spam learning integration:

```shell
docker run -d \
  -p 993:993 \
  -p 24:24 \
  -p 12345:12345 \
  -v /path/to/certs:/etc/dovecot/tls:ro \
  -v dovecot-mail:/var/vmail \
  -e DOVECOT_MYSQL_HOST=mysql \
  -e DOVECOT_MYSQL_USER=dovecot \
  -e DOVECOT_MYSQL_PASSWORD=secret \
  -e DOVECOT_MYSQL_DATABASE=mailserver \
  -e DOVECOT_RSPAMD_HOST=rspamd \
  -e DOVECOT_RSPAMD_FUZZY_WHITE_TAG=2 \
  -e DOVECOT_RSPAMD_FUZZY_DENIED_TAG=1 \
  anthochamp/dovecot
```

You can also configure sensitive values by appending `__FILE` to any supported environment variable name. When set, the container reads the value from the specified file path. This is commonly used with Docker secrets (e.g., `DOVECOT_MYSQL_PASSWORD__FILE=/run/secrets/mysql_password`).

## Volumes

- `/var/vmail/` — mail storage directory. Each user's mail is stored under `/var/vmail/<local>@<domain>/Maildir/`. Mount a named volume or host directory here; must be owned by `vmail` (UID/GID configurable via `VMAIL_UID`/`VMAIL_GID`).
- `/etc/dovecot/tls/` — TLS certificate directory. Must contain:
  - `fullchain.pem` — server certificate + intermediate chain
  - `key.pem` — server private key

  SSL is **required** by default; all IMAP, POP3, Sieve and Submission connections must be encrypted.

## Ports

| Port  | Protocol | Description                                         |
|-------|----------|-----------------------------------------------------|
| 24    | TCP      | LMTP — accepts mail from Postfix for local delivery |
| 143   | TCP      | IMAP (STARTTLS required)                            |
| 993   | TCP      | IMAPS (implicit TLS)                                |
| 110   | TCP      | POP3 (STARTTLS required)                            |
| 995   | TCP      | POP3S (implicit TLS)                                |
| 587   | TCP      | Submission (STARTTLS required)                      |
| 4190  | TCP      | ManageSieve — Sieve script management               |
| 12345 | TCP      | SASL — SMTP authentication for Postfix              |
| 12340 | TCP      | Quota status — Postfix policy service for quota     |
| 9900  | TCP      | Prometheus metrics (`/metrics`)                     |
| 5001  | TCP      | Health check                                        |

## MySQL Database Schema

Dovecot requires a single table (or view) for authentication and user lookups. The default table name is `mail_users` (configurable via `DOVECOT_MYSQL_TABLE`).

```sql
CREATE TABLE mail_users (
  local       varchar(64)  NOT NULL,
  domain      varchar(255) NOT NULL,
  email       varchar(320) NOT NULL,
  password    varchar(255) NOT NULL,
  quota_bytes int          NOT NULL DEFAULT 1024,
  sendonly    tinyint(1)   NOT NULL DEFAULT 0,
  enabled     tinyint(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (local, domain)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Required columns:**

- `local` — local part of the email address (before `@`)
- `domain` — domain part of the email address
- `email` — full email address (`local@domain`); returned as the authentication user
- `password` — bcrypt-hashed password with Dovecot prefix: `{BLF-CRYPT}$2y$...`
- `quota_bytes` — mailbox quota in **megabytes** (0 = unlimited)
- `sendonly` — if `1`, user can only send; LMTP rejects incoming delivery
- `enabled` — if `0`, authentication fails for this user

**Example:**

```sql
INSERT INTO mail_users (local, domain, email, password, quota_bytes, sendonly, enabled)
VALUES ('john', 'example.com', 'john@example.com', '{BLF-CRYPT}$2y$...', 1024, 0, 1);
```

You can use a view instead of the table directly — useful for joining data from multiple tables — as long as it exposes the required columns.

## Configuration

### DOVECOT_MYSQL_HOST

**Default**: *empty*

MySQL/MariaDB server hostname or IP address.

### DOVECOT_MYSQL_USER

**Default**: *empty*

MySQL username for database authentication.

### DOVECOT_MYSQL_PASSWORD

**Default**: *empty*

MySQL password for database authentication.

### DOVECOT_MYSQL_DATABASE

**Default**: *empty*

MySQL database name containing the virtual user table.

### DOVECOT_MYSQL_TABLE

**Default**: `mail_users`

Name of the MySQL table or view used for authentication and user lookups. See [MySQL Database Schema](#mysql-database-schema) for the required columns.

### DOVECOT_ADMIN_EMAIL

**Default**: *empty*

IMAP [METADATA](https://doc.dovecot.org/2.4.2/core/config/settings/mail_server_admin/) admin contact address (RFC 5464). Exposed to connected IMAP clients via the `mail-server-admin` metadata key.

### DOVECOT_POSTMASTER_EMAIL

**Default**: *empty*

Email address that receives quota warning notifications. When set, Dovecot sends a message to the user at 80% and 95% quota usage. When unset, quota warnings are silently suppressed.

### DOVECOT_RSPAMD_HOST

**Default**: *empty*

Rspamd controller hostname. When set, Dovecot's Sieve scripts call `rspamc` to train Bayes and fuzzy storage when users move messages to/from the Junk folder.

Refer to [Rspamd documentation](https://rspamd.com/doc/workers/controller.html) for the controller worker.

### DOVECOT_RSPAMD_PORT

**Default**: `11334` (plaintext) or `443` (when `DOVECOT_RSPAMD_TLS=1`)

Rspamd controller port.

### DOVECOT_RSPAMD_TLS

**Default**: `0`

Set to `1` to connect to Rspamd over TLS via stunnel. When enabled, TLS termination is handled by stunnel before forwarding to the Rspamd controller.

### DOVECOT_RSPAMD_TLS_SKIP_VERIFY

**Default**: `0`

Set to `1` to disable TLS certificate verification for Rspamd connections. Not recommended for production.

### DOVECOT_RSPAMD_TLS_CA_FILE

**Default**: *empty* (system CA bundle)

Path to a CA certificate file for Rspamd TLS verification. Leave empty to use the system certificate bundle.

### DOVECOT_RSPAMD_TLS_CERT_FILE

**Default**: *empty*

Path to a client certificate file for Rspamd mutual TLS authentication.

### DOVECOT_RSPAMD_TLS_CERT_KEY_FILE

**Default**: *empty*

Path to the client certificate private key for Rspamd mutual TLS authentication. Required when `DOVECOT_RSPAMD_TLS_CERT_FILE` is set.

### DOVECOT_RSPAMD_FUZZY_WHITE_TAG

**Default**: *empty*

Rspamd fuzzy storage flag number for ham (legitimate mail). When set and a user moves a message **out** of the Junk folder, `rspamc fuzzy_add` is called with this flag. Typically `2`. Refer to [Rspamd fuzzy storage documentation](https://rspamd.com/doc/modules/fuzzy_check.html).

### DOVECOT_RSPAMD_FUZZY_DENIED_TAG

**Default**: *empty*

Rspamd fuzzy storage flag number for spam. When set and a user moves a message **into** the Junk folder, `rspamc fuzzy_add` is called with this flag. Typically `1`.

### VMAIL_UID

**Default**: `1000`

UID for the `vmail` system user, which owns all mail files under `/var/vmail/`. Change this if the mounted volume has different ownership requirements.

### VMAIL_GID

**Default**: `1000`

GID for the `vmail` system group.

### DOVECOT_DEBUG

**Default**: `no`

Set to `yes` to enable verbose debug logging for authentication and mail subsystems. Refer to [Dovecot logging documentation](https://doc.dovecot.org/2.4.2/core/logging/).
