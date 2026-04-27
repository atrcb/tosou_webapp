import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import * as logic from './logic.js';
import * as notion from './notion.js';
import * as notionUtils from './notionUtils.js';
import { resolveWorkflowManagerNestedDatabase } from './workflowNotion.js';

const NOTION_PAGE_ICON = { type: 'emoji', emoji: '⚙️' };

type WorkflowProduct = {
  id: string;
  selected: boolean;
  colorAccent: boolean;
  override: boolean;
  trial: string;
  part: string;
  color: string;
  qty: string;
  ct: number;
  date: string;
  sourceRows?: number[];
  alreadySynced?: boolean;
};

type ExistingColorPage = {
  id: string;
  properties: Record<string, any>;
};

type ProductLineMatch = {
  targetIndex: number | null;
  partPageId: string | null;
};

const EXCEL_HIGHLIGHT_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FFFFFF00' },
};

const HIGHLIGHT_START_COLUMN = 2;
const HIGHLIGHT_END_COLUMN = 10;

function cloneExcelValue<T>(value: T): T {
  if (value == null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function getProductPartVariants(part: string, color: string): string[] {
  const variants = [logic.cleanStr(part)];
  const normalizedColor = logic.normalizeColorKey(color);
  if (variants[0] && normalizedColor) {
    variants.push(`${variants[0]}(${normalizedColor})`);
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

function resolvePartPageId(
  partVariants: string[],
  partsMapLocal: Record<string, string>,
  partsKeyIndex?: notionUtils.PartsKeyIndex,
): string | null {
  const keys = partsKeyIndex || notionUtils.buildPartsKeyIndex(partsMapLocal);
  let bestKey: string | null = null;
  let bestLength = -1;

  for (const variant of partVariants) {
    for (const key of keys) {
      if (bestLength >= 0 && key.length < bestLength) {
        break;
      }
      if (variant.startsWith(key) && key.length > bestLength) {
        bestKey = key;
        bestLength = key.length;
      }
    }
  }

  return bestKey ? partsMapLocal[bestKey] : null;
}

function locateProductInPartsRichText(
  partsRt: any[],
  partsMapLocal: Record<string, string>,
  product: Pick<WorkflowProduct, 'part' | 'color' | 'date'>,
  partsKeyIndex?: notionUtils.PartsKeyIndex,
): ProductLineMatch {
  const partVariants = getProductPartVariants(product.part, product.color);
  const partPageId = resolvePartPageId(partVariants, partsMapLocal, partsKeyIndex);
  const normalizedDate = logic.cleanStr(product.date);

  for (const variant of partVariants) {
    const targetIndex = notionUtils.findPartLineIndex(partsRt, partPageId, variant, normalizedDate, false);
    if (targetIndex !== null) {
      return { targetIndex, partPageId };
    }

    if (normalizedDate) {
      const fallbackIndex = notionUtils.findPartLineIndex(partsRt, partPageId, variant, '', false);
      if (fallbackIndex !== null) {
        return { targetIndex: fallbackIndex, partPageId };
      }
    }
  }

  if (partPageId) {
    const targetIndex = notionUtils.findPartLineIndex(partsRt, partPageId, '', normalizedDate, false);
    if (targetIndex !== null) {
      return { targetIndex, partPageId };
    }
  }

  return { targetIndex: null, partPageId };
}

function buildExistingColorPageIndex(existingPages: any[]): Record<string, ExistingColorPage> {
  const existingByColor: Record<string, ExistingColorPage> = {};

  for (const page of existingPages) {
    const props = (page as any).properties || {};
    const titleArr = props['色']?.title;
    if (!titleArr?.length) continue;
    const colorKey = logic.normalizeColorKey(titleArr[0].plain_text?.trim() || '');
    if (!colorKey) continue;
    existingByColor[colorKey] = page as ExistingColorPage;
  }

  return existingByColor;
}

function applyHighlightToRow(row: ExcelJS.Row) {
  for (let i = HIGHLIGHT_START_COLUMN; i <= HIGHLIGHT_END_COLUMN; i += 1) {
    const cell = row.getCell(i);
    const nextStyle = cloneExcelValue(cell.style) || {};
    nextStyle.fill = cloneExcelValue(EXCEL_HIGHLIGHT_FILL);
    cell.style = nextStyle;
  }
}

async function annotateProductsWithNotionState(products: WorkflowProduct[], pageId?: string): Promise<WorkflowProduct[]> {
  const baseProducts = products.map((product) => ({ ...product, alreadySynced: false }));
  if (!pageId || baseProducts.length === 0) {
    return baseProducts;
  }

  const partsMapPromise = notion.buildPartsMap();
  let nestedId: string | null = null;
  try {
    ({nestedId} = await resolveWorkflowManagerNestedDatabase(pageId, '作業内容'));
  } catch {
    return baseProducts;
  }

  const [existingPages, partsMapLocal] = await Promise.all([
    notion.getAllPages(nestedId),
    partsMapPromise,
  ]);
  const partsKeyIndex = notionUtils.buildPartsKeyIndex(partsMapLocal);
  const existingByColor = buildExistingColorPageIndex(existingPages);

  return baseProducts.map((product) => {
    const colorKey = logic.normalizeColorKey(product.color);
    const page = existingByColor[colorKey];
    if (!page) {
      return product;
    }

    const partsRt = page.properties?.['品番']?.rich_text || [];
    const { targetIndex } = locateProductInPartsRichText(partsRt, partsMapLocal, product, partsKeyIndex);

    return {
      ...product,
      alreadySynced: targetIndex !== null,
    };
  });
}

export async function loadProductsFromExcel(filePath: string, pageId?: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0]; // Assuming first sheet
  
  const headers: Record<string, number> = {};
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.text.trim()] = colNumber;
  });

  const entries: any[] = [];
  
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    
    const rawColor = headers['塗装色'] ? (row.getCell(headers['塗装色']).text || '').trim() : '';
    const part = headers['品目名称'] ? (row.getCell(headers['品目名称']).text || '').trim() : '';
    if (!part) return;
    
    const fullName = headers['子品番の正式名称'] ? (row.getCell(headers['子品番の正式名称']).text || '').trim() : '';
    const trial = logic.cleanStr(headers['試作番号'] ? (row.getCell(headers['試作番号']).text || '').trim() : '');
    const qty = headers['完成品数'] ? (row.getCell(headers['完成品数']).text || '').trim() : '';
    
    let dStr = '';
    if (headers['開始日']) {
      const dVal = row.getCell(headers['開始日']).value;
      dStr = logic.formatDateMmDd(dVal as any);
    }
    
    let ctVal = 0;
    if (headers['作業時間(秒)']) {
      ctVal = logic.ceilNumber(row.getCell(headers['作業時間(秒)']).value);
    }
    
    let colors = logic.splitExcelColor(rawColor, fullName);
    if (colors.length === 0) {
      colors = [logic.normalizeColorKey(rawColor)];
    }
    
    for (const c of colors) {
      entries.push({
        trial,
        part,
        fullName,
        color: logic.normalizeColorKey(c),
        qty,
        ct: ctVal,
        date: dStr,
        rowNumber
      });
    }
  });

  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    const key = `${entry.color}|${logic.normalizePartKey(entry.part)}|${entry.trial}|${entry.date}`;
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(entry);
  }

  const out: WorkflowProduct[] = [];
  let idCounter = 0;
  for (const key in grouped) {
    const items = grouped[key];
    const fullNames = new Set(items.map((item) => logic.cleanStr(item.fullName)).filter(Boolean));

    if (fullNames.size <= 1) {
      for (const item of items) {
        out.push({
          id: `row-${idCounter++}`,
          selected: false,
          colorAccent: false,
          override: false,
          trial: item.trial,
          part: item.part,
          color: item.color,
          qty: logic.cleanStr(item.qty),
          ct: item.ct,
          date: item.date,
          sourceRows: [item.rowNumber]
        });
      }
      continue;
    }

    const firstItem = items[0];
    const firstDate = items.find((item) => item.date)?.date || '';
    const firstQty = items.find((item) => logic.cleanStr(item.qty))?.qty || '';
    const totalCt = items.reduce((sum, item) => sum + item.ct, 0);
    const sourceRows = Array.from(new Set(items.map((item) => item.rowNumber)));

    out.push({
      id: `group-${idCounter++}`,
      selected: false,
      colorAccent: false,
      override: false,
      trial: firstItem.trial,
      part: firstItem.part,
      color: firstItem.color,
      qty: firstQty,
      ct: totalCt,
      date: firstDate,
      sourceRows
    });
  }

  const annotatedProducts = await annotateProductsWithNotionState(out, pageId);
  return annotatedProducts;
}

export async function highlightAndSync(filePath: string, pageId: string, products: any[]) {
  const selectedProducts = products.filter((product) => product.selected);

  const wb = new ExcelJS.Workbook();
  const workbookReadPromise = wb.xlsx.readFile(filePath);
  if (selectedProducts.length === 0) {
    await workbookReadPromise;
    const buffer = await wb.xlsx.writeBuffer();
    return { success: true, buffer: Buffer.from(buffer).toString('base64') };
  }

  const partsMapPromise = notion.buildPartsMap();
  await workbookReadPromise;

  const {nestedId} = await resolveWorkflowManagerNestedDatabase(pageId, '作業内容');
  const ws = wb.worksheets[0];
  
  const headers: Record<string, number> = {};
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.text.trim()] = colNumber;
  });

  type ExcelRowRecord = {
    row: ExcelJS.Row;
    rowNumber: number;
    wasHighlighted: boolean;
  };
  const rowRecordsByNumber = new Map<number, ExcelRowRecord>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawColor = headers['塗装色'] ? (row.getCell(headers['塗装色']).text || '').trim() : '';
    const part = headers['品目名称'] ? (row.getCell(headers['品目名称']).text || '').trim() : '';
    if (!part) return;

    const fullName = headers['子品番の正式名称'] ? (row.getCell(headers['子品番の正式名称']).text || '').trim() : '';
    
    const rowRecord: ExcelRowRecord = {
      row,
      rowNumber,
      wasHighlighted: false,
    };
    rowRecordsByNumber.set(rowNumber, rowRecord);
  });

  type PendingWorkflowAction = {
    op: 'add' | 'remove';
    color: string;
    trial: string;
    part: string;
    qty: string;
    ct: number;
    date: string;
    override?: boolean;
    rowsToHighlight: ExcelRowRecord[];
  };
  const actions: PendingWorkflowAction[] = [];
  
  for (const uiProd of selectedProducts) {
    const effectivePart = uiProd.colorAccent ? `${uiProd.part}(${uiProd.color})` : uiProd.part;
    const colorKey = logic.normalizeColorKey(uiProd.color);
    const rowsToTouch = Array.isArray(uiProd.sourceRows)
      ? uiProd.sourceRows
          .map((rowNumber) => rowRecordsByNumber.get(Number(rowNumber)))
          .filter((entry): entry is ExcelRowRecord => Boolean(entry))
      : [];
    const isOverride = uiProd.override;
    const chosenCt = logic.ceilNumber(uiProd.ct);

    if (uiProd.alreadySynced && !isOverride) {
      continue;
    }

    const rowsToHighlight = rowsToTouch.filter((entry) => !entry.wasHighlighted);
    
    if (isOverride) {
      actions.push({
        op: 'add',
        color: colorKey,
        trial: uiProd.trial,
        part: effectivePart,
        qty: uiProd.qty,
        ct: chosenCt,
        date: uiProd.date,
        override: true,
        rowsToHighlight,
      });
      continue;
    }

    actions.push({
      op: 'add',
      color: colorKey,
      trial: uiProd.trial,
      part: effectivePart,
      qty: uiProd.qty,
      ct: chosenCt,
      date: uiProd.date,
      rowsToHighlight,
    });
  }

  // Group actions by color and process
  const actionsByColor: Record<string, any[]> = {};
  for (const a of actions) {
    if (!actionsByColor[a.color]) actionsByColor[a.color] = [];
    actionsByColor[a.color].push(a);
  }

  const [existingPages, partsMapLocal] = await Promise.all([
    notion.getAllPages(nestedId),
    partsMapPromise,
  ]);
  const partsKeyIndex = notionUtils.buildPartsKeyIndex(partsMapLocal);
  const existingByColor = buildExistingColorPageIndex(existingPages);
  let mutatedNestedDb = false;
  const rowsToHighlightAfterSync: ExcelRowRecord[] = [];

  for (const colorKey in actionsByColor) {
    const acts = actionsByColor[colorKey];
    let page = existingByColor[colorKey];
    const hasAdd = acts.some(a => a.op === 'add');
    
    if (!page && hasAdd) {
      page = await notion.createPage(nestedId, {
        '色': { title: [{ text: { content: colorKey } }] },
        '詳細': { select: { name: 'ライン' } },
        '品番': { rich_text: [] },
        '数量': { rich_text: [] },
        'c/t 秒': { number: 0 }
      }, NOTION_PAGE_ICON);
      existingByColor[colorKey] = page;
      mutatedNestedDb = true;
    }
    
    if (!page) continue;
    
    const props = page.properties;
    let partsRt = props['品番']?.rich_text || [];
    let qtyRt = props['数量']?.rich_text || [];
    let currentCt = props['c/t 秒']?.number || 0;
    
    const originalEntries = notionUtils.parsePartsLines(partsRt);
    
    for (const act of acts) {
      const fullText = act.part;
      
      const bestKey = notionUtils.resolveBestPartKey(fullText, partsMapLocal, partsKeyIndex);
      const partPageId = bestKey ? partsMapLocal[bestKey] : partsMapLocal[act.part];
      
      if (act.op === 'add') {
        const already = originalEntries.some(e => {
          const matchId = partPageId && e.mention_id === partPageId;
          const matchTxt = !partPageId && act.part && e.part_text?.includes(act.part);
          return (matchId || matchTxt) && e.date === act.date;
        });
        
        if (already) {
          currentCt += act.ct;
          continue;
        }
        
        partsRt = notionUtils.ensurePartsHasSeparator(partsRt);
        const lineBlocks: any[] = [];
        
        if (act.trial) {
          const m = /^(試作\d+)$/.exec(act.trial.trim());
          if (m) {
            lineBlocks.push({ type: 'text', text: { content: m[1] }, annotations: { bold: true, color: 'red_background' } });
            lineBlocks.push({ type: 'text', text: { content: '・' } });
          } else {
            lineBlocks.push({ type: 'text', text: { content: act.trial } });
            lineBlocks.push({ type: 'text', text: { content: '・' } });
          }
        }
        
        if (partPageId) {
           lineBlocks.push({ type: 'mention', mention: { page: { id: partPageId } } });
        } else {
           lineBlocks.push({ type: 'text', text: { content: fullText } });
        }
        
        if (act.date) {
           const md = logic.formatDateMmDd(act.date);
           lineBlocks.push({ type: 'text', text: { content: ` ${md}` }, annotations: { italic: true, color: 'green' } });
        }
        
        partsRt = notionUtils.trimPartsTrailingNewline([...partsRt, ...lineBlocks]);
        qtyRt = notionUtils.appendQtyGreenItalic(qtyRt, act.qty);
        currentCt += act.ct;
        rowsToHighlightAfterSync.push(...act.rowsToHighlight);
      } else {
        let targetIdx = notionUtils.findPartLineIndex(partsRt, partPageId || null, fullText, act.date, false);
        if (targetIdx === null) {
          targetIdx = notionUtils.findPartLineIndex(partsRt, partPageId || null, fullText, '', false);
        }
        
        if (targetIdx !== null) {
          partsRt = notionUtils.removePartsLineAtIndex(partsRt, targetIdx);
          qtyRt = notionUtils.removeQtyAtIndexIfGreenItalicWithValue(qtyRt, targetIdx, act.qty);
          currentCt = Math.max(0, currentCt - act.ct);
        }
      }
    }
    
    if (notionUtils.richTextIsEffectivelyEmpty(partsRt) && notionUtils.richTextIsEffectivelyEmpty(qtyRt) && currentCt === 0) {
      await notion.archivePage(page.id);
      mutatedNestedDb = true;
    } else {
      await notion.updatePageProperties(page.id, {
        '品番': { rich_text: partsRt },
        '数量': { rich_text: qtyRt },
        'c/t 秒': { number: currentCt }
      });
      mutatedNestedDb = true;
    }
  }

  if (mutatedNestedDb) {
    notion.invalidateDatabasePagesCache(nestedId);
  }

  const highlightedRowNumbers = new Set<number>();
  let workbookChanged = false;
  for (const entry of rowsToHighlightAfterSync) {
    if (entry.wasHighlighted || highlightedRowNumbers.has(entry.rowNumber)) {
      continue;
    }
    applyHighlightToRow(entry.row);
    entry.wasHighlighted = true;
    highlightedRowNumbers.add(entry.rowNumber);
    workbookChanged = true;
  }

  const workbookBuffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  if (workbookChanged) {
    await fs.writeFile(filePath, workbookBuffer);
  }
  return { success: true, buffer: workbookChanged ? workbookBuffer.toString('base64') : null };
}

export async function removeProductFromNotion(pageId: string, product: WorkflowProduct) {
  const partsMapPromise = notion.buildPartsMap();
  const {nestedId} = await resolveWorkflowManagerNestedDatabase(pageId, '作業内容');
  const existingPages = await notion.getAllPages(nestedId);
  const existingByColor = buildExistingColorPageIndex(existingPages);
  const colorKey = logic.normalizeColorKey(product.color);
  const page = existingByColor[colorKey];

  if (!page) {
    return { removed: false };
  }

  const props = page.properties || {};
  let partsRt = props['品番']?.rich_text || [];
  let qtyRt = props['数量']?.rich_text || [];
  let currentCt = Number(props['c/t 秒']?.number || 0);
  const partsMapLocal = await partsMapPromise;
  const partsKeyIndex = notionUtils.buildPartsKeyIndex(partsMapLocal);
  const { targetIndex } = locateProductInPartsRichText(partsRt, partsMapLocal, product, partsKeyIndex);

  if (targetIndex === null) {
    return { removed: false };
  }

  partsRt = notionUtils.removePartsLineAtIndex(partsRt, targetIndex);
  qtyRt = notionUtils.removeQtyAtIndexIfGreenItalicWithValue(qtyRt, targetIndex, logic.cleanStr(product.qty));
  currentCt = Math.max(0, currentCt - logic.ceilNumber(product.ct));

  if (notionUtils.richTextIsEffectivelyEmpty(partsRt) && notionUtils.richTextIsEffectivelyEmpty(qtyRt) && currentCt === 0) {
    await notion.archivePage(page.id);
  } else {
    await notion.updatePageProperties(page.id, {
      '品番': { rich_text: partsRt },
      '数量': { rich_text: qtyRt },
      'c/t 秒': { number: currentCt }
    });
  }

  notion.invalidateDatabasePagesCache(nestedId);

  return { removed: true };
}
