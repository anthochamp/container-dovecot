#!/usr/bin/env sh
set -eu

# shellcheck disable=SC2120,SC3043
replaceEnvSecrets() {
	# replaceEnvSecrets 1.0.0
	# https://gist.github.com/anthochamp/d4d9537f52e5b6c42f0866dd823a605f
	local prefix="${1:-}"

	for envSecretName in $(export | awk '{print $2}' | grep -oE '^[^=]+' | grep '__FILE$'); do
		if [ -z "$prefix" ] || printf '%s' "$envSecretName" | grep "^$prefix" >/dev/null; then
			local envName
			envName=$(printf '%s' "$envSecretName" | sed 's/__FILE$//')

			local filePath
			filePath=$(eval echo '${'"$envSecretName"':-}')

			if [ -n "$filePath" ]; then
				if [ -f "$filePath" ]; then
					echo Using content from "$filePath" file for "$envName" environment variable value.

					export "$envName"="$(cat -A "$filePath")"
					unset "$envSecretName"
				else
					echo ERROR: Environment variable "$envSecretName" is defined but does not point to a regular file. 1>&2
					exit 1
				fi
			fi
		fi
	done
}

replaceEnvSecrets DOVECOT_

export DOVECOT_DEBUG="${DOVECOT_DEBUG:-no}"
export DOVECOT_POSTMASTER_EMAIL="${DOVECOT_POSTMASTER_EMAIL:-}"

export DOVECOT_RSPAMD_HOST="${DOVECOT_RSPAMD_HOST:-}"
export DOVECOT_RSPAMD_TLS="${DOVECOT_RSPAMD_TLS:-0}"
export DOVECOT_RSPAMD_TLS_SKIP_VERIFY="${DOVECOT_RSPAMD_TLS_SKIP_VERIFY:-0}"
export DOVECOT_RSPAMD_TLS_CA_FILE="${DOVECOT_RSPAMD_TLS_CA_FILE:-}"
export DOVECOT_RSPAMD_TLS_CERT_FILE="${DOVECOT_RSPAMD_TLS_CERT_FILE:-}"
export DOVECOT_RSPAMD_TLS_CERT_KEY_FILE="${DOVECOT_RSPAMD_TLS_CERT_KEY_FILE:-}"

if [ -n "$DOVECOT_RSPAMD_HOST" ]; then
	if [ "$DOVECOT_RSPAMD_TLS" -eq 0 ]; then
		export DOVECOT_RSPAMD_PORT="${DOVECOT_RSPAMD_PORT:-11334}"

		export _DOVECOT_RSPAMC_HOST="$DOVECOT_RSPAMD_HOST"
		export _DOVECOT_RSPAMC_PORT="$DOVECOT_RSPAMD_PORT"
	else
		export DOVECOT_RSPAMD_PORT="${DOVECOT_RSPAMD_PORT:-443}"

		export _DOVECOT_RSPAMC_HOST=127.0.0.20
		export _DOVECOT_RSPAMC_PORT=10000
	fi
fi

j2Templates="
/etc/dovecot/conf.d/10-mail.conf
/etc/dovecot/conf.d/10-logging.conf
/etc/dovecot/conf.d/90-quota.conf
/etc/dovecot/dovecot-sql.conf.ext
/etc/stunnel/stunnel.conf
"

for file in $j2Templates; do
	jinja2 -o "$file" "$file.j2"

	# can't use --reference with alpine
	chmod "$(stat -c '%a' "$file.j2")" "$file"
	chown "$(stat -c '%U:%G' "$file.j2")" "$file"
done

# Ensure mounted volume permissions
chown -R vmail:vmail /var/vmail

exec "$@"
