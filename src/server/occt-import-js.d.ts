declare module 'occt-import-js' {
  export type OcctImportFactoryOptions = {
    locateFile?: (path: string) => string;
  };

  export type OcctImportModule = {
    ReadBrepFile: (content: Uint8Array, params: Record<string, unknown> | null) => unknown;
    ReadIgesFile: (content: Uint8Array, params: Record<string, unknown> | null) => unknown;
    ReadStepFile: (content: Uint8Array, params: Record<string, unknown> | null) => unknown;
  };

  const occtImport: (options?: OcctImportFactoryOptions) => Promise<OcctImportModule>;
  export default occtImport;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
