.PHONY: help install typecheck test ci

help:
	@echo "make install    install exact dependencies from package-lock.json"
	@echo "make typecheck  type-check every package"
	@echo "make test       run every package's tests"
	@echo "make ci         every gate CI runs, in the same order"

install:
	npm ci

typecheck:
	npm run typecheck

test:
	npm test

ci: typecheck test
