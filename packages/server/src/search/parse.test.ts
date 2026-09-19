import { describe, expect, it } from 'vitest';
import { buildFtsMatch, parseSearch } from './parse';

describe('parseSearch', () => {
  it('extracts filters and free text', () => {
    const p = parseSearch('from:epic has:attachment is:unread 发票 报销');
    expect(p.from).toBe('epic');
    expect(p.hasAttachment).toBe(true);
    expect(p.unread).toBe(true);
    expect(p.text).toBe('发票 报销');
  });
  it('supports quoted values and starred', () => {
    const p = parseSearch('from:"Epic Games" is:starred "run failed"');
    expect(p.from).toBe('epic games');
    expect(p.starred).toBe(true);
    expect(p.text).toBe('run failed');
  });
  it('keeps unknown prefixes as text', () => {
    expect(parseSearch('http://x.y foo').text).toBe('http://x.y foo');
  });
  it('maps in: to folder and account: to account', () => {
    const p = parseSearch('in:junk account:QQ x');
    expect(p.folder).toBe('junk');
    expect(p.account).toBe('QQ');
  });
  it('accepts chinese aliases', () => {
    const p = parseSearch('has:附件 is:未读');
    expect(p.hasAttachment).toBe(true);
    expect(p.unread).toBe(true);
    expect(p.text).toBe('');
  });
});

describe('buildFtsMatch', () => {
  it('quotes and ANDs terms', () => {
    expect(buildFtsMatch('epic games')).toBe('"epic" AND "games"');
  });
  it('drops short terms and returns null when nothing usable', () => {
    expect(buildFtsMatch('ab 发票')).toBe(null);
    expect(buildFtsMatch('ab 发票单')).toBe('"发票单"');
  });
  it('escapes double quotes', () => {
    expect(buildFtsMatch('say"hi"')).toBe('"say""hi"""');
  });
});
