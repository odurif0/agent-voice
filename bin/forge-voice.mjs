#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { process.exitCode = await main(['forge', ...process.argv.slice(2)]) || 0; }
catch (error) { console.error(`forge-voice: ${error.message}`); process.exitCode = 1; }
