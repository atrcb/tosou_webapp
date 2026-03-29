import ExcelJS from 'exceljs';
import * as logic from './logic.js';
import * as notion from './notion.js';
import * as notionUtils from './notionUtils.js';

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

export async function loadProductsFromExcel(filePath: string) {
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
    const trial = headers['試作番号'] ? (row.getCell(headers['試作番号']).text || '').trim() : '';
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
        isYellow
      });
    }
  });

  const grouped: Record<string, any[]> = {};
  for (const e of entries) {
    const key = `${e.color}|${logic.normalizePartKey(e.part)}|${e.trial}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  const out = [];
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
          date: i.date
        });
      }
    } else {
      const i0 = items[0];
      const date0 = items.find(i => i.date)?.date || '';
      const qty0 = items.find(i => logic.cleanStr(i.qty))?.qty || '';
      const ctSum = items.reduce((sum, i) => sum + i.ct, 0);
      const wasYellowAny = items.some(i => i.isYellow);
      
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
        date: date0
      });
    }
  }

  return out;
}

export async function highlightAndSync(filePath: string, pageId: string, products: any[]) {
  const nestedDbs = await notion.findNestedDatabases(pageId, '作業内容');
  if (nestedDbs.length === 0) {
    throw new Error("No nested '作業内容' database found in selected calendar page.");
  }
  const nestedId = nestedDbs[0];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  
  const headers: Record<string, number> = {};
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.text.trim()] = colNumber;
  });

  const excelIndex: Record<string, { rows: ExcelJS.Row[], wasHighlighted: boolean, ctTotal: number }> = {};

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawColor = headers['塗装色'] ? (row.getCell(headers['塗装色']).text || '').trim() : '';
    const part = headers['品目名称'] ? (row.getCell(headers['品目名称']).text || '').trim() : '';
    if (!part) return;

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
    
    for (const c of colorsToProcess) {
      const colorKey = logic.normalizeColorKey(c);
      const key = `${colorKey}|${partKey}`;
      
      if (!excelIndex[key]) {
        excelIndex[key] = { rows: [], wasHighlighted: false, ctTotal: 0 };
      }
      excelIndex[key].rows.push(row);
      
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
  
  for (const uiProd of products) {
    const effectivePart = uiProd.colorAccent ? `${uiProd.part}(${uiProd.color})` : uiProd.part;
    const colorKey = logic.normalizeColorKey(uiProd.color);
    const key = `${colorKey}|${logic.normalizePartKey(uiProd.part)}`;
    const rec = excelIndex[key];
    
    const wasPre = rec ? rec.wasHighlighted : false;
    let excelCt = rec ? rec.ctTotal : 0;
    const isOverride = uiProd.override;
    const chosenCt = logic.ceilNumber(uiProd.ct);
    
    if (uiProd.selected) {
      if (isOverride) {
        actions.push({ op: 'add', color: colorKey, trial: uiProd.trial, part: effectivePart, qty: uiProd.qty, ct: chosenCt, date: uiProd.date, override: true });
      } else {
        if (wasPre) continue;
        if (rec && !rec.wasHighlighted) {
          rec.rows.forEach(r => {
            for (let i = 1; i <= 10; i++) {
              const cell = r.getCell(i);
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
            }
          });
          rec.wasHighlighted = true;
        }
        actions.push({ op: 'add', color: colorKey, trial: uiProd.trial, part: effectivePart, qty: uiProd.qty, ct: chosenCt, date: uiProd.date });
      }
    } else {
      if (rec && rec.wasHighlighted) {
        rec.rows.forEach(r => {
          for (let i = 1; i <= 10; i++) {
            const cell = r.getCell(i);
            cell.fill = { type: 'pattern', pattern: 'none' };
          }
        });
        rec.wasHighlighted = false;
        actions.push({ op: 'remove', color: colorKey, trial: uiProd.trial, part: effectivePart, qty: uiProd.qty, ct: chosenCt, date: uiProd.date });
      }
    }
  }

  // Group actions by color and process
  const actionsByColor: Record<string, any[]> = {};
  for (const a of actions) {
    if (!actionsByColor[a.color]) actionsByColor[a.color] = [];
    actionsByColor[a.color].push(a);
  }

  const existingPages = await notion.getAllPages(nestedId);
  const existingByColor: Record<string, any> = {};
  for (const p of existingPages) {
    const props = (p as any).properties;
    const titleArr = props['色']?.title;
    if (titleArr && titleArr.length > 0) {
      existingByColor[titleArr[0].plain_text.trim()] = p;
    }
  }
  
  const partsMapLocal = await notion.buildPartsMap();

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
      });
      existingByColor[colorKey] = page;
    }
    
    if (!page) continue;
    
    const props = page.properties;
    let partsRt = props['品番']?.rich_text || [];
    let qtyRt = props['数量']?.rich_text || [];
    let currentCt = props['c/t 秒']?.number || 0;
    
    let currentEntries = notionUtils.parsePartsLines(partsRt);
    
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
        const already = currentEntries.some(e => {
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
        currentEntries = notionUtils.parsePartsLines(partsRt);
        
      } else {
        let targetIdx = notionUtils.findPartLineIndex(partsRt, partPageId || null, fullText, act.date, false);
        if (targetIdx === null) {
          targetIdx = notionUtils.findPartLineIndex(partsRt, partPageId || null, fullText, '', false);
        }
        
        if (targetIdx !== null) {
          partsRt = notionUtils.removePartsLineAtIndex(partsRt, targetIdx);
          qtyRt = notionUtils.removeQtyAtIndexIfGreenItalicWithValue(qtyRt, targetIdx, act.qty);
          currentCt = Math.max(0, currentCt - act.ct);
          currentEntries = notionUtils.parsePartsLines(partsRt);
        }
      }
    }
    
    if (notionUtils.richTextIsEffectivelyEmpty(partsRt) && notionUtils.richTextIsEffectivelyEmpty(qtyRt) && currentCt === 0) {
      await notion.updatePageProperties(page.id, { archived: true });
    } else {
      await notion.updatePageProperties(page.id, {
        '品番': { rich_text: partsRt },
        '数量': { rich_text: qtyRt },
        'c/t 秒': { number: currentCt }
      });
    }
  }

  await wb.xlsx.writeFile(filePath);
  const buffer = await wb.xlsx.writeBuffer();
  return { success: true, buffer: Buffer.from(buffer).toString('base64') };
}

