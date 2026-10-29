FROM node:24.19.0-bookworm-slim AS frontend
WORKDIR /src/web
ENV COREPACK_ENABLE_AUTO_PIN=0
RUN corepack enable pnpm && corepack install --global pnpm@latest
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
COPY userscripts/ /src/userscripts/
RUN pnpm run build && pnpm prune --prod && pnpm licenses list --prod --json > /src/frontend-licenses.json

FROM golang:latest AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY migrations/ migrations/
COPY userscripts/ userscripts/
COPY scripts/notices/ scripts/notices/
COPY --from=frontend /src/internal/web/dist/ internal/web/dist/
COPY --from=frontend /src/web/node_modules/ web/node_modules/
COPY --from=frontend /src/frontend-licenses.json frontend-licenses.json
ARG VERSION=0.0.0-dev
ARG CHANNEL=dev
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=${VERSION} -X main.channel=${CHANNEL}" -o /out/ovs ./cmd/ovs \
    && go run ./scripts/notices -frontend frontend-licenses.json > /out/THIRD_PARTY_NOTICES.txt \
    && mkdir -p /out/data \
    && chown 10001:10001 /out/data \
    && chmod 0700 /out/data

FROM scratch
COPY --from=backend /out/ovs /ovs
COPY --from=backend --chown=10001:10001 /out/data /data
COPY --from=backend /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=backend /out/THIRD_PARTY_NOTICES.txt /licenses/THIRD_PARTY_NOTICES.txt
COPY LICENSE /licenses/LICENSE
USER 10001:10001
ENV OVS_LISTEN_ADDR=:8080 OVS_DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD ["/ovs", "healthcheck"]
ENTRYPOINT ["/ovs"]
