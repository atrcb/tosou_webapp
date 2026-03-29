export function normalizePartKey(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name);
  s = s.replace(/　/g, " ");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/－|―|ー|‐/g, "-");
  s = s.replace(/\s*-\s*/g, "-");
  return s.trim();
}

export function normalizeColorKey(name: string | null | undefined): string {
  if (!name) return "";
  let s = String(name);
  s = s.replace(/　/g, " ");
  s = s.replace(/\s+/g, " ");
  return s.trim();
}

export function normalizeThreefBlack(s: string | null | undefined): string {
  if (!s) return "";
  let s0 = String(s);
  s0 = s0.replace(/　/g, " ");
  s0 = s0.replace(/\s+/g, "");
  // Map full-width to half-width
  const transMap: Record<string, string> = { "３": "3", "Ｆ": "F", "ｆ": "f" };
  s0 = s0.replace(/[３Ｆｆ]/g, match => transMap[match] || match);
  s0 = s0.replace(/ブラック/g, "ﾌﾞﾗｯｸ").replace(/ツヤ/g, "艶");
  if (/3[fF]黒/.test(s0)) return "3F黒";
  if (/3分艶(ﾌﾞﾗｯｸ|黒)/.test(s0)) return "3F黒";
  return s0;
}

export function stripTrailingColorSuffix(s: string | null | undefined): string {
  if (!s) return "";
  let out = String(s);
  while (true) {
    const match = /(?:（|\()[^)）]+(?:）|\))$/.exec(out);
    if (!match) break;
    out = out.slice(0, match.index);
  }
  return out.trim();
}

const COLOR_PAREN_RE = /(?:（|\()([^)）]+)(?:）|\))$/;

export function splitExcelColor(rawColor: string, fullName: string = ""): string[] {
  let colors: string[] = [];
  let normColor = normalizeColorKey(rawColor);

  if (!normColor && fullName) {
    const match = COLOR_PAREN_RE.exec(fullName);
    if (match) {
      normColor = normalizeColorKey(match[1]);
    }
  }

  if (!normColor) return colors;

  if (normColor.includes("・")) {
    const [main, ...subParts] = normColor.split("・");
    const sub = subParts.join("・");
    const normMain = normalizeColorKey(main);
    const normSub = normalizeColorKey(sub);
    if (normMain) colors.push(normMain);
    if (normSub) {
      const subNorm3F = normalizeThreefBlack(normSub);
      colors.push(subNorm3F === "3F黒" ? "3F黒" : subNorm3F);
    }
  } else {
    const rawNorm = normalizeThreefBlack(normColor);
    colors.push(rawNorm === "3F黒" ? "3F黒" : normColor);
  }

  return colors.filter(Boolean);
}

const CT_SPLIT_MAIN_RATIO = 0.65;
const CT_SPLIT_3F_RATIO = 0.35;

export function allocateCtForColors(colors: string[], totalCt: number = 0): Record<string, number> {
  const norm = colors.map(c => normalizeThreefBlack(c) === "3F黒" ? "3F黒" : c);
  if (norm.length === 2 && norm[1] === "3F黒") {
    const mainCt = Math.ceil(totalCt * CT_SPLIT_MAIN_RATIO);
    const subCt = Math.max(0, totalCt - mainCt);
    return {
      [norm[0]]: mainCt,
      [norm[1]]: subCt
    };
  }
  // Legacy allocation (100% per color)
  const alloc: Record<string, number> = {};
  for (const c of norm) {
    alloc[c] = totalCt;
  }
  return alloc;
}

export function ceilNumber(val: any): number {
  if (val === null || val === undefined || val === "") return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : Math.ceil(num);
}

export function formatDateMmDd(v: string | Date | null | undefined): string {
  if (!v) return "";
  if (v instanceof Date) {
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${m}/${d}`;
  }
  const s = String(v).trim();
  const match = s.match(/(?:(\d{4})[\-/])?(\d{1,2})[\-/](\d{1,2})/);
  if (match) {
    const mth = String(match[2]).padStart(2, '0');
    const day = String(match[3]).padStart(2, '0');
    return `${mth}/${day}`;
  }
  return s;
}

export function cleanStr(val: any): string {
  if (val === null || val === undefined) return "";
  const s = String(val).trim();
  const lower = s.toLowerCase();
  if (["nan", "nat", "none"].includes(lower)) return "";
  return s;
}
