#!/usr/bin/env node
import { registry } from '@probelab/sandbox';
import { main } from './cli.js';

const result = await main(process.argv.slice(2), registry);
process.exitCode = result.exitCode;
