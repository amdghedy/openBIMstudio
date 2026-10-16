/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly BASE_URL: string;
  readonly [key: string]: unknown;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: {
    accept(cb?: (mod: unknown) => void): void;
    accept(dep: string, cb: (mod: unknown) => void): void;
    dispose(cb: () => void): void;
    decline(): void;
    invalidate(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb: (...args: unknown[]) => void): void;
    send(event: string, data?: unknown): void;
    data: Record<string, unknown>;
  };
  glob(pattern: string): Record<string, unknown>;
  globEager(pattern: string): Record<string, unknown>;
}