#!/usr/bin/env sh
# shellcheck disable=SC2086
set -eu

if [ -z "${_DOVECOT_RSPAMC_HOST:-}" ] || [ -z "${_DOVECOT_RSPAMC_PORT:-}" ]; then
  echo "$0": cancelled: missing _DOVECOT_RSPAMC_HOST and/or _DOVECOT_RSPAMC_PORT environment variables >&2
  exit 0
fi

if ! rspamcHostIp=$(getent hosts "$_DOVECOT_RSPAMC_HOST" | cut -d' ' -f1); then
  echo "$0": failed to lookup $_DOVECOT_RSPAMC_HOST >&2
  exit 1
fi

tmpFile=$(mktemp)
cat >"$tmpFile"

rspamcArgs="-h $rspamcHostIp:$_DOVECOT_RSPAMC_PORT"

set +e

if [ -n "$DOVECOT_RSPAMD_FUZZY_WHITE_TAG" ]; then
  rspamc $rspamcArgs -f "$DOVECOT_RSPAMD_FUZZY_WHITE_TAG" fuzzy_del "$tmpFile"
fi
if [ -n "$DOVECOT_RSPAMD_FUZZY_DENIED_TAG" ]; then
  rspamc $rspamcArgs -f "$DOVECOT_RSPAMD_FUZZY_DENIED_TAG" fuzzy_add "$tmpFile"
fi

rspamc $rspamcArgs learn_spam "$tmpFile"

set -e

rm "$tmpFile"
