import ExcelJS from 'exceljs';
import fs from 'fs/promises';
import * as logic from './logic.js';
import * as notion from './notion.js';
import * as notionUtils from './notionUtils.js';

const NOTION_PAGE_ICON = {type: 'emoji', emoji: '⚙️'};
const COLOR_PAREN_RE = /(?:（|\()([^)）]+)(?:）|\))$/;
const LOT_SUFFIX_RE = /(?:\s*ロット\s*#?\s*\d+)\s*$/;
const TRIAL_CODE_RE = /^(試作\d+)$/;

type DailyAccumulatorItem = {
  ct: number;
  display: string;
  fullName: string;
  qty: string;
  rowNumber: number;
};

type DailyEntry = {
  displayName: string;
  finishQty: string;
  sourceRows: number[];
  totalCycleTime: number;
};

type DailyGroup = {
  entries: DailyEntry[];
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

type DailyPreviewSummary = {
  alreadyHighlightedRows: number;
  matchedNotionRows: number;
  pendingRows: number;
  totalRows: number;
};

type ExistingColorPage = {
  id: string;
  properties: Record<string, any>;
};

type ParsedDailyNotionLine = {
  idx: number;
  mentionId: string | null;
  partSuffixText: string;
  qty: string;
  trial: string;
};

const EXCEL_HIGHLIGHT_FILL: ExcelJS.FillPattern = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: {argb: 'FFFFFF00'},
};

const HIGHLIGHT_START_COLUMN = 2;
const HIGHLIGHT_END_COLUMN = 10;

function isYellowFill(fill: ExcelJS.Fill | undefined): boolean {
  const patternFill = fill as ExcelJS.FillPattern | undefined;
  if (!patternFill || patternFill.type !== 'pattern' || patternFill.pattern !== 'solid') {
    return false;
  }

  const fgCode = patternFill.fgColor?.argb?.toUpperCase() || '';
  return ['FFFF00', 'FFFFFF00', '00FFFF00', 'FF00FFFF00'].includes(fgCode);
}

function isRowHighlighted(row: ExcelJS.Row): boolean {
  for (let i = HIGHLIGHT_START_COLUMN; i <= HIGHLIGHT_END_COLUMN; i += 1) {
    if (!isYellowFill(row.getCell(i).fill)) {
      return false;
    }
  }
  return true;
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
        rowNumber,
      });
      itemsByKey.set(groupingKey, items);
      processedRowNumbers.add(rowNumber);
    }
  });

  const groups: Record<string, DailyGroup> = {};

  for (const [color, itemsByKey] of perColor.entries()) {
    const group: DailyGroup = {
      entries: [],
      displayNames: [],
      finishQty: [],
      totalCycleTime: 0,
    };

    for (const items of itemsByKey.values()) {
      const fullNames = new Set(items.map((item) => logic.cleanStr(item.fullName)).filter(Boolean));
      if (fullNames.size <= 1) {
        items.forEach((item) => {
          const entry: DailyEntry = {
            displayName: item.display,
            finishQty: item.qty,
            sourceRows: [item.rowNumber],
            totalCycleTime: item.ct,
          };
          group.entries.push(entry);
          group.displayNames.push(item.display);
          group.finishQty.push(item.qty);
          group.totalCycleTime += item.ct;
        });
      } else {
        const entry: DailyEntry = {
          displayName: items[0]?.display || '',
          finishQty: firstNonEmptyQty(items),
          sourceRows: Array.from(new Set(items.map((item) => item.rowNumber))),
          totalCycleTime: items.reduce((sum, item) => sum + item.ct, 0),
        };
        group.entries.push(entry);
        group.displayNames.push(entry.displayName);
        group.finishQty.push(entry.finishQty);
        group.totalCycleTime += entry.totalCycleTime;
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

function buildExistingColorPageIndex(existingPages: any[]): Record<string, ExistingColorPage> {
  const existingByColor: Record<string, ExistingColorPage> = {};

  for (const page of existingPages) {
    const props = (page as any).properties || {};
    const titleArr = props['色']?.title;
    if (!titleArr?.length) {
      continue;
    }

    const colorKey = logic.normalizeColorKey(titleArr[0].plain_text?.trim() || '');
    if (!colorKey) {
      continue;
    }

    existingByColor[colorKey] = page as ExistingColorPage;
  }

  return existingByColor;
}

function splitDailyDisplayName(displayName: string): {partText: string; trial: string} {
  const separatorIndex = displayName.indexOf('・');
  if (separatorIndex < 0) {
    return {partText: logic.cleanStr(displayName), trial: ''};
  }

  const trial = logic.cleanStr(displayName.slice(0, separatorIndex));
  const partText = logic.cleanStr(displayName.slice(separatorIndex + 1));
  return partText ? {partText, trial} : {partText: logic.cleanStr(displayName), trial: ''};
}

function collectPlainText(fragments: any[]): string {
  return fragments
    .map((fragment) => {
      if (fragment.type !== 'text') {
        return '';
      }
      return fragment.text?.content || '';
    })
    .join('');
}

function parseDailyNotionLines(partsRt: any[], qtyRt: any[]): ParsedDailyNotionLine[] {
  const partLines = notionUtils.richTextToLines(partsRt || []);
  const qtyLines = notionUtils.richTextToLines(qtyRt || []);

  return partLines.map((line, idx) => {
    let mentionId: string | null = null;
    let sawSeparator = false;
    let trialText = '';
    let partSuffixText = '';

    for (const fragment of line) {
      if (fragment.type === 'mention' && fragment.mention?.type === 'page') {
        mentionId = fragment.mention.page.id;
        continue;
      }

      if (fragment.type !== 'text') {
        continue;
      }

      let remaining = fragment.text?.content || '';
      if (!remaining || remaining === '\n') {
        continue;
      }

      while (remaining.length > 0) {
        if (!sawSeparator) {
          const separatorIndex = remaining.indexOf('・');
          if (separatorIndex < 0) {
            if (!mentionId && !partSuffixText) {
              trialText += remaining;
            } else {
              partSuffixText += remaining;
            }
            remaining = '';
            continue;
          }

          trialText += remaining.slice(0, separatorIndex);
          remaining = remaining.slice(separatorIndex + 1);
          sawSeparator = true;
          continue;
        }

        partSuffixText += remaining;
        remaining = '';
      }
    }

    if (!sawSeparator) {
      if (!mentionId) {
        partSuffixText = trialText + partSuffixText;
      }
      trialText = '';
    }

    return {
      idx,
      mentionId,
      partSuffixText: logic.cleanStr(partSuffixText),
      qty: notionUtils.normalizeQtyStr(collectPlainText(qtyLines[idx] || [])),
      trial: logic.cleanStr(trialText),
    };
  });
}

function entryMatchesDailyNotionLine(
  line: ParsedDailyNotionLine,
  entry: DailyEntry,
  partsMap: Record<string, string>,
): boolean {
  const {partText, trial} = splitDailyDisplayName(entry.displayName);
  const entryQty = notionUtils.normalizeQtyStr(entry.finishQty);

  if (entryQty !== line.qty) {
    return false;
  }

  if (logic.cleanStr(trial) !== logic.cleanStr(line.trial)) {
    return false;
  }

  const bestKey = resolveBestPartKey(partText, partsMap);
  if (bestKey && partsMap[bestKey]) {
    if (line.mentionId !== partsMap[bestKey]) {
      return false;
    }

    const suffix = logic.cleanStr(partText.slice(bestKey.length));
    if (!suffix) {
      return true;
    }

    return logic.normalizePartKey(line.partSuffixText) === logic.normalizePartKey(suffix);
  }

  return logic.normalizePartKey(line.partSuffixText) === logic.normalizePartKey(partText);
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

    for (let i = HIGHLIGHT_START_COLUMN; i <= HIGHLIGHT_END_COLUMN; i += 1) {
      row.getCell(i).fill = EXCEL_HIGHLIGHT_FILL;
    }
  });
}

export async function refreshDailyWorkbookState(filePath: string, pageId: string) {
  const wb = new ExcelJS.Workbook();
  const workbookReadPromise = wb.xlsx.readFile(filePath);
  const nestedDbsPromise = notion.findNestedDatabases(pageId, '作業内容');
  const partsMapPromise = notion.buildPartsMap();

  await workbookReadPromise;

  const nestedDbs = await nestedDbsPromise;
  if (nestedDbs.length === 0) {
    throw new Error("No nested '作業内容' database found in selected calendar page.");
  }

  const [existingPages, partsMap] = await Promise.all([
    notion.getAllPages(nestedDbs[0]),
    partsMapPromise,
  ]);

  const ws = wb.worksheets[0];
  const headers = getHeaders(ws);
  const lotNumbersChanged = applyLotNumbersToWorksheet(ws, headers);
  const {groups, processedRowNumbers, skippedHighlightedRows, totalRows} = buildDailyGroups(ws, headers);
  const existingByColor = buildExistingColorPageIndex(existingPages);
  const rowNumbersToHighlight = new Set<number>();

  for (const [color, group] of Object.entries(groups)) {
    const page = existingByColor[color];
    if (!page) {
      continue;
    }

    const props = page.properties || {};
    const parsedLines = parseDailyNotionLines(props['品番']?.rich_text || [], props['数量']?.rich_text || []);
    const matchedLineIndexes = new Set<number>();

    for (const entry of group.entries) {
      const matchedLine = parsedLines.find(
        (line) => !matchedLineIndexes.has(line.idx) && entryMatchesDailyNotionLine(line, entry, partsMap),
      );

      if (!matchedLine) {
        continue;
      }

      matchedLineIndexes.add(matchedLine.idx);
      entry.sourceRows.forEach((rowNumber) => rowNumbersToHighlight.add(rowNumber));
    }
  }

  if (lotNumbersChanged) {
    const workbookBuffer = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
    await fs.writeFile(filePath, workbookBuffer);
  }

  const summary: DailyPreviewSummary = {
    alreadyHighlightedRows: skippedHighlightedRows,
    matchedNotionRows: rowNumbersToHighlight.size,
    pendingRows: processedRowNumbers.size,
    totalRows,
  };

  return {
    success: true,
    summary,
  };
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
