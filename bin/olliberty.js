#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
/* Olliberty CLI launcher. Keeps the published entry point stable while the
   compiled TypeScript lives under out/cli. */
'use strict';

const path = require('path');
const entry = path.join(__dirname, '..', 'out', 'cli', 'index.js');

let cli;
try {
  cli = require(entry);
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes(entry)) {
    process.stderr.write(
      'Olliberty CLI is not built yet.\nRun `npm run compile:cli` in the extension repository first.\n'
    );
    process.exit(1);
  }
  throw error;
}

cli
  .main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`olliberty: ${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
