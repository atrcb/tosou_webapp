import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

let notion: Client | null = null;

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

export async function getAllPages(databaseId: string, filter?: any, sorts?: any[]): Promise<any[]> {
  const n = getNotion();
  let results: any[] = [];
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
  return results;
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
  
  // Basic file-based cache could go here, omitting for brevity/cleanliness unless strictly needed
  const pages = await getAllPages(process.env.PARTS_DATABASE_ID);
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
  return partsMap;
}

export async function findNestedDatabases(pageId: string, targetTitle: string = '作業内容'): Promise<string[]> {
  const n = getNotion();
  let found: string[] = [];

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
  return found;
}

export async function updatePageProperties(pageId: string, properties: any) {
  const n = getNotion();
  return (n as any).request({
    path: `pages/${pageId}`,
    method: 'PATCH',
    body: { properties }
  });
}

export async function createPage(parentDatabaseId: string, properties: any) {
  const n = getNotion();
  return (n as any).request({
    path: `pages`,
    method: 'POST',
    body: {
      parent: { type: 'database_id', database_id: parentDatabaseId },
      properties
    }
  });
}
