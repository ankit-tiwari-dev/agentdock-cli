.PHONY: help install typecheck lint format hygiene test ci

help:
	@echo "make install    install exact dependencies from package-lock.json"
	@echo "make typecheck  type-check every package"
	@echo "make lint       ESLint plus the Prettier check"
	@echo "make format     rewrite files in the Prettier style"
	@echo "make hygiene    repo rules: names, planning refs, artifacts, pinned actions, lockfile"
	@echo "make test       run every package's tests"
	@echo "make ci         every gate CI runs, in the same order"

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
