#!/usr/bin/env sh

if [ -z "${DOVECOT_POSTMASTER_EMAIL:-}" ]; then
  echo "$0": cancelled: missing DOVECOT_POSTMASTER_EMAIL environment variable >&2
  exit 0
fi

percent=$1
user=$2

cat <<EOF | /usr/libexec/dovecot/dovecot-lda -d "$user" -o "plugin/quota=maildir:Userquota:noenforcing"
From: $DOVECOT_POSTMASTER_EMAIL
Subject: Quota warning - $percent% reached

Hello,

Your mailbox $user can only store a limited amount of emails.
Currently it is $percent% full. If you reach 100% then
new emails cannot be stored.

Thanks for your understanding.
EOF
