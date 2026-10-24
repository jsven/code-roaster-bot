import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ and dist/ have the same directory depth relative to runtime assets.
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export const projectPath = (...parts: string[]): string => path.join(projectRoot, ...parts);
