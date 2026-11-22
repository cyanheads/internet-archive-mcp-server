/**
 * @fileoverview Upstream text remains literal and URLs remain usable in tool Markdown.
 * @module tests/tools/markdown-format
 */
import { describe, expect, it } from 'vitest';
import { iaFindSnapshots } from '@/mcp-server/tools/definitions/ia-find-snapshots.tool.js';
import { iaGetItem } from '@/mcp-server/tools/definitions/ia-get-item.tool.js';
import { iaGetSnapshot } from '@/mcp-server/tools/definitions/ia-get-snapshot.tool.js';
import { iaGetText } from '@/mcp-server/tools/definitions/ia-get-text.tool.js';
import { iaSearchItems } from '@/mcp-server/tools/definitions/ia-search-items.tool.js';

describe('upstream Markdown syntax', () => {
  it('escapes document and snapshot text without altering the structured value', () => {
    const text = '*literal* [label](url)';
    const document = { text, source_file: 'a.txt', char_offset: 0, max_chars: 50, has_more: false };
    const snapshot = {
      text,
      replay_url: 'https://example.com/a_(b)',
      resolved_timestamp: '20200101000000',
      resolved_status: '200',
      char_offset: 0,
      max_chars: 50,
      has_more: false,
      total_chars: text.length,
    };
    expect(iaGetText.format!(document)).toEqual([
      { type: 'text', text: expect.stringContaining('\\*literal\\* \\[label\\](url)') },
    ]);
    expect(iaGetSnapshot.format!(snapshot)).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('[https://example.com/a\\_(b)](<https://example.com/a_(b)>)'),
      },
    ]);
    expect(document.text).toBe('*literal* [label](url)');
    expect(snapshot.text).toBe('*literal* [label](url)');
  });

  it('renders snapshot links as links whose text and URL read back as given, an empty label included', () => {
    const links = [
      { text: 'a] b', url: 'https://example.com/a' },
      { text: 'f(x) (2)', url: 'https://example.com/b' },
      { text: 'C:\\path\\', url: 'https://example.com/c' },
      { text: 'run `ls`', url: 'https://example.com/d' },
      { text: '', url: 'https://example.com/logo' },
      { text: '*star* <b> [x](y)', url: 'https://example.com/?q=<1>&a=(2) b&amp;' },
    ];
    const snapshot = {
      text: 'page',
      replay_url: 'https://example.com/',
      resolved_timestamp: '20200101000000',
      resolved_status: '200',
      char_offset: 0,
      max_chars: 50,
      has_more: false,
      total_chars: 4,
      links,
      total_links: 9,
    };
    // Each item, parsed as CommonMark, reads back its label as link text and its URL as the href.
    expect(iaGetSnapshot.format!(snapshot)).toEqual([
      {
        type: 'text',
        text: '**Replay URL:** [https://example.com/](<https://example.com/>)\n**Resolved Timestamp:** 20200101000000 | **Status:** 200\n**Offset:** 0 | **Max Chars:** 50 | **Total Chars:** 4 — end of text\n\n---\n\npage\n\n**Links on this page:** 6 of 9\n\n- [a\\] b](<https://example.com/a>)\n- [f(x) (2)](<https://example.com/b>)\n- [C:\\path\\\\](<https://example.com/c>)\n- [run \\`ls\\`](<https://example.com/d>)\n- [](<https://example.com/logo>)\n- [\\*star\\* \\<b> \\[x\\](y)](<https://example.com/?q=\\<1\\>&a=(2) b\\&amp;>)',
      },
    ]);
    expect(links[2]?.text).toBe('C:\\path\\');
  });

  it('escapes metadata and search titles and keeps multiline titles outside headings', () => {
    const metadata = {
      identifier: 'a',
      title: '*title*\n# data',
      rights: '<b>data</b>',
      file_count: 0,
      files: [],
    };
    const search = {
      items: [{ identifier: 'a', title: '*title*' }],
      total_found: 1,
      page: 1,
      rows: 50,
    };
    expect(iaGetItem.format!(metadata)).toEqual([
      { type: 'text', text: expect.stringMatching(/^\\\*title\\\*/) },
    ]);
    expect(iaGetItem.format!(metadata)).toEqual([
      { type: 'text', text: expect.stringContaining('\\<b>data\\</b>') },
    ]);
    expect(iaSearchItems.format!(search)).toEqual([
      { type: 'text', text: expect.stringContaining('## \\*title\\*') },
    ]);
  });

  it('escapes list titles, catalog fields, and descriptions in item Markdown, one item per list value', () => {
    const item = {
      identifier: 'a',
      title: ['*one*', '[two](x)'],
      publisher: '<i>Press</i>',
      volume: '*2*',
      description: ['# heading', '- item'],
      file_count: 0,
      files: [],
    };
    const [block] = iaGetItem.format!(item) as [{ text: string }];
    expect(block.text).toBe(
      '# a\n**Title:**\n\n- \\*one\\*\n- \\[two\\](x)\n\n**Identifier:** a\n**Publisher:** \\<i>Press\\</i>\n**Volume:** \\*2\\*\n\n**Description:**\n\n- \\# heading\n- \\- item\n\n**Files (0):**',
    );
    expect(item.title).toEqual(['*one*', '[two](x)']);
  });

  it('escapes each rights value and links each license URL in item Markdown, one item per list value', () => {
    const item = {
      identifier: 'a',
      licenseurl: ['https://example.org/*a*', 'CC0 <1.0>'],
      rights: ['<b>one</b>', '[two](x)'],
      file_count: 0,
      files: [],
    };
    const [block] = iaGetItem.format!(item) as [{ text: string }];
    expect(block.text).toBe(
      '# a\n**Identifier:** a\n**License:**\n\n- [https://example.org/\\*a\\*](<https://example.org/*a*>)\n- CC0 <1.0>\n\n**Rights:**\n\n- \\<b>one\\</b>\n- \\[two\\](x)\n\n**Files (0):**',
    );
    expect(item.licenseurl).toEqual(['https://example.org/*a*', 'CC0 <1.0>']);
  });

  it('escapes each file’s title, track, and length in its own nested item, line breaks as hard breaks', () => {
    const file = {
      name: 'a_b.mp3',
      title: '*Live* [set](x) <i>1</i>\n> quote\n1. not a list',
      track: '`1`',
      length: '| 06:21 |',
      download_url: 'https://archive.org/download/a/a_b.mp3',
    };
    const [block] = iaGetItem.format!({ identifier: 'a', file_count: 1, files: [file] }) as [
      { text: string },
    ];
    expect(block.text).toContain(
      '\n- **a_b.mp3**: [https://archive.org/download/a/a_b.mp3](<https://archive.org/download/a/a_b.mp3>)\n  - **Title:** \\*Live\\* \\[set\\](x) \\<i>1\\</i>\\\n\\> quote\\\n1\\. not a list\n  - **Track:** \\`1\\`\n  - **Length:** \\| 06:21 \\|',
    );
    expect(file.title).toBe('*Live* [set](x) <i>1</i>\n> quote\n1. not a list');
  });

  it('renders capture URLs as links and escapes opaque resume keys', () => {
    const result = {
      snapshots: [{ timestamp: '20200101', replay_url: 'https://example.com/a_(b)' }],
      resume_key: '*opaque*',
    };
    expect(iaFindSnapshots.format!(result)).toEqual([
      { type: 'text', text: expect.stringContaining('](<https://example.com/a_(b)>)') },
    ]);
    expect(iaFindSnapshots.format!(result)).toEqual([
      { type: 'text', text: expect.stringContaining('**Resume Key:** \\*opaque\\*') },
    ]);
    expect(result.resume_key).toBe('*opaque*');
  });
});
