#!/usr/bin/env bun
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadCatalog, validateCatalog } from '../src/catalog/io.ts';
import { getCatalogCoverage } from '../src/catalog/query.ts';

const root = resolve(import.meta.dir, '..');
const live = resolve(root, 'data/catalog/clawscape-live');
const directory = process.argv[2] ? resolve(process.argv[2]) : existsSync(live) ? live : resolve(root, 'data/catalog');
const catalog = loadCatalog(directory);
const validation = validateCatalog(catalog);
const report = { directory, coverage: getCatalogCoverage(catalog), warnings: validation.warnings, errors: validation.errors };
console.log(JSON.stringify(report, null, 2));
if (validation.errors.length) process.exitCode = 1;
