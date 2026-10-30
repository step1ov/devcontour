import { rmSync } from 'node:fs';

// Only the generated root output; never resolve the path from the caller's cwd.
rmSync(new URL('../lib', import.meta.url), { recursive: true, force: true });
