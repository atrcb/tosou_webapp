import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import * as logic from './logic.js';
import * as notion from './notion.js';

const NOTION_PAGE_ICON = {type: 'emoji', emoji: '⚙️'};
const COLOR_PAREN_RE = /(?:（|\()([^)）]+)(?:）|\))$/;
const LOT_SUFFIX_RE = /(?:\s*ロット\s*#?\s*\d+)\s*$/;
const TRIAL_CODE_RE = /^(試作\d+)$/;

type DailyAccumulatorItem = {
  ct: number;
  display: string;
  fullName: string;
  qty: string;
};

type DailyGroup = {
  displayNames: string[];
  finishQty: string[];
  totalCycleTime: number;
};

type DailyRunSummary = {
  colorsCreated: string[];
  groupsCount: number;
  processedRows: number;
  skippedHighlightedRows: number;
  totalRows: number;
};

function isRowHighlighted(row: ExcelJS.Row): boolean {
  for (let i = 1; i <= 40; i += 1) {
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

function getHeaders(ws: ExcelJS.Worksheet): Record<string, number> {
  const headers: Record<string, number> = {};
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    headers[(cell.text || '').trim()] = colNumber;
  });
  return headers;
}

function getCellText(row: ExcelJS.Row, columnNumber?: number): string {
  if (!columnNumber) {
    return '';
  }
  return (row.getCell(columnNumber).text || '').trim();
}

function stripLotSuffix(value: string): string {
  return value.replace(LOT_SUFFIX_RE, '').trim();
}

function applyLotNumbersToWorksheet(ws: ExcelJS.Worksheet, headers: Record<string, number>): boolean {
  const partColumn = headers['品目名称'];
  if (!partColumn) {
    return false;
  }

  const colorColumn = headers['塗装色'];
  const fullNameColumn = headers['子品番の正式名称'];
  const groups = new Map<string, ExcelJS.Cell[]>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }

    const partCell = row.getCell(partColumn);
    const part = String(partCell.value || '').trim();
    if (!part) {
      return;
    }

    const basePart = stripLotSuffix(part);
    const fullName = getCellText(row, fullNameColumn);
    let rawColor = getCellText(row, colorColumn);
    if (!rawColor && fullName) {
      const match = COLOR_PAREN_RE.exec(fullName);
      if (match) {
        rawColor = logic.cleanStr(match[1]);
      }
    }

    const key = [rawColor, basePart, fullName].join('\u0000');
    const cells = groups.get(key);
    if (cells) {
      cells.push(partCell);
    } else {
      groups.set(key, [partCell]);
    }
  });

  let changed = false;

  for (const cells of groups.values()) {
    for (const cell of cells) {
      const current = String(cell.value || '').trim();
      const stripped = stripLotSuffix(current);
      if (stripped !== current) {
        cell.value = stripped;
        changed = true;
      }
    }
  }

  for (const cells of groups.values()) {
    if (cells.length <= 1) {
      continue;
    }

    cells.forEach((cell, index) => {
      const basePart = stripLotSuffix(String(cell.value || '').trim());
      const nextValue = basePart ? `${basePart} ロット${index + 1}` : `ロット${index + 1}`;
      if (String(cell.value || '').trim() !== nextValue) {
        cell.value = nextValue;
        changed = true;
      }
    });
  }

  return changed;
}

function firstNonEmptyQty(items: DailyAccumulatorItem[]): string {
  for (const item of items) {
    if (logic.cleanStr(item.qty)) {
      return logic.cleanStr(item.qty);
    }
  }
  return '';
}

function buildDailyGroups(
  ws: ExcelJS.Worksheet,
  headers: Record<string, number>,
): {groups: Record<string, DailyGroup>; processedRowNumbers: Set<number>; skippedHighlightedRows: number; totalRows: number} {
  const partColumn = headers['品目名称'];
  const colorColumn = headers['塗装色'];
  const fullNameColumn = headers['子品番の正式名称'];
  const trialColumn = headers['試作番号'];
  const qtyColumn = headers['完成品数'];
  const ctColumn = headers['作業時間(秒)'];

  const highlightedRowNumbers = new Set<number>();
  const processedRowNumbers = new Set<number>();
  const perColor = new Map<string, Map<string, DailyAccumulatorItem[]>>();
  let totalRows = 0;

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }

    totalRows += 1;

    if (isRowHighlighted(row)) {
      highlightedRowNumbers.add(rowNumber);
      return;
    }

    const partName = getCellText(row, partColumn);
    if (!partName) {
      return;
    }

    const rawColor = getCellText(row, colorColumn);
    const fullName = getCellText(row, fullNameColumn);
    const colorsToUse = logic.splitExcelColor(rawColor, fullName);
    if (colorsToUse.length === 0) {
      return;
    }

    const trial = logic.cleanStr(getCellText(row, trialColumn));
    const displayName = trial ? `${trial}・${partName}` : partName;
    const qtyValue = qtyColumn ? row.getCell(qtyColumn).value : 0;
    const qtyString = String(logic.ceilNumber(qtyValue));
    const rowCt = logic.ceilNumber(ctColumn ? row.getCell(ctColumn).value : 0);
    const ctAllocation =
      rawColor.includes('・') || colorsToUse.length > 1
        ? logic.allocateCtForColors(colorsToUse, rowCt)
        : Object.fromEntries(colorsToUse.map((color) => [logic.normalizeColorKey(color), rowCt]));

    const partKey = logic.normalizePartKey(partName);
    const groupingKey = `${partKey}|${trial}`;

    for (const colorName of colorsToUse) {
      const colorKey = logic.normalizeColorKey(colorName);
      if (!colorKey) {
        continue;
      }

      let itemsByKey = perColor.get(colorKey);
      if (!itemsByKey) {
        itemsByKey = new Map<string, DailyAccumulatorItem[]>();
        perColor.set(colorKey, itemsByKey);
      }

      const items = itemsByKey.get(groupingKey) || [];
      items.push({
        ct: logic.ceilNumber(ctAllocation[colorKey] ?? rowCt),
        display: displayName,
        fullName: logic.cleanStr(fullName),
        qty: qtyString,
      });
      itemsByKey.set(groupingKey, items);
      processedRowNumbers.add(rowNumber);
    }
  });

  const groups: Record<string, DailyGroup> = {};

  for (const [color, itemsByKey] of perColor.entries()) {
    const group: DailyGroup = {
      displayNames: [],
      finishQty: [],
      totalCycleTime: 0,
    };

    for (const items of itemsByKey.values()) {
      const fullNames = new Set(items.map((item) => logic.cleanStr(item.fullName)).filter(Boolean));
      if (fullNames.size <= 1) {
        items.forEach((item) => {
          group.displayNames.push(item.display);
          group.finishQty.push(item.qty);
          group.totalCycleTime += item.ct;
        });
      } else {
        group.displayNames.push(items[0]?.display || '');
        group.finishQty.push(firstNonEmptyQty(items));
        group.totalCycleTime += items.reduce((sum, item) => sum + item.ct, 0);
      }
    }

    if (group.displayNames.length > 0) {
      groups[color] = group;
    }
  }

  return {
    groups,
    processedRowNumbers,
    skippedHighlightedRows: highlightedRowNumbers.size,
    totalRows,
  };
}

function resolveBestPartKey(partText: string, partsMap: Record<string, string>): string | null {
  if (!partText) {
    return null;
  }
  if (partsMap[partText]) {
    return partText;
  }

  let bestKey: string | null = null;
  let bestLen = -1;
  for (const key of Object.keys(partsMap)) {
    if (!partText.startsWith(key)) {
      continue;
    }
    if (key.length > bestLen) {
      bestKey = key;
      bestLen = key.length;
    }
  }

  return bestKey;
}

function appendPartWithMention(richText: any[], partText: string, partsMap: Record<string, string>) {
  const bestKey = resolveBestPartKey(partText, partsMap);
  if (bestKey && partsMap[bestKey]) {
    richText.push({
      type: 'mention',
      mention: {type: 'page', page: {id: partsMap[bestKey]}},
    });
    const modifier = partText.slice(bestKey.length);
    if (modifier) {
      richText.push({type: 'text', text: {content: modifier}});
    }
    return;
  }

  richText.push({type: 'text', text: {content: partText}});
}

function buildPartsRichText(displayNames: string[], partsMap: Record<string, string>): any[] {
  const richText: any[] = [];

  displayNames.forEach((displayName, index) => {
    const separatorIndex = displayName.indexOf('・');
    const maybeTrial = separatorIndex >= 0 ? displayName.slice(0, separatorIndex) : '';
    const partText = separatorIndex >= 0 ? displayName.slice(separatorIndex + 1) : displayName;

    if (TRIAL_CODE_RE.test(maybeTrial)) {
      richText.push({
        type: 'text',
        text: {content: maybeTrial},
        annotations: {bold: true, color: 'red_background'},
      });
      richText.push({type: 'text', text: {content: '・'}});
    } else if (maybeTrial) {
      richText.push({type: 'text', text: {content: maybeTrial}});
      richText.push({type: 'text', text: {content: '・'}});
    }

    appendPartWithMention(richText, partText, partsMap);
    if (index < displayNames.length - 1) {
      richText.push({type: 'text', text: {content: '\n'}});
    }
  });

  return richText;
}

function buildQtyRichText(finishQty: string[]): any[] {
  return finishQty.map((qty, index) => ({
    type: 'text',
    text: {
      content: `${qty}${index < finishQty.length - 1 ? '\n' : ''}`,
    },
    annotations: {bold: true, color: 'orange'},
  }));
}

async function createDailyColorPage(
  nestedDbId: string,
  color: string,
  group: DailyGroup,
  partsMap: Record<string, string>,
) {
  return notion.createPage(
    nestedDbId,
    {
      '色': {title: [{text: {content: color}}]},
      '品番': {rich_text: buildPartsRichText(group.displayNames, partsMap)},
      '数量': {rich_text: buildQtyRichText(group.finishQty)},
      'c/t 秒': {number: group.totalCycleTime},
      '詳細': {select: {name: 'ライン'}},
    },
    NOTION_PAGE_ICON,
  );
}

function highlightProcessedRows(ws: ExcelJS.Worksheet, rowNumbers: Set<number>) {
  if (rowNumbers.size === 0) {
    return;
  }

  ws.eachRow((row, rowNumber) => {
    if (!rowNumbers.has(rowNumber)) {
      return;
    }

    for (let i = 1; i <= 10; i += 1) {
      row.getCell(i).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: {argb: 'FFFFFF00'},
      };
    }
  });
}

export async function runDailyWorkflow(filePath: string, pageId: string) {
  const wb = new ExcelJS.Workbook();
  const workbookReadPromise = wb.xlsx.readFile(filePath);
  const nestedDbsPromise = notion.findNestedDatabases(pageId, '作業内容');
  const partsMapPromise = notion.buildPartsMap();

  await workbookReadPromise;

  const nestedDbs = await nestedDbsPromise;
  if (nestedDbs.length === 0) {
    throw new Error("No nested '作業内容' database found in selected calendar page.");
  }

  const nestedDbId = nestedDbs[0];
  const ws = wb.worksheets[0];
  const headers = getHeaders(ws);

  applyLotNumbersToWorksheet(ws, headers);

  const {groups, processedRowNumbers, skippedHighlightedRows, totalRows} = buildDailyGroups(ws, headers);
  const partsMap = await partsMapPromise;

  const colorsCreated = Object.keys(groups);
  for (const color of colorsCreated) {
    await createDailyColorPage(nestedDbId, color, groups[color], partsMap);
  }

  highlightProcessedRows(ws, processedRowNumbers);

  const workbookBuffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  await fs.writeFile(filePath, workbookBuffer);

  const summary: DailyRunSummary = {
    colorsCreated,
    groupsCount: colorsCreated.length,
    processedRows: processedRowNumbers.size,
    skippedHighlightedRows,
    totalRows,
  };

  return {
    success: true,
    buffer: workbookBuffer.toString('base64'),
    summary,
  };
}
