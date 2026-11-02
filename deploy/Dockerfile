FROM --platform=$BUILDPLATFORM node:24.19.0-bookworm-slim AS frontend
WORKDIR /src/modules/web
ENV COREPACK_ENABLE_AUTO_PIN=0
RUN corepack enable pnpm && corepack install --global pnpm@latest
COPY modules/web/package.json modules/web/pnpm-lock.yaml modules/web/pnpm-workspace.yaml ./
COPY modules/helper/package.json /src/modules/helper/package.json
RUN pnpm install --frozen-lockfile
COPY versions.toml /src/versions.toml
COPY scripts/versions.mjs scripts/versions.d.mts /src/scripts/
COPY modules/web/ ./
COPY modules/helper/ /src/modules/helper/
ARG OVS_BUILD_INFO
RUN pnpm --dir ../helper run build \
    && OVS_BUILD_INFO="${OVS_BUILD_INFO}" pnpm run build \
    && node /src/scripts/versions.mjs sync > /src/sync-version \
    && pnpm prune --prod \
    && pnpm licenses list --prod --json > /src/frontend-licenses.json

FROM --platform=$BUILDPLATFORM golang:latest AS backend
WORKDIR /src/modules/sync
COPY modules/sync/go.mod modules/sync/go.sum ./
RUN go mod download
COPY modules/sync/cmd/ cmd/
COPY modules/sync/internal/ internal/
COPY modules/sync/sql/ sql/
COPY scripts/go.mod scripts/go.sum /src/scripts/
COPY scripts/notices/ /src/scripts/notices/
COPY --from=frontend /src/modules/web/dist/ internal/web/dist/
COPY --from=frontend /src/modules/helper/dist/ internal/helper/dist/
COPY --from=frontend /src/modules/web/node_modules/ /src/modules/web/node_modules/
COPY --from=frontend /src/sync-version /src/sync-version
COPY --from=frontend /src/frontend-licenses.json /src/frontend-licenses.json
ARG CHANNEL=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -buildvcs=false -ldflags "-s -w -X main.version=$(cat /src/sync-version) -X main.channel=${CHANNEL}" -o /out/ovs ./cmd/ovs \
    && go -C /src/scripts run ./notices -sync /src/modules/sync -frontend /src/frontend-licenses.json > /out/THIRD_PARTY_NOTICES.txt \
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
