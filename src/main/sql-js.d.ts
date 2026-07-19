declare module 'sql.js' {
  interface InitSqlJsConfig {
    locateFile?: (file: string) => string;
  }

  type InitSqlJs = (config?: InitSqlJsConfig) => Promise<unknown>;

  const initSqlJs: InitSqlJs;
  export = initSqlJs;
}
