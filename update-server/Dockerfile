# syntax=docker/dockerfile:1
#
# Update server + download page for Unity Project Sync.
# Build context is this folder (Coolify: Base Directory /update-server, Dockerfile Location /Dockerfile):
#   docker build -t ups-update-server ./update-server

# ---------- build: static musl binary ----------
FROM rust:1.99-alpine3.24 AS build
RUN apk add --no-cache musl-dev
WORKDIR /src

# Dependency layer: only rebuilt when Cargo.toml / Cargo.lock change.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
 && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src

# The real sources (static/ is embedded with include_bytes!).
COPY src ./src
COPY static ./static
RUN touch src/main.rs && cargo build --release --locked

# ---------- runtime ----------
FROM alpine:3.24
# busybox wget (in the base image) serves the HEALTHCHECK; nothing else is needed.
RUN addgroup -S -g 10001 app \
 && adduser -S -D -H -u 10001 -G app -s /sbin/nologin app \
 && mkdir -p /data/releases
COPY --from=build /src/target/release/update-server /usr/local/bin/update-server

ENV PORT=8080 \
    RELEASES_DIR=/data/releases
EXPOSE 8080
# The server only reads RELEASES_DIR; it never writes anything.
USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/update-server"]
