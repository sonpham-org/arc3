# arc3-viewer: Caddy static server gated by oauth2-proxy (Google login).
# Public traffic hits oauth2-proxy on $PORT; only authenticated + allowlisted
# users are proxied through to Caddy (internal :8081). Allowlist + OAuth secrets
# come from Railway env vars (never committed) — see entrypoint.sh.
FROM quay.io/oauth2-proxy/oauth2-proxy:v7.7.1 AS proxy

FROM caddy:2-alpine
COPY --from=proxy /bin/oauth2-proxy /usr/local/bin/oauth2-proxy
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY runs.html /srv/runs.html
COPY run.html /srv/run.html
COPY harness.html /srv/harness.html
COPY viewer.html /srv/viewer.html
COPY signals.html /srv/signals.html
COPY usage.html /srv/usage.html
COPY static /srv/static
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
