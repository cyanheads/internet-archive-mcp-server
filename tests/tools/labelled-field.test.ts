/**
 * @fileoverview Tests for the labelled-field renderer shared by ia_get_item and ia_search_items:
 * one value inline after its label, two or more as one list item each, and the item heading.
 * @module tests/tools/labelled-field.test
 */

import { describe, expect, it } from 'vitest';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';
import { pushItemHeading, pushLabelledField } from '@/mcp-server/tools/labelled-field.js';

/** The lines `pushLabelledField` appends to an empty array. */
const labelledField = (label: string, value: string | string[], note?: string): string[] => {
  const lines: string[] = [];
  pushLabelledField(lines, label, value, note);
  return lines;
};

/** The lines `pushItemHeading` appends to an empty array. */
const itemHeading = (title: string | string[] | undefined, identifier: string, level: 1 | 2) => {
  const lines: string[] = [];
  pushItemHeading(lines, title, identifier, level);
  return lines;
};

describe('pushLabelledField', () => {
  it('appends after the lines already there', () => {
    const lines = ['# x', '**Identifier:** x'];
    pushLabelledField(lines, 'Subjects', ['a', 'b']);
    pushLabelledField(lines, 'Date', '1894');
    expect(lines).toEqual([
      '# x',
      '**Identifier:** x',
      '**Subjects:**',
      '',
      '- a',
      '- b',
      '',
      '**Date:** 1894',
    ]);
  });

  it('renders a string inline after its label, commas and all', () => {
    expect(labelledField('Creator', 'Austen, Jane, 1775-1817')).toEqual([
      '**Creator:** Austen, Jane, 1775-1817',
    ]);
  });

  it('renders a one-value list exactly as its string', () => {
    expect(labelledField('Collection', ['americana'])).toEqual(['**Collection:** americana']);
  });

  it('escapes an inline value', () => {
    expect(labelledField('Volume', '*2*')).toEqual(['**Volume:** \\*2\\*']);
  });

  it('renders two or more values as the label, a blank line, one item per value, and a blank line', () => {
    expect(
      labelledField('Creator', ['Austen, Jane, 1775-1817', 'Thomson, Hugh, 1860-1920, ill']).join(
        '\n',
      ),
    ).toBe('**Creator:**\n\n- Austen, Jane, 1775-1817\n- Thomson, Hugh, 1860-1920, ill\n');
  });

  it('keeps every value its own item: empty, multi-line, edge spaces, entity-shaped, and marker-led', () => {
    expect(
      labelledField('Description', [
        '',
        'Photocopy\nMode of access: Internet',
        'Afganistan  ',
        'AT&amp;T',
        '- dash',
        '**bold**',
        '',
      ]),
    ).toEqual([
      '**Description:**',
      '',
      '- ',
      '- Photocopy\\\nMode of access: Internet',
      '- Afganistan&#32;&#32;',
      '- AT\\&amp;T',
      '- \\- dash',
      '- \\*\\*bold\\*\\*',
      '- ',
      '',
    ]);
  });

  it('renders each value through render when one is given, inline and as list items', () => {
    const link = (v: string) => `[${v}](<${v}>)`;
    const lines: string[] = [];
    pushLabelledField(lines, 'License', 'https://a', '', link);
    pushLabelledField(lines, 'License', ['https://a'], '', link);
    pushLabelledField(lines, 'License', ['https://a', 'https://b'], ' (2)', link);
    expect(lines).toEqual([
      '**License:** [https://a](<https://a>)',
      '**License:** [https://a](<https://a>)',
      '**License:** (2)',
      '',
      '- [https://a](<https://a>)',
      '- [https://b](<https://b>)',
      '',
    ]);
  });

  it('keeps a note on the label line: after the value inline, after the label for a list', () => {
    const note = ' (2 of 409; ia_get_item lists all)';
    expect(labelledField('Creator', 'A', note)).toEqual([
      '**Creator:** A (2 of 409; ia_get_item lists all)',
    ]);
    expect(labelledField('Creator', ['A', 'B'], note)).toEqual([
      '**Creator:** (2 of 409; ia_get_item lists all)',
      '',
      '- A',
      '- B',
      '',
    ]);
  });
});

describe('pushItemHeading', () => {
  it('uses the identifier when the title is absent or empty, at the given level', () => {
    expect(itemHeading(undefined, '00hamigoog', 1)).toEqual(['# 00hamigoog']);
    expect(itemHeading(undefined, '00hamigoog', 2)).toEqual(['## 00hamigoog']);
    expect(itemHeading('', '00hamigoog', 1)).toEqual(['# 00hamigoog']);
    expect(itemHeading([''], '00hamigoog', 1)).toEqual(['# 00hamigoog']);
  });

  it('uses a string or one-value title as the heading, escaped', () => {
    expect(itemHeading('Pride and prejudice', 'x', 1)).toEqual(['# Pride and prejudice']);
    expect(itemHeading(['*Pride*'], 'x', 2)).toEqual(['## \\*Pride\\*']);
  });

  it('keeps a title holding a line break out of the heading', () => {
    expect(itemHeading('First\nline', 'x', 1)).toEqual(['First\\\nline']);
    expect(itemHeading(['First\r\nline'], 'x', 2)).toEqual(['First\\\nline']);
  });

  it('falls back to the identifier for two or more titles and lists them under Title', () => {
    expect(itemHeading(['Afganistan ', 'Афганистанъ '], '00hamigoog', 1)).toEqual([
      '# 00hamigoog',
      '**Title:**',
      '',
      '- Afganistan&#32;',
      '- Афганистанъ&#32;',
      '',
    ]);
  });
});

describe('a field of 150,000 values through format()', () => {
  // Past the argument count a spread call (`lines.push(...block)`) can take on Node.
  const values = Array.from({ length: 150_000 }, (_, i) => `v${i}`);
  const items = (text: string) => text.split('\n').filter((line) => line.startsWith('- v')).length;

  it('renders every value of an ia_get_item field as its own item', () => {
    const [block] = iaGetItem.format!({
      identifier: 'x',
      subject: values,
      file_count: 0,
      files: [],
    }) as [{ text: string }];
    expect(block.text.startsWith('# x\n**Identifier:** x\n**Subjects:**\n\n- v0\n- v1\n')).toBe(
      true,
    );
    expect(block.text.endsWith('\n- v149999\n\n**Files (0):**')).toBe(true);
    expect(items(block.text)).toBe(150_000);
  });

  it('renders every value of an ia_search_items field as its own item', () => {
    const [block] = iaSearchItems.format!({
      items: [{ identifier: 'x', collection: values }],
      total_found: 1,
      page: 1,
      rows: 50,
    }) as [{ text: string }];
    expect(
      block.text.startsWith(
        '**1 total results** — Page 1 (1 shown, 50 per page)\n\n## x\n**Identifier:** x\n**Collection:**\n\n- v0\n- v1\n',
      ),
    ).toBe(true);
    expect(block.text.endsWith('\n- v149999\n')).toBe(true);
    expect(items(block.text)).toBe(150_000);
  });
});
