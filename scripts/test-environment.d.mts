export function testEnvironment(base?: NodeJS.ProcessEnv): {
  home: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
};
