.PHONY: help install typecheck lint format hygiene test ci devcontainer-check

help:
	@echo "make install    install exact dependencies from package-lock.json"
	@echo "make typecheck  type-check every package"
	@echo "make lint       ESLint plus the Prettier check"
	@echo "make format     rewrite files in the Prettier style"
	@echo "make hygiene    repo rules: names, planning refs, artifacts, pinned actions and images, lockfile"
	@echo "make test       run every package's tests"
	@echo "make ci         every gate CI runs, in the same order"
	@echo "make devcontainer-check  build the dev container and run make ci and actionlint in it (needs Docker; CI runs it too)"

install:
	npm ci

typecheck:
	npm run typecheck

lint:
	npm run lint
	npm run format:check

format:
	npm run format

hygiene:
	npm run hygiene

test:
	npm test

ci: lint typecheck hygiene test

# The repo is mounted read-only and cloned inside, so the check runs as the container's node user whoever owns the
# checkout, and sees only committed files. Run it from a normal clone: a git worktree's .git points outside the mount.
DEVCONTAINER_IMAGE ?= agentdock-cli-dev
devcontainer-check:
	docker build -t $(DEVCONTAINER_IMAGE) .devcontainer
	docker run --rm -v "$(CURDIR):/src:ro" $(DEVCONTAINER_IMAGE) bash -euo pipefail -c '\
		node -v; go version; make --version; git --version; \
		git config --global --add safe.directory /src; \
		git config --global --add safe.directory /src/.git; \
		git clone --quiet /src /home/node/work; \
		cd /home/node/work; \
		npm ci --no-audit --no-fund; \
		make ci; \
		go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -color'
