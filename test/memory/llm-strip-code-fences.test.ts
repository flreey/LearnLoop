/**
 * Unit tests for stripCodeFences utility.
 * Covers: plain JSON, ```json wrapped, ``` wrapped, trailing text.
 */

import { describe, it, expect } from 'vitest';
import { stripCodeFences, parseMemoryResponse, parseReflectionResponse } from '../../src/llm/index.js';

describe('stripCodeFences', () => {
  it('returns plain JSON unchanged', () => {
    const input = '{"memories": []}';
    expect(stripCodeFences(input)).toBe('{"memories": []}');
  });

  it('strips ```json ... ``` code fence', () => {
    const input = '```json\n{"memories": []}\n```';
    expect(stripCodeFences(input)).toBe('{"memories": []}');
  });

  it('strips ``` ... ``` bare code fence', () => {
    const input = '```\n{"memories": []}\n```';
    expect(stripCodeFences(input)).toBe('{"memories": []}');
  });

  it('strips ```json fence and ignores trailing natural language text', () => {
    const input = '```json\n{"memories": []}\n```\nHere is the extracted data.';
    expect(stripCodeFences(input)).toBe('{"memories": []}');
  });

  it('strips fence with no newline after opening fence', () => {
    const input = '```json{"task_type": "code"}```';
    expect(stripCodeFences(input)).toBe('{"task_type": "code"}');
  });

  it('handles trimming of surrounding whitespace', () => {
    const input = '  \n{"memories": []}  \n  ';
    expect(stripCodeFences(input)).toBe('{"memories": []}');
  });

  it('handles multi-line JSON in fence', () => {
    const inner = '{\n  "memories": [\n    {"type": "fact"}\n  ]\n}';
    const input = '```json\n' + inner + '\n```';
    expect(stripCodeFences(input)).toBe(inner.trim());
  });
});

describe('parseMemoryResponse handles code-fenced JSON', () => {
  it('parses ```json-wrapped memory response correctly', () => {
    const fenced = '```json\n{"memories": [{"type": "preference", "content": "User prefers dark mode", "subject": "ui-theme", "confidence": 0.9, "importance": 0.7}]}\n```';
    const result = parseMemoryResponse(fenced);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('preference');
    expect(result[0].content).toBe('User prefers dark mode');
    expect(result[0].subject).toBe('ui-theme');
  });

  it('parses bare ```-wrapped memory response correctly', () => {
    const fenced = '```\n{"memories": [{"type": "fact", "content": "Alice is an engineer", "subject": "user-identity", "confidence": 0.95, "importance": 0.9}]}\n```';
    const result = parseMemoryResponse(fenced);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('fact');
  });

  it('parses plain JSON memory response correctly', () => {
    const plain = '{"memories": [{"type": "entity", "content": "OpenAI", "subject": "ai-company", "confidence": 0.99, "importance": 0.6}]}';
    const result = parseMemoryResponse(plain);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('entity');
  });

  it('returns empty array for completely invalid content', () => {
    expect(parseMemoryResponse('not json at all')).toEqual([]);
  });
});

describe('parseReflectionResponse handles code-fenced JSON', () => {
  const validReflection = {
    task_type: 'code',
    task_summary: 'Implement auth module',
    outcome: 'success',
    reflection: 'Task completed with TDD approach.',
    lessons: ['Write tests first'],
  };

  it('parses ```json-wrapped reflection response correctly', () => {
    const fenced = '```json\n' + JSON.stringify(validReflection) + '\n```';
    const result = parseReflectionResponse(fenced);
    expect(result).not.toBeNull();
    expect(result!.task_type).toBe('code');
    expect(result!.outcome).toBe('success');
  });

  it('parses plain JSON reflection response correctly', () => {
    const result = parseReflectionResponse(JSON.stringify(validReflection));
    expect(result).not.toBeNull();
    expect(result!.task_summary).toBe('Implement auth module');
  });

  it('returns null for invalid content', () => {
    expect(parseReflectionResponse('not json')).toBeNull();
  });
});
