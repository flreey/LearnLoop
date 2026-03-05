/**
 * Tests for TASK-4.1: openclaw.plugin.json manifest and package.json openclaw.extensions.
 * Verifies AC1, AC2, AC3.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('openclaw.plugin.json', () => {
  let manifest: Record<string, unknown>;

  it('file exists', () => {
    const filePath = path.join(ROOT, 'openclaw.plugin.json');
    expect(fs.existsSync(filePath), 'openclaw.plugin.json should exist').toBe(true);
  });

  it('is valid JSON (AC3)', () => {
    const filePath = path.join(ROOT, 'openclaw.plugin.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(() => {
      manifest = JSON.parse(raw);
    }, 'JSON.parse should not throw').not.toThrow();
  });

  it('contains required field: name (AC1)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'openclaw.plugin.json'), 'utf-8');
    manifest = JSON.parse(raw);
    expect(typeof manifest.name).toBe('string');
    expect((manifest.name as string).length).toBeGreaterThan(0);
  });

  it('contains required field: version (AC1)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'openclaw.plugin.json'), 'utf-8');
    manifest = JSON.parse(raw);
    expect(typeof manifest.version).toBe('string');
    expect((manifest.version as string).length).toBeGreaterThan(0);
  });

  it('contains required field: description (AC1)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'openclaw.plugin.json'), 'utf-8');
    manifest = JSON.parse(raw);
    expect(typeof manifest.description).toBe('string');
    expect((manifest.description as string).length).toBeGreaterThan(0);
  });

  it('contains required field: hooks as non-empty array (AC1)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'openclaw.plugin.json'), 'utf-8');
    manifest = JSON.parse(raw);
    expect(Array.isArray(manifest.hooks), 'hooks should be an array').toBe(true);
    expect((manifest.hooks as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('package.json', () => {
  let pkg: Record<string, unknown>;

  it('is valid JSON (AC3)', () => {
    const filePath = path.join(ROOT, 'package.json');
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(() => {
      pkg = JSON.parse(raw);
    }, 'JSON.parse should not throw').not.toThrow();
  });

  it('contains openclaw.extensions field (AC2)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
    const extensions = (pkg as Record<string, Record<string, unknown>>)['openclaw']?.['extensions'];
    expect(extensions, 'openclaw.extensions should be defined').toBeDefined();
  });

  it('openclaw.extensions points to openclaw.plugin.json (AC2)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
    const extensions = (pkg as Record<string, Record<string, unknown>>)['openclaw']?.['extensions'];
    expect(extensions).toBe('./openclaw.plugin.json');
  });

  it('openclaw.extensions target file exists (AC2)', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
    const extensions = (pkg as Record<string, Record<string, unknown>>)['openclaw']?.['extensions'] as string;
    const resolvedPath = path.resolve(ROOT, extensions);
    expect(fs.existsSync(resolvedPath), `File at ${extensions} should exist`).toBe(true);
  });
});
