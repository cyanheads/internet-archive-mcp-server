/**
 * @fileoverview Domain types for the Archive Search (Advanced Search) service.
 * @module services/archive-search/types
 */

/** A single search result item from the Internet Archive. */
export interface SearchResultItem {
  /** Collections the item belongs to, without `fav-` favorites lists. */
  collection?: string | string[];
  /** Creator or author name(s) — the first 10 when the record lists more. */
  creator?: string | string[];
  /** Full creator count, present only when `creator` was cut to its first 10. */
  creator_count?: number;
  /** Publication or upload date(s); a few records carry a list. */
  date?: string | string[];
  /** Total download count. */
  downloads?: number;
  /** Internet Archive item identifier. */
  identifier: string;
  /** Media type (texts, audio, movies, software, image, etc.). */
  mediatype?: string;
  /** Item title; a few records carry a list. */
  title?: string | string[];
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
