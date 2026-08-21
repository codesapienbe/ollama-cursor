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
DIST_DIR := $(ROOT_DIR)/dist
PLUGIN_NAME := $(shell sed -n 's/^pluginName[[:space:]]*=[[:space:]]*//p' $(INTELLIJ_DIR)/gradle.properties | tr -d '\r')

.PHONY: guard-env install build-vscode build-cursor build-intellij build-cli bump-plugin-versions bundle \
	install-vscode install-cursor install-intellij reinstall-vscode \
	uninstall uninstall-vscode uninstall-cli uninstall-intellij \
	run run-vscode run-cursor run-intellij run-cli test-cli

guard-env:
	@if [ "$(ENV)" != "dev" ]; then \
		echo "Unsupported ENV=$(ENV). Only ENV=dev is supported right now."; \
		exit 1; \
	fi

# One shot: build every artifact, then install everything this machine can
# take — the extension into VS Code and/or Cursor, and the `olliberty` CLI on
# PATH. Editors that are not installed are skipped rather than failing the run.
# IntelliJ plugins cannot be installed from a shell, so its ZIP path is printed.
install: guard-env build-vscode install-intellij
	@installed=""; \
	for entry in "VS Code|$(VSCODE_BIN)" "Cursor|$(CURSOR_BIN)"; do \
		name="$${entry%%|*}"; bin="$${entry#*|}"; \
		if [ -x "$$bin" ]; then \
			"$$bin" --install-extension "$(VSIX)" --force && installed="$$installed $$name"; \
		else \
			echo "Skipping $$name: editor CLI not found at $$bin"; \
		fi; \
	done; \
	if [ -z "$$installed" ]; then \
		echo "No VS Code or Cursor CLI found. Install the VSIX by hand: $(VSIX)"; \
	fi; \
	echo ""; \
	echo "Extension installed into:$${installed:- (none)}"
	npm link
	@echo "CLI installed: olliberty ($$(command -v olliberty || echo 'restart your shell to pick it up'))"
	@echo ""
	@echo "Activate the new builds: VS Code/Cursor -> Developer: Reload Window, IntelliJ IDEA -> restart."

build-vscode:
	npm install
	npm run compile
	npx @vscode/vsce package

build-cursor: build-vscode
	@echo "Cursor uses the same VSIX artifact built for VS Code."

# The terminal client. Shares src/main/core with the extension.
build-cli:
	npm install
	npm run compile:cli

test-cli:
	npm run test:cli

build-intellij:
	cd "$(INTELLIJ_DIR)" && ./gradlew buildPlugin

bump-plugin-versions:
	node "$(ROOT_DIR)/scripts/bump-plugin-versions.mjs"

# Every installable artifact in one place: the VSIX (VS Code and Cursor), the
# IntelliJ plugin ZIP, and an npm tarball of the CLI. Versions are bumped first,
# so the names are resolved inside the recipe rather than at parse time.
bundle: bump-plugin-versions build-vscode build-intellij
	@rm -rf "$(DIST_DIR)" && mkdir -p "$(DIST_DIR)"
	@name=$$(node -p "require('$(ROOT_DIR)/package.json').name"); \
	version=$$(node -p "require('$(ROOT_DIR)/package.json').version"); \
	cp "$(ROOT_DIR)/$$name-$$version.vsix" "$(DIST_DIR)/"; \
	cp "$(INTELLIJ_DIR)"/build/distributions/*.zip "$(DIST_DIR)/"; \
	npm pack --pack-destination "$(DIST_DIR)" >/dev/null; \
	echo ""; \
	echo "Bundled into $(DIST_DIR):"; \
	ls -1 "$(DIST_DIR)" | sed 's/^/  /'; \
	echo ""; \
	echo "Install from the bundle:"; \
	echo "  code   --install-extension $(DIST_DIR)/$$name-$$version.vsix"; \
	echo "  cursor --install-extension $(DIST_DIR)/$$name-$$version.vsix"; \
	echo "  npm install -g $(DIST_DIR)/$$name-$$version.tgz"; \
	echo "  IntelliJ IDEA -> Settings -> Plugins -> Install Plugin from Disk... -> $(DIST_DIR)/$$(cd "$(DIST_DIR)" && ls -1 *.zip | head -1)"

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

# Installing an unpublished JetBrains plugin means unpacking it into the IDE's
# plugins directory — that is exactly what "Install Plugin from Disk..." does.
# Every IntelliJ IDEA configuration directory found gets it; point the search
# somewhere specific with JETBRAINS_PLUGIN_DIR=/path/to/plugins.
install-intellij: build-intellij
	@zip="$$(ls -1t "$(INTELLIJ_DIR)"/build/distributions/*.zip 2>/dev/null | head -1)"; \
	if [ -z "$$zip" ]; then \
		echo "No IntelliJ plugin ZIP in $(INTELLIJ_DIR)/build/distributions"; \
		exit 1; \
	fi; \
	if [ -n "$(JETBRAINS_PLUGIN_DIR)" ]; then \
		targets="$(JETBRAINS_PLUGIN_DIR)"; \
	else \
		targets="$$(ls -d "$$HOME"/Library/Application\ Support/JetBrains/*/ "$$HOME"/.local/share/JetBrains/*/ 2>/dev/null \
			| grep -Ei '/(IntelliJIdea|IdeaIC)[0-9]{4}\.[0-9]+/$$' | sed 's|/$$|/plugins|')"; \
	fi; \
	if [ -z "$$targets" ]; then \
		echo "No IntelliJ IDEA configuration directory found."; \
		echo "Install by hand: Settings -> Plugins -> gear -> Install Plugin from Disk... -> $$zip"; \
		exit 0; \
	fi; \
	printf '%s\n' "$$targets" | while IFS= read -r plugins; do \
		[ -n "$$plugins" ] || continue; \
		mkdir -p "$$plugins"; \
		rm -rf "$$plugins/$(PLUGIN_NAME)"; \
		unzip -qo "$$zip" -d "$$plugins"; \
		echo "IntelliJ plugin installed: $$plugins/$(PLUGIN_NAME)"; \
	done; \
	echo "Restart IntelliJ IDEA to load it."

uninstall-vscode:
	-"$(VSCODE_BIN)" --uninstall-extension "$(EXTENSION_ID)"

uninstall-intellij:
	@if [ -n "$(JETBRAINS_PLUGIN_DIR)" ]; then \
		targets="$(JETBRAINS_PLUGIN_DIR)"; \
	else \
		targets="$$(ls -d "$$HOME"/Library/Application\ Support/JetBrains/*/ "$$HOME"/.local/share/JetBrains/*/ 2>/dev/null \
			| grep -Ei '/(IntelliJIdea|IdeaIC)[0-9]{4}\.[0-9]+/$$' | sed 's|/$$|/plugins|')"; \
	fi; \
	printf '%s\n' "$$targets" | while IFS= read -r plugins; do \
		[ -n "$$plugins" ] || continue; \
		if [ -d "$$plugins/$(PLUGIN_NAME)" ]; then \
			rm -rf "$$plugins/$(PLUGIN_NAME)"; \
			echo "Removed $$plugins/$(PLUGIN_NAME)"; \
		fi; \
	done

uninstall-cli:
	-npm unlink -g olliberty

# Mirror of `install`: drop the extension, the IntelliJ plugin, and the CLI link.
uninstall: uninstall-vscode uninstall-intellij uninstall-cli

# Clean reinstall: drops the installed copy first so VS Code cannot reuse a
# cached build when the version number has not changed.
reinstall-vscode: build-vscode uninstall-vscode
	"$(VSCODE_BIN)" --install-extension "$(VSIX)" --force
	@echo ""
	@echo "Reinstalled $(notdir $(VSIX)). Reload the VS Code window to activate it."

run: guard-env run-vscode run-cursor run-intellij

run-cli:
	npm run cli -- --help

run-vscode:
	"$(VSCODE_BIN)" --extensionDevelopmentPath="$(ROOT_DIR)"

run-cursor:
	"$(CURSOR_BIN)" --extensionDevelopmentPath="$(ROOT_DIR)"

run-intellij:
	cd "$(INTELLIJ_DIR)" && ./gradlew runIde
