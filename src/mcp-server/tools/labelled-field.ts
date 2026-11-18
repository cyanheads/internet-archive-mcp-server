/**
 * @fileoverview Markdown for the string-or-list metadata fields `ia_get_item` and `ia_search_items`
 * render: a labelled field, one list item per value when it holds two or more, and the item heading.
 * @module mcp-server/tools/labelled-field
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * Appends a labelled field to `lines` as Markdown lines. A string or a one-value list renders
 * inline after the label. Two or more values render as the label line, a blank line, one `- ` item
 * per value, and a blank line, so a value holding a comma or a line break keeps its boundaries. The
 * blank line after the label keeps an empty first item from reading as a setext underline; the one
 * after the list keeps the next line from continuing the last item. `note` is authored text kept on
 * the label line: after the value inline, after the label for a list. Items are appended one at a
 * time, since a list holds as many values as the upstream record sends.
 */
export function pushLabelledField(
  lines: string[],
  label: string,
  value: string | string[],
  note = '',
): void {
  if (typeof value === 'string' || value.length < 2) {
    const text = typeof value === 'string' ? value : (value[0] ?? '');
    lines.push(`**${label}:** ${escapeMarkdownInline(text)}${note}`);
    return;
  }
  lines.push(`**${label}:**${note}`, '');
  for (const v of value) lines.push(`- ${escapeMarkdownInline(v)}`);
  lines.push('');
}

/**
 * Appends an item's heading to `lines`. A string or one-value title is the heading text; an absent
 * or empty title, or a list of two or more, falls back to `identifier`, with the list under
 * `**Title:**`. A heading cannot hold a line break, so a title holding one renders as a plain line.
 */
export function pushItemHeading(
  lines: string[],
  title: string | string[] | undefined,
  identifier: string,
  level: 1 | 2,
): void {
  const titles = title === undefined ? [] : typeof title === 'string' ? [title] : title;
  const [only] = titles;
  const text = titles.length === 1 && only ? only : identifier;
  lines.push(
    /[\r\n]/.test(text)
      ? escapeMarkdownInline(text)
      : `${'#'.repeat(level)} ${escapeMarkdownInline(text)}`,
  );
  if (titles.length > 1) pushLabelledField(lines, 'Title', titles);
}
