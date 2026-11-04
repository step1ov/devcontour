export function browserNodeImports(options: {
  root: string;
  entry: string;
  configFile?: string | false;
  cacheDir?: string;
}): Promise<{ modules: number; violations: { module: string; chain: string[] }[] }>;
