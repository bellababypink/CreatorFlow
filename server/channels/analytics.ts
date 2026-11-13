import type { ChannelConnection, ChannelFilters, ChannelGroup, ChannelOverview, ChannelPost, ChannelSnapshot, ComparisonSeries, MetricValue } from '../../shared/channels.js';
import type { Workspace } from '../../shared/types.js';
import { HttpError } from '../errors.js';

export const ANALYTICS_LIMITATIONS = [
  'Post date filters select publication dates; they do not rewrite lifetime counts or the reporting windows returned with metrics.',
  'Associations are observational. Post age, audience size, distribution, selection bias, and incomplete synchronization can affect apparent performance.',
  'Different platforms, API endpoints, imported sources, metric definitions, and reporting windows are kept separate. There is no combined cross-platform views or engagement score.',
  'Missing metrics are unavailable, not zero. Video hooks, spoken captions, and visual editing patterns require linked, authorized video analysis.',
];
const additiveKeys = new Set(['views','view_count','viewCount','likes','like_count','likeCount','comments','comment_count','commentCount','shares','share_count','reach','impressions','watch_time','watch_time_seconds','estimatedMinutesWatched','estimated_minutes_watched','subscribersGained','subscribersLost','subscribers_gained','subscribers_lost','engagedViews']);

function isViewMetric(metric: MetricValue): boolean {
  return /^(?:views|view_count|viewCount)$/.test(metric.key) || /^(?:views|viewCount)$/.test(metric.providerMetric);
}
function metricIdentity(metric: MetricValue, provider: string): string {
  return JSON.stringify([provider,metric.source,metric.key,metric.comparisonKey,metric.definition,metric.unit,metric.scope,metric.periodStart,metric.periodEnd]);
}
/** Lifetime observations captured on different dates are different as-of cohorts. */
function aggregateIdentity(metric: MetricValue, provider: string): string {
  return JSON.stringify([metricIdentity(metric,provider),metric.scope==='lifetime'?metric.observedAt.slice(0,10):null]);
}
function aggregateComparisonKey(metric: MetricValue): string {
  return metric.scope==='lifetime'?`${metric.comparisonKey}:asof:${metric.observedAt.slice(0,10)}`:metric.comparisonKey;
}
function validMetric(metric: MetricValue): boolean {
  return Number.isFinite(metric.value) && metric.value >= 0 && Number.isFinite(Date.parse(metric.observedAt));
}
/** Never add repeated observations of the same post/metric/window. */
export function latestMetrics(metrics: MetricValue[], provider: string): MetricValue[] {
  const output = new Map<string,MetricValue>();
  for (const metric of metrics.filter(validMetric)) {
    const identity = metricIdentity(metric,provider);
    const previous = output.get(identity);
    if (!previous || metric.observedAt > previous.observedAt) output.set(identity,metric);
  }
  return [...output.values()];
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b), middle = Math.floor(sorted.length/2);
  return sorted.length%2 ? sorted[middle] : (sorted[middle-1]+sorted[middle])/2;
}
function durationGroup(seconds: number | null): string {
  if (seconds === null) return 'Unknown duration';
  if (seconds <= 30) return 'Up to 30 seconds';
  if (seconds <= 60) return '31–60 seconds';
  if (seconds <= 180) return '61–180 seconds';
  if (seconds <= 600) return '181–600 seconds';
  return 'Over 600 seconds';
}
function deriveAllowed(post: ChannelPost): boolean {
  return post.source === 'manual_import' || post.provider !== 'youtube' || process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED === 'true';
}
function summarizeGroups(posts: ChannelPost[], connections: Map<string,ChannelConnection>, labels: (post: ChannelPost)=>string[]): ChannelGroup[] {
  const buckets = new Map<string,{label:string;posts:Set<string>;values:number[];metricKey:string|null;comparisonKey:string|null;restricted:boolean}>();
  for (const post of posts) {
    const connection = connections.get(post.connectionId)!;
    const metrics = latestMetrics(post.metrics,post.provider).filter(isViewMetric);
    // Prefer the newest reporting observation, but retain its exact cohort.
    const view = metrics.sort((a,b)=>b.observedAt.localeCompare(a.observedAt) || (a.scope==='period'?0:1)-(b.scope==='period'?0:1))[0];
    for (const group of [...new Set(labels(post))]) {
      const cohort = view ? aggregateIdentity(view,post.provider) : 'unavailable';
      const identity = JSON.stringify([post.connectionId,group,cohort]);
      let bucket = buckets.get(identity);
      if (!bucket) {
        bucket = {label:`${connection.accountName} · ${post.provider} · ${group}${view ? ` · ${view.scope}${view.periodStart ? ` ${view.periodStart}–${view.periodEnd}`:view.scope==='lifetime'?` as of ${view.observedAt.slice(0,10)}`:''}`:''}`,posts:new Set(),values:[],metricKey:view?.key||null,comparisonKey:view?aggregateComparisonKey(view):null,restricted:false};
        buckets.set(identity,bucket);
      }
      bucket.posts.add(post.id);
      if (view && deriveAllowed(post)) bucket.values.push(view.value);
      if (!deriveAllowed(post)) bucket.restricted = true;
    }
  }
  return [...buckets.values()].map(bucket=>({label:bucket.label,posts:bucket.posts.size,postsWithMetric:bucket.values.length,median:median(bucket.values),metricKey:bucket.metricKey,comparisonKey:bucket.comparisonKey,
    caveat:bucket.restricted?'Derived YouTube pattern analysis awaits developer approval. Inspect the original per-post metrics.':'Median uses each post’s newest view observation within this account, source, definition, reporting window and lifetime as-of date. Small samples and post age prevent causal conclusions.'}));
}

export function buildChannelOverview(posts: ChannelPost[], snapshots: ChannelSnapshot[], connections: ChannelConnection[], filters: ChannelFilters, workspace?: Workspace): ChannelOverview {
  for (const value of [filters.startDate,filters.endDate]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)) throw new HttpError(400,'Date filters must be valid YYYY-MM-DD dates.');
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) throw new HttpError(400,'Start date must not follow end date.');
  const selectedConnections = connections.filter(connection=>(!workspace || connection.workspaceId === workspace.id) && (!filters.platform || connection.provider === filters.platform) && (!filters.connectionId || connection.id === filters.connectionId));
  const connectionMap = new Map(selectedConnections.map(connection=>[connection.id,connection]));
  const selectedPosts = posts.filter(post=>{
    const connection = connectionMap.get(post.connectionId);
    return connection && post.workspaceId === connection.workspaceId && post.provider === connection.provider && (!filters.startDate || post.publishedAt.slice(0,10)>=filters.startDate) && (!filters.endDate || post.publishedAt.slice(0,10)<=filters.endDate) && (!filters.contentType || post.contentType === filters.contentType) && (!filters.pillar || post.pillar === filters.pillar);
  }).map(post=>({...post,metrics:latestMetrics(post.metrics,post.provider)})).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  const limitations = [...ANALYTICS_LIMITATIONS];
  const latestSnapshots = new Map<string,ChannelSnapshot>();
  for (const snapshot of snapshots) {
    const connection = connectionMap.get(snapshot.connectionId);
    if (!connection || connection.workspaceId !== snapshot.workspaceId || connection.provider !== snapshot.provider) continue;
    const prior = latestSnapshots.get(snapshot.connectionId);
    if (!prior || `${snapshot.observedAt}${snapshot.createdAt}` > `${prior.observedAt}${prior.createdAt}`) latestSnapshots.set(snapshot.connectionId,snapshot);
  }
  let selectedSnapshots = [...latestSnapshots.values()];
  if (filters.contentType || filters.pillar) {
    selectedSnapshots = [];
    limitations.push('Account-level history and audience data are hidden while content-type or pillar filters are active because those reports cannot be filtered to these post labels.');
  } else {
    selectedSnapshots = selectedSnapshots.map(snapshot=>({...snapshot,daily:snapshot.daily.filter(day=>(!filters.startDate || day.date>=filters.startDate) && (!filters.endDate || day.date<=filters.endDate))}));
  }
  for (const snapshot of selectedSnapshots) limitations.push(...snapshot.coverage.limitations);
  if (selectedSnapshots.some(snapshot=>snapshot.coverage.hasMore)) limitations.push('Synchronization was capped. This is a partial post inventory; do not treat it as the complete channel history.');
  if (selectedPosts.some(post=>!post.mediaAssetId)) limitations.push('Some posts have no linked original video. Their actual opening hook, speech, and visual patterns have not been observed.');
  if (selectedPosts.some(post=>post.provider==='youtube' && post.source!=='manual_import') && process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED !== 'true') limitations.push('YouTube API content categories, custom scores, inferred audiences and full generative pattern analysis are unavailable until the applicable developer approval is recorded. Only returned metrics and explicit labels are shown.');
  const comparisons: ComparisonSeries[] = selectedConnections.map(connection=>{
    const accountPosts = selectedPosts.filter(post=>post.connectionId === connection.id);
    const nativeYouTube = connection.provider === 'youtube' && connection.source === 'oauth' && process.env.YOUTUBE_DERIVED_ANALYTICS_APPROVED !== 'true';
    if (nativeYouTube) {
      const snapshot = selectedSnapshots.find(item=>item.connectionId===connection.id);
      return {connectionId:connection.id,accountName:connection.accountName,provider:connection.provider,source:connection.source,posts:accountPosts.length,postsPerWeek:null,
        metrics:latestMetrics(snapshot?.accountMetrics || [],connection.provider).map(metric=>({key:metric.key,label:metric.label,definition:`Native account report, not recomputed from the selected post subset. ${metric.definition}`,unit:metric.unit,total:metric.value,postsWithMetric:0,comparisonKey:metric.comparisonKey,scope:metric.scope,periodStart:metric.periodStart,periodEnd:metric.periodEnd}))};
    }
    const groups = new Map<string,ComparisonSeries['metrics'][number]>();
    for (const post of accountPosts) for (const metric of post.metrics) {
      if (!additiveKeys.has(metric.key) && !additiveKeys.has(metric.providerMetric)) continue;
      // Reach is unique within each post. Its sum is explicitly post-level, not account unique reach.
      const identity = aggregateIdentity(metric,post.provider);
      const existing = groups.get(identity);
      if (existing) { existing.total += metric.value; existing.postsWithMetric++; }
      else groups.set(identity,{key:metric.key,label:metric.key==='reach'?'Sum of post reach (not unique)':metric.label,definition:`Sum across selected post observations only.${metric.scope==='lifetime'?` Observed as of ${metric.observedAt.slice(0,10)}.`:''} ${metric.definition}${metric.key==='reach'?' People may appear in multiple posts; this is not account-level unique reach.':''}`,unit:metric.unit,total:metric.value,postsWithMetric:1,comparisonKey:aggregateComparisonKey(metric),scope:metric.scope,periodStart:metric.periodStart,periodEnd:metric.periodEnd});
    }
    const dateStart = filters.startDate || accountPosts.at(-1)?.publishedAt.slice(0,10), dateEnd = filters.endDate || accountPosts[0]?.publishedAt.slice(0,10);
    const days = dateStart && dateEnd ? Math.floor((Date.parse(dateEnd+'T00:00:00Z')-Date.parse(dateStart+'T00:00:00Z'))/86_400_000)+1 : 0;
    return {connectionId:connection.id,accountName:connection.accountName,provider:connection.provider,source:connection.source,posts:accountPosts.length,postsPerWeek:days>0?accountPosts.length/days*7:null,metrics:[...groups.values()]};
  });
  const allPillars = posts.filter(post=>connectionMap.has(post.connectionId) && post.workspaceId === connectionMap.get(post.connectionId)!.workspaceId).flatMap(post=>post.pillar?[post.pillar]:[]);
  const publicationDates = selectedPosts.map(post=>post.publishedAt.slice(0,10)).sort();
  return {
    posts:selectedPosts,snapshots:selectedSnapshots,comparisons,
    groups:{lengths:summarizeGroups(selectedPosts,connectionMap,post=>[durationGroup(post.durationSeconds)]),pillars:summarizeGroups(selectedPosts,connectionMap,post=>[post.pillar||'Unlabelled']),formats:summarizeGroups(selectedPosts,connectionMap,post=>[post.contentType]),topics:summarizeGroups(selectedPosts,connectionMap,post=>post.tags.length?post.tags:['No source tags'])},
    coverage:{posts:selectedPosts.length,accounts:selectedConnections.length,periodStart:filters.startDate||publicationDates[0]||null,periodEnd:filters.endDate||publicationDates.at(-1)||null,limitations:[...new Set(limitations)]},
    pillars:[...new Set(allPillars)].sort(),filters:{...filters},
  };
}
