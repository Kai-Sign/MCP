#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { id } from 'ethers';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const files = args.filter(a => a !== '--fix');

if (files.length === 0) {
  console.error('Usage: node scripts/metadata-selector-coverage.mjs [--fix] <metadata.json>...');
  process.exit(2);
}

function legacyType(input) {
  return input.type;
}

function canonicalType(input) {
  if (!input.type?.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  const inner = (input.components ?? []).map(canonicalType).join(',');
  return `(${inner})${suffix}`;
}

function signature(fn, mapper) {
  return `${fn.name}(${(fn.inputs ?? []).map(mapper).join(',')})`;
}

function selectorFor(fn) {
  if (fn.selector) return fn.selector.toLowerCase();
  return id(signature(fn, canonicalType)).slice(0, 10).toLowerCase();
}

function title(fn) {
  return fn.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function existingFormat(formats, fn, selector) {
  return formats[selector]
    ?? formats[signature(fn, canonicalType)]
    ?? formats[signature(fn, legacyType)]
    ?? formats[fn.name];
}

function genericFormat(fn) {
  const fields = (fn.inputs ?? []).map(input => ({
    path: `#.${input.name || 'arg'}`,
    label: input.name || 'Argument',
    format: input.type === 'address' ? 'addressName' : input.type === 'bytes' ? 'bytes' : 'raw'
  }));
  return {
    intent: `Review ${title(fn)} transaction`,
    ...(fields.length ? { fields } : {})
  };
}

let totalMissing = 0;
for (const file of files) {
  const metadata = JSON.parse(await readFile(file, 'utf8'));
  metadata.display ??= {};
  metadata.display.formats ??= {};
  const formats = metadata.display.formats;
  const functions = (metadata.context?.contract?.abi ?? []).filter(f => f.type === 'function');
  const missing = [];

  for (const fn of functions) {
    const selector = selectorFor(fn);
    const hasExactSelectorKey = Boolean(formats[selector]);
    const hasAnyUsableFormat = Boolean(existingFormat(formats, fn, selector));
    if (!hasExactSelectorKey) {
      missing.push({ fn, selector, hadSignatureOrNameFormat: hasAnyUsableFormat });
      if (fix) {
        formats[selector] = hasAnyUsableFormat ? existingFormat(formats, fn, selector) : genericFormat(fn);
      }
    }
  }

  totalMissing += missing.length;
  console.log(`${file}: ${functions.length} functions, ${missing.length} missing exact selector display keys`);
  for (const m of missing) {
    console.log(`  ${m.selector} ${signature(m.fn, canonicalType)}${m.hadSignatureOrNameFormat ? ' (aliased existing format)' : ' (generic)'}`);
  }

  if (fix && missing.length) {
    await writeFile(file, JSON.stringify(metadata, null, 2) + '\n');
  }
}

if (!fix && totalMissing) process.exit(1);
