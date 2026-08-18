SHELL := /bin/bash

ENV ?= dev
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
INTELLIJ_DIR := $(ROOT_DIR)/intellij-plugin

# Editor CLIs: prefer PATH, fall back to the macOS app bundle.
# Override on the command line, e.g. make install-vscode VSCODE_BIN=/usr/local/bin/code
VSCODE_BIN ?= $(shell command -v code 2>/dev/null || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
CURSOR_BIN ?= $(shell command -v cursor 2>/dev/null || echo "/Applications/Cursor.app/Contents/Resources/app/bin/cursor")

EXTENSION_ID := $(shell node -p "const p=require('$(ROOT_DIR)/package.json');p.publisher+'.'+p.name")
VSIX := $(ROOT_DIR)/$(shell node -p "const p=require('$(ROOT_DIR)/package.json');p.name+'-'+p.version+'.vsix'")

.PHONY: guard-env install build-vscode build-cursor build-intellij bump-plugin-versions bundle \
	install-vscode install-cursor reinstall-vscode uninstall-vscode \
	run run-vscode run-cursor run-intellij

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

bump-plugin-versions:
	node "$(ROOT_DIR)/scripts/bump-plugin-versions.mjs"

bundle: bump-plugin-versions build-intellij
	@echo "IntelliJ plugin ZIP: $(INTELLIJ_DIR)/build/distributions"

# Package the VSIX and install it into VS Code, replacing any existing copy.
install-vscode: build-vscode
	@if [ ! -x "$(VSCODE_BIN)" ]; then \
		echo "VS Code CLI not found at: $(VSCODE_BIN)"; \
		echo "Fix: VS Code -> Command Palette -> Shell Command: Install 'code' command in PATH"; \
		echo "Or:  make install-vscode VSCODE_BIN=/path/to/code"; \
		exit 1; \
	fi
	@if [ ! -f "$(VSIX)" ]; then echo "VSIX not found: $(VSIX)"; exit 1; fi
	"$(VSCODE_BIN)" --install-extension "$(VSIX)" --force
	@echo ""
	@echo "Installed $(notdir $(VSIX)) into VS Code."
	@echo "Reload the window to activate it: Command Palette -> Developer: Reload Window"

# Same, for Cursor.
install-cursor: build-vscode
	@if [ ! -x "$(CURSOR_BIN)" ]; then \
		echo "Cursor CLI not found at: $(CURSOR_BIN)"; \
		echo "Or: make install-cursor CURSOR_BIN=/path/to/cursor"; \
		exit 1; \
	fi
	@if [ ! -f "$(VSIX)" ]; then echo "VSIX not found: $(VSIX)"; exit 1; fi
	"$(CURSOR_BIN)" --install-extension "$(VSIX)" --force
	@echo "Installed $(notdir $(VSIX)) into Cursor. Reload the window to activate it."

uninstall-vscode:
	-"$(VSCODE_BIN)" --uninstall-extension "$(EXTENSION_ID)"

# Clean reinstall: drops the installed copy first so VS Code cannot reuse a
# cached build when the version number has not changed.
reinstall-vscode: build-vscode uninstall-vscode
	"$(VSCODE_BIN)" --install-extension "$(VSIX)" --force
	@echo ""
	@echo "Reinstalled $(notdir $(VSIX)). Reload the VS Code window to activate it."

run: guard-env run-vscode run-cursor run-intellij

run-vscode:
	"$(VSCODE_BIN)" --extensionDevelopmentPath="$(ROOT_DIR)"

run-cursor:
	"$(CURSOR_BIN)" --extensionDevelopmentPath="$(ROOT_DIR)"

run-intellij:
	cd "$(INTELLIJ_DIR)" && ./gradlew runIde
