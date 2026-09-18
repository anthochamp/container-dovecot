FROM dovecot/dovecot:2.4.5-root@sha256:e6bae0e8f0ce8fe1941d93138ff7235f6dc6bcc397b9a171c31cb6a5a610b23b

# hadolint ignore=DL3008,DL3009
RUN set -ex; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
	pipx rspamd supervisor stunnel4; \
	apt-get clean; \
	rm -rf /var/lib/apt/lists/*

# Install jinja2-cli globally via pipx
# hadolint ignore=DL3013
RUN PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install jinja2-cli


RUN set -ex; \
	# dovecot binaries live under /dovecot/ in the official image; create a compat
	# symlink so paths referencing /usr/lib/dovecot (e.g. sieve-pipe) still work.
	ln -s /dovecot/lib/dovecot /usr/lib/dovecot; \
	# required for dovecot-lda logging
	mkdir -p /var/log/dovecot; \
	chown dovecot:dovecot /var/log/dovecot; \
	chmod 775 /var/log/dovecot

# Remove the base image's /etc/dovecot entirely; we replace it with our own
# complete, explicit configuration so no implicit defaults can bleed through.
RUN rm -rf /etc/dovecot

COPY --chmod=644 /rootfs/etc/dovecot /etc/dovecot
RUN set -ex; \
	chmod 600 /etc/dovecot/dovecot-sql.conf.ext.j2; \
	chmod 755 /etc/dovecot/virtual /etc/dovecot/virtual/* /etc/dovecot/conf.d; \
	mkdir -p /etc/dovecot/tls

COPY --chmod=644 /rootfs/etc/supervisord.conf /etc/
COPY --chmod=644 /rootfs/etc/syslog.conf /etc/

RUN set -ex; \
	mkdir -p /run/stunnel; \
	chown stunnel4:stunnel4 /run/stunnel
COPY --chmod=644 /rootfs/etc/stunnel/stunnel.conf.j2 /etc/stunnel/

COPY /rootfs/var/lib/dovecot/sieve /var/lib/dovecot/sieve
RUN set -ex; \
	sievec /var/lib/dovecot/sieve/global-spam.sieve; \
	sievec /var/lib/dovecot/sieve/report-spam.sieve; \
	sievec /var/lib/dovecot/sieve/report-ham.sieve

COPY --chmod=755 /rootfs/usr/lib/dovecot/sieve-pipe /usr/lib/dovecot/sieve-pipe/

COPY --chmod=755 /rootfs/usr/local/bin /usr/local/bin

# pop3 (110), imap (143), imaps (993), pop3s (995), sieve (4190)
EXPOSE 110 143 993 995 4190

# private: lmtp (24), healthcheck (5001), prometheus metrics (9900), sasl (12345), quota (12340)
# EXPOSE 24 5001 9900 12345 12340

VOLUME ["/etc/dovecot/tls", "/var/vmail/"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

CMD [ "supervisord", "-c", "/etc/supervisord.conf" ]

HEALTHCHECK \
	CMD (echo "PING" | nc -w 1 localhost 5001 | grep ^PONG$) || exit 1
