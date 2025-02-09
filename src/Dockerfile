FROM alpine:3.21.2@sha256:56fa17d2a7e7f168a043a2712e63aed1f8543aeafdcee47c58dcffe38ed51099

# Ensures to have consistent mailboxes uid/gid. IDs values must be at
# least first_valid_uid.
ARG VMAIL_UID=500
ARG VMAIL_GID=500

RUN set -ex; \
	addgroup -g $VMAIL_GID vmail; \
	adduser -G vmail -u $VMAIL_UID -h /var/vmail -s /sbin/nologin -D vmail

# hadolint ignore=DL3018
RUN apk add --update --no-cache jinja2-cli supervisor stunnel rspamd-client \
	dovecot dovecot-mysql dovecot-pop3d dovecot-lmtpd dovecot-pigeonhole-plugin

# required for dovecot-lda logging
RUN set -ex; \
	mkdir -p /var/log/dovecot; \
	chown dovecot:dovecot /var/log/dovecot; \
	chmod 775 /var/log/dovecot

COPY --chmod=644 /rootfs/config /etc/dovecot
RUN set -ex; \
	chmod 755 /etc/dovecot/virtual /etc/dovecot/virtual/* /etc/dovecot/conf.d; \
	mkdir -p /etc/dovecot/tls

COPY --chmod=644 /rootfs/supervisord.conf /etc
COPY --chmod=644 /rootfs/syslog.conf /etc

RUN set -ex; \
	mkdir -p /run/stunnel; \
	chown stunnel:stunnel /run/stunnel
COPY --chmod=644 /rootfs/stunnel.conf.j2 /etc/stunnel

COPY /rootfs/sieve /var/lib/dovecot/sieve
RUN set -ex; \
	sievec /var/lib/dovecot/sieve/global-spam.sieve; \
	sievec /var/lib/dovecot/sieve/report-spam.sieve; \
	sievec /var/lib/dovecot/sieve/report-ham.sieve

COPY --chmod=755 /rootfs/sieve-pipe /usr/lib/dovecot/sieve-pipe

COPY --chmod=755 /rootfs/scripts/* /usr/local/bin

# pop3 (110), imap (143), imaps (993), pop3s (995), sieve (4190)
EXPOSE 110 143 993 995 4190

# private: lmtp (24), healthcheck (5001), prometheus metrics (9900), sasl (12345), quota (12340)
# EXPOSE 24 5001 9900 12345 12340

VOLUME ["/etc/dovecot/tls", "/var/vmail/"]

COPY --chmod=755 /rootfs/docker-entrypoint.sh /

ENTRYPOINT ["./docker-entrypoint.sh"]

CMD [ "supervisord", "-c", "/etc/supervisord.conf" ]

HEALTHCHECK \
	CMD (echo "PING" | nc -w 1 localhost 5001 | grep ^PONG$) || exit 1
