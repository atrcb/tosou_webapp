import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import * as logic from './logic.js';
import * as notion from './notion.js';
import * as notionUtils from './notionUtils.js';

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

function isRowHighlighted(row: ExcelJS.Row): boolean {
  for (let i = 1; i <= 40; i++) {
    const cell = row.getCell(i);
    const fill = cell.fill as ExcelJS.FillPattern;
    if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
      const fgCode = fill.fgColor?.argb?.toUpperCase() || '';
      if (['FFFF00', 'FFFFFF00', '00FFFF00', 'FF00FFFF00'].includes(fgCode)) {
        return true;
      }
    }
  }
  return false;
}

function getProductPartVariants(part: string, color: string): string[] {
  const variants = [logic.cleanStr(part)];
  const normalizedColor = logic.normalizeColorKey(color);
  if (variants[0] && normalizedColor) {
    variants.push(`${variants[0]}(${normalizedColor})`);
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

function resolvePartPageId(partVariants: string[], partsMapLocal: Record<string, string>): string | null {
  let bestKey: string | null = null;
  let bestLen = -1;

  for (const variant of partVariants) {
    for (const key of Object.keys(partsMapLocal)) {
      if (!variant.startsWith(key)) continue;
      if (key.length > bestLen) {
        bestKey = key;
        bestLen = key.length;
      }
    }
  }

  return bestKey ? partsMapLocal[bestKey] : null;
}

function locateProductInPartsRichText(
  partsRt: any[],
  partsMapLocal: Record<string, string>,
  product: Pick<WorkflowProduct, 'part' | 'color' | 'date'>,
): ProductLineMatch {
  const partVariants = getProductPartVariants(product.part, product.color);
  const partPageId = resolvePartPageId(partVariants, partsMapLocal);
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
  for (let i = 1; i <= 10; i += 1) {
    row.getCell(i).fill = EXCEL_HIGHLIGHT_FILL;
  }
}

async function annotateProductsWithNotionState(products: WorkflowProduct[], pageId?: string): Promise<WorkflowProduct[]> {
  const baseProducts = products.map((product) => ({ ...product, alreadySynced: false }));
  if (!pageId || baseProducts.length === 0) {
    return baseProducts;
  }

  const nestedDbsPromise = notion.findNestedDatabases(pageId, '作業内容');
  const partsMapPromise = notion.buildPartsMap();
  const nestedDbs = await nestedDbsPromise;
  if (nestedDbs.length === 0) {
    return baseProducts;
  }

  const [existingPages, partsMapLocal] = await Promise.all([
    notion.getAllPages(nestedDbs[0]),
    partsMapPromise,
  ]);
  const existingByColor = buildExistingColorPageIndex(existingPages);

  return baseProducts.map((product) => {
    const colorKey = logic.normalizeColorKey(product.color);
    const page = existingByColor[colorKey];
    if (!page) {
      return product;
    }

    const partsRt = page.properties?.['品番']?.rich_text || [];
    const { targetIndex } = locateProductInPartsRichText(partsRt, partsMapLocal, product);

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
    
    const isYellow = isRowHighlighted(row);
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
        isYellow,
        rowNumber
      });
    }
  });

  const grouped: Record<string, any[]> = {};
  for (const e of entries) {
    const key = `${e.color}|${logic.normalizePartKey(e.part)}|${e.trial}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  const out: WorkflowProduct[] = [];
  let idCounter = 0;
  for (const key in grouped) {
    const items = grouped[key];
    const fullNames = new Set(items.map(i => logic.cleanStr(i.fullName)).filter(Boolean));
    
    if (fullNames.size <= 1) {
      for (const i of items) {
        out.push({
          id: `row-${idCounter++}`,
          selected: i.isYellow,
          colorAccent: false,
          override: false,
          trial: i.trial,
          part: i.part,
          color: i.color,
          qty: logic.cleanStr(i.qty),
          ct: i.ct,
          date: i.date,
          sourceRows: [i.rowNumber]
        });
      }
    } else {
      const i0 = items[0];
      const date0 = items.find(i => i.date)?.date || '';
      const qty0 = items.find(i => logic.cleanStr(i.qty))?.qty || '';
      const ctSum = items.reduce((sum, i) => sum + i.ct, 0);
      const wasYellowAny = items.some(i => i.isYellow);
      const sourceRows = Array.from(new Set(items.map((i) => i.rowNumber)));
      
      out.push({
        id: `group-${idCounter++}`,
        selected: wasYellowAny,
        colorAccent: false,
        override: false,
        trial: i0.trial,
        part: i0.part,
        color: i0.color,
        qty: qty0,
        ct: ctSum,
        date: date0,
        sourceRows
      });
    }
  }

  const annotatedProducts = await annotateProductsWithNotionState(out, pageId);
  if (!pageId) {
    return annotatedProducts;
  }

  const refreshedProducts = annotatedProducts.map((product) => {
    if (product.alreadySynced) {
      return { ...product, selected: true };
    }
    return product;
  });

  return refreshedProducts;
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

  const nestedDbsPromise = notion.findNestedDatabases(pageId, '作業内容');
  const partsMapPromise = notion.buildPartsMap();
  await workbookReadPromise;

  const nestedDbs = await nestedDbsPromise;
  if (nestedDbs.length === 0) {
    throw new Error("No nested '作業内容' database found in selected calendar page.");
  }
  const nestedId = nestedDbs[0];
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
  const excelIndex: Record<string, { rows: ExcelRowRecord[]; wasHighlighted: boolean; ctTotal: number }> = {};

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawColor = headers['塗装色'] ? (row.getCell(headers['塗装色']).text || '').trim() : '';
    const part = headers['品目名称'] ? (row.getCell(headers['品目名称']).text || '').trim() : '';
    if (!part) return;

    const trial = headers['試作番号'] ? (row.getCell(headers['試作番号']).text || '').trim() : '';
    const fullName = headers['子品番の正式名称'] ? (row.getCell(headers['子品番の正式名称']).text || '').trim() : '';
    let derivedColor = '';
    if (!rawColor && fullName) {
      const m = /(?:（|\()([^)）]+)(?:）|\))$/.exec(fullName);
      if (m) derivedColor = logic.normalizeColorKey(m[1]);
    }

    let ctVal = 0;
    if (headers['作業時間(秒)']) {
      ctVal = logic.ceilNumber(row.getCell(headers['作業時間(秒)']).value);
    }
    
    const rowIsYellow = isRowHighlighted(row);
    let colorsToProcess = logic.splitExcelColor(rawColor, fullName);
    if (colorsToProcess.length === 0) {
      colorsToProcess = [logic.normalizeColorKey(rawColor)];
    }
    
    const partKey = logic.normalizePartKey(part);
    const rowRecord: ExcelRowRecord = {
      row,
      rowNumber,
      wasHighlighted: rowIsYellow,
    };
    
    for (const c of colorsToProcess) {
      const colorKey = logic.normalizeColorKey(c);
      const key = `${colorKey}|${partKey}|${trial}`;
      
      if (!excelIndex[key]) {
        excelIndex[key] = { rows: [], wasHighlighted: false, ctTotal: 0 };
      }
      excelIndex[key].rows.push(rowRecord);
      
      const isMixed = rawColor.includes('・') || derivedColor.includes('・');
      if (isMixed) {
        const alloc = logic.allocateCtForColors(colorsToProcess, ctVal);
        excelIndex[key].ctTotal += (alloc[colorKey] ?? ctVal);
      } else {
        excelIndex[key].ctTotal += ctVal;
      }
      
      if (rowIsYellow) {
        excelIndex[key].wasHighlighted = true;
      }
    }
  });

  const actions: any[] = [];
  
  for (const uiProd of selectedProducts) {
    const effectivePart = uiProd.colorAccent ? `${uiProd.part}(${uiProd.color})` : uiProd.part;
    const colorKey = logic.normalizeColorKey(uiProd.color);
    const key = `${colorKey}|${logic.normalizePartKey(uiProd.part)}|${logic.cleanStr(uiProd.trial)}`;
    const rec = excelIndex[key];
    const sourceRows = Array.isArray(uiProd.sourceRows) && uiProd.sourceRows.length > 0 ? new Set(uiProd.sourceRows) : null;
    const rowsToTouch = rec
      ? sourceRows
        ? rec.rows.filter((entry) => sourceRows.has(entry.rowNumber))
        : rec.rows
      : [];
    const isOverride = uiProd.override;
    const chosenCt = logic.ceilNumber(uiProd.ct);

    if (uiProd.alreadySynced && !isOverride) {
      continue;
    }

    if (rowsToTouch.length > 0) {
      rowsToTouch.forEach((entry) => {
        if (entry.wasHighlighted) return;
        applyHighlightToRow(entry.row);
        entry.wasHighlighted = true;
      });
    }
    
    if (isOverride) {
      actions.push({ op: 'add', color: colorKey, trial: uiProd.trial, part: effectivePart, qty: uiProd.qty, ct: chosenCt, date: uiProd.date, override: true });
      continue;
    }

    actions.push({ op: 'add', color: colorKey, trial: uiProd.trial, part: effectivePart, qty: uiProd.qty, ct: chosenCt, date: uiProd.date });
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
  const existingByColor = buildExistingColorPageIndex(existingPages);
  let mutatedNestedDb = false;

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
      
      let bestKey: string | null = null;
      let bestLen = -1;
      for (const k in partsMapLocal) {
        if (fullText.startsWith(k) && k.length > bestLen) {
          bestKey = k;
          bestLen = k.length;
        }
      }
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

  const workbookBuffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  await fs.writeFile(filePath, workbookBuffer);
  return { success: true, buffer: workbookBuffer.toString('base64') };
}

export async function removeProductFromNotion(pageId: string, product: WorkflowProduct) {
  const nestedDbsPromise = notion.findNestedDatabases(pageId, '作業内容');
  const partsMapPromise = notion.buildPartsMap();
  const nestedDbs = await nestedDbsPromise;
  if (nestedDbs.length === 0) {
    throw new Error("No nested '作業内容' database found in selected calendar page.");
  }

  const nestedId = nestedDbs[0];
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
  const { targetIndex } = locateProductInPartsRichText(partsRt, partsMapLocal, product);

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
