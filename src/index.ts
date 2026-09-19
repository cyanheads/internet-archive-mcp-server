#!/usr/bin/env node
/**
 * @fileoverview internet-archive-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allPromptDefinitions } from './mcp-server/prompts/definitions/index.js';
import { iaItemResource } from './mcp-server/resources/definitions/index.js';
import {
  iaFindSnapshots,
  iaGetItem,
  iaGetSnapshot,
  iaGetText,
  iaSearchItems,
} from './mcp-server/tools/definitions/index.js';
import { initArchiveMetadataService } from './services/archive-metadata/archive-metadata-service.js';
import { initArchiveSearchService } from './services/archive-search/archive-search-service.js';
import { initWaybackService } from './services/wayback/wayback-service.js';

await createApp({
  name: 'internet-archive-mcp-server',
  title: 'internet-archive-mcp-server',
  /**
   * No tool here calls `ctx.requestInput`, so nothing needs a live session.
   * Seeds `MCP_SESSION_MODE` when the environment does not set a meaningful
   * value; a deployment that sets it explicitly still wins.
   */
  sessionMode: 'stateless',
  tools: [iaFindSnapshots, iaGetSnapshot, iaSearchItems, iaGetItem, iaGetText],
  resources: [iaItemResource],
  prompts: allPromptDefinitions,
  instructions:
    'Internet Archive MCP server — access the Wayback Machine and the IA library.\n' +
    '- Wayback workflow: ia_find_snapshots → ia_get_snapshot\n' +
    '- Library workflow: ia_search_items → ia_get_item → ia_get_text (for text items)\n' +
    '- All tools are read-only; no credentials required.',
  setup(core) {
    initWaybackService(core.config, core.storage);
    initArchiveSearchService(core.config, core.storage);
    initArchiveMetadataService(core.config, core.storage);
  },
});
