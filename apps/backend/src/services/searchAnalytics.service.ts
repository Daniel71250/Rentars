import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface SearchAnalytic {
  id?: string;
  query: string;
  filters?: Record<string, unknown>;
  result_count: number;
  user_id?: string;
  created_at?: string;
}

export interface SearchSuggestion {
  query: string;
  frequency: number;
  result_count?: number;
}

export interface TopQuery {
  query: string;
  frequency: number;
  avg_results?: number;
}

export interface DailyVolume {
  date: string;
  count: number;
}

/**
 * Minimum number of distinct events a cohort must contain before it is
 * surfaced through standard admin analytics. Cohorts below this threshold are
 * suppressed to prevent user-level behavioral surveillance.
 */
export const MIN_AGGREGATION_THRESHOLD = 5;

/**
 * Maximum span (in days) allowed for a single analytics query window.
 */
export const MAX_TIME_WINDOW_DAYS = 90;

/**
 * Allowlisted filter keys that may be applied to analytics queries. Arbitrary
 * filtering is rejected to prevent narrowing cohorts down to individuals.
 */
export const ALLOWED_ANALYTICS_FILTERS = ['category', 'content_type', 'result_bucket'] as const;
export type AllowedAnalyticsFilter = (typeof ALLOWED_ANALYTICS_FILTERS)[number];

export interface AnalyticsQueryOptions {
  /** Allowlisted filters only; unknown keys are rejected. */
  filters?: Partial<Record<AllowedAnalyticsFilter, string>>;
}

export interface AnalyticsMeta {
  start_date: string;
  end_date: string;
  min_cohort_size: number;
  suppressed: boolean;
}

export interface AggregatedTopQuery {
  /** Normalized query bucket (lowercased, trimmed, truncated). */
  query_bucket: string;
  frequency: number;
  avg_results?: number;
}

export interface AggregatedDailyVolume {
  date: string;
  count: number;
}

export interface AggregatedTrendingSearch {
  query_bucket: string;
  frequency: number;
}

export interface AggregatedResult<T> {
  items: T[];
  meta: AnalyticsMeta;
}

const MAX_QUERY_BUCKET_LENGTH = 64;

/**
 * Normalize a raw query string into a non-identifying bucket. Raw query
 * strings may contain PII (emails, names, addresses) so we lowercase, collapse
 * whitespace, strip obvious PII patterns, and truncate.
 */
export function normalizeQueryBucket(rawQuery: string): string {
  const collapsed = (rawQuery ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // Strip email-like and long numeric sequences that could identify a user.
  const scrubbed = collapsed
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[redacted]')
    .replace(/\b\d{6,}\b/g, '[redacted]');
  return scrubbed.slice(0, MAX_QUERY_BUCKET_LENGTH);
}

function validateTimeWindow(startDate: string, endDate: string): string | null {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Invalid date range';
  }
  if (start > end) {
    return 'start_date must be before end_date';
  }
  const spanDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (spanDays > MAX_TIME_WINDOW_DAYS) {
    return `Date range exceeds maximum window of ${MAX_TIME_WINDOW_DAYS} days`;
  }
  return null;
}

function validateFilters(filters?: Record<string, unknown>): string | null {
  if (!filters) return null;
  for (const key of Object.keys(filters)) {
    if (!(ALLOWED_ANALYTICS_FILTERS as readonly string[]).includes(key)) {
      return `Filter '${key}' is not permitted for analytics queries`;
    }
  }
  return null;
}

function buildMeta(startDate: string, endDate: string, suppressed: boolean): AnalyticsMeta {
  return {
    start_date: startDate,
    end_date: endDate,
    min_cohort_size: MIN_AGGREGATION_THRESHOLD,
    suppressed,
  };
}

/**
 * Track a search query for analytics and suggestions.
 */
export async function trackSearch(
  query: string,
  resultCount: number,
  userId?: string,
  filters?: Record<string, unknown>,
): Promise<ServiceResponse<SearchAnalytic>> {
  const { data, error } = await supabase
    .from('search_analytics')
    .insert({
      query: query.toLowerCase(),
      filters,
      result_count: resultCount,
      user_id: userId,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: data as SearchAnalytic };
}

/**
 * Get search suggestions based on frequency and recency.
 */
export async function getSearchSuggestions(
  prefix: string,
  limit = 10,
): Promise<ServiceResponse<SearchSuggestion[]>> {
  if (!prefix || prefix.length < 2) {
    return { success: true, data: [] };
  }

  const { data, error } = await supabase.rpc('get_search_suggestions', {
    search_prefix: `${prefix.toLowerCase()}%`,
    limit,
  });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as SearchSuggestion[] };
}

/**
 * Top queries by frequency over a date range. Index-backed via idx_search_analytics_created_at.
 * Returns normalized query buckets only; cohorts below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getTopQueries(
  startDate: string,
  endDate: string,
  limit = 20,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTopQuery>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_top_queries', {
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
  });

  if (error) return { success: false, error: error.message };

  const buckets = new Map<string, { frequency: number; totalResults: number }>();
  for (const row of (data ?? []) as TopQuery[]) {
    const bucket = normalizeQueryBucket(row.query);
    if (!bucket) continue;
    const existing = buckets.get(bucket);
    if (existing) {
      existing.frequency += row.frequency;
      existing.totalResults += (row.avg_results ?? 0) * row.frequency;
    } else {
      buckets.set(bucket, {
        frequency: row.frequency,
        totalResults: (row.avg_results ?? 0) * row.frequency,
      });
    }
  }

  const items: AggregatedTopQuery[] = [];
  for (const [query_bucket, agg] of buckets) {
    if (agg.frequency < MIN_AGGREGATION_THRESHOLD) continue;
    items.push({
      query_bucket,
      frequency: agg.frequency,
      avg_results: agg.frequency > 0 ? agg.totalResults / agg.frequency : undefined,
    });
  }
  items.sort((a, b) => b.frequency - a.frequency);

  return {
    success: true,
    data: { items: items.slice(0, limit), meta: buildMeta(startDate, endDate, items.length === 0) },
  };
}

/**
 * Zero-result queries by frequency over a date range. Index-backed via idx_search_analytics_zero_result.
 * Returns normalized query buckets only; cohorts below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getZeroResultQueries(
  startDate: string,
  endDate: string,
  limit = 20,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTopQuery>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_zero_result_queries', {
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
  });

  if (error) return { success: false, error: error.message };

  const buckets = new Map<string, { frequency: number; totalResults: number }>();
  for (const row of (data ?? []) as TopQuery[]) {
    const bucket = normalizeQueryBucket(row.query);
    if (!bucket) continue;
    const existing = buckets.get(bucket);
    if (existing) {
      existing.frequency += row.frequency;
      existing.totalResults += (row.avg_results ?? 0) * row.frequency;
    } else {
      buckets.set(bucket, {
        frequency: row.frequency,
        totalResults: (row.avg_results ?? 0) * row.frequency,
      });
    }
  }

  const items: AggregatedTopQuery[] = [];
  for (const [query_bucket, agg] of buckets) {
    if (agg.frequency < MIN_AGGREGATION_THRESHOLD) continue;
    items.push({
      query_bucket,
      frequency: agg.frequency,
      avg_results: agg.frequency > 0 ? agg.totalResults / agg.frequency : undefined,
    });
  }
  items.sort((a, b) => b.frequency - a.frequency);

  return {
    success: true,
    data: { items: items.slice(0, limit), meta: buildMeta(startDate, endDate, items.length === 0) },
  };
}

/**
 * Daily search volume over a date range. Days with fewer than
 * MIN_AGGREGATION_THRESHOLD events are suppressed.
 */
export async function getDailySearchVolume(
  startDate: string,
  endDate: string,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedDailyVolume>>> {
  const windowError = validateTimeWindow(startDate, endDate);
  if (windowError) return { success: false, error: windowError };
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const { data, error } = await supabase.rpc('get_daily_search_volume', {
    p_start_date: startDate,
    p_end_date: endDate,
  });

  if (error) return { success: false, error: error.message };

  const items: AggregatedDailyVolume[] = ((data ?? []) as DailyVolume[])
    .filter((row) => row.count >= MIN_AGGREGATION_THRESHOLD)
    .map((row) => ({ date: row.date, count: row.count }));

  return {
    success: true,
    data: { items, meta: buildMeta(startDate, endDate, items.length === 0) },
  };
}

/**
 * Record that relaxed-filter suggestions were offered or accepted.
 */
export async function trackSuggestionEvent(
  eventType: 'offered' | 'accepted',
  suggestionType: string,
  originalQuery?: string,
  userId?: string,
): Promise<void> {
  await supabase.from('search_suggestion_events').insert({
    event_type: eventType,
    suggestion_type: suggestionType,
    original_query: originalQuery,
    user_id: userId,
  });
}

/**
 * Get trending searches for the past 7 days. Returns normalized query buckets
 * only; buckets below MIN_AGGREGATION_THRESHOLD are suppressed.
 */
export async function getTrendingSearches(
  limit = 10,
  options: AnalyticsQueryOptions = {},
): Promise<ServiceResponse<AggregatedResult<AggregatedTrendingSearch>>> {
  const filterError = validateFilters(options.filters);
  if (filterError) return { success: false, error: filterError };

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);

  const startIso = startDate.toISOString();
  const endIso = endDate.toISOString();

  const { data, error } = await supabase
    .from('search_analytics')
    .select('query')
    .gte('created_at', startIso)
    .lte('created_at', endIso)
    .order('created_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  // Group by normalized bucket and count
  const counts = new Map<string, number>();
  for (const item of (data ?? []) as Array<{ query: string }>) {
    const bucket = normalizeQueryBucket(item.query);
    if (!bucket) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const items: AggregatedTrendingSearch[] = [];
  for (const [query_bucket, frequency] of counts) {
    if (frequency < MIN_AGGREGATION_THRESHOLD) continue;
    items.push({ query_bucket, frequency });
  }
  items.sort((a, b) => b.frequency - a.frequency);

  return {
    success: true,
    data: {
      items: items.slice(0, limit),
      meta: buildMeta(startIso, endIso, items.length === 0),
    },
  };
}
