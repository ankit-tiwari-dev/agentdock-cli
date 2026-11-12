# The development environment for this repo: the Node and Go versions CI uses, plus git and make.
# For working on the CLI only. The CLI itself runs on the host, where the agent's hooks call it before
# every tool call (docs/DECISIONS.md, D-11).
FROM node:24-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496

# Go runs actionlint, gitleaks and osv-scanner (`go run ...` in .github/workflows), at the version CI uses.
COPY --from=golang:1.27-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:/home/node/go/bin:$PATH \
    NEXT_TELEMETRY_DISABLED=1

# The Go module cache is a volume (devcontainer.json); create it as the node user so it is writable.
RUN mkdir -p /home/node/go/pkg/mod && chown -R node:node /home/node/go

USER node
