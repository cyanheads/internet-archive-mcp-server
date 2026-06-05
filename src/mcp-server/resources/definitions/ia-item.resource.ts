/**
 * @fileoverview Resource definition for Internet Archive item metadata (ia://item/{identifier}).
 * @module mcp-server/resources/definitions/ia-item
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getArchiveMetadataService } from '@/services/archive-metadata/archive-metadata-service.js';

export const iaItemResource = resource('ia://item/{identifier}', {
  name: 'Internet Archive Item Metadata',
  description:
    'Metadata snapshot for an Internet Archive item — title, creator, mediatype, description, ' +
    'subjects, collections, date, license, and file count. Provides stable injectable context for ' +
    'agents that need to reference an item by URI without fetching the full file manifest.',
  mimeType: 'application/json',
  params: z.object({
    identifier: z
      .string()
      .describe(
        'Internet Archive item identifier, e.g. "pg1342". Obtain from ia_search_items results.',
      ),
  }),

  errors: [
    {
      reason: 'item_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The identifier does not exist in the Internet Archive.',
      recovery: 'Verify the identifier with ia_search_items or the Internet Archive website.',
    },
  ],

  async handler(params, ctx) {
    const svc = getArchiveMetadataService();
    const item = await svc.getItem(params.identifier, ctx);
    const meta = item.metadata;

    return {
      identifier: meta.identifier,
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.creator ? { creator: meta.creator } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.mediatype ? { mediatype: meta.mediatype } : {}),
      ...(meta.date ? { date: meta.date } : {}),
      ...(meta.subject ? { subject: meta.subject } : {}),
      ...(meta.collection ? { collection: meta.collection } : {}),
      ...(meta.licenseurl ? { licenseurl: meta.licenseurl } : {}),
      ...(meta.rights ? { rights: meta.rights } : {}),
      ...(meta.language ? { language: meta.language } : {}),
      file_count: item.files.length,
    };
  },

  list: async () => ({
    resources: [
      {
        uri: 'ia://item/pg1342',
        name: 'Example: Pride and Prejudice (pg1342)',
        mimeType: 'application/json',
      },
    ],
  }),
});
