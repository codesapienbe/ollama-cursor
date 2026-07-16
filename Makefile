SHELL := /bin/bash

ENV ?= dev
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
INTELLIJ_DIR := $(ROOT_DIR)/intellij-plugin

.PHONY: guard-env install build-vscode build-cursor build-intellij bundle run run-vscode run-cursor run-intellij

guard-env:
	@if [ "$(ENV)" != "dev" ]; then \
		echo "Unsupported ENV=$(ENV). Only ENV=dev is supported right now."; \
		exit 1; \
	fi

install: guard-env build-vscode build-cursor build-intellij

build-vscode:
	npm install
	npm run compile
	npx @vscode/vsce package

build-cursor: build-vscode
	@echo "Cursor uses the same VSIX artifact built for VS Code."

build-intellij:
	cd "$(INTELLIJ_DIR)" && ./gradlew buildPlugin

bundle: build-intellij
	@echo "IntelliJ plugin ZIP: $(INTELLIJ_DIR)/build/distributions"

run: guard-env run-vscode run-cursor run-intellij

run-vscode:
	code --extensionDevelopmentPath="$(ROOT_DIR)"

run-cursor:
	cursor --extensionDevelopmentPath="$(ROOT_DIR)"

run-intellij:
	cd "$(INTELLIJ_DIR)" && ./gradlew runIde
