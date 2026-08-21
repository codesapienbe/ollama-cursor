// SPDX-FileCopyrightText: 2026 Yilmaz Mustafa
// SPDX-License-Identifier: GPL-3.0-or-later
declare module 'sql.js' {
  interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }

  type InitSqlJs = (config?: InitSqlJsConfig) => Promise<unknown>;

  const initSqlJs: InitSqlJs;
  export = initSqlJs;
}
