import * as logic from './logic.js';
import * as notion from './notion.js';
import {resolveWorkflowManagerNestedDatabase} from './workflowNotion.js';

const DEFAULT_DEFECTIVE_PARTS_DATABASE_ID = '11132a09e406803e933cebd191e9fb82';
const DEFECTIVE_PARTS_DATABASE_ID =
  process.env.DEFECTIVE_PARTS_DATABASE_ID || DEFAULT_DEFECTIVE_PARTS_DATABASE_ID;
const TRACKER_TIME_ZONE = process.env.TRACKER_TIME_ZONE || process.env.TZ || 'Asia/Tokyo';

type CalendarPage = {
  id: string;
  title: string;
  date: string;
};

type TrackerSchemaStatus = {
  accessible: boolean;
  canSubmit: boolean;
  defectTypeOptions: string[];
  warning: string | null;
};

type NotionPropertySchema = {
  checkbox?: Record<string, never>;
  id: string;
  multi_select?: {options?: Array<{name: string}>};
  name?: string;
  relation?: {database_id?: string};
  select?: {options?: Array<{name: string}>};
  status?: {options?: Array<{name: string}>};
  type: string;
};

type TrackerSourceExtraction = {
  colorOptions: string[];
  colorPartMap: Record<string, string[]>;
  warnings: string[];
};

export type DefectiveTrackerSourceDatabase = {
  discoverySource: notion.NestedDatabaseLookupSource;
  id: string;
  title: string;
};

export type DefectiveTrackerSnapshot = {
  calendarPage: CalendarPage | null;
  canSubmit: boolean;
  colorOptions: string[];
  colorPartMap: Record<string, string[]>;
  databaseAccessible: boolean;
  databaseId: string;
  defectTypeOptions: string[];
  nestedDatabase: DefectiveTrackerSourceDatabase | null;
  timeZone: string;
  today: string;
  warning: string | null;
};

export type DefectiveTrackerSubmission = {
  color: string;
  defectType: string;
  partName: string;
  partNumber: string;
  quantity: string;
};

function getIsoDateInTimeZone(timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDatabaseProperties(database: any): Record<string, NotionPropertySchema> {
  return (database?.properties || {}) as Record<string, NotionPropertySchema>;
}

function getTitlePropertyName(properties: Record<string, NotionPropertySchema>): string | null {
  for (const [name, property] of Object.entries(properties)) {
    if (property?.type === 'title') {
      return name;
    }
  }
  return null;
}

function sortUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ja'));
}

function buildSelectOptions(property?: NotionPropertySchema): string[] {
  if (!property) {
    return [];
  }

  if (property.type === 'select') {
    return sortUnique((property.select?.options || []).map((option) => logic.cleanStr(option.name)));
  }

  if (property.type === 'status') {
    return sortUnique((property.status?.options || []).map((option) => logic.cleanStr(option.name)));
  }

  if (property.type === 'multi_select') {
    return sortUnique((property.multi_select?.options || []).map((option) => logic.cleanStr(option.name)));
  }

  return [];
}

function buildTrackerSchemaStatus(database: any): TrackerSchemaStatus {
  const properties = getDatabaseProperties(database);
  const titlePropertyName = getTitlePropertyName(properties);
  const partNameProperty = properties['部品名'];
  const qtyProperty = properties['数量'];
  const defectTypeProperty = properties['不良類'];
  const defectTypeOptions = buildSelectOptions(defectTypeProperty);
  const missing: string[] = [];

  if (!titlePropertyName) {
    missing.push('title');
  }
  if (!partNameProperty && titlePropertyName !== '部品名') {
    missing.push('部品名');
  }
  if (!qtyProperty) {
    missing.push('数量');
  }
  if (!defectTypeProperty) {
    missing.push('不良類');
  }

  if (missing.length > 0) {
    return {
      accessible: true,
      canSubmit: false,
      defectTypeOptions,
      warning: `Defective parts database is missing: ${missing.join(', ')}`,
    };
  }

  if (
    defectTypeProperty &&
    (defectTypeProperty.type === 'select' ||
      defectTypeProperty.type === 'status' ||
      defectTypeProperty.type === 'multi_select') &&
    defectTypeOptions.length === 0
  ) {
    return {
      accessible: true,
      canSubmit: false,
      defectTypeOptions,
      warning: 'The 不良類 property has no selectable options yet.',
    };
  }

  return {
    accessible: true,
    canSubmit: true,
    defectTypeOptions,
    warning: null,
  };
}

function collectPlainTextFromRichText(fragments: any[]): string {
  return (fragments || [])
    .map((fragment) => {
      if (typeof fragment?.plain_text === 'string') {
        return fragment.plain_text;
      }
      if (fragment?.type === 'text') {
        return fragment.text?.content || '';
      }
      if (fragment?.type === 'mention') {
        return fragment.plain_text || '';
      }
      return '';
    })
    .join('');
}

function collectPropertyPlainText(property: any): string {
  if (!property || typeof property !== 'object') {
    return '';
  }

  switch (property.type) {
    case 'title':
      return collectPlainTextFromRichText(property.title || []);
    case 'rich_text':
      return collectPlainTextFromRichText(property.rich_text || []);
    case 'select':
      return logic.cleanStr(property.select?.name);
    case 'status':
      return logic.cleanStr(property.status?.name);
    case 'multi_select':
      return (property.multi_select || [])
        .map((option: any) => logic.cleanStr(option?.name))
        .filter(Boolean)
        .join('\n');
    case 'formula': {
      const formula = property.formula;
      if (!formula) {
        return '';
      }
      if (formula.type === 'string') {
        return logic.cleanStr(formula.string);
      }
      if (formula.type === 'number' && typeof formula.number === 'number') {
        return String(formula.number);
      }
      if (formula.type === 'date') {
        return logic.cleanStr(formula.date?.start);
      }
      if (formula.type === 'boolean') {
        return formula.boolean ? 'true' : '';
      }
      return '';
    }
    default:
      return '';
  }
}

function splitVisibleLines(value: string): string[] {
  return sortUnique(
    value
      .split(/\r?\n/)
      .map((line) => logic.cleanStr(line))
      .filter(Boolean),
  );
}

function normalizeTrackerColor(value: string): string {
  const cleaned = logic.cleanStr(value).replace(/^[✅☑️✔︎✓\s　]+/, '');
  return logic.normalizeColorKey(cleaned);
}

function normalizePartNumberLine(value: string): string {
  return logic.normalizePartKey(logic.cleanStr(value));
}

function extractColorValues(properties: Record<string, any>): string[] {
  const property = properties['色'];
  if (!property) {
    return [];
  }

  if (property.type === 'select') {
    return sortUnique([normalizeTrackerColor(property.select?.name || '')].filter(Boolean));
  }

  if (property.type === 'status') {
    return sortUnique([normalizeTrackerColor(property.status?.name || '')].filter(Boolean));
  }

  if (property.type === 'multi_select') {
    return sortUnique(
      (property.multi_select || [])
        .map((option: any) => normalizeTrackerColor(option?.name || ''))
        .filter(Boolean),
    );
  }

  return sortUnique(
    splitVisibleLines(collectPropertyPlainText(property))
      .map((value) => normalizeTrackerColor(value))
      .filter(Boolean),
  );
}

function extractPartNumbers(properties: Record<string, any>): string[] {
  const property = properties['品番'];
  if (!property) {
    return [];
  }

  if (property.type === 'select') {
    return sortUnique([normalizePartNumberLine(property.select?.name || '')].filter(Boolean));
  }

  if (property.type === 'status') {
    return sortUnique([normalizePartNumberLine(property.status?.name || '')].filter(Boolean));
  }

  if (property.type === 'multi_select') {
    return sortUnique(
      (property.multi_select || [])
        .map((option: any) => normalizePartNumberLine(option?.name || ''))
        .filter(Boolean),
    );
  }

  return sortUnique(
    splitVisibleLines(collectPropertyPlainText(property))
      .map((value) => normalizePartNumberLine(value))
      .filter(Boolean),
  );
}

function buildTrackerSourceExtraction(existingPages: any[]): TrackerSourceExtraction {
  const warnings: string[] = [];
  const partsByColor = new Map<string, Set<string>>();
  let rowsMissingColor = 0;
  let rowsMissingPartNumber = 0;
  let rowsWithEmptyPartNumberText = 0;

  if (existingPages.length === 0) {
    warnings.push('The nested 「作業内容」 database is empty.');
  }

  for (const page of existingPages) {
    const properties = (page as any).properties || {};
    const colors = extractColorValues(properties);
    if (colors.length === 0) {
      rowsMissingColor += 1;
      continue;
    }

    const partProperty = properties['品番'];
    if (!partProperty) {
      rowsMissingPartNumber += 1;
      continue;
    }

    const partNumbers = extractPartNumbers(properties);
    if (partNumbers.length === 0) {
      if (partProperty.type === 'rich_text' || partProperty.type === 'title') {
        rowsWithEmptyPartNumberText += 1;
      } else {
        rowsMissingPartNumber += 1;
      }
      continue;
    }

    colors.forEach((color) => {
      const colorSet = partsByColor.get(color) || new Set<string>();
      partNumbers.forEach((partNumber) => colorSet.add(partNumber));
      partsByColor.set(color, colorSet);
    });
  }

  if (rowsMissingColor > 0) {
    warnings.push(`${rowsMissingColor} source row${rowsMissingColor === 1 ? '' : 's'} are missing 色.`);
  }
  if (rowsMissingPartNumber > 0) {
    warnings.push(`${rowsMissingPartNumber} source row${rowsMissingPartNumber === 1 ? '' : 's'} are missing 品番.`);
  }
  if (rowsWithEmptyPartNumberText > 0) {
    warnings.push(
      `${rowsWithEmptyPartNumberText} source row${rowsWithEmptyPartNumberText === 1 ? '' : 's'} have empty 品番 rich text.`,
    );
  }

  const colorPartMap = Object.fromEntries(
    Array.from(partsByColor.entries()).map(([color, partNumbers]) => [color, Array.from(partNumbers).sort((a, b) => a.localeCompare(b, 'ja'))]),
  ) as Record<string, string[]>;

  const colorOptions = Object.keys(colorPartMap).sort((a, b) => a.localeCompare(b, 'ja'));
  if (colorOptions.length === 0 && existingPages.length > 0) {
    warnings.push('No usable 色 / 品番 rows were found in the nested 「作業内容」 database.');
  }

  return {
    colorOptions,
    colorPartMap,
    warnings,
  };
}

async function resolveTrackerCalendarPage(pageId?: string): Promise<CalendarPage> {
  if (pageId) {
    try {
      const matched = await notion.getCalendarPageById(pageId);
      if (matched) {
        return matched;
      }
    } catch (error) {
      console.warn(`[defective-parts] direct page lookup failed for ${pageId}:`, error);
    }

    const pages = await notion.getCalendarPagesNextN(30);
    const fallbackMatch = pages.find((page) => page.id === pageId);
    if (fallbackMatch) {
      return fallbackMatch;
    }

    throw new Error('The selected page could not be resolved from Notion.');
  }

  const today = getIsoDateInTimeZone(TRACKER_TIME_ZONE);
  const exactTodayMatch = await notion.getCalendarPageForDate(today);
  if (exactTodayMatch) {
    return exactTodayMatch;
  }

  const pages = await notion.getCalendarPagesNextN();
  if (pages.length === 0) {
    throw new Error('No calendar pages were returned by the workflow manager search.');
  }

  return pages.find((page) => page.date === today) || pages[0];
}

async function loadWorkflowContextForTracker(pageId?: string): Promise<{
  calendarPage: CalendarPage;
  colorOptions: string[];
  colorPartMap: Record<string, string[]>;
  nestedDatabase: DefectiveTrackerSourceDatabase;
  warnings: string[];
}> {
  const calendarPage = await resolveTrackerCalendarPage(pageId);
  const nestedResolution = await resolveWorkflowManagerNestedDatabase(calendarPage.id, '作業内容');
  const nestedDatabaseTitle =
    nestedResolution.childDatabases.find((database) => database.id === nestedResolution.nestedId)?.title || '作業内容';

  console.info(
    `[defective-parts] source database ${nestedResolution.nestedId} (${nestedDatabaseTitle}) resolved from ${nestedResolution.discoverySource} search for page ${calendarPage.id}`,
  );

  const existingPages = await notion.getAllPages(nestedResolution.nestedId);
  const extracted = buildTrackerSourceExtraction(existingPages);

  if (extracted.warnings.length > 0) {
    console.warn(
      `[defective-parts] source extraction warnings for ${nestedResolution.nestedId}: ${extracted.warnings.join(' | ')}`,
    );
  }

  return {
    calendarPage,
    colorOptions: extracted.colorOptions,
    colorPartMap: extracted.colorPartMap,
    nestedDatabase: {
      discoverySource: nestedResolution.discoverySource,
      id: nestedResolution.nestedId,
      title: nestedDatabaseTitle,
    },
    warnings: extracted.warnings,
  };
}

function resolvePartPageId(partNumber: string, partName: string, partsMap: Record<string, string>): string | null {
  const candidates = sortUnique([logic.cleanStr(partNumber), logic.cleanStr(partName)].filter(Boolean));

  for (const candidate of candidates) {
    if (partsMap[candidate]) {
      return partsMap[candidate];
    }
  }

  let bestKey: string | null = null;
  let bestLength = -1;
  for (const candidate of candidates) {
    for (const key of Object.keys(partsMap)) {
      if (!candidate.startsWith(key)) {
        continue;
      }
      if (key.length > bestLength) {
        bestKey = key;
        bestLength = key.length;
      }
    }
  }

  return bestKey ? partsMap[bestKey] : null;
}

function buildTitlePropertyValue(value: string) {
  return {
    title: value
      ? [{type: 'text', text: {content: value}}]
      : [],
  };
}

function buildRichTextPropertyValue(value: string) {
  return {
    rich_text: value
      ? [{type: 'text', text: {content: value}}]
      : [],
  };
}

function buildStringPropertyValue(property: NotionPropertySchema, value: string) {
  const cleaned = logic.cleanStr(value);

  switch (property.type) {
    case 'title':
      return buildTitlePropertyValue(cleaned);
    case 'rich_text':
      return buildRichTextPropertyValue(cleaned);
    case 'number': {
      if (!cleaned) {
        return {number: null};
      }
      const parsed = Number.parseFloat(cleaned);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid number value: ${value}`);
      }
      return {number: parsed};
    }
    case 'select':
      return {select: cleaned ? {name: cleaned} : null};
    case 'status':
      return {status: cleaned ? {name: cleaned} : null};
    case 'multi_select':
      return {multi_select: cleaned ? [{name: cleaned}] : []};
    case 'date':
      return {date: cleaned ? {start: cleaned} : null};
    case 'url':
      return {url: cleaned || null};
    case 'email':
      return {email: cleaned || null};
    case 'phone_number':
      return {phone_number: cleaned || null};
    default:
      throw new Error(`Unsupported property type: ${property.type}`);
  }
}

function buildPartLookupPropertyValue(
  property: NotionPropertySchema,
  displayValue: string,
  partNumber: string,
  partName: string,
  partsMap: Record<string, string>,
) {
  if (property.type === 'relation') {
    const resolvedPartPageId = resolvePartPageId(partNumber, partName, partsMap);
    if (!resolvedPartPageId) {
      throw new Error(`Could not resolve a Notion page for 品番: ${partNumber || partName}`);
    }
    return {relation: [{id: resolvedPartPageId}]};
  }

  if (property.type === 'checkbox') {
    return {checkbox: true};
  }

  return buildStringPropertyValue(property, displayValue);
}

function addOptionalProperty(
  payload: Record<string, any>,
  properties: Record<string, NotionPropertySchema>,
  propertyName: string,
  value: string,
) {
  const property = properties[propertyName];
  if (!property) {
    return;
  }

  payload[propertyName] = buildStringPropertyValue(property, value);
}

function resolveTitleValue(
  titlePropertyName: string,
  submission: Pick<DefectiveTrackerSubmission, 'partName' | 'partNumber'>,
): string {
  if (titlePropertyName === '品番') {
    return submission.partNumber || submission.partName;
  }
  return submission.partName || submission.partNumber;
}

function buildSubmissionProperties(
  properties: Record<string, NotionPropertySchema>,
  submission: DefectiveTrackerSubmission,
  today: string,
  partsMap: Record<string, string>,
) {
  const titlePropertyName = getTitlePropertyName(properties);
  if (!titlePropertyName) {
    throw new Error('The defective parts database has no title property.');
  }

  const payload: Record<string, any> = {
    [titlePropertyName]: buildTitlePropertyValue(resolveTitleValue(titlePropertyName, submission)),
  };

  if (properties['部品名'] && titlePropertyName !== '部品名') {
    payload['部品名'] = buildPartLookupPropertyValue(
      properties['部品名'],
      submission.partName,
      submission.partNumber,
      submission.partName,
      partsMap,
    );
  }

  if (properties['品番'] && titlePropertyName !== '品番') {
    payload['品番'] = buildPartLookupPropertyValue(
      properties['品番'],
      submission.partNumber,
      submission.partNumber,
      submission.partName,
      partsMap,
    );
  }

  if (properties['数量']) {
    payload['数量'] = buildStringPropertyValue(properties['数量'], submission.quantity);
  }

  if (properties['不良類']) {
    payload['不良類'] = buildStringPropertyValue(properties['不良類'], submission.defectType);
  }

  addOptionalProperty(payload, properties, '色', submission.color);
  addOptionalProperty(payload, properties, '日付', today);

  return payload;
}

function normalizePositiveQuantity(value: string): string {
  const cleaned = logic.cleanStr(value).replace(/,/g, '');
  if (!cleaned) {
    throw new Error('数量 is required.');
  }

  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('数量 must be a positive number.');
  }

  if (Math.abs(parsed - Math.round(parsed)) < 1e-9) {
    return String(Math.round(parsed));
  }

  return String(parsed);
}

function normalizeSubmission(submission: DefectiveTrackerSubmission): DefectiveTrackerSubmission {
  const color = normalizeTrackerColor(submission.color);
  const defectType = logic.cleanStr(submission.defectType);
  const partName = logic.cleanStr(submission.partName);
  const partNumber = normalizePartNumberLine(submission.partNumber);
  const quantity = normalizePositiveQuantity(submission.quantity);

  if (!color) {
    throw new Error('色 is required.');
  }
  if (!partNumber) {
    throw new Error('品番 is required.');
  }
  if (!partName) {
    throw new Error('部品名 is required.');
  }
  if (!defectType) {
    throw new Error('不良類 is required.');
  }

  return {
    color,
    defectType,
    partName,
    partNumber,
    quantity,
  };
}

export async function loadDefectiveTrackerSnapshot(pageId?: string): Promise<DefectiveTrackerSnapshot> {
  const today = getIsoDateInTimeZone(TRACKER_TIME_ZONE);
  const [workflowContextResult, defectDatabaseResult] = await Promise.allSettled([
    loadWorkflowContextForTracker(pageId),
    notion.retrieveDatabase(DEFECTIVE_PARTS_DATABASE_ID),
  ]);

  const warnings: string[] = [];
  let calendarPage: CalendarPage | null = null;
  let colorOptions: string[] = [];
  let colorPartMap: Record<string, string[]> = {};
  let nestedDatabase: DefectiveTrackerSourceDatabase | null = null;

  if (workflowContextResult.status === 'fulfilled') {
    calendarPage = workflowContextResult.value.calendarPage;
    colorOptions = workflowContextResult.value.colorOptions;
    colorPartMap = workflowContextResult.value.colorPartMap;
    nestedDatabase = workflowContextResult.value.nestedDatabase;
    warnings.push(...workflowContextResult.value.warnings);
  } else {
    warnings.push(workflowContextResult.reason?.message || String(workflowContextResult.reason));
  }

  let schemaStatus: TrackerSchemaStatus = {
    accessible: false,
    canSubmit: false,
    defectTypeOptions: [],
    warning: null,
  };

  if (defectDatabaseResult.status === 'fulfilled') {
    schemaStatus = buildTrackerSchemaStatus(defectDatabaseResult.value);
    if (schemaStatus.warning) {
      warnings.push(schemaStatus.warning);
    }
  } else {
    warnings.push(defectDatabaseResult.reason?.message || String(defectDatabaseResult.reason));
  }

  return {
    calendarPage,
    canSubmit: schemaStatus.canSubmit,
    colorOptions,
    colorPartMap,
    databaseAccessible: schemaStatus.accessible,
    databaseId: DEFECTIVE_PARTS_DATABASE_ID,
    defectTypeOptions: schemaStatus.defectTypeOptions,
    nestedDatabase,
    timeZone: TRACKER_TIME_ZONE,
    today,
    warning: warnings.length > 0 ? warnings.join(' | ') : null,
  };
}

export async function submitDefectiveParts(submissions: DefectiveTrackerSubmission[]) {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    throw new Error('A defective-parts submission is required.');
  }

  const cleanedSubmissions = submissions.map((submission) => normalizeSubmission(submission));
  const today = getIsoDateInTimeZone(TRACKER_TIME_ZONE);
  const [database, partsMap] = await Promise.all([
    notion.retrieveDatabase(DEFECTIVE_PARTS_DATABASE_ID),
    notion.buildPartsMap(),
  ]);
  const properties = getDatabaseProperties(database);
  const schemaStatus = buildTrackerSchemaStatus(database);

  if (!schemaStatus.canSubmit) {
    throw new Error(schemaStatus.warning || 'Defective parts database is not ready.');
  }

  let created = 0;
  for (const submission of cleanedSubmissions) {
    const pageProperties = buildSubmissionProperties(properties, submission, today, partsMap);
    const createdPage = await notion.createPage(DEFECTIVE_PARTS_DATABASE_ID, pageProperties);
    if (!createdPage?.id) {
      throw new Error('Notion did not return a page ID — the record was not saved. Check the integration permissions.');
    }
    console.info(`[defective-parts] created page ${createdPage.id} in ${DEFECTIVE_PARTS_DATABASE_ID}`);
    created += 1;
  }

  return {
    created,
    databaseId: DEFECTIVE_PARTS_DATABASE_ID,
    today,
  };
}
