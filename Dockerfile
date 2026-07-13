FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY runs.html /srv/runs.html
COPY run.html /srv/run.html
COPY static /srv/static
COPY data /srv/data
CMD ["sh", "-c", "PORT=${PORT:-8080} exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
