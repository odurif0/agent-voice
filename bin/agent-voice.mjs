#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { process.exitCode = await main(process.argv.slice(2)) || 0; }
catch (error) { console.error(`agent-voice: ${error.message}`); process.exitCode = 1; }
