FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY static /srv/static
COPY data /srv/data
