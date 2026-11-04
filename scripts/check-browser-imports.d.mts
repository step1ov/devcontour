export function browserNodeImports(options: {
  root: string;
  entry: string;
  configFile?: string | false;
}): Promise<{ modules: number; violations: { module: string; chain: string[] }[] }>;
