import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

let notion: Client | null = null;
const CACHE_DIR = process.env.CACHE_DIR || path.join('/tmp', 'notion-backend-cache');
const PARTS_CACHE_FILE = process.env.PARTS_CACHE_FILE || path.join(CACHE_DIR, 'parts-map.json');
const PARTS_CACHE_TTL_SEC = Number.parseInt(process.env.PARTS_CACHE_TTL_SEC || '300', 10);
const DATABASE_PAGES_CACHE_TTL_SEC = Number.parseInt(process.env.DATABASE_PAGES_CACHE_TTL_SEC || '60', 10);
const NESTED_DATABASE_CACHE_TTL_SEC = Number.parseInt(process.env.NESTED_DATABASE_CACHE_TTL_SEC || '300', 10);

export type StartupCacheWarmSummary = {
  calendarPages: number;
  failures: string[];
  nestedDatabases: number;
  partsEntries: number;
  warmedDatabases: number;
};

type PartsMapCachePayload = {
  databaseId: string;
  fetchedAt: number;
  partsMap: Record<string, string>;
};

let partsMapMemoryCache: PartsMapCachePayload | null = null;
let partsMapInFlight: Promise<Record<string, string>> | null = null;
const databasePagesMemoryCache = new Map<string, { fetchedAt: number; results: any[] }>();
const databasePagesInFlight = new Map<string, Promise<any[]>>();
const nestedDatabasesMemoryCache = new Map<string, { fetchedAt: number; ids: string[] }>();
const nestedDatabasesInFlight = new Map<string, Promise<string[]>>();
let startupCacheWarmInFlight: Promise<StartupCacheWarmSummary> | null = null;

export function initNotion() {
  if (!process.env.NOTION_TOKEN) {
    throw new Error('NOTION_TOKEN is missing. Please set it in .env');
  }
  notion = new Client({
    auth: process.env.NOTION_TOKEN,
    notionVersion: '2022-06-28'
  });
}

function getNotion(): Client {
  if (!notion) initNotion();
  return notion!;
}

function isFresh(timestampMs: number, ttlMs: number): boolean {
  return Date.now() - timestampMs < ttlMs;
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
}

function formatWarmupError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function readPartsMapCache(databaseId: string, ttlMs: number): Record<string, string> | null {
  if (partsMapMemoryCache && partsMapMemoryCache.databaseId === databaseId && isFresh(partsMapMemoryCache.fetchedAt, ttlMs)) {
    return partsMapMemoryCache.partsMap;
  }

  try {
    if (!fs.existsSync(PARTS_CACHE_FILE)) {
      return null;
    }

    const payload = JSON.parse(fs.readFileSync(PARTS_CACHE_FILE, 'utf8')) as PartsMapCachePayload;
    if (
      payload &&
      payload.databaseId === databaseId &&
      typeof payload.fetchedAt === 'number' &&
      payload.partsMap &&
      isFresh(payload.fetchedAt, ttlMs)
    ) {
      partsMapMemoryCache = payload;
      return payload.partsMap;
    }
  } catch {
    // Ignore a corrupt cache file and rebuild it from Notion below.
  }

  return null;
}

function writePartsMapCache(databaseId: string, partsMap: Record<string, string>) {
  const payload: PartsMapCachePayload = {
    databaseId,
    fetchedAt: Date.now(),
    partsMap,
  };

  partsMapMemoryCache = payload;

  try {
    ensureCacheDir();
    fs.writeFileSync(PARTS_CACHE_FILE, JSON.stringify(payload), 'utf8');
  } catch {
    // In-memory cache is still useful even if disk persistence fails.
  }
}

function getDatabasePagesCacheKey(databaseId: string, filter?: any, sorts?: any[]): string {
  return `${databaseId}::${JSON.stringify(filter ?? null)}::${JSON.stringify(sorts ?? null)}`;
}

function getNestedDatabasesCacheKey(pageId: string, targetTitle: string): string {
  return `${pageId}::${targetTitle}`;
}

export function invalidateDatabasePagesCache(databaseId?: string) {
  if (!databaseId) {
    databasePagesMemoryCache.clear();
    databasePagesInFlight.clear();
    return;
  }

  const prefix = `${databaseId}::`;
  for (const key of databasePagesMemoryCache.keys()) {
    if (key.startsWith(prefix)) {
      databasePagesMemoryCache.delete(key);
    }
  }
  for (const key of databasePagesInFlight.keys()) {
    if (key.startsWith(prefix)) {
      databasePagesInFlight.delete(key);
    }
  }
}

export async function getAllPages(databaseId: string, filter?: any, sorts?: any[]): Promise<any[]> {
  const ttlMs = Math.max(DATABASE_PAGES_CACHE_TTL_SEC, 0) * 1000;
  const cacheKey = getDatabasePagesCacheKey(databaseId, filter, sorts);
  const cached = databasePagesMemoryCache.get(cacheKey);
  if (ttlMs > 0 && cached && isFresh(cached.fetchedAt, ttlMs)) {
    return cached.results;
  }

  const inFlight = databasePagesInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const n = getNotion();
  const requestPromise = (async () => {
    const results: any[] = [];
    let cursor: string | undefined = undefined;

    while (true) {
      const response = await (n as any).request({
        path: `databases/${databaseId}/query`,
        method: 'POST',
        body: {
          filter: filter,
          sorts: sorts,
          page_size: 100,
          start_cursor: cursor || undefined,
        }
      });
      
      results.push(...response.results);
      if (!response.has_more) {
        break;
      }
      cursor = response.next_cursor || undefined;
    }

    if (ttlMs > 0) {
      databasePagesMemoryCache.set(cacheKey, {
        fetchedAt: Date.now(),
        results,
      });
    } else {
      databasePagesMemoryCache.delete(cacheKey);
    }

    return results;
  })();

  databasePagesInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    databasePagesInFlight.delete(cacheKey);
  }
}

export async function getCalendarPagesNextN(n: number = 4, lookaheadDays: number = 120): Promise<Array<{ id: string, title: string, date: string }>> {
  if (!process.env.CALENDAR_DATABASE_ID) throw new Error('CALENDAR_DATABASE_ID missing.');
  
  const today = new Date();
  const startDay = new Date();
  startDay.setDate(today.getDate() - 2); // 2 days ago
  const endDay = new Date();
  endDay.setDate(today.getDate() + 2); // 2 days from now
  
  const pages = await getAllPages(process.env.CALENDAR_DATABASE_ID, {
    and: [
      { property: '日付', date: { on_or_after: startDay.toISOString().split('T')[0] } },
      { property: '日付', date: { on_or_before: endDay.toISOString().split('T')[0] } }
    ]
  }, [
    { property: '日付', direction: 'ascending' }
  ]);
  
  const out: Array<{ id: string, title: string, date: string }> = [];
  for (const p of pages) {
    const props = (p as any).properties;
    const dStr = props['日付']?.date?.start || '';
    
    // Find title
    let title = '';
    for (const key in props) {
      if (props[key].type === 'title') {
        title = props[key].title?.[0]?.plain_text || '';
        break;
      }
    }
    
    if (p.id && dStr) {
      out.push({ id: p.id, title, date: dStr });
    }
  }
  
  return out;
}

export async function buildPartsMap(): Promise<Record<string, string>> {
  if (!process.env.PARTS_DATABASE_ID) throw new Error('PARTS_DATABASE_ID missing.');

  const databaseId = process.env.PARTS_DATABASE_ID;
  const ttlMs = Math.max(PARTS_CACHE_TTL_SEC, 0) * 1000;
  if (ttlMs > 0) {
    const cached = readPartsMapCache(databaseId, ttlMs);
    if (cached) {
      return cached;
    }
  }

  if (partsMapInFlight) {
    return partsMapInFlight;
  }

  partsMapInFlight = (async () => {
    const pages = await getAllPages(databaseId);
    const partsMap: Record<string, string> = {};

    for (const p of pages) {
      const props = (p as any).properties;
      const titleArr = props['品番']?.title;
      if (titleArr && titleArr.length > 0) {
        const name = titleArr[0].plain_text?.trim();
        if (name) {
          partsMap[name] = p.id;
        }
      }
    }

    if (ttlMs > 0) {
      writePartsMapCache(databaseId, partsMap);
    } else {
      partsMapMemoryCache = null;
    }

    return partsMap;
  })();

  try {
    return await partsMapInFlight;
  } finally {
    partsMapInFlight = null;
  }
}

export async function findNestedDatabases(pageId: string, targetTitle: string = '作業内容'): Promise<string[]> {
  const ttlMs = Math.max(NESTED_DATABASE_CACHE_TTL_SEC, 0) * 1000;
  const cacheKey = getNestedDatabasesCacheKey(pageId, targetTitle);
  const cached = nestedDatabasesMemoryCache.get(cacheKey);
  if (ttlMs > 0 && cached && isFresh(cached.fetchedAt, ttlMs)) {
    return cached.ids;
  }

  const inFlight = nestedDatabasesInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const n = getNotion();
  const requestPromise = (async () => {
    const found: string[] = [];

    async function _recursiveFind(parentId: string) {
      let cursor: string | undefined = undefined;
      while (true) {
        const response: any = await (n as any).request({
          path: `blocks/${parentId}/children`,
          method: 'GET',
          query: {
            page_size: 100,
            start_cursor: cursor || undefined,
          }
        });

        for (const b of response.results) {
          if (b.type === 'child_database') {
            const title = b.child_database.title;
            if (title.includes(targetTitle)) {
              found.push(b.id);
            }
          } else if (b.has_children) {
            // Recursive call for blocks like synced blocks, columns, etc.
            await _recursiveFind(b.id);
          }
        }

        if (!response.has_more) break;
        cursor = response.next_cursor || undefined;
      }
    }

    await _recursiveFind(pageId);

    if (ttlMs > 0) {
      nestedDatabasesMemoryCache.set(cacheKey, {
        fetchedAt: Date.now(),
        ids: found,
      });
    } else {
      nestedDatabasesMemoryCache.delete(cacheKey);
    }

    return found;
  })();

  nestedDatabasesInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    nestedDatabasesInFlight.delete(cacheKey);
  }
}

export async function updatePageProperties(pageId: string, properties: any) {
  const n = getNotion();
  return (n as any).request({
    path: `pages/${pageId}`,
    method: 'PATCH',
    body: { properties }
  });
}

export async function archivePage(pageId: string) {
  const n = getNotion();
  return (n as any).request({
    path: `pages/${pageId}`,
    method: 'PATCH',
    body: { archived: true }
  });
}

export async function createPage(parentDatabaseId: string, properties: any, icon?: any) {
  const n = getNotion();
  const response = await (n as any).request({
    path: `pages`,
    method: 'POST',
    body: {
      parent: { type: 'database_id', database_id: parentDatabaseId },
      properties,
      ...(icon ? { icon } : {})
    }
  });
  invalidateDatabasePagesCache(parentDatabaseId);
  return response;
}

export async function warmStartupCaches(): Promise<StartupCacheWarmSummary> {
  if (startupCacheWarmInFlight) {
    return startupCacheWarmInFlight;
  }

  startupCacheWarmInFlight = (async () => {
    const summary: StartupCacheWarmSummary = {
      calendarPages: 0,
      failures: [],
      nestedDatabases: 0,
      partsEntries: 0,
      warmedDatabases: 0,
    };

    const [partsMapResult, calendarPagesResult] = await Promise.allSettled([
      buildPartsMap(),
      getCalendarPagesNextN(),
    ]);

    if (partsMapResult.status === 'fulfilled') {
      summary.partsEntries = Object.keys(partsMapResult.value).length;
    } else {
      summary.failures.push(`parts map: ${formatWarmupError(partsMapResult.reason)}`);
    }

    let calendarPages: Array<{ id: string; title: string; date: string }> = [];
    if (calendarPagesResult.status === 'fulfilled') {
      calendarPages = calendarPagesResult.value;
      summary.calendarPages = calendarPages.length;
    } else {
      summary.failures.push(`calendar pages: ${formatWarmupError(calendarPagesResult.reason)}`);
    }

    if (calendarPages.length === 0) {
      return summary;
    }

    const nestedDatabaseResults = await Promise.allSettled(
      calendarPages.map((page) => findNestedDatabases(page.id, '作業内容')),
    );

    const nestedDatabaseIds = new Set<string>();
    nestedDatabaseResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        result.value.forEach((databaseId) => nestedDatabaseIds.add(databaseId));
        return;
      }

      const page = calendarPages[index];
      summary.failures.push(
        `nested dbs for ${page?.title || page?.id || `page-${index + 1}`}: ${formatWarmupError(result.reason)}`,
      );
    });

    const nestedDatabaseList = Array.from(nestedDatabaseIds);
    summary.nestedDatabases = nestedDatabaseList.length;

    if (nestedDatabaseList.length === 0) {
      return summary;
    }

    const nestedPageResults = await Promise.allSettled(
      nestedDatabaseList.map((databaseId) => getAllPages(databaseId)),
    );

    nestedPageResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        summary.warmedDatabases += 1;
        return;
      }

      summary.failures.push(
        `nested db pages ${nestedDatabaseList[index]}: ${formatWarmupError(result.reason)}`,
      );
    });

    return summary;
  })();

  try {
    return await startupCacheWarmInFlight;
  } finally {
    startupCacheWarmInFlight = null;
  }
}
