import fs from 'fs';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';

export type HiraharaUploadSource = {
  displayName: string;
  filePath: string;
};

export type HiraharaCompileSummary = {
  compiledRows: number;
  monthLabel: string;
  skippedFiles: string[];
  sourceFiles: number;
  sourceOrderSections: number;
};

export type HiraharaCompileResult = {
  buffer: Buffer;
  filename: string;
  summary: HiraharaCompileSummary;
};

type ParsedOrderRow = {
  color: string;
  dueDate: string;
  orderDate: Date;
  part: string;
  quantity: number;
  sequence: number;
  totalPrice: number;
  unitPrice: number;
};

type ParsedFileResult = {
  rows: ParsedOrderRow[];
  sections: number;
  warning?: string;
};

const DATA_START_ROW = 7;
const TEMPLATE_TOTAL_ROW = 199;
const TEMPLATE_LAST_DATA_ROW = TEMPLATE_TOTAL_ROW - 1;
const TEMPLATE_MAX_DATA_ROWS = TEMPLATE_LAST_DATA_ROW - DATA_START_ROW + 1;
const ORDER_TITLE = '注文書';
const SHEET_TITLE_SINGLE = 'ヒラハラ様　請求明細';
const TEAM_LABEL = '塗装ﾁｰﾑ';
const OWNER_LABEL = '藤平';
const HEADER_ROW = ['注文　月　日', '品番', '色', '希望納期', '数量', '単価', '価格', ''];
const DATE_PATTERN = /^(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})$/;
const FORMAT_NUMBER = '#,##0';
const FORMAT_DATE = 'm/d/yy';
const TOTALS_VALUE_FONT = {
  name: 'Arial',
  size: 16,
};
const TITLE_CELL_STYLE = {
  alignment: {
    horizontal: 'center',
    vertical: 'center',
  },
  font: {
    name: 'Arial',
    sz: 24,
  },
};
const DATE_HEADER_CELL_STYLE = {
  alignment: {
    horizontal: 'center',
    vertical: 'center',
  },
  font: {
    name: 'Arial',
    sz: 18,
  },
};
const TEMPLATE_PATH_CANDIDATES = [
  process.env.HIRAHARA_TEMPLATE_PATH?.trim() || '',
  '/home/atrcb/companyshare/製造グループ/塗装チーム/レオ/Excel Files/ヒラハラ注文書_2026.3月度.xls',
  '/home/atrcb/companyshare/製造グループ/塗装チーム/レオ/Excel Files/Computed Form.xls',
].filter(Boolean);
const TEMPLATE_MERGES = [
  XLSX.utils.decode_range('A1:H1'),
  XLSX.utils.decode_range('C2:E3'),
  XLSX.utils.decode_range('D4:E4'),
];
const TEMPLATE_COLS = [
  { wch: 11.5 },
  { wch: 12.5 },
  { wch: 10.5 },
  { wch: 12.5 },
  { wch: 9.5 },
  { wch: 10.5 },
  { wch: 12.5 },
  { hidden: true, wch: 4.5 },
];

const FULLWIDTH_KATAKANA_MAP: Record<string, string> = {
  '。': '｡',
  '「': '｢',
  '」': '｣',
  '、': '､',
  '・': '･',
  'ー': 'ｰ',
  'ァ': 'ｧ',
  'ア': 'ｱ',
  'ィ': 'ｨ',
  'イ': 'ｲ',
  'ゥ': 'ｩ',
  'ウ': 'ｳ',
  'ヴ': 'ｳﾞ',
  'ェ': 'ｪ',
  'エ': 'ｴ',
  'ォ': 'ｫ',
  'オ': 'ｵ',
  'カ': 'ｶ',
  'ガ': 'ｶﾞ',
  'キ': 'ｷ',
  'ギ': 'ｷﾞ',
  'ク': 'ｸ',
  'グ': 'ｸﾞ',
  'ケ': 'ｹ',
  'ゲ': 'ｹﾞ',
  'コ': 'ｺ',
  'ゴ': 'ｺﾞ',
  'サ': 'ｻ',
  'ザ': 'ｻﾞ',
  'シ': 'ｼ',
  'ジ': 'ｼﾞ',
  'ス': 'ｽ',
  'ズ': 'ｽﾞ',
  'セ': 'ｾ',
  'ゼ': 'ｾﾞ',
  'ソ': 'ｿ',
  'ゾ': 'ｿﾞ',
  'タ': 'ﾀ',
  'ダ': 'ﾀﾞ',
  'チ': 'ﾁ',
  'ヂ': 'ﾁﾞ',
  'ッ': 'ｯ',
  'ツ': 'ﾂ',
  'ヅ': 'ﾂﾞ',
  'テ': 'ﾃ',
  'デ': 'ﾃﾞ',
  'ト': 'ﾄ',
  'ド': 'ﾄﾞ',
  'ナ': 'ﾅ',
  'ニ': 'ﾆ',
  'ヌ': 'ﾇ',
  'ネ': 'ﾈ',
  'ノ': 'ﾉ',
  'ハ': 'ﾊ',
  'バ': 'ﾊﾞ',
  'パ': 'ﾊﾟ',
  'ヒ': 'ﾋ',
  'ビ': 'ﾋﾞ',
  'ピ': 'ﾋﾟ',
  'フ': 'ﾌ',
  'ブ': 'ﾌﾞ',
  'プ': 'ﾌﾟ',
  'ヘ': 'ﾍ',
  'ベ': 'ﾍﾞ',
  'ペ': 'ﾍﾟ',
  'ホ': 'ﾎ',
  'ボ': 'ﾎﾞ',
  'ポ': 'ﾎﾟ',
  'マ': 'ﾏ',
  'ミ': 'ﾐ',
  'ム': 'ﾑ',
  'メ': 'ﾒ',
  'モ': 'ﾓ',
  'ャ': 'ｬ',
  'ヤ': 'ﾔ',
  'ュ': 'ｭ',
  'ユ': 'ﾕ',
  'ョ': 'ｮ',
  'ヨ': 'ﾖ',
  'ラ': 'ﾗ',
  'リ': 'ﾘ',
  'ル': 'ﾙ',
  'レ': 'ﾚ',
  'ロ': 'ﾛ',
  'ヮ': 'ﾜ',
  'ワ': 'ﾜ',
  'ヲ': 'ｦ',
  'ン': 'ﾝ',
  '゛': 'ﾞ',
  '゜': 'ﾟ',
};

const cleanText = (value: unknown): string => String(value ?? '').replace(/\r?\n/g, ' ').trim();

const toHalfWidthKana = (value: string): string =>
  Array.from(value).map((character) => FULLWIDTH_KATAKANA_MAP[character] ?? character).join('');

const normalizeText = (value: unknown): string => toHalfWidthKana(cleanText(value));

const parseNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = cleanText(value);
  if (!text) {
    return null;
  }

  const normalized = text.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseOrderDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const text = cleanText(value);
  if (!text) {
    return null;
  }

  const matched = text.match(DATE_PATTERN);
  if (!matched) {
    return null;
  }

  const first = Number(matched[1]);
  const second = Number(matched[2]);
  const third = Number(matched[3]);

  const year = matched[1].length === 4 ? first : matched[3].length === 4 ? third : 2000 + third;
  const month = matched[1].length === 4 ? second : first;
  const day = matched[1].length === 4 ? third : second;
  const parsed = new Date(year, month - 1, day);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
};

const isBlankItemRow = (row: unknown[]): boolean =>
  row.slice(0, 8).every((cell) => cleanText(cell) === '');

const isOrderHeaderRow = (row: unknown[]): boolean =>
  cleanText(row[0]) === '品番' && cleanText(row[5]) === '数量' && cleanText(row[6]) === '単価';

const isSectionBoundaryRow = (row: unknown[]): boolean => {
  const firstCell = cleanText(row[0]);
  const seventhCell = cleanText(row[6]);
  return (
    firstCell === ORDER_TITLE ||
    firstCell === '納品書' ||
    firstCell.startsWith('（塗装コード）') ||
    firstCell.startsWith('(塗装コード)') ||
    seventhCell === '小計' ||
    seventhCell === '消費税' ||
    seventhCell === '合計'
  );
};

const findSectionHeaderRow = (rows: unknown[][], startIndex: number): number => {
  for (let index = startIndex; index < rows.length && index < startIndex + 6; index += 1) {
    if (isOrderHeaderRow(rows[index] ?? [])) {
      return index;
    }
  }
  return -1;
};

const findSectionDate = (rows: unknown[][], sectionStartIndex: number, headerRowIndex: number): Date | null => {
  for (let rowIndex = sectionStartIndex; rowIndex <= headerRowIndex; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    for (let columnIndex = 0; columnIndex < 8; columnIndex += 1) {
      const parsed = parseOrderDate(row[columnIndex]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
};

const excelDateSerial = (value: Date): number =>
  Math.floor((Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) - Date.UTC(1899, 11, 30)) / 86400000);

const ensureCell = (worksheet: XLSX.WorkSheet, address: string) => {
  if (!worksheet[address]) {
    worksheet[address] = { t: 's', v: '' };
  }
  return worksheet[address]!;
};

const clearCellValue = (worksheet: XLSX.WorkSheet, address: string) => {
  const cell = ensureCell(worksheet, address);
  cell.t = 's';
  cell.v = '';
  delete cell.f;
  delete cell.w;
};

const setStringCell = (worksheet: XLSX.WorkSheet, address: string, value: string) => {
  const cell = ensureCell(worksheet, address);
  cell.t = 's';
  cell.v = value;
  delete cell.f;
  delete cell.w;
};

const setNumericCell = (worksheet: XLSX.WorkSheet, address: string, value: number, format = FORMAT_NUMBER) => {
  const cell = ensureCell(worksheet, address);
  cell.t = 'n';
  cell.v = value;
  cell.z = format;
  delete cell.f;
  delete cell.w;
};

const setCellStyle = (worksheet: XLSX.WorkSheet, address: string, style: Record<string, unknown>) => {
  const cell = ensureCell(worksheet, address);
  cell.s = style as never;
};

const pruneWorksheetAfterRow = (worksheet: XLSX.WorkSheet, lastRow: number) => {
  Object.keys(worksheet).forEach((address) => {
    if (!/^[A-Z]+\d+$/.test(address)) {
      return;
    }

    const rowNumber = Number(address.match(/\d+$/)?.[0] || 0);
    if (rowNumber > lastRow) {
      delete worksheet[address];
    }
  });

  const rowMetadata = (worksheet as XLSX.WorkSheet & { ['!rows']?: unknown[] })['!rows'];
  if (Array.isArray(rowMetadata)) {
    rowMetadata.length = Math.min(rowMetadata.length, lastRow);
    if (rowMetadata.length === 0) {
      delete (worksheet as XLSX.WorkSheet & { ['!rows']?: unknown[] })['!rows'];
    }
  }

  delete (worksheet as XLSX.WorkSheet & { ['!fullref']?: string })['!fullref'];
 };

const resolveTemplatePath = (): string | null => {
  for (const candidate of TEMPLATE_PATH_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const formatYearMonth = (value: Date): string => `${value.getFullYear()}.${value.getMonth() + 1}月`;

const sortByDate = (left: Date, right: Date): number => left.getTime() - right.getTime();

const getTotalsAnchorRow = (lastDataRow: number): number => lastDataRow + 2;

const buildPeriodMetadata = (rows: ParsedOrderRow[]): { filenameLabel: string; sheetName: string; title: string } => {
  const monthDates = Array.from(
    new Map(
      rows.map((row) => {
        const monthDate = new Date(row.orderDate.getFullYear(), row.orderDate.getMonth(), 1);
        return [monthDate.getTime(), monthDate];
      }),
    ).values(),
  ).sort(sortByDate);

  if (monthDates.length === 1) {
    const label = formatYearMonth(monthDates[0]);
    return {
      filenameLabel: `${label}度`,
      sheetName: label,
      title: `${label}度`,
    };
  }

  const firstLabel = formatYearMonth(monthDates[0]);
  const lastLabel = formatYearMonth(monthDates[monthDates.length - 1]);
  const rangeLabel = `${firstLabel}-${lastLabel}`;

  return {
    filenameLabel: `${rangeLabel}度`,
    sheetName: rangeLabel,
    title: `${rangeLabel}度`,
  };
};

const createTemplateWorkbook = (rows: ParsedOrderRow[]): XLSX.WorkBook | null => {
  const templatePath = resolveTemplatePath();
  if (!templatePath || rows.length > TEMPLATE_MAX_DATA_ROWS) {
    return null;
  }

  const period = buildPeriodMetadata(rows);
  const workbook = XLSX.readFile(templatePath, {
    cellDates: true,
    cellNF: true,
    cellStyles: true,
    raw: false,
  });

  const originalSheetName = workbook.SheetNames[0];
  if (!originalSheetName) {
    return null;
  }

  const worksheet = workbook.Sheets[originalSheetName];
  if (!worksheet) {
    return null;
  }

  for (let rowNumber = 2; rowNumber <= 4; rowNumber += 1) {
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((column) => {
      clearCellValue(worksheet, `${column}${rowNumber}`);
    });
  }

  for (let rowNumber = DATA_START_ROW; rowNumber <= TEMPLATE_LAST_DATA_ROW; rowNumber += 1) {
    ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach((column) => {
      clearCellValue(worksheet, `${column}${rowNumber}`);
    });
  }

  setStringCell(worksheet, 'A1', SHEET_TITLE_SINGLE);
  setStringCell(worksheet, 'C2', period.title);
  setCellStyle(worksheet, 'A1', TITLE_CELL_STYLE);
  setCellStyle(worksheet, 'C2', DATE_HEADER_CELL_STYLE);
  setStringCell(worksheet, 'C4', TEAM_LABEL);
  setStringCell(worksheet, 'D4', OWNER_LABEL);
  setStringCell(worksheet, 'A6', HEADER_ROW[0]);
  setStringCell(worksheet, 'B6', HEADER_ROW[1]);
  setStringCell(worksheet, 'C6', HEADER_ROW[2]);
  setStringCell(worksheet, 'D6', HEADER_ROW[3]);
  setStringCell(worksheet, 'E6', HEADER_ROW[4]);
  setStringCell(worksheet, 'F6', HEADER_ROW[5]);
  setStringCell(worksheet, 'G6', HEADER_ROW[6]);

  let previousDateKey = '';
  rows.forEach((row, index) => {
    const excelRowNumber = DATA_START_ROW + index;
    const dateKey = `${row.orderDate.getFullYear()}-${row.orderDate.getMonth()}-${row.orderDate.getDate()}`;
    if (dateKey === previousDateKey) {
      clearCellValue(worksheet, `A${excelRowNumber}`);
    } else {
      setNumericCell(worksheet, `A${excelRowNumber}`, excelDateSerial(row.orderDate), FORMAT_DATE);
    }
    setStringCell(worksheet, `B${excelRowNumber}`, row.part);
    setStringCell(worksheet, `C${excelRowNumber}`, row.color);
    setStringCell(worksheet, `D${excelRowNumber}`, row.dueDate);
    setNumericCell(worksheet, `E${excelRowNumber}`, row.quantity);
    setNumericCell(worksheet, `F${excelRowNumber}`, row.unitPrice);
    setNumericCell(worksheet, `G${excelRowNumber}`, row.totalPrice);
    previousDateKey = dateKey;
  });

  const lastDataRow = DATA_START_ROW + rows.length - 1;
  const totalRow = getTotalsAnchorRow(lastDataRow);
  const taxRow = totalRow + 1;
  const grandTotalRow = totalRow + 2;
  const subtotal = rows.reduce((sum, row) => sum + row.totalPrice, 0);
  const tax = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + tax;

  ['F199', 'G199', 'F200', 'G200', 'F201', 'G201'].forEach((address) => {
    clearCellValue(worksheet, address);
  });

  setStringCell(worksheet, `F${totalRow}`, '金額');
  setNumericCell(worksheet, `G${totalRow}`, subtotal);
  setStringCell(worksheet, `F${taxRow}`, '消費税');
  setNumericCell(worksheet, `G${taxRow}`, tax);
  setStringCell(worksheet, `F${grandTotalRow}`, '合計金額');
  setNumericCell(worksheet, `G${grandTotalRow}`, grandTotal);
  pruneWorksheetAfterRow(worksheet, grandTotalRow);
  worksheet['!merges'] = TEMPLATE_MERGES;
  worksheet['!cols'] = TEMPLATE_COLS;
  worksheet['!ref'] = `A1:H${grandTotalRow}`;

  if (period.sheetName !== originalSheetName) {
    workbook.SheetNames[0] = period.sheetName;
    workbook.Sheets[period.sheetName] = worksheet;
    delete workbook.Sheets[originalSheetName];
  }

  return workbook;
};

const createWorkbook = (rows: ParsedOrderRow[]): XLSX.WorkBook => {
  const period = buildPeriodMetadata(rows);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([]);
  const lastDataRow = DATA_START_ROW + rows.length - 1;
  const totalRow = getTotalsAnchorRow(lastDataRow);
  const taxRow = totalRow + 1;
  const grandTotalRow = totalRow + 2;
  const subtotal = rows.reduce((sum, row) => sum + row.totalPrice, 0);
  const tax = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + tax;

  XLSX.utils.sheet_add_aoa(
    worksheet,
    [
      [SHEET_TITLE_SINGLE],
      ['', '', period.title, '', '', '', '', ''],
      [],
      ['', '', TEAM_LABEL, OWNER_LABEL, '', '', '', ''],
      [],
      HEADER_ROW,
    ],
    { origin: 'A1' },
  );

  let previousDateKey = '';
  rows.forEach((row, index) => {
    const excelRowNumber = DATA_START_ROW + index;
    const dateKey = `${row.orderDate.getFullYear()}-${row.orderDate.getMonth()}-${row.orderDate.getDate()}`;
    const dateCellAddress = `A${excelRowNumber}`;
    const quantityCellAddress = `E${excelRowNumber}`;
    const unitPriceCellAddress = `F${excelRowNumber}`;
    const totalPriceCellAddress = `G${excelRowNumber}`;

    worksheet[dateCellAddress] =
      dateKey === previousDateKey
        ? { t: 's', v: '' }
        : { t: 'n', v: excelDateSerial(row.orderDate), z: FORMAT_DATE };
    worksheet[`B${excelRowNumber}`] = { t: 's', v: row.part };
    worksheet[`C${excelRowNumber}`] = { t: 's', v: row.color };
    worksheet[`D${excelRowNumber}`] = { t: 's', v: row.dueDate };
    worksheet[quantityCellAddress] = { t: 'n', v: row.quantity, z: FORMAT_NUMBER };
    worksheet[unitPriceCellAddress] = { t: 'n', v: row.unitPrice, z: FORMAT_NUMBER };
    worksheet[totalPriceCellAddress] = { t: 'n', v: row.totalPrice, z: FORMAT_NUMBER };

    previousDateKey = dateKey;
  });

  worksheet[`F${totalRow}`] = { t: 's', v: '金額' };
  worksheet[`G${totalRow}`] = {
    t: 'n',
    v: subtotal,
    z: FORMAT_NUMBER,
  };
  worksheet[`F${taxRow}`] = { t: 's', v: '消費税' };
  worksheet[`G${taxRow}`] = {
    t: 'n',
    v: tax,
    z: FORMAT_NUMBER,
  };
  worksheet[`F${grandTotalRow}`] = { t: 's', v: '合計金額' };
  worksheet[`G${grandTotalRow}`] = {
    t: 'n',
    v: grandTotal,
    z: FORMAT_NUMBER,
  };
  setCellStyle(worksheet, 'A1', TITLE_CELL_STYLE);
  setCellStyle(worksheet, 'C2', DATE_HEADER_CELL_STYLE);

  worksheet['!cols'] = TEMPLATE_COLS;
  worksheet['!merges'] = TEMPLATE_MERGES;
  worksheet['!ref'] = `A1:H${grandTotalRow}`;

  XLSX.utils.book_append_sheet(workbook, worksheet, period.sheetName);
  return workbook;
};

const createStyledWorkbookBuffer = async (rows: ParsedOrderRow[]): Promise<Buffer> => {
  const period = buildPeriodMetadata(rows);
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(period.sheetName);
  const lastDataRow = DATA_START_ROW + rows.length - 1;
  const totalRow = getTotalsAnchorRow(lastDataRow);
  const taxRow = totalRow + 1;
  const grandTotalRow = totalRow + 2;
  const subtotal = rows.reduce((sum, row) => sum + row.totalPrice, 0);
  const tax = Math.round(subtotal * 0.1);
  const grandTotal = subtotal + tax;

  worksheet.columns = [
    { width: 11.5 },
    { width: 12.5 },
    { width: 10.5 },
    { width: 12.5 },
    { width: 9.5 },
    { width: 10.5 },
    { width: 12.5 },
    { width: 4.5, hidden: true },
  ];

  worksheet.mergeCells('A1:H1');
  worksheet.mergeCells('C2:E3');
  worksheet.mergeCells('D4:E4');

  worksheet.getCell('A1').value = SHEET_TITLE_SINGLE;
  worksheet.getCell('A1').font = { name: 'Arial', size: 24 };
  worksheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

  worksheet.getCell('C2').value = period.title;
  worksheet.getCell('C2').font = { name: 'Arial', size: 18 };
  worksheet.getCell('C2').alignment = { horizontal: 'center', vertical: 'middle' };

  worksheet.getCell('C4').value = TEAM_LABEL;
  worksheet.getCell('D4').value = OWNER_LABEL;

  HEADER_ROW.slice(0, 7).forEach((label, index) => {
    worksheet.getCell(6, index + 1).value = label;
  });

  let previousDateKey = '';
  rows.forEach((row, index) => {
    const excelRowNumber = DATA_START_ROW + index;
    const dateKey = `${row.orderDate.getFullYear()}-${row.orderDate.getMonth()}-${row.orderDate.getDate()}`;

    if (dateKey !== previousDateKey) {
      const dateCell = worksheet.getCell(`A${excelRowNumber}`);
      dateCell.value = new Date(row.orderDate.getFullYear(), row.orderDate.getMonth(), row.orderDate.getDate());
      dateCell.numFmt = FORMAT_DATE;
    }

    worksheet.getCell(`B${excelRowNumber}`).value = row.part;
    worksheet.getCell(`C${excelRowNumber}`).value = row.color;
    worksheet.getCell(`D${excelRowNumber}`).value = row.dueDate;

    const quantityCell = worksheet.getCell(`E${excelRowNumber}`);
    quantityCell.value = row.quantity;
    quantityCell.numFmt = FORMAT_NUMBER;

    const unitPriceCell = worksheet.getCell(`F${excelRowNumber}`);
    unitPriceCell.value = row.unitPrice;
    unitPriceCell.numFmt = FORMAT_NUMBER;

    const totalPriceCell = worksheet.getCell(`G${excelRowNumber}`);
    totalPriceCell.value = row.totalPrice;
    totalPriceCell.numFmt = FORMAT_NUMBER;

    previousDateKey = dateKey;
  });

  worksheet.getCell(`F${totalRow}`).value = '金額';
  worksheet.getCell(`G${totalRow}`).value = subtotal;
  worksheet.getCell(`G${totalRow}`).numFmt = FORMAT_NUMBER;
  worksheet.getCell(`G${totalRow}`).font = TOTALS_VALUE_FONT;
  worksheet.getCell(`F${taxRow}`).value = '消費税';
  worksheet.getCell(`G${taxRow}`).value = tax;
  worksheet.getCell(`G${taxRow}`).numFmt = FORMAT_NUMBER;
  worksheet.getCell(`G${taxRow}`).font = TOTALS_VALUE_FONT;
  worksheet.getCell(`F${grandTotalRow}`).value = '合計金額';
  worksheet.getCell(`G${grandTotalRow}`).value = grandTotal;
  worksheet.getCell(`G${grandTotalRow}`).numFmt = FORMAT_NUMBER;
  worksheet.getCell(`G${grandTotalRow}`).font = TOTALS_VALUE_FONT;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
};

const parseUploadedFile = (source: HiraharaUploadSource, sequenceStart: number): ParsedFileResult => {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(source.filePath, {
      cellDates: true,
      cellNF: true,
      raw: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      rows: [],
      sections: 0,
      warning: `${source.displayName}: ${message}`,
    };
  }

  const parsedRows: ParsedOrderRow[] = [];
  let sections = 0;
  let sequence = sequenceStart;

  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      defval: '',
      header: 1,
      raw: false,
    }) as unknown[][];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      if (cleanText(row[0]) !== ORDER_TITLE) {
        continue;
      }

      const headerRowIndex = findSectionHeaderRow(rows, rowIndex + 1);
      if (headerRowIndex < 0) {
        continue;
      }

      const orderDate = findSectionDate(rows, rowIndex, headerRowIndex);
      if (!orderDate) {
        continue;
      }

      sections += 1;
      let sectionRowCount = 0;

      for (let itemRowIndex = headerRowIndex + 1; itemRowIndex < rows.length; itemRowIndex += 1) {
        const itemRow = rows[itemRowIndex] ?? [];
        if (isBlankItemRow(itemRow)) {
          if (sectionRowCount > 0) {
            break;
          }
          continue;
        }
        if (isSectionBoundaryRow(itemRow) || isOrderHeaderRow(itemRow)) {
          break;
        }

        const part = normalizeText(itemRow[0]);
        const color = normalizeText(itemRow[2]);
        const dueDate = cleanText(itemRow[4]);
        const quantity = parseNumber(itemRow[5]);
        const unitPrice = parseNumber(itemRow[6]);
        const totalPrice = parseNumber(itemRow[7]) ?? (quantity !== null && unitPrice !== null ? quantity * unitPrice : null);

        if (!part || quantity === null || unitPrice === null || totalPrice === null) {
          continue;
        }

        parsedRows.push({
          color,
          dueDate,
          orderDate,
          part,
          quantity,
          sequence,
          totalPrice,
          unitPrice,
        });
        sectionRowCount += 1;
        sequence += 1;
      }
    }
  });

  if (parsedRows.length === 0) {
    return {
      rows: [],
      sections,
      warning: `${source.displayName}: 注文書の明細行を抽出できませんでした。`,
    };
  }

  return {
    rows: parsedRows,
    sections,
  };
};

export async function compileHiraharaOrders(sourceFiles: HiraharaUploadSource[]): Promise<HiraharaCompileResult> {
  if (!sourceFiles.length) {
    throw new Error('At least one workbook is required.');
  }

  const warnings: string[] = [];
  const compiledRows: ParsedOrderRow[] = [];
  let sourceOrderSections = 0;
  let sequenceCursor = 0;

  sourceFiles.forEach((source) => {
    const parsed = parseUploadedFile(source, sequenceCursor);
    if (parsed.warning) {
      warnings.push(parsed.warning);
    }
    compiledRows.push(...parsed.rows);
    sourceOrderSections += parsed.sections;
    sequenceCursor += parsed.rows.length;
  });

  if (!compiledRows.length) {
    throw new Error('No order rows were found in the uploaded workbooks.');
  }

  compiledRows.sort((left, right) => {
    const dateDiff = left.orderDate.getTime() - right.orderDate.getTime();
    return dateDiff !== 0 ? dateDiff : left.sequence - right.sequence;
  });

  const period = buildPeriodMetadata(compiledRows);
  const buffer = await createStyledWorkbookBuffer(compiledRows);

  return {
    buffer,
    filename: `ヒラハラ注文書_${period.filenameLabel}.xlsx`,
    summary: {
      compiledRows: compiledRows.length,
      monthLabel: period.filenameLabel,
      skippedFiles: warnings,
      sourceFiles: sourceFiles.length,
      sourceOrderSections,
    },
  };
}
