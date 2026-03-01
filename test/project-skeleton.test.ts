/**
 * Tests for project skeleton setup — AC coverage for TASK-BE-0.1
 * Tests verify that the project structure, dependencies, and configuration are correct.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PROJECT_ROOT = path.resolve(__dirname, '..');

describe('Project build configuration', () => {
  it('tsconfig.json has strict mode enabled', () => {
    const tsconfigPath = path.join(PROJECT_ROOT, 'tsconfig.json');
    expect(fs.existsSync(tsconfigPath), 'tsconfig.json must exist').toBe(true);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.compilerOptions.strict, 'strict must be true in tsconfig').toBe(true);
  });
});

describe('Production dependencies', () => {
  it('better-sqlite3 is listed as a production dependency', () => {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('better-sqlite3');
  });

  it('minisearch is listed as a production dependency', () => {
    const pkgPath = path.join(PROJECT_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('minisearch');
  });

  it('better-sqlite3 can be imported without error', async () => {
    // Dynamic import to catch module resolution errors at runtime
    const mod = await import('better-sqlite3');
    expect(mod).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });

  it('minisearch can be imported without error', async () => {
    const mod = await import('minisearch');
    expect(mod).toBeDefined();
    // MiniSearch should be a class/constructor
    const MiniSearch = mod.default;
    expect(typeof MiniSearch).toBe('function');
  });
});

describe('Source directory structure', () => {
  const requiredDirs = [
    'src/storage',
    'src/search',
    'src/memory',
    'src/reflection',
    'src/hooks',
    'src/llm',
    'src/config',
    'src/types',
  ];

  for (const dir of requiredDirs) {
    it(`directory exists: ${dir}`, () => {
      const dirPath = path.join(PROJECT_ROOT, dir);
      expect(fs.existsSync(dirPath), `${dir} must exist`).toBe(true);
      expect(fs.statSync(dirPath).isDirectory(), `${dir} must be a directory`).toBe(true);
    });
  }
});

describe('Test directory structure', () => {
  it('test/fixtures/ directory exists', () => {
    const fixturesPath = path.join(PROJECT_ROOT, 'test', 'fixtures');
    expect(fs.existsSync(fixturesPath), 'test/fixtures/ must exist').toBe(true);
    expect(fs.statSync(fixturesPath).isDirectory(), 'test/fixtures/ must be a directory').toBe(true);
  });
});

describe('Database path configuration', () => {
  it('default database directory path resolves to ~/.openclaw/learnloop/', async () => {
    const { defaultConfig } = await import('../src/config/index.js');
    const expectedDir = path.join(os.homedir(), '.openclaw', 'learnloop');
    expect(defaultConfig.dbDir).toBe(expectedDir);
  });

  it('default database file path resolves to ~/.openclaw/learnloop/learnloop.db', async () => {
    const { defaultConfig } = await import('../src/config/index.js');
    const expectedPath = path.join(os.homedir(), '.openclaw', 'learnloop', 'learnloop.db');
    expect(defaultConfig.dbPath).toBe(expectedPath);
  });

  it('getConfig() returns the default configuration', async () => {
    const { getConfig, defaultConfig } = await import('../src/config/index.js');
    const config = getConfig();
    expect(config.dbDir).toBe(defaultConfig.dbDir);
    expect(config.dbPath).toBe(defaultConfig.dbPath);
  });
});
