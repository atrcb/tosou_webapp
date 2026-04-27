import { normalizePartKey } from './logic.js';

export type PartsKeyIndex = string[];

export function buildPartsKeyIndex(partsMap: Record<string, string>): PartsKeyIndex {
  return Object.keys(partsMap || {})
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

export function resolveBestPartKey(
  partText: string,
  partsMap: Record<string, string>,
  partsKeyIndex?: PartsKeyIndex,
): string | null {
  if (!partText) {
    return null;
  }

  if (partsMap[partText]) {
    return partText;
  }

  const keys = partsKeyIndex || buildPartsKeyIndex(partsMap);
  let bestKey: string | null = null;
  let bestLength = -1;

  for (const key of keys) {
    if (bestLength >= 0 && key.length < bestLength) {
      break;
    }

    if (!partText.startsWith(key)) {
      continue;
    }

    if (key.length > bestLength) {
      bestKey = key;
      bestLength = key.length;
    }
  }

  return bestKey;
}

export function resolveBestPartKeyFromCandidates(
  candidates: string[],
  partsMap: Record<string, string>,
  partsKeyIndex?: PartsKeyIndex,
): string | null {
  for (const candidate of candidates) {
    if (candidate && partsMap[candidate]) {
      return candidate;
    }
  }

  let bestKey: string | null = null;
  let bestLength = -1;
  const keys = partsKeyIndex || buildPartsKeyIndex(partsMap);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const key = resolveBestPartKey(candidate, partsMap, keys);
    if (key && key.length > bestLength) {
      bestKey = key;
      bestLength = key.length;
    }
  }

  return bestKey;
}

export function normalizeQtyStr(q: any): string {
  if (q === null || q === undefined) return '';
  let s = String(q).trim();
  if (s === '') return '';
  s = s.replace(/,/g, '');
  const f = parseFloat(s);
  if (!isNaN(f)) {
    const i = Math.floor(f);
    if (Math.abs(f - i) < 1e-6) {
      return i.toString();
    }
  }
  return s;
}

export function qtyStringsEqual(a: any, b: any): boolean {
  return normalizeQtyStr(a) === normalizeQtyStr(b);
}

export function richTextIsEffectivelyEmpty(rt: any[]): boolean {
  if (!rt || rt.length === 0) return true;
  for (const frag of rt) {
    if (frag.type === 'mention') return false;
    if (frag.type === 'text') {
      const content = frag.text?.content || '';
      if (content.trim() && content.trim() !== '\n') return false;
    }
  }
  return true;
}

export function richTextToLines(rt: any[]): any[][] {
  const lines: any[][] = [];
  let cur: any[] = [];
  for (const frag of (rt || [])) {
    if (frag.type === 'text') {
      const content = frag.text?.content || '';
      if (content.includes('\n')) {
        const segments = content.split('\n');
        segments.forEach((segment, index) => {
          if (segment) {
            cur.push({
              ...frag,
              text: {
                ...(frag.text || {}),
                content: segment,
              },
              plain_text: segment,
            });
          }

          if (index < segments.length - 1) {
            lines.push(cur);
            cur = [];
          }
        });
        continue;
      }
    }

    if (frag.type === 'text' && frag.text?.content === '\n') {
      lines.push(cur);
      cur = [];
    } else {
      cur.push(frag);
    }
  }
  if (cur.length > 0) {
    lines.push(cur);
  }
  return lines;
}

export function linesToRichText(lines: any[][]): any[] {
  const out: any[] = [];
  for (const line of lines) {
    out.push(...line);
    out.push({ type: 'text', text: { content: '\n' } });
  }
  if (out.length > 0 && out[out.length - 1].type === 'text' && out[out.length - 1].text?.content === '\n') {
    out.pop();
  }
  return out;
}

export interface ParsedPartLine {
  idx: number;
  mention_id: string | null;
  part_text: string;
  date: string;
  is_app_style: boolean;
}

export function parsePartsLines(partsRt: any[]): ParsedPartLine[] {
  const lines = richTextToLines(partsRt || []);
  const out: ParsedPartLine[] = [];
  
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let mention_id: string | null = null;
    let partTextAccum: string[] = [];
    let dateToken = '';
    let hasTrialStyle = false;

    for (const frag of line) {
      if (frag.type === 'mention' && frag.mention?.type === 'page') {
        mention_id = frag.mention.page.id;
      } else if (frag.type === 'text') {
        const content = frag.text?.content || '';
        const ann = frag.annotations || {};
        
        if (ann.bold && ann.color === 'red_background') {
          if (/^(試作\d+)$/.test(content.trim())) {
            hasTrialStyle = true;
          }
        }
        if (ann.italic && (ann.color === 'blue' || ann.color === 'green')) {
          dateToken = content.trim();
        }
        if (content && content !== '\n') {
          partTextAccum.push(content);
        }
      }
    }
    
    out.push({
      idx,
      mention_id,
      part_text: partTextAccum.join('').trim(),
      date: dateToken,
      is_app_style: hasTrialStyle
    });
  }
  return out;
}

export function ensurePartsHasSeparator(partsRt: any[]): any[] {
  if (!partsRt || partsRt.length === 0) return [];
  const last = partsRt[partsRt.length - 1];
  if (last.type === 'text' && last.text?.content === '\n') {
    return partsRt;
  }
  return [...partsRt, { type: 'text', text: { content: '\n' } }];
}

export function trimPartsTrailingNewline(partsRt: any[]): any[] {
  if (!partsRt || partsRt.length === 0) return [];
  const copy = [...partsRt];
  if (copy[copy.length - 1].type === 'text' && copy[copy.length - 1].text?.content === '\n') {
    copy.pop();
  }
  return copy;
}

export function findPartLineIndex(partsRt: any[], partPageId: string | null, partName: string, dateStr: string, strict: boolean = false): number | null {
  const parsed = parsePartsLines(partsRt);
  if (!parsed.length) return null;
  
  const dStr = (dateStr || '').trim();
  const normTarget = normalizePartKey(partName || '');
  
  if (partPageId && dStr) {
    const found = parsed.find(e => e.mention_id === partPageId && e.date === dStr);
    if (found) return found.idx;
  }
  if (partName && dStr) {
    const found = parsed.find(e => e.date === dStr && (strict ? e.part_text === partName : e.part_text?.includes(partName)));
    if (found) return found.idx;
  }
  if (normTarget && dStr) {
    const found = parsed.find(e => e.date === dStr && normalizePartKey(e.part_text) === normTarget);
    if (found) return found.idx;
  }
  if (partPageId) {
    const found = parsed.find(e => e.mention_id === partPageId);
    if (found) return found.idx;
  }
  if (partName) {
    const found = parsed.find(e => strict ? e.part_text === partName : e.part_text?.includes(partName));
    if (found) return found.idx;
  }
  if (normTarget) {
    const found = parsed.find(e => normalizePartKey(e.part_text) === normTarget);
    if (found) return found.idx;
  }
  if (!strict && parsed.length === 1) {
    return parsed[0].idx;
  }
  return null;
}

const APP_QTY_COLOR = 'green';
const APP_QTY_REQUIRE_BOLD = true;
const APP_QTY_ALLOW_NEIGHBORS = true;
const APP_SKIP_EMPTY_QTY = true;

export function appendQtyGreenItalic(qtyRt: any[], qtyValue: string): any[] {
  if (!qtyValue && APP_SKIP_EMPTY_QTY) return qtyRt || [];
  const norm = normalizeQtyStr(qtyValue);
  if (norm === '' && APP_SKIP_EMPTY_QTY) return qtyRt || [];
  
  const newRt = [...(qtyRt || [])];
  if (newRt.length > 0) {
    const last = newRt[newRt.length - 1];
    if (!(last.type === 'text' && last.text?.content === '\n')) {
      newRt.push({ type: 'text', text: { content: '\n' } });
    }
  }
  newRt.push({
    type: 'text',
    text: { content: norm },
    annotations: { bold: APP_QTY_REQUIRE_BOLD, italic: false, color: APP_QTY_COLOR }
  });
  return newRt;
}

export function removeQtyAtIndexIfGreenItalicWithValue(qtyRt: any[], index: number | null, qtyValue: string): any[] {
  if (!qtyRt) return [];
  const lines = richTextToLines(qtyRt);
  const wantNorm = normalizeQtyStr(qtyValue);
  
  const lineHasAppQty = (lineFrags: any[]) => {
    for (const f of lineFrags) {
      if (f.type !== 'text') continue;
      const txt = (f.text?.content || '').trim();
      if (!qtyStringsEqual(txt, wantNorm)) continue;
      const ann = f.annotations || {};
      if (APP_QTY_REQUIRE_BOLD && !ann.bold) continue;
      if (ann.color !== APP_QTY_COLOR) continue;
      if (ann.italic) continue; 
      return true;
    }
    return false;
  };

  const candidates = index !== null ? [index] : [];
  if (APP_QTY_ALLOW_NEIGHBORS && index !== null) {
    candidates.push(index - 1, index + 1);
  }

  let chosenIdx: number | null = null;
  for (const cand of candidates) {
    if (cand >= 0 && cand < lines.length && lineHasAppQty(lines[cand])) {
      chosenIdx = cand;
      break;
    }
  }

  if (chosenIdx === null) {
    let bestDist = Infinity;
    for (let i = 0; i < lines.length; i++) {
      if (lineHasAppQty(lines[i])) {
        const dist = Math.abs(i - (index !== null ? index : i));
        if (dist < bestDist) {
          bestDist = dist;
          chosenIdx = i;
        }
      }
    }
  }

  if (chosenIdx === null) return qtyRt;

  lines.splice(chosenIdx, 1);

  const normalizedLines: any[][] = [];
  let prevBlank = false;
  for (const ln of lines) {
    const isBlank = ln.length === 0;
    if (isBlank) {
      if (!prevBlank) normalizedLines.push([]);
      prevBlank = true;
    } else {
      normalizedLines.push(ln);
      prevBlank = false;
    }
  }

  return linesToRichText(normalizedLines);
}

export function removePartsLineAtIndex(partsRt: any[], index: number): any[] {
  const lines = richTextToLines(partsRt || []);
  if (index >= 0 && index < lines.length) {
    lines.splice(index, 1);
  }
  return linesToRichText(lines);
}
