export function browserNodeImports(options: {
  root: string;
  entry: string;
  configFile?: string | false;
}): Promise<{
  modules: number;
  files: string[];
  violations: { module: string; chain: string[] }[];
}>;
