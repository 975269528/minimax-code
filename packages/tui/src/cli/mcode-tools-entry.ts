#!/usr/bin/env node
import { configureMcodeToolsChildEnvironment } from './mcode-tools-environment.js';

configureMcodeToolsChildEnvironment();
const embeddedEntry = new URL('./embedded/mcode-tools/cli.mjs', import.meta.url);
await import(embeddedEntry.href);
