/**
 * @fileoverview Domain types for the Archive Search (Advanced Search) service.
 * @module services/archive-search/types
 */

/** A single search result item from the Internet Archive. */
export interface SearchResultItem {
  /** Primary collection the item belongs to. */
  collection?: string | string[];
  /** Creator or author name(s). */
  creator?: string | string[];
  /** Publication or upload date. */
  date?: string;
  /** Total download count. */
  downloads?: number;
  /** Internet Archive item identifier. */
  identifier: string;
  /** Media type (texts, audio, movies, software, image, etc.). */
  mediatype?: string;
  /** Item title. */
  title?: string;
}

/** Paginated search results. */
export interface SearchResult {
  /** Items returned for this page. */
  items: SearchResultItem[];
  /** Current page number (1-indexed). */
  page: number;
  /** Number of rows requested per page. */
  rows: number;
  /** Total number of matching items across all pages. */
  totalFound: number;
}
