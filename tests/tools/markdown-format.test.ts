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
