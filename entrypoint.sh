#!/bin/sh
set -e

# Allowlist of Google accounts, from a Railway env var so the emails never live
# in this public repo. Comma- or space-separated -> one per line.
: "${ALLOWED_EMAILS:?set ALLOWED_EMAILS (comma-separated Google accounts)}"
: "${OAUTH2_PROXY_CLIENT_ID:?set OAUTH2_PROXY_CLIENT_ID}"
: "${OAUTH2_PROXY_CLIENT_SECRET:?set OAUTH2_PROXY_CLIENT_SECRET}"
: "${OAUTH2_PROXY_COOKIE_SECRET:?set OAUTH2_PROXY_COOKIE_SECRET (32-byte)}"

printf '%s\n' "$ALLOWED_EMAILS" | tr ', ' '\n\n' | sed '/^[[:space:]]*$/d' > /tmp/emails.txt
echo "oauth2-proxy: allowlisting $(wc -l < /tmp/emails.txt) email(s)"

# Static server (internal, not exposed).
caddy start --config /etc/caddy/Caddyfile --adapter caddyfile

# Auth proxy on the public port. Secrets come from OAUTH2_PROXY_* env vars.
exec oauth2-proxy \
  --provider=google \
  --http-address="0.0.0.0:${PORT:-8080}" \
  --upstream="http://127.0.0.1:8081" \
  --redirect-url="${OAUTH2_PROXY_REDIRECT_URL:-https://arc3.sonpham.net/oauth2/callback}" \
  --authenticated-emails-file=/tmp/emails.txt \
  --email-domain="*" \
  --cookie-secure=true \
  --cookie-expire=168h \
  --reverse-proxy=true \
  --skip-provider-button=false \
  --whitelist-domain="arc3.sonpham.net"
