/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronRight,
  Database,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  Minus,
  Moon,
  Plus,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {AnimatePresence, motion} from 'motion/react';

declare global {
  interface Window {
    __EMBED_MODE__?: boolean;
    __EMBED_SESSION__?: Promise<string>;
  }
}

type View = 'home' | 'workflow-manager' | 'daily-generator' | 'defective-parts' | 'hirahara-orders' | 'settings';
type Theme = 'light' | 'dark';
type Language = 'en' | 'ja';
type ReviewCategory = 'all' | 'part' | 'color' | 'trial' | 'date';
type LocalizedText = Record<Language, string>;
type StepState = 'complete' | 'current' | 'upcoming';
type WorkflowStep = {
  label: LocalizedText;
  detail: LocalizedText;
  state: StepState;
};
type DownloadArtifact = {
  filename: string;
  url?: string;
  revokeUrl?: boolean;
  serverFile?: string;
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
type HiraharaCompileSummary = {
  compiledRows: number;
  monthLabel: string;
  skippedFiles: string[];
  sourceFiles: number;
  sourceOrderSections: number;
};
type LauncherTileConfig = {
  key: string;
  icon: any;
  accent: LauncherAccent;
  label: string;
  subtitle: string;
  badge?: string;
  card?: boolean;
  compact?: boolean;
  disabled?: boolean;
  spinning?: boolean;
  onClick: () => void;
};
type StartupCacheWarmSummary = {
  calendarPages: number;
  failures: string[];
  nestedDatabases: number;
  partsEntries: number;
  warmedDatabases: number;
};
type DefectiveTrackerField = 'color' | 'defectType' | 'partName' | 'partNumber' | 'quantity';
type DefectiveTrackerFieldErrors = Partial<Record<DefectiveTrackerField, string>>;
type DefectiveTrackerNotice = {
  message: string;
  tone: 'error' | 'success' | 'warning';
};
type DefectiveTrackerSnapshot = {
  calendarPage: CalendarPage | null;
  canSubmit: boolean;
  colorOptions: string[];
  colorPartMap: Record<string, string[]>;
  databaseAccessible: boolean;
  databaseId: string;
  defectTypeOptions: string[];
  nestedDatabase: {
    discoverySource: 'cache' | 'fresh';
    id: string;
    title: string;
  } | null;
  timeZone: string;
  today: string;
  warning: string | null;
};
type LauncherAccent = 'sky' | 'emerald' | 'amber' | 'violet' | 'slate';

interface CalendarPage {
  id: string;
  title: string;
  date: string;
}

interface Product {
  id: string;
  trial: string;
  part: string;
  color: string;
  qty: number;
  ct: number;
  date: string;
  selected: boolean;
  override: boolean;
  colorAccent: boolean;
  sourceRows?: number[];
  alreadySynced?: boolean;
}

interface LogEntry {
  timestamp: string;
  message: LocalizedText;
  type: 'info' | 'success' | 'warning' | 'error';
  icon?: string;
}

const text = (en: string, ja: string): LocalizedText => ({en, ja});

const VIEW_LABELS: Record<View, LocalizedText> = {
  home: text('Home', 'ホーム'),
  'workflow-manager': text('Workflow', 'ワークフロー'),
  'daily-generator': text('Daily Generator', '日次生成'),
  'defective-parts': text('Defective Parts Tracker', '欠品入力'),
  'hirahara-orders': text('Hirahara Orders', 'ヒラハラ注文書'),
  settings: text('Settings', '設定'),
};

const isAppleMobileDevice = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
};

const isEmbeddedMode = (): boolean => Boolean(window.__EMBED_MODE__);

const supportsNativeFilePicker = (): boolean =>
  typeof window !== 'undefined' && 'showOpenFilePicker' in window;

const supportsDirectoryPicker = (): boolean =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const HANDLE_DB_NAME = 'notion-backend-fs-handles';
const HANDLE_STORE_NAME = 'handles';

const openHandleDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    const request = indexedDB.open(HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        db.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });

const idbGet = async <T,>(key: string): Promise<T | null> => {
  const db = await openHandleDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
      const store = tx.objectStore(HANDLE_STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
    });
  } finally {
    db.close();
  }
};

const idbSet = async (key: string, value: unknown): Promise<void> => {
  const db = await openHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB set failed'));
    });
  } finally {
    db.close();
  }
};

const idbDel = async (key: string): Promise<void> => {
  const db = await openHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
    });
  } finally {
    db.close();
  }
};

const createObjectUrlDownloadArtifact = (base64: string, filename: string): DownloadArtifact => {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  return {
    filename,
    url: URL.createObjectURL(blob),
    revokeUrl: true,
  };
};

const triggerDownload = ({filename, url}: DownloadArtifact) => {
  if (!url) {
    return;
  }

  const prefersNewWindow = isEmbeddedMode();
  if (prefersNewWindow) {
    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (popup) {
      return;
    }
  }

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
  if (prefersNewWindow) {
    anchor.target = '_blank';
  }
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
};

const MOCK_CALENDAR_PAGES: CalendarPage[] = [
  {id: '1', title: '3/21 Painting Plan', date: '2026-03-21'},
  {id: '2', title: '3/22 Painting Plan', date: '2026-03-22'},
  {id: '3', title: '3/23 Painting Plan', date: '2026-03-23'},
  {id: '4', title: '3/24 Painting Plan', date: '2026-03-24'},
];

const MOCK_PRODUCTS: Product[] = [
  {id: 'p1', trial: '試作01', part: 'N93-3F Front Panel', color: '3F黒', qty: 120, ct: 45, date: '03/21', selected: false, override: false, colorAccent: false},
  {id: 'p2', trial: '', part: 'N93-3F Side Bracket', color: '3F黒', qty: 240, ct: 30, date: '03/21', selected: true, override: false, colorAccent: false},
  {id: 'p3', trial: '試作02', part: 'M12-Silver Frame', color: 'Silver', qty: 50, ct: 120, date: '03/21', selected: false, override: false, colorAccent: false},
  {id: 'p4', trial: '', part: 'M12-Silver Cover', color: 'Silver', qty: 50, ct: 80, date: '03/21', selected: false, override: false, colorAccent: false},
  {id: 'p5', trial: '', part: 'X9-Emerald Case', color: 'Emerald', qty: 10, ct: 300, date: '03/21', selected: true, override: true, colorAccent: true},
];

const getReviewCategoryFields = (category: ReviewCategory, product: Product): string[] => {
  switch (category) {
    case 'part':
      return [product.part];
    case 'color':
      return [product.color];
    case 'trial':
      return [product.trial];
    case 'date':
      return [product.date];
    default:
      return [product.part, product.color, product.trial, product.date, String(product.qty), String(product.ct)];
  }
};

const apiFetch = async (path: string, init?: RequestInit) => {
  const isEmbedApiCall = window.__EMBED_MODE__ && path.startsWith('/api/');
  if (!isEmbedApiCall) {
    return fetch(path, init);
  }

  const accessToken = await window.__EMBED_SESSION__;
  if (!accessToken) {
    throw new Error('Embed session is unavailable.');
  }

  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  const rewrittenPath = `/embed-api/${path.slice('/api/'.length)}`;
  return fetch(rewrittenPath, {
    ...init,
    headers,
  });
};

const Panel = ({
  children,
  className = '',
  strong = false,
}: {
  children: React.ReactNode;
  className?: string;
  strong?: boolean;
}) => (
  <div className={`overflow-hidden rounded-[28px] ${strong ? 'app-panel-strong' : 'app-panel'} ${className}`}>
    {children}
  </div>
);

const CircleToggle = ({
  active,
  tone,
  label,
  ariaLabel,
  onClick,
}: {
  active: boolean;
  tone: 'select' | 'success' | 'warning';
  label: string;
  ariaLabel: string;
  onClick: () => void;
}) => {
  const base =
    'inline-flex h-11 w-11 items-center justify-center rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_12px_24px_rgba(15,23,42,0.14)] transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-slate-200/90 md:h-12 md:w-12';
  const inactive =
    'border-[1.5px] border-white/90 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(243,246,250,0.96))] hover:border-slate-200';
  const activeClasses =
    tone === 'select'
      ? 'border-[2.5px] border-sky-700 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(243,246,250,0.96))] shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_14px_28px_rgba(37,99,235,0.14)]'
      : tone === 'success'
        ? 'border-[2.5px] border-emerald-700 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(243,246,250,0.96))] shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_14px_28px_rgba(5,150,105,0.14)]'
        : 'border-[2.5px] border-amber-700 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(243,246,250,0.96))] shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_14px_28px_rgba(180,83,9,0.14)]';
  const labelClasses =
    tone === 'select'
      ? 'text-sky-700'
      : tone === 'success'
        ? 'text-emerald-700'
        : 'text-amber-700';

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`${base} ${active ? activeClasses : inactive} ${active ? 'font-extrabold' : 'font-bold'}`}
    >
      <span className={`text-xs tracking-[-0.02em] ${labelClasses} md:text-sm`}>{label}</span>
    </button>
  );
};

const BackButton = ({label, onClick}: {label: string; onClick: () => void}) => (
  <button onClick={onClick} className="secondary-button w-fit">
    <ArrowLeft size={16} />
    {label}
  </button>
);

const launcherAccentClasses: Record<LauncherAccent, string> = {
  sky: 'launcher-icon-shell-sky',
  emerald: 'launcher-icon-shell-emerald',
  amber: 'launcher-icon-shell-amber',
  violet: 'launcher-icon-shell-violet',
  slate: 'launcher-icon-shell-slate',
};

const LauncherTile = ({
  icon: Icon,
  accent,
  label,
  subtitle,
  badge,
  card = false,
  compact = false,
  disabled = false,
  spinning = false,
  onClick,
}: {
  icon: any;
  accent: LauncherAccent;
  label: string;
  subtitle: string;
  badge?: string;
  card?: boolean;
  compact?: boolean;
  disabled?: boolean;
  spinning?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`launcher-tile text-left disabled:cursor-not-allowed disabled:opacity-75 ${compact ? 'launcher-tile-compact' : ''} ${card ? 'launcher-tile-card' : ''}`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className={`launcher-icon-shell ${launcherAccentClasses[accent]} ${compact ? 'launcher-icon-shell-compact' : ''} ${card ? 'launcher-icon-shell-card' : ''}`}>
        <span className="launcher-icon-gloss" aria-hidden="true" />
        <Icon size={compact ? 24 : card ? 22 : 26} className={spinning ? 'animate-spin' : ''} />
      </div>
      {badge && <span className="launcher-badge">{badge}</span>}
    </div>
    <div className={`mt-auto ${compact ? 'pt-3.5' : card ? 'pt-3' : 'pt-4'}`}>
      <p className={`${compact ? 'text-[0.9rem]' : card ? 'text-[0.95rem]' : 'text-base'} font-semibold tracking-[-0.03em] text-[var(--text-primary)]`}>{label}</p>
      <p className={`leading-snug text-[var(--text-secondary)] ${compact ? 'mt-1 text-[0.72rem]' : card ? 'mt-1 text-[0.76rem]' : 'mt-1 text-[0.82rem]'}`}>{subtitle}</p>
    </div>
  </button>
);

const LanguageToggle = ({
  language,
  onChange,
}: {
  language: Language;
  onChange: (nextLanguage: Language) => void;
}) => (
  <button
    type="button"
    onClick={() => onChange(language === 'ja' ? 'en' : 'ja')}
    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[color:var(--line)] bg-white/60 shadow-sm backdrop-blur-xl transition-all hover:bg-white/80 dark:bg-white/6 dark:hover:bg-white/10"
    aria-label={language === 'ja' ? 'Switch language to English' : '言語を日本語に切り替え'}
  >
    <span className={`leading-none font-semibold text-[var(--text-primary)] ${language === 'ja' ? 'text-[9px]' : 'text-[11px]'}`}>
      {language === 'ja' ? '日本語' : 'EN'}
    </span>
  </button>
);

const ActivityDrawer = ({
  open,
  onClose,
  logs,
  status,
  isBusy,
  reducedMotion,
  language,
}: {
  open: boolean;
  onClose: () => void;
  logs: LogEntry[];
  status: string;
  isBusy: boolean;
  reducedMotion: boolean;
  language: Language;
}) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.button
          aria-label={language === 'ja' ? 'アクティビティパネルを閉じる' : 'Close activity panel'}
          className="fixed inset-0 z-40 bg-slate-950/16 backdrop-blur-[2px]"
          initial={reducedMotion ? false : {opacity: 0}}
          animate={{opacity: 1}}
          exit={reducedMotion ? {opacity: 1} : {opacity: 0}}
          transition={{duration: reducedMotion ? 0 : 0.18}}
          onClick={onClose}
        />
        <motion.aside
          initial={reducedMotion ? false : {opacity: 0, x: 28}}
          animate={{opacity: 1, x: 0}}
          exit={reducedMotion ? {opacity: 1, x: 0} : {opacity: 0, x: 28}}
          transition={{duration: reducedMotion ? 0 : 0.18}}
          className="fixed inset-y-4 right-4 z-50 w-[min(380px,calc(100vw-2rem))]"
        >
          <div className="app-panel-strong flex h-full flex-col rounded-[30px] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[var(--text-tertiary)]">{language === 'ja' ? 'アクティビティ' : 'Activity'}</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]">
                  {language === 'ja' ? '最近の更新' : 'Recent updates'}
                </h2>
              </div>
              <button onClick={onClose} className="icon-button" aria-label={language === 'ja' ? '閉じる' : 'Close'}>
                <X size={18} />
              </button>
            </div>

            <div className="mt-5 rounded-[22px] border border-[color:var(--line)] bg-white/60 px-4 py-3 dark:bg-white/6">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className={`h-2.5 w-2.5 rounded-full ${isBusy ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span>{status}</span>
              </div>
            </div>

            <div className="soft-scroll mt-5 flex-1 space-y-3 overflow-y-auto pr-1">
              {logs.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-[color:var(--line)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                  {language === 'ja' ? '最近のアクティビティはありません。' : 'No recent activity.'}
                </div>
              ) : (
                [...logs].reverse().map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className="rounded-[22px] border border-[color:var(--line)] bg-white/50 px-4 py-4 dark:bg-white/4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        {log.icon ? (
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/80 text-sm shadow-sm dark:bg-white/10"
                            aria-hidden="true"
                          >
                            {log.icon}
                          </span>
                        ) : (
                          <span
                            className={`h-2 w-2 rounded-full ${
                              log.type === 'success'
                                ? 'bg-emerald-500'
                                : log.type === 'error'
                                  ? 'bg-rose-500'
                                  : log.type === 'warning'
                                    ? 'bg-amber-500'
                                    : 'bg-slate-400'
                            }`}
                          />
                        )}
                        <p className="text-sm font-medium text-[var(--text-primary)]">{log.message[language]}</p>
                      </div>
                      <span className="shrink-0 text-xs text-[var(--text-tertiary)]">{log.timestamp}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </motion.aside>
      </>
    )}
  </AnimatePresence>
);

export default function App() {
  const embedMode = isEmbeddedMode();
  const iosDevice = isAppleMobileDevice();
  const reducedMotion = embedMode;
  const canUseNativeFilePicker = supportsNativeFilePicker() && !embedMode && !iosDevice;
  const canUseDirectoryPicker = canUseNativeFilePicker && supportsDirectoryPicker();

  const [viewHistory, setViewHistory] = useState<View[]>(['home']);
  const [theme, setTheme] = useState<Theme>('light');
  const [language, setLanguage] = useState<Language>(() => {
    if (typeof window === 'undefined') return 'en';
    const savedLanguage = window.localStorage.getItem('app-language');
    if (savedLanguage === 'ja' || savedLanguage === 'en') {
      return savedLanguage;
    }
    return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  });
  const [pageZoom, setPageZoom] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const savedZoom = window.localStorage.getItem('app-page-zoom') ?? window.localStorage.getItem('app-embed-zoom');
    const parsed = savedZoom ? Number(savedZoom) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0.7 && parsed <= 1.4) {
      return parsed;
    }
    return 1;
  });
  const [activityOpen, setActivityOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      timestamp: '06:31:23',
      message: embedMode
        ? text('Embed share view initialized.', '埋め込み共有ビューを初期化しました。')
        : text('Application initialized.', 'アプリを初期化しました。'),
      type: 'info',
    },
    {
      timestamp: '06:31:25',
      message: text('Connected to Notion API.', 'Notion API に接続しました。'),
      type: 'success',
    },
  ]);
  const [status, setStatus] = useState<LocalizedText>(text('Ready', '準備完了'));
  const [progress, setProgress] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isInitializingCaches, setIsInitializingCaches] = useState(false);
  const [startupCacheSummary, setStartupCacheSummary] = useState<StartupCacheWarmSummary | null>(null);

  const [selectedCalendar, setSelectedCalendar] = useState<CalendarPage | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(null);
  const [defaultWorkbookDir, setDefaultWorkbookDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [downloadArtifact, setDownloadArtifact] = useState<DownloadArtifact | null>(null);
  const [hasPendingWorkbookDownload, setHasPendingWorkbookDownload] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [calendarPages, setCalendarPages] = useState<CalendarPage[]>([]);
  const [dailyCalendar, setDailyCalendar] = useState<CalendarPage | null>(null);
  const [dailyPreviewSummary, setDailyPreviewSummary] = useState<DailyPreviewSummary | null>(null);
  const [dailyRunSummary, setDailyRunSummary] = useState<DailyRunSummary | null>(null);
  const [defectiveTrackerCalendar, setDefectiveTrackerCalendar] = useState<CalendarPage | null>(null);
  const [defectiveTrackerCanSubmit, setDefectiveTrackerCanSubmit] = useState(false);
  const [defectiveTrackerColorOptions, setDefectiveTrackerColorOptions] = useState<string[]>([]);
  const [defectiveTrackerColorPartMap, setDefectiveTrackerColorPartMap] = useState<Record<string, string[]>>({});
  const [defectiveTrackerDatabaseAccessible, setDefectiveTrackerDatabaseAccessible] = useState(false);
  const [defectiveTrackerDatabaseId, setDefectiveTrackerDatabaseId] = useState('');
  const [defectiveTrackerLoading, setDefectiveTrackerLoading] = useState(false);
  const [defectiveTrackerNestedDatabase, setDefectiveTrackerNestedDatabase] =
    useState<DefectiveTrackerSnapshot['nestedDatabase']>(null);
  const [defectiveTrackerNotice, setDefectiveTrackerNotice] = useState<DefectiveTrackerNotice | null>(null);
  const [defectiveTrackerPageId, setDefectiveTrackerPageId] = useState('');
  const [defectiveTrackerPartName, setDefectiveTrackerPartName] = useState('');
  const [defectiveTrackerPartNumber, setDefectiveTrackerPartNumber] = useState('');
  const [defectiveTrackerSelectedColor, setDefectiveTrackerSelectedColor] = useState('');
  const [defectiveTrackerSubmitting, setDefectiveTrackerSubmitting] = useState(false);
  const [defectiveTrackerSelectedType, setDefectiveTrackerSelectedType] = useState('');
  const [defectiveTrackerFieldErrors, setDefectiveTrackerFieldErrors] = useState<DefectiveTrackerFieldErrors>({});
  const [defectiveTrackerToday, setDefectiveTrackerToday] = useState('');
  const [defectiveTrackerTypes, setDefectiveTrackerTypes] = useState<string[]>([]);
  const [defectiveTrackerQuantity, setDefectiveTrackerQuantity] = useState('');
  const [defectiveTrackerWarning, setDefectiveTrackerWarning] = useState<string | null>(null);
  const [hiraharaFiles, setHiraharaFiles] = useState<File[]>([]);
  const [hiraharaCompileSummary, setHiraharaCompileSummary] = useState<HiraharaCompileSummary | null>(null);
  const [reviewQuery, setReviewQuery] = useState('');
  const [reviewCategory, setReviewCategory] = useState<ReviewCategory>('all');
  const [removingProductId, setRemovingProductId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hiraharaFileInputRef = useRef<HTMLInputElement>(null);
  const view = viewHistory[viewHistory.length - 1] ?? 'home';
  const localize = (message: LocalizedText) => message[language];
  const tr = (en: string, ja: string) => (language === 'ja' ? ja : en);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const isBusy = isSyncing || isInitializingCaches || defectiveTrackerLoading || defectiveTrackerSubmitting;
  const selectedFileRef = selectedFileKey ?? selectedFile;
  const viewSupportsWorkbookDownload = (targetView: View) =>
    targetView === 'home' ||
    targetView === 'workflow-manager' ||
    targetView === 'daily-generator' ||
    targetView === 'hirahara-orders';
  const getProductSyncKey = (product: Product) =>
    [
      (product.sourceRows ?? []).join(','),
      product.color,
      product.part,
      product.trial,
      product.date,
    ].join('|');
  type ProductState = Pick<Product, 'override' | 'colorAccent'>;
  const buildProductStateByKey = (sourceProducts: Product[]) =>
    new Map<string, ProductState>(
      sourceProducts.map((product) => [
        getProductSyncKey(product),
        {
          override: product.override,
          colorAccent: product.colorAccent,
        },
      ]),
    );
  const mergePreservedProductState = (loadedProducts: Product[], sourceProducts: Product[]) => {
    if (!sourceProducts.length) {
      return loadedProducts;
    }

    const preservedStateByKey = buildProductStateByKey(sourceProducts);
    return loadedProducts.map((product) => {
      const preservedState = preservedStateByKey.get(getProductSyncKey(product));
      return preservedState ? ({...product, ...preservedState} as Product) : product;
    });
  };

  const addLog = (message: LocalizedText, type: LogEntry['type'] = 'info', icon?: string) => {
    const timestamp = new Date().toLocaleTimeString(language === 'ja' ? 'ja-JP' : 'en-GB', {
      hour12: false,
    });
    setLogs((prev) => [...prev, {timestamp, message, type, icon}]);
  };

  const confirmLeaveWithPendingDownload = () => {
    if (!hasPendingWorkbookDownload || typeof window === 'undefined') {
      return true;
    }

    return window.confirm(
      tr(
        'The updated workbook has not been downloaded yet. Download it before leaving this screen to save your Excel changes. Leave anyway?',
        '更新済みのブックはまだダウンロードされていません。Excel の変更を保存するには、この画面を離れる前にダウンロードしてください。このまま移動しますか？',
      ),
    );
  };

  const navigateTo = (nextView: View) => {
    if (!viewSupportsWorkbookDownload(nextView) && !confirmLeaveWithPendingDownload()) {
      return;
    }
    setViewHistory((prev) => (prev[prev.length - 1] === nextView ? prev : [...prev, nextView]));
  };

  const goBack = () => {
    const previousView = viewHistory.length > 1 ? viewHistory[viewHistory.length - 2] : viewHistory[0];
    if (!viewSupportsWorkbookDownload(previousView) && !confirmLeaveWithPendingDownload()) {
      return;
    }
    setViewHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  const handleLanguageChange = (nextLanguage: Language) => setLanguage(nextLanguage);

  const buildWorkbookDownloadUrl = async (serverFile: string, downloadName: string) => {
    const params = new URLSearchParams({file: serverFile});
    if (downloadName) {
      params.set('name', downloadName);
    }
    if (window.__EMBED_MODE__) {
      const accessToken = await window.__EMBED_SESSION__;
      if (!accessToken) {
        throw new Error('Embed session is unavailable.');
      }
      params.set('access_token', accessToken);
      return `/embed-api/download?${params.toString()}`;
    }

    return `/api/download?${params.toString()}`;
  };

  const replaceDownloadArtifact = (nextArtifact: DownloadArtifact | null) => {
    setDownloadArtifact((currentArtifact) => {
      if (currentArtifact?.revokeUrl && currentArtifact.url) {
        URL.revokeObjectURL(currentArtifact.url);
      }
      return nextArtifact;
    });
  };

  const clearDownloadArtifact = () => {
    replaceDownloadArtifact(null);
    setHasPendingWorkbookDownload(false);
  };

  const prepareDownloadArtifact = async (base64: string, filename: string, serverFile?: string | null) => {
    try {
      const safeFilename = filename || 'updated_plan.xlsx';
      const artifact: DownloadArtifact = base64
        ? createObjectUrlDownloadArtifact(base64, safeFilename)
        : serverFile
          ? {filename: safeFilename, serverFile}
          : createObjectUrlDownloadArtifact(base64, safeFilename);
      replaceDownloadArtifact(artifact);
      setHasPendingWorkbookDownload(true);
      addLog(
        text(
          'Processed workbook ready. Download it before leaving to save the Excel changes.',
          '処理済みブックの準備ができました。Excel の変更を保存するには、ページを離れる前にダウンロードしてください。',
        ),
        'success',
        '⚙️',
      );
    } catch (error: any) {
      addLog(text(`Error creating download link: ${error.message}`, `ダウンロードリンクの作成エラー: ${error.message}`), 'error');
    }
  };

  const handleDownloadWorkbook = async () => {
    if (!downloadArtifact) {
      return;
    }

    try {
      const resolvedArtifact =
        downloadArtifact.serverFile
          ? {...downloadArtifact, url: await buildWorkbookDownloadUrl(downloadArtifact.serverFile, downloadArtifact.filename)}
          : downloadArtifact;

      if (!resolvedArtifact.url) {
        throw new Error('Download URL is unavailable.');
      }

      triggerDownload(resolvedArtifact);
      setHasPendingWorkbookDownload(false);
      setStatus(text('Workbook download started', 'ブックのダウンロードを開始しました'));
      addLog(text(`Download started: ${resolvedArtifact.filename}`, `ダウンロードを開始しました: ${resolvedArtifact.filename}`), 'success', '⚙️');
    } catch (error: any) {
      addLog(
        text(`Download failed: ${error?.message || String(error)}`, `ダウンロードに失敗しました: ${error?.message || String(error)}`),
        'error',
      );
      setStatus(text('Download failed', 'ダウンロードに失敗しました'));
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement> | null, manualFile?: File) => {
    const inputElement = event?.target as HTMLInputElement | undefined;
    const file = manualFile || inputElement?.files?.[0];
    if (!file) return;

    if (!confirmLeaveWithPendingDownload()) {
      if (inputElement) {
        inputElement.value = '';
      }
      return;
    }

    if (hasPendingWorkbookDownload) {
      clearDownloadArtifact();
    }

    setDailyPreviewSummary(null);
    setDailyRunSummary(null);

    setIsSyncing(true);
    setStatus(text('Uploading workbook', 'ブックをアップロード中'));

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Upload failed');

      const data = await response.json();
      setSelectedFile(data.filename);
      setSelectedFileKey(data.fileKey || data.filename);
      addLog(text(`Workbook uploaded: ${data.filename}`, `ブックをアップロードしました: ${data.filename}`), 'success', '⚙️');
      setStatus(text('Workbook ready', 'ブックの準備ができました'));
    } catch (error) {
      addLog(text(`Upload error: ${error}`, `アップロードエラー: ${error}`), 'error');
      setStatus(text('Upload failed', 'アップロードに失敗しました'));
    } finally {
      setIsSyncing(false);
      if (inputElement) {
        inputElement.value = '';
      }
    }
  };

  const openNativeSelector = async () => {
    if (canUseNativeFilePicker) {
      try {
        let startIn: any = undefined;
        if (defaultWorkbookDir) {
          try {
            const dirHandle: any = defaultWorkbookDir;
            if (typeof dirHandle.queryPermission === 'function') {
              const status = await dirHandle.queryPermission({mode: 'read'});
              if (status === 'granted') {
                startIn = defaultWorkbookDir;
              } else if (typeof dirHandle.requestPermission === 'function') {
                const requested = await dirHandle.requestPermission({mode: 'read'});
                if (requested === 'granted') {
                  startIn = defaultWorkbookDir;
                }
              }
            } else {
              startIn = defaultWorkbookDir;
            }
          } catch {
            startIn = undefined;
          }
        }

        const [handle] = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'Excel Files',
              accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']},
            },
          ],
          ...(startIn ? {startIn} : {}),
          id: 'workbook-picker',
          multiple: false,
        });
        const file = await handle.getFile();
        handleFileChange(null, file);
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          addLog(text(`File picker error: ${error.message}. Falling back.`, `ファイルピッカーエラー: ${error.message}。標準モードに切り替えます。`), 'warning');
          fileInputRef.current?.click();
        }
      }
      return;
    }

    addLog(text('Using the standard file picker for compatibility.', '互換性のため標準ファイルピッカーを使用します。'), 'info');
    fileInputRef.current?.click();
  };

  const clearHiraharaSelection = () => {
    if (!confirmLeaveWithPendingDownload()) {
      return;
    }

    if (hasPendingWorkbookDownload) {
      clearDownloadArtifact();
    }

    setHiraharaFiles([]);
    setHiraharaCompileSummary(null);
    if (hiraharaFileInputRef.current) {
      hiraharaFileInputRef.current.value = '';
    }
  };

  const handleHiraharaFilesChange = async (event: React.ChangeEvent<HTMLInputElement> | null, manualFiles?: File[]) => {
    const inputElement = event?.target as HTMLInputElement | undefined;
    const nextFiles = (manualFiles || Array.from(inputElement?.files || [])).filter((file) =>
      /\.(xls|xlsx)$/i.test(file.name),
    );

    if (!nextFiles.length) {
      if (inputElement) {
        inputElement.value = '';
      }
      return;
    }

    if (!confirmLeaveWithPendingDownload()) {
      if (inputElement) {
        inputElement.value = '';
      }
      return;
    }

    if (hasPendingWorkbookDownload) {
      clearDownloadArtifact();
    }

    setHiraharaCompileSummary(null);
    setHiraharaFiles(nextFiles);
    setStatus(text('Order files ready', '注文書ファイルの準備ができました'));
    addLog(
      text(
        `${nextFiles.length} order files selected for Hirahara compilation.`,
        `ヒラハラ注文書用に ${nextFiles.length} 件の注文書ファイルを選択しました。`,
      ),
      'success',
      '📄',
    );

    if (inputElement) {
      inputElement.value = '';
    }
  };

  const openHiraharaSelector = async () => {
    if (canUseNativeFilePicker) {
      try {
        const handles = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'Excel Files',
              accept: {
                'application/vnd.ms-excel': ['.xls'],
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              },
            },
          ],
          id: 'hirahara-order-picker',
          multiple: true,
        });
        const files = await Promise.all(handles.map((handle: any) => handle.getFile()));
        await handleHiraharaFilesChange(null, files);
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          addLog(
            text(
              `File picker error: ${error.message}. Falling back.`,
              `ファイルピッカーエラー: ${error.message}。標準モードに切り替えます。`,
            ),
            'warning',
          );
          hiraharaFileInputRef.current?.click();
        }
      }
      return;
    }

    addLog(text('Using the standard file picker for compatibility.', '互換性のため標準ファイルピッカーを使用します。'), 'info');
    hiraharaFileInputRef.current?.click();
  };

  const loadCalendarPages = async () => {
    try {
      const response = await apiFetch('/api/calendar');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch calendar');
      }
      const data = await response.json();
      setCalendarPages(data);
    } catch (error) {
      addLog(text(`Error loading calendar pages: ${error}`, `カレンダーページの読み込みエラー: ${error}`), 'error');
      setCalendarPages(MOCK_CALENDAR_PAGES);
    }
  };

  const handleInitializeCaches = async () => {
    setIsInitializingCaches(true);
    setStatus(text('Initializing caches', 'キャッシュを初期化中'));
    addLog(
      text(
        'Initializing parts, calendar, and nested database caches.',
        '部品、カレンダー、ネストされたデータベースのキャッシュを初期化しています。',
      ),
      'info',
      '⚡',
    );

    try {
      const response = await apiFetch('/api/initialize', {method: 'POST'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to initialize caches');
      }

      const summary = data as StartupCacheWarmSummary;
      setStartupCacheSummary(summary);
      await loadCalendarPages();

      const summaryMessage = text(
        `Initialization complete: ${summary.partsEntries} parts, ${summary.calendarPages} calendar pages, ${summary.warmedDatabases} warmed databases.`,
        `初期化が完了しました: 部品 ${summary.partsEntries} 件、カレンダーページ ${summary.calendarPages} 件、温めたデータベース ${summary.warmedDatabases} 件。`,
      );

      addLog(summaryMessage, summary.failures.length > 0 ? 'warning' : 'success', '⚡');
      summary.failures.slice(0, 2).forEach((failure) => {
        addLog(text(`Warmup warning: ${failure}`, `ウォームアップ警告: ${failure}`), 'warning');
      });
      setStatus(text('Caches ready', 'キャッシュ準備完了'));
    } catch (error: any) {
      addLog(
        text(`Cache initialization failed: ${error?.message || String(error)}`, `キャッシュ初期化に失敗しました: ${error?.message || String(error)}`),
        'error',
        '⚠️',
      );
      setStatus(text('Initialization failed', '初期化に失敗しました'));
    } finally {
      setIsInitializingCaches(false);
    }
  };

  const loadDefectiveTrackerSnapshot = async (options?: {pageId?: string; silent?: boolean}) => {
    const pageId = (options?.pageId ?? defectiveTrackerPageId) || undefined;
    const silent = options?.silent ?? false;
    setDefectiveTrackerLoading(true);
    setDefectiveTrackerWarning(null);
    setDefectiveTrackerNotice(null);
    if (!silent) {
      setStatus(text('Loading defective parts tracker', '欠品入力を読み込み中'));
    }

    try {
      const params = new URLSearchParams();
      if (pageId) {
        params.set('page_id', pageId);
      }
      const response = await apiFetch(`/api/defective-parts/tracker${params.toString() ? `?${params.toString()}` : ''}`);
      const data = (await response.json().catch(() => ({}))) as Partial<DefectiveTrackerSnapshot>;
      if (!response.ok) {
        throw new Error((data as any)?.error || 'Failed to load defective parts tracker');
      }

      const nextColorOptions = data.colorOptions ?? [];
      const nextColorPartMap = data.colorPartMap ?? {};
      const nextSelectedColor =
        defectiveTrackerSelectedColor && nextColorOptions.includes(defectiveTrackerSelectedColor)
          ? defectiveTrackerSelectedColor
          : nextColorOptions[0] ?? '';
      const nextPartOptions = nextSelectedColor ? nextColorPartMap[nextSelectedColor] ?? [] : [];
      const nextSelectedPartNumber =
        defectiveTrackerPartNumber && nextPartOptions.includes(defectiveTrackerPartNumber)
          ? defectiveTrackerPartNumber
          : nextPartOptions[0] ?? '';
      const nextSelectedType =
        defectiveTrackerSelectedType && (data.defectTypeOptions ?? []).includes(defectiveTrackerSelectedType)
          ? defectiveTrackerSelectedType
          : '';

      setDefectiveTrackerCalendar(data.calendarPage ?? null);
      setDefectiveTrackerCanSubmit(Boolean(data.canSubmit));
      setDefectiveTrackerColorOptions(nextColorOptions);
      setDefectiveTrackerColorPartMap(nextColorPartMap);
      setDefectiveTrackerDatabaseAccessible(Boolean(data.databaseAccessible));
      setDefectiveTrackerDatabaseId(data.databaseId ?? '');
      setDefectiveTrackerNestedDatabase(data.nestedDatabase ?? null);
      setDefectiveTrackerPageId(data.calendarPage?.id ?? pageId ?? '');
      setDefectiveTrackerToday(data.today ?? '');
      setDefectiveTrackerTypes(data.defectTypeOptions ?? []);
      setDefectiveTrackerWarning(data.warning ?? null);
      setDefectiveTrackerFieldErrors({});
      setDefectiveTrackerSelectedColor(nextSelectedColor);
      setDefectiveTrackerPartNumber(nextSelectedPartNumber);
      setDefectiveTrackerSelectedType(nextSelectedType);

      if (!silent) {
        setStatus(text('Defective parts tracker ready', '欠品入力の準備ができました'));
        addLog(
          text(
            `Loaded defective parts tracker for ${data.calendarPage?.title || data.today || 'today'}.`,
            `${data.calendarPage?.title || data.today || '本日'} の欠品入力を読み込みました。`,
          ),
          data.warning ? 'warning' : 'success',
          '⚠️',
        );
      }
    } catch (error: any) {
      setDefectiveTrackerCalendar(null);
      setDefectiveTrackerCanSubmit(false);
      setDefectiveTrackerColorOptions([]);
      setDefectiveTrackerColorPartMap({});
      setDefectiveTrackerDatabaseAccessible(false);
      setDefectiveTrackerDatabaseId('');
      setDefectiveTrackerNestedDatabase(null);
      setDefectiveTrackerPageId(pageId ?? '');
      setDefectiveTrackerSelectedColor('');
      setDefectiveTrackerPartNumber('');
      setDefectiveTrackerToday('');
      setDefectiveTrackerTypes([]);
      setDefectiveTrackerFieldErrors({});
      setDefectiveTrackerWarning(error?.message || String(error));
      setStatus(text('Defective parts tracker failed to load', '欠品入力の読み込みに失敗しました'));
      addLog(
        text(
          `Defective parts tracker error: ${error?.message || String(error)}`,
          `欠品入力エラー: ${error?.message || String(error)}`,
        ),
        'error',
      );
    } finally {
      setDefectiveTrackerLoading(false);
    }
  };

  const parseDefectiveTrackerQuantity = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!/^\d+(?:\.\d+)?$/.test(trimmed) || !Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  };

  const handleDefectiveTrackerQuantityChange = (value: string) => {
    setDefectiveTrackerQuantity(value);
    setDefectiveTrackerFieldErrors((prev) => {
      const next = {...prev};
      const trimmed = value.trim();
      if (!trimmed) {
        delete next.quantity;
        return next;
      }

      if (parseDefectiveTrackerQuantity(trimmed) == null) {
        next.quantity = tr('Enter a positive number.', '正の数値を入力してください。');
      } else {
        delete next.quantity;
      }
      return next;
    });
  };

  const stepDefectiveTrackerQuantity = (delta: number) => {
    const currentValue = parseDefectiveTrackerQuantity(defectiveTrackerQuantity) ?? 0;
    if (delta < 0 && currentValue <= 1) {
      return;
    }

    const nextValue = Math.max(1, currentValue + delta);
    setDefectiveTrackerNotice(null);
    clearDefectiveTrackerFieldError('quantity');
    handleDefectiveTrackerQuantityChange(String(nextValue));
  };

  const splitDefectiveTrackerPartDisplay = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) {
      return {mainLabel: '', trialLabel: ''};
    }

    const patterns = [
      /^(試作\s*\d+)\s*[・／/|｜:：-]\s*(.+)$/,
      /^(試作\s*\d+)\s+(.+)$/,
      /^(試作\s*\d+)([A-Za-z0-9].+)$/,
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match && match[2]) {
        return {
          mainLabel: match[2].trim(),
          trialLabel: match[1].replace(/\s+/g, ''),
        };
      }
    }

    return {mainLabel: cleaned, trialLabel: ''};
  };

  const clearDefectiveTrackerFieldError = (field: DefectiveTrackerField) => {
    setDefectiveTrackerFieldErrors((prev) => {
      if (!prev[field]) {
        return prev;
      }
      const next = {...prev};
      delete next[field];
      return next;
    });
  };

  const validateDefectiveTrackerForm = (): DefectiveTrackerFieldErrors => {
    const nextErrors: DefectiveTrackerFieldErrors = {};
    const trimmedQuantity = defectiveTrackerQuantity.trim();
    const parsedQuantity = Number(trimmedQuantity);

    if (!defectiveTrackerSelectedColor) {
      nextErrors.color = tr('Select a color.', '色を選択してください。');
    }
    if (!defectiveTrackerPartNumber) {
      nextErrors.partNumber = tr('Select a part number.', '品番を選択してください。');
    }
    if (!defectiveTrackerPartName.trim()) {
      nextErrors.partName = tr('Enter a part name.', '部品名を入力してください。');
    }
    if (!trimmedQuantity) {
      nextErrors.quantity = tr('Enter a quantity.', '数量を入力してください。');
    } else if (!/^\d+(?:\.\d+)?$/.test(trimmedQuantity) || !Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      nextErrors.quantity = tr('Enter a positive number.', '正の数値を入力してください。');
    }
    if (!defectiveTrackerSelectedType) {
      nextErrors.defectType = tr('Select a defect type.', '不良類を選択してください。');
    }

    return nextErrors;
  };

  const handleDefectiveTrackerSubmit = async () => {
    const nextErrors = validateDefectiveTrackerForm();
    setDefectiveTrackerFieldErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setDefectiveTrackerNotice({
        message: tr('Check the highlighted fields before saving.', '登録前に入力内容を確認してください。'),
        tone: 'warning',
      });
      addLog(
        text('Defective parts form validation failed.', '欠品入力フォームの検証に失敗しました。'),
        'warning',
      );
      return;
    }

    setDefectiveTrackerSubmitting(true);
    setDefectiveTrackerNotice(null);
    setStatus(text('Saving defective parts', '欠品を登録中'));

    try {
      const response = await apiFetch('/api/defective-parts/submit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          item: {
            color: defectiveTrackerSelectedColor,
            defectType: defectiveTrackerSelectedType,
            partName: defectiveTrackerPartName.trim(),
            partNumber: defectiveTrackerPartNumber,
            quantity: defectiveTrackerQuantity.trim(),
          },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save defective parts');
      }

      setDefectiveTrackerPartName('');
      setDefectiveTrackerQuantity('');
      setDefectiveTrackerFieldErrors({});
      setDefectiveTrackerNotice({
        message: tr('The defective part record was saved.', '欠品レコードを登録しました。'),
        tone: 'success',
      });

      setStatus(text('Defective parts saved', '欠品を登録しました'));
      addLog(
        text(
          `Saved ${data.created || 1} defective parts entr${(data.created || 1) === 1 ? 'y' : 'ies'}.`,
          `${data.created || 1} 件の欠品を登録しました。`,
        ),
        'success',
        '⚠️',
      );
    } catch (error: any) {
      setStatus(text('Defective parts save failed', '欠品の登録に失敗しました'));
      setDefectiveTrackerNotice({
        message: error?.message || String(error),
        tone: 'error',
      });
      addLog(
        text(
          `Defective parts save error: ${error?.message || String(error)}`,
          `欠品登録エラー: ${error?.message || String(error)}`,
        ),
        'error',
      );
    } finally {
      setDefectiveTrackerSubmitting(false);
    }
  };

  useEffect(() => {
    if (!canUseDirectoryPicker) return;
    idbGet<FileSystemDirectoryHandle>('default-workbook-dir')
      .then((handle) => {
        if (handle) setDefaultWorkbookDir(handle);
      })
      .catch(() => {
        // Ignore persisted-handle load failures (e.g., browser restrictions).
      });
  }, [canUseDirectoryPicker]);

  const pickDefaultWorkbookFolder = async () => {
    if (!canUseDirectoryPicker) {
      addLog(text('Default folder selection is not supported in this browser.', 'このブラウザでは既定フォルダの選択に対応していません。'), 'warning');
      return;
    }

    try {
      const dirHandle = await (window as any).showDirectoryPicker({mode: 'read'});
      await idbSet('default-workbook-dir', dirHandle);
      setDefaultWorkbookDir(dirHandle);
      addLog(
        text(`Default workbook folder set to: ${dirHandle.name}`, `既定のブックフォルダを設定しました: ${dirHandle.name}`),
        'success',
        '📁',
      );
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        addLog(
          text(`Folder picker error: ${error?.message ?? String(error)}`, `フォルダ選択エラー: ${error?.message ?? String(error)}`),
          'error',
        );
      }
    }
  };

  const clearDefaultWorkbookFolder = async () => {
    try {
      await idbDel('default-workbook-dir');
    } catch {
      // ignore
    }
    setDefaultWorkbookDir(null);
    addLog(text('Default workbook folder cleared.', '既定のブックフォルダをクリアしました。'), 'info', '🧹');
  };

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('app-language', language);
    }
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('app-page-zoom', String(pageZoom));
    }
  }, [pageZoom]);

  useEffect(() => {
    loadCalendarPages();
  }, []);

  useEffect(() => {
    return () => {
      if (downloadArtifact?.revokeUrl && downloadArtifact.url) {
        URL.revokeObjectURL(downloadArtifact.url);
      }
    };
  }, [downloadArtifact]);

  useEffect(() => {
    if (!hasPendingWorkbookDownload || typeof window === 'undefined') {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasPendingWorkbookDownload]);

  useEffect(() => {
    if (!selectedFileRef || view !== 'workflow-manager') return;
    const preservedProducts = products;

    const loadProducts = async () => {
      setIsSyncing(true);
      setStatus(
        selectedCalendar
          ? text('Loading workbook and Notion state', 'ブックとNotion状態を読み込み中')
          : text('Loading workbook', 'ブックを読み込み中'),
      );
      try {
        const response = await apiFetch('/api/load-products', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({filePath: selectedFileRef, pageId: selectedCalendar?.id}),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to load products');
        }
        const data = await response.json();
        setProducts(mergePreservedProductState(data, preservedProducts));
        setStatus(text('Review ready', '確認の準備ができました'));
        addLog(
          selectedCalendar
            ? text(
                `Loaded ${data.length} products from ${selectedFile} and checked ${selectedCalendar.title}.`,
                `${selectedFile} から ${data.length} 件を読み込み、${selectedCalendar.title} のNotion状態を確認しました。`,
              )
            : text(`Loaded ${data.length} products from ${selectedFile}`, `${selectedFile} から ${data.length} 件の商品を読み込みました。`),
          'success',
          '⚙️',
        );
      } catch (error) {
        addLog(text(`Error loading products: ${error}`, `商品の読み込みエラー: ${error}`), 'error');
        setStatus(text('Review loaded with sample data', 'サンプルデータで確認画面を表示しました'));
        setProducts(MOCK_PRODUCTS);
      } finally {
        setIsSyncing(false);
      }
    };

    loadProducts();
  }, [selectedFile, selectedFileRef, selectedCalendar?.id, view]);

  useEffect(() => {
    if (!selectedFileRef || !dailyCalendar || view !== 'daily-generator') {
      setDailyPreviewSummary(null);
      return;
    }

    let isActive = true;

    const refreshDailyPreview = async () => {
      setIsSyncing(true);
      setStatus(text('Checking workbook state', 'ブック状態を確認中'));

      try {
        const response = await apiFetch('/api/daily-preview', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            file_path: selectedFileRef,
            page_id: dailyCalendar.id,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Failed to refresh workbook state');
        }

        if (!isActive) {
          return;
        }

        const summary = (data.summary ?? null) as DailyPreviewSummary | null;
        setDailyPreviewSummary(summary);
        setStatus(text('Workbook ready', 'ブックの準備ができました'));

        if (summary) {
          addLog(
            text(
              `Workbook checked for ${dailyCalendar.title}: ${summary.matchedNotionRows} rows already in Notion, ${summary.pendingRows} rows still pending.`,
              `${dailyCalendar.title} 用にブックを確認しました: ${summary.matchedNotionRows} 行はすでに Notion にあり、${summary.pendingRows} 行が未処理です。`,
            ),
            'success',
            '⚙️',
          );
        }
      } catch (error) {
        if (!isActive) {
          return;
        }

        setDailyPreviewSummary(null);
        addLog(text(`Workbook check error: ${error}`, `ブック確認エラー: ${error}`), 'error');
        setStatus(text('Workbook check failed', 'ブック確認に失敗しました'));
      } finally {
        if (isActive) {
          setIsSyncing(false);
        }
      }
    };

    refreshDailyPreview();

    return () => {
      isActive = false;
    };
  }, [selectedFileRef, dailyCalendar?.id, view]);

  useEffect(() => {
    if (view !== 'defective-parts') {
      return;
    }

    if (defectiveTrackerPageId) {
      return;
    }

    void loadDefectiveTrackerSnapshot();
  }, [view, defectiveTrackerPageId]);

  useEffect(() => {
    const nextPartOptions = defectiveTrackerSelectedColor
      ? defectiveTrackerColorPartMap[defectiveTrackerSelectedColor] ?? []
      : [];

    if (defectiveTrackerPartNumber && nextPartOptions.includes(defectiveTrackerPartNumber)) {
      return;
    }

    setDefectiveTrackerPartNumber(nextPartOptions[0] ?? '');
  }, [defectiveTrackerColorPartMap, defectiveTrackerPartNumber, defectiveTrackerSelectedColor]);

  const refreshProductsFromServer = async (sourceProducts: Product[]) => {
    if (!selectedFileRef) {
      return false;
    }

    const refreshResponse = await apiFetch('/api/load-products', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filePath: selectedFileRef, pageId: selectedCalendar?.id}),
    });

    if (!refreshResponse.ok) {
      return false;
    }

    const refreshedData = await refreshResponse.json();
    setProducts(mergePreservedProductState(refreshedData, sourceProducts));
    return true;
  };

  const handleSync = async () => {
    if (!selectedCalendar || !selectedFileRef) return;

    const currentProducts = products;
    setIsSyncing(true);
    setStatus(text('Syncing to Notion', 'Notion と同期中'));
    addLog(text(`Starting sync for ${selectedCalendar.title}`, `${selectedCalendar.title} の同期を開始します。`), 'info', '⚙️');

    try {
      const response = await apiFetch('/api/sync', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          file_path: selectedFileRef,
          page_id: selectedCalendar.id,
          products: currentProducts,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Sync failed');
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      if (data.buffer) {
        await prepareDownloadArtifact(data.buffer, selectedFile || 'updated_plan.xlsx', selectedFileRef);
      }

      setStatus(
        data.buffer
          ? text('Sync complete. Download workbook to save changes.', '同期が完了しました。変更を保存するにはブックをダウンロードしてください。')
          : text('Sync complete', '同期が完了しました'),
      );
      addLog(text('Notion sync completed successfully.', 'Notion との同期が完了しました。'), 'success', '⚙️');

      await refreshProductsFromServer(currentProducts);
    } catch (error) {
      addLog(text(`Sync error: ${error}`, `同期エラー: ${error}`), 'error');
      setStatus(text('Sync failed', '同期に失敗しました'));
    } finally {
      setIsSyncing(false);
      setProgress(0);
    }
  };

  const handleRemoveFromNotion = async (product: Product) => {
    if (!selectedCalendar || !product.alreadySynced || removingProductId) return;

    const currentProducts = products;
    setRemovingProductId(product.id);
    setStatus(text('Removing item from Notion', 'Notion から項目を削除中'));
    addLog(
      text(`Removing ${product.part} from ${selectedCalendar.title}.`, `${selectedCalendar.title} から ${product.part} を削除しています。`),
      'warning',
      '−',
    );

    try {
      const response = await apiFetch('/api/remove-product', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          page_id: selectedCalendar.id,
          product,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to remove product from Notion');
      }

      const refreshed = await refreshProductsFromServer(currentProducts);
      if (!refreshed) {
        setProducts((prev) =>
          prev.map((item) => (item.id === product.id ? {...item, alreadySynced: false} : item)),
        );
      }

      if (data.removed) {
        setStatus(text('Notion item removed', 'Notion から項目を削除しました'));
        addLog(text(`${product.part} was removed from Notion.`, `${product.part} を Notion から削除しました。`), 'success', '−');
      } else {
        setStatus(text('Notion item not found', 'Notion 上で項目が見つかりませんでした'));
        addLog(
          text(`No matching Notion row was found for ${product.part}.`, `${product.part} に一致する Notion 行は見つかりませんでした。`),
          'warning',
          '−',
        );
      }
    } catch (error) {
      addLog(text(`Remove error: ${error}`, `削除エラー: ${error}`), 'error');
      setStatus(text('Remove failed', '削除に失敗しました'));
    } finally {
      setRemovingProductId(null);
    }
  };

  const handleDailyRun = async () => {
    if (!dailyCalendar || !selectedFileRef) return;

    setIsSyncing(true);
    setProgress(15);
    setDailyPreviewSummary(null);
    setDailyRunSummary(null);
    setStatus(text('Running generator', 'ジェネレーターを実行中'));
    addLog(
      text(
        `Generating workflow for ${dailyCalendar.title} using ${selectedFile}.`,
        `${selectedFile} を使って ${dailyCalendar.title} のワークフローを生成しています。`,
      ),
      'info',
      '⚙️',
    );

    try {
      const response = await apiFetch('/api/daily-run', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          file_path: selectedFileRef,
          page_id: dailyCalendar.id,
        }),
      });

      setProgress(85);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Daily generator failed');
      }
      if (data.error) {
        throw new Error(data.error);
      }

      if (data.buffer) {
        await prepareDownloadArtifact(data.buffer, selectedFile || 'updated_plan.xlsx', selectedFileRef);
      }

      const summary = (data.summary ?? null) as DailyRunSummary | null;
      setDailyRunSummary(summary);

      if (summary && summary.groupsCount === 0) {
        setStatus(text('Daily run complete. Nothing new to add.', '日次実行が完了しました。新しく追加する行はありません。'));
        addLog(
          text(
            `Daily generator finished. ${summary.skippedHighlightedRows} rows were already highlighted, so nothing new was sent to Notion.`,
            `日次ジェネレーターが完了しました。${summary.skippedHighlightedRows} 行はすでにハイライト済みのため、新規に Notion へ送信した行はありません。`,
          ),
          'success',
          '⚙️',
        );
      } else {
        setStatus(
          data.buffer
            ? text('Daily run complete. Download workbook to save changes.', '日次実行が完了しました。変更を保存するにはブックをダウンロードしてください。')
            : text('Daily run complete', '日次実行が完了しました'),
        );
        addLog(
          summary
            ? text(
                `Daily workflow generated for ${summary.groupsCount} color groups. ${summary.processedRows} rows were processed.`,
                `${summary.groupsCount} 色グループの日次ワークフローを生成しました。${summary.processedRows} 行を処理しました。`,
              )
            : text('Daily workflow generated and synced to Notion.', '日次ワークフローを生成し、Notion に同期しました。'),
          'success',
          '⚙️',
        );
      }
    } catch (error) {
      addLog(text(`Daily generator error: ${error}`, `日次ジェネレーターエラー: ${error}`), 'error');
      setStatus(text('Daily run failed', '日次実行に失敗しました'));
    } finally {
      setIsSyncing(false);
      setProgress(0);
    }
  };

  const handleHiraharaCompile = async () => {
    if (!hiraharaFiles.length) {
      return;
    }

    setIsSyncing(true);
    setStatus(text('Compiling Hirahara orders', 'ヒラハラ注文書を集計中'));
    setHiraharaCompileSummary(null);
    addLog(
      text(
        `Compiling ${hiraharaFiles.length} order files into one Hirahara workbook.`,
        `${hiraharaFiles.length} 件の注文書ファイルを 1 つのヒラハラ注文書に集計しています。`,
      ),
      'info',
      '📄',
    );

    const formData = new FormData();
    hiraharaFiles.forEach((file) => {
      formData.append('files', file);
    });

    try {
      const response = await apiFetch('/api/hirahara-orders/compile', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to compile Hirahara orders');
      }

      await prepareDownloadArtifact('', data.filename || 'ヒラハラ注文書.xlsx', data.fileKey);

      const summary = (data.summary ?? null) as HiraharaCompileSummary | null;
      setHiraharaCompileSummary(summary);
      setStatus(text('Compilation complete. Download workbook to save it.', '集計が完了しました。保存するにはブックをダウンロードしてください。'));

      if (summary?.skippedFiles?.length) {
        summary.skippedFiles.forEach((warning) => {
          addLog(text(`Compile warning: ${warning}`, `集計警告: ${warning}`), 'warning');
        });
      }

      addLog(
        summary
          ? text(
              `Hirahara workbook ready: ${summary.compiledRows} rows from ${summary.sourceFiles} files.`,
              `ヒラハラ注文書の準備ができました: ${summary.sourceFiles} 件のファイルから ${summary.compiledRows} 行を集計しました。`,
            )
          : text('Hirahara workbook is ready to download.', 'ヒラハラ注文書をダウンロードできます。'),
        'success',
        '📄',
      );
    } catch (error) {
      addLog(text(`Compile error: ${error}`, `集計エラー: ${error}`), 'error');
      setStatus(text('Compilation failed', '集計に失敗しました'));
    } finally {
      setIsSyncing(false);
    }
  };

  const selectedCount = products.filter((product) => product.selected).length;
  const syncReadyCount = products.filter((product) => product.selected && (!product.alreadySynced || product.override)).length;
  const recentLogs = logs.slice(-3).reverse();
  const hiraharaSelectedCount = hiraharaFiles.length;
  const defectiveTrackerPartOptions = defectiveTrackerSelectedColor
    ? defectiveTrackerColorPartMap[defectiveTrackerSelectedColor] ?? []
    : [];
  const defectiveTrackerSelectedPartCount = defectiveTrackerPartOptions.length;
  const defectiveTrackerColorCount = defectiveTrackerColorOptions.length;
  const defectiveTrackerPartCount = (Object.values(defectiveTrackerColorPartMap) as string[][]).reduce(
    (total, partNumbers) => total + partNumbers.length,
    0,
  );
  const defectiveTrackerSelectedSource = splitDefectiveTrackerPartDisplay(defectiveTrackerPartNumber);
  const defectiveTrackerQuantityValue = parseDefectiveTrackerQuantity(defectiveTrackerQuantity);
  const defectiveTrackerCanDecrementQuantity = (defectiveTrackerQuantityValue ?? 0) > 1;
  const defectiveTrackerFormReady =
    Boolean(defectiveTrackerSelectedColor) &&
    Boolean(defectiveTrackerPartNumber) &&
    Boolean(defectiveTrackerPartName.trim()) &&
    Boolean(defectiveTrackerSelectedType) &&
    Boolean(defectiveTrackerQuantity.trim()) &&
    !defectiveTrackerFieldErrors.quantity;
  const defectiveTrackerSubmitDisabled =
    defectiveTrackerSubmitting ||
    defectiveTrackerLoading ||
    !defectiveTrackerCanSubmit ||
    !defectiveTrackerFormReady;
  const defectiveTrackerActionStatusLabel = !defectiveTrackerDatabaseAccessible
    ? tr('Database share needed', 'DB 共有が必要')
    : defectiveTrackerFormReady
      ? tr('Ready to save', '登録できます')
      : tr('Waiting for required fields', '必須項目を入力してください');
  const defectiveTrackerActionStatusReady = defectiveTrackerDatabaseAccessible && defectiveTrackerFormReady;
  const defectiveTrackerFloatingSummary = [
    {
      label: tr('Color', '色'),
      value: defectiveTrackerSelectedColor || tr('Choose color', '色を選択'),
    },
    ...(defectiveTrackerSelectedSource.trialLabel
      ? [
          {
            label: tr('Trial', '試作'),
            value: defectiveTrackerSelectedSource.trialLabel,
          },
        ]
      : []),
    {
      label: tr('Product', '対象部品'),
      value:
        defectiveTrackerSelectedSource.mainLabel ||
        defectiveTrackerPartNumber ||
        tr('Choose a part', '品番を選択'),
    },
    {
      label: tr('Part name', '部品名'),
      value: defectiveTrackerPartName.trim() || tr('Enter part name', '部品名を入力'),
    },
    {
      label: tr('Quantity', '数量'),
      value:
        defectiveTrackerQuantityValue != null
          ? String(defectiveTrackerQuantityValue)
          : tr('Set quantity', '数量を設定'),
    },
    {
      label: tr('Type', '不良類'),
      value: defectiveTrackerSelectedType || tr('Choose type', '不良類を選択'),
    },
  ];
  const normalizedQuery = reviewQuery.trim().toLowerCase();
  const filteredProducts = normalizedQuery
    ? products.filter((product) =>
        getReviewCategoryFields(reviewCategory, product).some((field) => field.toLowerCase().includes(normalizedQuery)),
      )
    : products;
  const productGroups = filteredProducts.reduce<Record<string, Product[]>>((groups, product) => {
    if (!groups[product.color]) {
      groups[product.color] = [];
    }
    groups[product.color].push(product);
    return groups;
  }, {});
  const groupedProducts = Object.entries(productGroups) as Array<[string, Product[]]>;
  const syncedCount = products.filter((product) => product.alreadySynced).length;
  const reviewCategoryOptions: Array<{value: ReviewCategory; label: string}> = [
    {value: 'all', label: tr('All fields', 'すべて')},
    {value: 'part', label: tr('Part', '品名')},
    {value: 'color', label: tr('Color', '色')},
    {value: 'trial', label: tr('Trial', '試作')},
    {value: 'date', label: tr('Date', '日付')},
  ];
  const reviewSearchPlaceholder =
    reviewCategory === 'all'
      ? tr('Search all fields', 'すべてを検索')
      : reviewCategory === 'part'
        ? tr('Search parts', '品名を検索')
        : reviewCategory === 'color'
          ? tr('Search colors', '色を検索')
          : reviewCategory === 'trial'
            ? tr('Search trials', '試作を検索')
            : tr('Search dates', '日付を検索');

  const workflowSteps: WorkflowStep[] = [
    {
      label: text('Choose page', 'ページを選択'),
      detail: selectedCalendar ? text(selectedCalendar.title, selectedCalendar.title) : text('Pick a Notion page', 'Notionページを選択'),
      state: (selectedCalendar ? 'complete' : 'current') as StepState,
    },
    {
      label: text('Upload file', 'ファイルをアップロード'),
      detail: selectedFile ? text(selectedFile, selectedFile) : text('Add the workbook', 'ブックを追加'),
      state: (selectedFile ? 'complete' : selectedCalendar ? 'current' : 'upcoming') as StepState,
    },
    {
      label: text('Review', '確認'),
      detail: products.length
        ? text(`${syncReadyCount} items ready to sync`, `${syncReadyCount} 件が同期可能`)
        : text('Check the rows', '行を確認'),
      state: (selectedFile ? 'current' : 'upcoming') as StepState,
    },
    {
      label: text('Sync', '同期'),
      detail: selectedCalendar && selectedFile ? text('Ready when you are', '準備完了') : text('Waiting for setup', '準備待ち'),
      state: (selectedCalendar && selectedFile ? 'current' : 'upcoming') as StepState,
    },
  ];

  const pageStackClass = embedMode ? 'space-y-6 pb-10' : 'space-y-8 pb-16';
  const heroPanelClass = embedMode ? 'relative p-6 md:p-8' : 'relative p-8 md:p-12 lg:p-14';
  const heroCopyClass = embedMode ? 'relative max-w-2xl space-y-5' : 'relative max-w-3xl space-y-6';
  const heroTitleClass = embedMode
    ? 'max-w-2xl text-3xl font-semibold tracking-[-0.06em] text-[var(--text-primary)] md:text-5xl'
    : 'max-w-2xl text-4xl font-semibold tracking-[-0.06em] text-[var(--text-primary)] md:text-6xl';
  const heroBodyClass = embedMode
    ? 'max-w-xl text-sm text-[var(--text-secondary)] md:text-base'
    : 'max-w-xl text-base text-[var(--text-secondary)] md:text-lg';
  const shellPaddingClass = embedMode ? 'px-2.5 pb-5 pt-3 md:px-3' : 'px-3 pb-8 pt-4 md:px-5 lg:px-6';
  const shellHeaderClass = embedMode
    ? 'glass-toolbar sticky top-3 z-20 flex items-center justify-between rounded-[22px] px-3 py-2.5 md:px-4'
    : 'glass-toolbar sticky top-4 z-20 flex items-center justify-between rounded-[26px] px-4 py-3 md:px-5';
  const shellInnerWidthClass = embedMode ? 'mx-auto max-w-[980px]' : 'mx-auto max-w-[1200px]';
  const shellZoomPaddingStyle: React.CSSProperties | undefined =
    pageZoom !== 1
      ? {
          paddingInline: embedMode
            ? `${Math.max(4, Math.round(12 / pageZoom))}px`
            : `clamp(${Math.max(4, Math.round(12 / pageZoom))}px, ${Math.max(6, Math.round(18 / pageZoom))}px, ${Math.max(8, Math.round(24 / pageZoom))}px)`,
        }
      : undefined;
  const shellZoomInnerWidthStyle: React.CSSProperties | undefined =
    pageZoom !== 1
      ? {
          maxWidth: `${Math.round((embedMode ? 980 : 1200) * pageZoom)}px`,
        }
      : undefined;
  const contentWidthClass = embedMode ? 'mt-4' : 'mt-6';
  const heroLayoutClass = embedMode ? 'relative space-y-5' : 'relative space-y-8';
  const homeLauncherGridClass = embedMode
    ? 'grid gap-3 sm:grid-cols-2 md:grid-cols-3'
    : 'grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4';
  const systemLauncherGridClass = embedMode ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-4 md:grid-cols-3';
  const homeInfoGridClass = embedMode ? 'grid gap-5 xl:grid-cols-[1.15fr_0.85fr]' : 'grid gap-6 lg:grid-cols-[1.15fr_0.85fr]';
  const workflowShellClass = embedMode ? 'space-y-5 pb-20' : 'space-y-6 pb-24';
  const workflowShellStyle: React.CSSProperties = {overflowAnchor: 'none'};
  const workflowSetupGridClass = embedMode
    ? 'grid gap-5 sm:grid-cols-2 sm:items-stretch'
    : 'grid gap-6 xl:grid-cols-2 xl:items-stretch';
  const actionBarClass = embedMode ? 'sticky bottom-0 z-20 -mx-3 mt-4 md:-mx-4' : 'sticky bottom-4 z-10 pt-4';
  const actionToolbarClass = embedMode
    ? 'glass-toolbar rounded-t-[30px] rounded-b-none border-b-0 p-4 md:p-5'
    : 'glass-toolbar rounded-[30px] p-4 md:p-5';
  const reviewGridClass = embedMode ? 'mt-8 grid gap-4 md:grid-cols-2' : 'mt-8 grid gap-5 lg:grid-cols-2';
  const reviewGridStyle: React.CSSProperties = {
    overflowAnchor: 'none',
    minHeight: embedMode ? '640px' : '560px',
  };
  const reviewSummaryPillClass =
    theme === 'dark'
      ? 'inline-flex items-center rounded-full border border-white/10 bg-white/6 px-3.5 py-1.5 text-xs font-semibold text-slate-100'
      : 'inline-flex items-center rounded-full border border-slate-200/90 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.08)]';
  const reviewGroupClass =
    theme === 'dark'
      ? 'rounded-[34px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.84),rgba(15,23,42,0.72))] p-4 text-white shadow-[0_24px_60px_rgba(2,6,23,0.35)] backdrop-blur-2xl'
      : 'rounded-[34px] border border-slate-200/95 bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(241,245,249,0.9))] p-4 text-slate-900 shadow-[0_24px_60px_rgba(15,23,42,0.12)] ring-1 ring-slate-200/80 backdrop-blur-2xl';
  const reviewColorChipClass =
    theme === 'dark'
      ? 'inline-flex items-center rounded-full border border-white/20 bg-white px-5 py-2 text-base font-extrabold tracking-[0.01em] text-slate-950 shadow-[0_12px_24px_rgba(2,6,23,0.22)] md:text-xl'
      : 'inline-flex items-center rounded-full border border-slate-200/90 bg-white px-5 py-2 text-base font-extrabold tracking-[0.01em] text-slate-950 shadow-[0_12px_24px_rgba(15,23,42,0.1)] md:text-xl';
  const reviewHeaderMetaClass =
    theme === 'dark'
      ? 'text-xs font-medium text-slate-300 md:text-sm'
      : 'text-xs font-medium text-slate-500 md:text-sm';
  const reviewHeaderColumnsClass =
    theme === 'dark'
      ? 'inline-flex items-center rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs font-semibold text-slate-100'
      : 'inline-flex items-center rounded-full border border-slate-200/90 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 shadow-[0_10px_20px_rgba(15,23,42,0.08)]';
  const selectedProductCardClass =
    theme === 'dark'
      ? 'border-sky-400/35 bg-white/[0.06] text-white shadow-[0_18px_36px_rgba(2,6,23,0.22)] ring-1 ring-sky-300/40 backdrop-blur-xl'
      : 'border-sky-200/95 bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(248,250,252,0.94))] text-slate-900 shadow-[0_18px_36px_rgba(15,23,42,0.1)] ring-2 ring-sky-300/75';
  const defaultProductCardClass =
    theme === 'dark'
      ? 'border-white/8 bg-white/[0.04] text-white shadow-[0_14px_28px_rgba(2,6,23,0.18)] backdrop-blur-xl'
      : 'border-slate-200/90 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,250,252,0.9))] text-slate-900 shadow-[0_14px_28px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/80';
  const reviewMetricChipClass =
    theme === 'dark'
      ? 'inline-flex items-center rounded-full border border-sky-400/10 bg-sky-400/10 px-3 py-1 text-xs font-semibold text-sky-100'
      : 'inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700';
  const notionMiniCircleBaseClass =
    'inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_10px_18px_rgba(15,23,42,0.12)] transition-all duration-150 md:h-10 md:w-10';
  const notionSyncedCircleActiveClass =
    theme === 'dark'
      ? 'border-emerald-400/45 bg-emerald-500/18 text-emerald-100'
      : 'border-emerald-200/90 bg-emerald-50 text-emerald-700';
  const notionSyncedCircleInactiveClass =
    theme === 'dark'
      ? 'border-white/10 bg-white/[0.04] text-slate-300 opacity-35'
      : 'border-slate-200/90 bg-white text-slate-400 opacity-45';
  const notionDeleteCircleClass =
    theme === 'dark'
      ? 'border-rose-400/40 bg-rose-500/14 text-rose-200'
      : 'border-rose-200/90 bg-rose-50 text-rose-700';
  const notionDeleteCircleInactiveClass =
    'cursor-not-allowed opacity-35';
  const notionDeleteCircleActiveClass =
    'hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-rose-200/80';
  const trackerFieldLabelClass =
    theme === 'dark'
      ? 'text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-300'
      : 'text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-600';
  const trackerFieldCardClass =
    theme === 'dark'
      ? 'rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.62),rgba(15,23,42,0.38))] p-4 shadow-[0_18px_48px_rgba(2,6,23,0.26)]'
      : 'rounded-[26px] border border-slate-300/90 bg-[linear-gradient(180deg,rgba(255,255,255,1),rgba(241,245,249,0.98))] p-4 shadow-[0_20px_44px_rgba(148,163,184,0.18)] ring-1 ring-slate-200/85';
  const getTrackerFieldCardClass = (field?: DefectiveTrackerField) =>
    field && defectiveTrackerFieldErrors[field]
      ? `${trackerFieldCardClass} border-rose-300 dark:border-rose-500/60`
      : trackerFieldCardClass;
  const trackerFieldInputClass =
    theme === 'dark'
      ? 'mt-2 w-full rounded-[18px] border border-white/10 bg-white/6 px-4 py-3 text-sm font-medium leading-[1.25] text-[var(--text-primary)] outline-none transition placeholder:text-slate-500 focus:border-sky-300 focus:bg-white/10'
      : 'mt-2 w-full rounded-[18px] border border-slate-300 bg-slate-50/92 px-4 py-3 text-sm font-medium leading-[1.25] text-slate-900 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_6px_14px_rgba(148,163,184,0.12)] outline-none transition placeholder:text-slate-500 focus:border-sky-400 focus:bg-white focus:shadow-[0_0_0_4px_rgba(125,211,252,0.18),0_12px_24px_rgba(148,163,184,0.18)]';
  const trackerFieldHintClass =
    theme === 'dark'
      ? 'mt-3 text-xs text-[var(--text-secondary)]'
      : 'mt-3 text-xs text-slate-600';
  const getTrackerFieldInputClass = (field: DefectiveTrackerField) =>
    defectiveTrackerFieldErrors[field]
      ? `${trackerFieldInputClass} border-rose-300 focus:border-rose-300 dark:border-rose-500/60`
      : trackerFieldInputClass;
  const trackerSelectionPanelClass =
    theme === 'dark'
      ? 'rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.74),rgba(15,23,42,0.48))] p-5 shadow-[0_20px_56px_rgba(2,6,23,0.3)]'
      : 'rounded-[30px] border border-slate-200/95 bg-[linear-gradient(180deg,rgba(255,255,255,0.99),rgba(241,245,249,0.94))] p-5 shadow-[0_20px_56px_rgba(15,23,42,0.08)]';
  const trackerSelectionStatusClass =
    theme === 'dark'
      ? 'inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-1.5 text-xs font-semibold text-slate-100'
      : 'inline-flex items-center gap-2 rounded-full border border-slate-200/90 bg-white/90 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.06)]';
  const trackerSelectionHintClass =
    theme === 'dark'
      ? 'rounded-[22px] border border-dashed border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-slate-300'
      : 'rounded-[22px] border border-dashed border-slate-200/90 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-600';
  const getTrackerChoiceButtonClass = (selected: boolean) =>
    selected
      ? theme === 'dark'
        ? 'inline-flex items-center gap-3 rounded-[22px] border border-sky-400/60 bg-sky-500/14 px-4 py-3 text-left text-sm font-semibold text-sky-100 shadow-[0_14px_30px_rgba(14,165,233,0.16)] transition'
        : 'inline-flex items-center gap-3 rounded-[22px] border border-sky-300 bg-sky-50 px-4 py-3 text-left text-sm font-semibold text-sky-900 shadow-[0_14px_30px_rgba(56,189,248,0.16)] transition'
      : theme === 'dark'
        ? 'inline-flex items-center gap-3 rounded-[22px] border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm font-medium text-slate-200 transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06]'
        : 'inline-flex items-center gap-3 rounded-[22px] border border-slate-200/90 bg-white/85 px-4 py-3 text-left text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white';
  const getTrackerCompactChoiceButtonClass = (selected: boolean) =>
    selected
      ? theme === 'dark'
        ? 'inline-flex items-center gap-2.5 rounded-[18px] border border-sky-400/60 bg-sky-500/14 px-3.5 py-2.5 text-left text-sm font-semibold text-sky-100 shadow-[0_12px_24px_rgba(14,165,233,0.14)] transition'
        : 'inline-flex items-center gap-2.5 rounded-[18px] border border-sky-300 bg-sky-50 px-3.5 py-2.5 text-left text-sm font-semibold text-sky-900 shadow-[0_12px_24px_rgba(56,189,248,0.14)] transition'
      : theme === 'dark'
        ? 'inline-flex items-center gap-2.5 rounded-[18px] border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-left text-sm font-medium text-slate-200 transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06]'
        : 'inline-flex items-center gap-2.5 rounded-[18px] border border-slate-200/90 bg-white/88 px-3.5 py-2.5 text-left text-sm font-medium text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white';
  const getTrackerPartCardClass = (selected: boolean) =>
    selected
      ? theme === 'dark'
        ? 'flex w-full items-start justify-between gap-3 rounded-[24px] border border-emerald-400/50 bg-emerald-500/12 px-4 py-4 text-left shadow-[0_18px_36px_rgba(16,185,129,0.16)] transition'
        : 'flex w-full items-start justify-between gap-3 rounded-[24px] border border-emerald-300 bg-emerald-50 px-4 py-4 text-left shadow-[0_18px_36px_rgba(16,185,129,0.14)] transition'
      : theme === 'dark'
        ? 'flex w-full items-start justify-between gap-3 rounded-[24px] border border-white/10 bg-white/[0.03] px-4 py-4 text-left transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.06]'
        : 'flex w-full items-start justify-between gap-3 rounded-[24px] border border-slate-200/90 bg-white/90 px-4 py-4 text-left transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-white';
  const trackerPartTrialBadgeClass =
    theme === 'dark'
      ? 'inline-flex w-fit items-center rounded-full border border-amber-500/40 bg-amber-500/18 px-2.5 py-1 text-[11px] font-semibold tracking-[0.06em] text-amber-50'
      : 'inline-flex w-fit items-center rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold tracking-[0.06em] text-amber-950';
  const trackerPartTitleClass =
    theme === 'dark'
      ? 'text-sm font-semibold leading-6 whitespace-normal break-words text-slate-50'
      : 'text-sm font-semibold leading-6 whitespace-normal break-words text-slate-900';
  const trackerActionChipClass =
    theme === 'dark'
      ? 'min-w-[132px] rounded-[20px] border border-white/10 bg-white/[0.04] px-4 py-3'
      : 'min-w-[132px] rounded-[20px] border border-slate-200/90 bg-white/94 px-4 py-3 shadow-[0_10px_24px_rgba(148,163,184,0.12)]';
  const trackerActionChipLabelClass =
    theme === 'dark'
      ? 'text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400'
      : 'text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500';
  const trackerActionChipValueClass =
    theme === 'dark'
      ? 'mt-1 text-sm font-semibold leading-5 text-slate-50 whitespace-normal break-words'
      : 'mt-1 text-sm font-semibold leading-5 text-slate-900 whitespace-normal break-words';
  const trackerActionHintClass =
    theme === 'dark'
      ? 'text-sm text-slate-300'
      : 'text-sm text-slate-600';
  const trackerStepperShellClass =
    theme === 'dark'
      ? 'mt-3 flex items-center gap-2 rounded-[20px] border border-white/10 bg-white/[0.04] p-2'
      : 'mt-3 flex items-center gap-2 rounded-[20px] border border-slate-200/90 bg-slate-50/85 p-2';
  const trackerStepperInputClass =
    'min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-center text-2xl font-semibold tracking-[-0.04em] text-[var(--text-primary)] outline-none placeholder:text-slate-400';
  const getTrackerStepperButtonClass = (disabled: boolean) =>
    disabled
      ? theme === 'dark'
        ? 'flex h-11 w-11 items-center justify-center rounded-[16px] border border-white/8 bg-white/[0.02] text-slate-500 opacity-45'
        : 'flex h-11 w-11 items-center justify-center rounded-[16px] border border-slate-200/80 bg-white/70 text-slate-300 opacity-45'
      : theme === 'dark'
        ? 'flex h-11 w-11 items-center justify-center rounded-[16px] border border-white/10 bg-white/[0.06] text-slate-100 transition hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.12]'
        : 'flex h-11 w-11 items-center justify-center rounded-[16px] border border-slate-200/90 bg-white text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50';
  const cacheSummaryCards = [
    {
      label: tr('Parts', '部品'),
      value: startupCacheSummary ? String(startupCacheSummary.partsEntries) : '0',
    },
    {
      label: tr('Calendar', 'カレンダー'),
      value: startupCacheSummary ? String(startupCacheSummary.calendarPages) : '0',
    },
    {
      label: tr('Nested DBs', '子DB'),
      value: startupCacheSummary ? String(startupCacheSummary.warmedDatabases) : '0',
    },
  ];
  const appLauncherTiles: LauncherTileConfig[] = [
    {
      key: 'workflow',
      icon: RefreshCw,
      accent: 'sky' as LauncherAccent,
      card: true,
      label: tr('Workflow', 'ワークフロー'),
      subtitle: selectedCalendar || selectedFile ? tr('Resume manual sync', '手動同期を再開') : tr('Manual sync', '手動同期'),
      badge: selectedCalendar && selectedFile ? tr('Ready', '準備完了') : undefined,
      onClick: () => navigateTo('workflow-manager'),
    },
    {
      key: 'daily',
      icon: Play,
      accent: 'emerald' as LauncherAccent,
      card: true,
      label: tr('Daily', '日次生成'),
      subtitle: tr('Generate today’s plan', '当日の計画を生成'),
      onClick: () => navigateTo('daily-generator'),
    },
    {
      key: 'defective-parts',
      icon: AlertCircle,
      accent: 'violet' as LauncherAccent,
      card: true,
      label: tr('Defective Parts Tracker', '欠品入力'),
      subtitle: tr('Quick entry from 作業内容', '不良部品の追跡を簡素化'),
      badge: defectiveTrackerPartName || defectiveTrackerQuantity ? tr('Open', '入力中') : undefined,
      onClick: () => navigateTo('defective-parts'),
    },
    {
      key: 'hirahara-orders',
      icon: FileSpreadsheet,
      accent: 'amber' as LauncherAccent,
      card: true,
      label: tr('Hirahara Orders', 'ヒラハラ注文書'),
      subtitle: hiraharaSelectedCount
        ? tr('Resume multi-file compile', '複数ファイル集計を再開')
        : tr('Compile uploaded order slips', '複数の注文書を集計'),
      badge: hiraharaCompileSummary ? tr('Ready', '準備完了') : undefined,
      onClick: () => navigateTo('hirahara-orders'),
    },
  ];
  const systemLauncherTiles: LauncherTileConfig[] = [
    {
      key: 'initialize',
      icon: isInitializingCaches ? RefreshCw : Database,
      accent: 'amber' as LauncherAccent,
      label: tr('Initialize', '初期化'),
      subtitle: isInitializingCaches ? tr('Warming caches...', 'キャッシュを初期化中...') : tr('Warm data caches', 'データキャッシュを作成'),
      badge: startupCacheSummary ? tr('Ready', '完了') : undefined,
      disabled: isInitializingCaches,
      spinning: isInitializingCaches,
      onClick: handleInitializeCaches,
    },
    {
      key: 'activity',
      icon: History,
      accent: 'violet' as LauncherAccent,
      label: tr('Activity', 'アクティビティ'),
      subtitle: tr('Open recent updates', '最近の更新を表示'),
      onClick: () => setActivityOpen(true),
    },
    {
      key: 'settings',
      icon: Settings,
      accent: 'slate' as LauncherAccent,
      label: tr('Settings', '設定'),
      subtitle: tr('Theme and language', 'テーマと言語'),
      onClick: () => navigateTo('settings'),
    },
  ];
  const HomeView = () => (
    <div className={pageStackClass}>
      <Panel strong className={heroPanelClass}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.7),transparent_38%)] dark:bg-[radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(148,163,184,0.08),transparent_40%)]" />
        <div className={heroLayoutClass}>
          <div className={heroCopyClass}>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] shadow-sm dark:border-white/10 dark:bg-white/6">
              <LayoutDashboard size={14} />
              {tr('Painting Team', '塗装チーム')}
            </div>
            <div className="space-y-4">
              <h1 className={heroTitleClass}>{tr('Notion Control Panel', 'Notionのコントロールパネル')}</h1>
              <p className={heroBodyClass}>
                {tr(
                  'Choose a tool, then use the system controls here to prepare caches, review activity, or adjust the workspace.',
                  'ツールを選び、ここにまとめたシステム操作でキャッシュ準備、アクティビティ確認、ワークスペース調整を行います。',
                )}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('System', 'システム')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Controls', 'コントロール')}</h2>
            </div>
            <div className={systemLauncherGridClass}>
              {systemLauncherTiles.map((tile) => (
                <div key={tile.key} className="contents">
                  <LauncherTile
                    icon={tile.icon}
                    accent={tile.accent}
                    label={tile.label}
                    subtitle={tile.subtitle}
                    badge={tile.badge}
                    compact
                    disabled={tile.disabled}
                    spinning={tile.spinning}
                    onClick={tile.onClick}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      <Panel className="p-6 md:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Apps', 'アプリ')}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Choose a function', '機能を選択')}</h2>
          </div>
          {startupCacheSummary && (
            <div className="status-pill">
              <Database size={14} />
              {tr('Caches ready', 'キャッシュ準備完了')}
            </div>
          )}
        </div>

        <div className={`mt-6 ${homeLauncherGridClass}`}>
          {appLauncherTiles.map((tile) => (
            <div key={tile.key} className="contents">
              <LauncherTile
                icon={tile.icon}
                accent={tile.accent}
                label={tile.label}
                subtitle={tile.subtitle}
                badge={tile.badge}
                card={tile.card}
                disabled={tile.disabled}
                spinning={tile.spinning}
                onClick={tile.onClick}
              />
            </div>
          ))}
        </div>
      </Panel>

      <div className={homeInfoGridClass}>
        <Panel className="p-6 md:p-7">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Current context', '現在の状態')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Ready at a glance', 'ひと目で確認')}</h2>
            </div>
            <div className="status-pill">
              <span className={`h-2 w-2 rounded-full ${isBusy ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
              {localize(status)}
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Page', 'ページ')}</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {selectedCalendar?.title ?? tr('Choose a page', 'ページを選択')}
              </p>
            </div>
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Workbook', 'ブック')}</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {selectedFile ?? tr('Choose a file', 'ファイルを選択')}
              </p>
            </div>
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Selection', '選択')}</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {tr(`${syncReadyCount} ready to sync`, `${syncReadyCount} 行が同期可能`)}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {cacheSummaryCards.map((card) => (
              <div key={card.label} className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
                <p className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">{card.label}</p>
                <p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-[var(--text-primary)]">{card.value}</p>
              </div>
            ))}
          </div>

          {startupCacheSummary?.failures.length ? (
            <div className="mt-5 rounded-[22px] border border-amber-300 bg-amber-100/90 px-4 py-4 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/55 dark:text-amber-50">
              {tr('Cache warmup completed with warnings.', 'キャッシュ初期化は完了しましたが警告があります。')}
            </div>
          ) : null}
        </Panel>

        <Panel className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Recent', '最近')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Latest updates', '最新の更新')}</h2>
            </div>
            <button onClick={() => setActivityOpen(true)} className="secondary-button">
              {tr('Open', '開く')}
            </button>
          </div>

          {downloadArtifact && (
            <div
              className={`mt-6 rounded-[24px] border p-5 ${
                hasPendingWorkbookDownload
                  ? 'border-amber-300 bg-amber-100/90 dark:border-amber-700/70 dark:bg-amber-950/55'
                  : 'border-emerald-200 bg-emerald-50/80 dark:border-emerald-900/60 dark:bg-emerald-950/25'
              }`}
            >
              <p
                className={`text-sm font-medium ${
                  hasPendingWorkbookDownload
                    ? 'text-amber-950 dark:text-amber-50'
                    : 'text-emerald-700 dark:text-emerald-200'
                }`}
              >
                {hasPendingWorkbookDownload
                  ? tr('Download required to save changes', '変更を保存するにはダウンロードが必要です')
                  : tr('Processed workbook ready', '処理済みブックの準備完了')}
              </p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{downloadArtifact.filename}</p>
              <button
                type="button"
                onClick={handleDownloadWorkbook}
                className={`mt-4 inline-flex items-center gap-2 text-sm font-medium transition ${
                  hasPendingWorkbookDownload
                    ? 'text-amber-950 hover:text-amber-900 dark:text-amber-50 dark:hover:text-amber-100'
                    : 'text-emerald-700 hover:text-emerald-800 dark:text-emerald-200'
                }`}
              >
                {hasPendingWorkbookDownload ? tr('Download workbook', 'ブックをダウンロード') : tr('Download again', '再度ダウンロード')}
                <ArrowRight size={15} />
              </button>
            </div>
          )}

          <div className="mt-6 space-y-3">
            {recentLogs.map((log, index) => (
              <div key={`${log.timestamp}-${index}`} className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{localize(log.message)}</p>
                  <span className="text-xs text-[var(--text-tertiary)]">{log.timestamp}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );

  const workflowManagerView = (
    <div className={workflowShellClass} style={workflowShellStyle}>
      <BackButton label={tr('Back', '戻る')} onClick={goBack} />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {workflowSteps.map((step, index) => {
          const stateClasses = {
            complete:
              'border-transparent bg-slate-900 text-white shadow-[0_18px_36px_rgba(15,23,42,0.16)] dark:bg-white dark:text-slate-900',
            current:
              'border-sky-200 bg-sky-50/85 text-sky-700 shadow-[0_18px_36px_rgba(59,130,246,0.14)] dark:border-sky-900/70 dark:bg-sky-950/35 dark:text-sky-200',
            upcoming:
              'border-[color:var(--line)] bg-white/55 text-[var(--text-secondary)] dark:bg-white/4',
          } as const;

          return (
            <div key={step.label.en} className={`rounded-[24px] border px-4 py-4 transition-all ${stateClasses[step.state]}`}>
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold ${
                    step.state === 'complete'
                      ? 'bg-white/16 text-white dark:bg-slate-900/8 dark:text-slate-900'
                      : step.state === 'current'
                        ? 'bg-white text-sky-700 dark:bg-sky-900/60 dark:text-sky-100'
                        : 'bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300'
                  }`}
                >
                  {step.state === 'complete' ? <Check size={16} /> : index + 1}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{localize(step.label)}</p>
                  <p className={`text-xs ${step.state === 'complete' ? 'text-white/72 dark:text-slate-700' : 'text-[var(--text-secondary)]'}`}>
                    {localize(step.detail)}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={workflowSetupGridClass}>
        <Panel className="h-full p-6">
          <div className="flex h-full flex-col">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('1. Choose page', '1. ページを選択')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Calendar', 'カレンダー')}</h2>
            </div>

            <div className="space-y-3">
              {calendarPages.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-[color:var(--line)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                  {tr('Loading pages...', 'ページを読み込み中...')}
                </div>
              ) : (
                calendarPages.map((page) => (
                  <button
                    key={page.id}
                    onClick={() => setSelectedCalendar(page)}
                    className={`w-full rounded-[22px] border px-4 py-4 text-left transition-all ${
                      selectedCalendar?.id === page.id
                        ? 'border-sky-200 bg-sky-50/85 shadow-[0_18px_36px_rgba(59,130,246,0.12)] dark:border-sky-900/60 dark:bg-sky-950/30'
                        : 'border-[color:var(--line)] bg-white/55 hover:bg-white/75 dark:bg-white/4 dark:hover:bg-white/8'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-base font-medium text-[var(--text-primary)]">{page.title}</p>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">{page.date}</p>
                      </div>
                      {selectedCalendar?.id === page.id && (
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-600 text-white">
                          <Check size={16} />
                        </div>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </Panel>

        <Panel className="h-full p-6">
          <div className="flex h-full flex-col">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('2. Upload file', '2. ファイルをアップロード')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Workbook', 'ブック')}</h2>
            </div>

            <div className="flex flex-1 flex-col">
              {canUseNativeFilePicker ? (
              <>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                />

                <button
                  onClick={openNativeSelector}
                  className={`w-full rounded-[26px] border border-dashed p-6 text-left transition-all ${
                    selectedFile
                      ? 'border-emerald-200 bg-emerald-50/75 shadow-[0_18px_36px_rgba(16,185,129,0.12)] dark:border-emerald-900/50 dark:bg-emerald-950/22'
                      : 'border-[color:var(--line-strong)] bg-white/50 hover:bg-white/72 dark:bg-white/4 dark:hover:bg-white/8'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] ${
                        selectedFile
                          ? 'bg-emerald-500 text-white'
                          : 'bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300'
                      }`}
                    >
                      {selectedFile ? <FileSpreadsheet size={24} /> : <Upload size={24} />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-medium text-[var(--text-primary)]">
                        {selectedFile ?? tr('Choose Excel file', 'Excelファイルを選択')}
                      </p>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        {selectedFile
                          ? tr('Tap to replace the current workbook.', 'タップして現在のブックを置き換えます。')
                          : tr('One workbook at a time.', '一度に扱えるブックは1つです。')}
                      </p>
                    </div>
                  </div>
                </button>

                {canUseDirectoryPicker && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={pickDefaultWorkbookFolder}
                      className="rounded-full border border-[color:var(--line)] bg-white/55 px-4 py-2 text-sm font-medium text-[var(--text-primary)] shadow-sm transition-all hover:bg-white/75 dark:bg-white/6 dark:hover:bg-white/10"
                    >
                      {defaultWorkbookDir
                        ? language === 'ja'
                          ? `既定フォルダ: ${defaultWorkbookDir.name}`
                          : `Default folder: ${defaultWorkbookDir.name}`
                        : tr('Set default folder', '既定フォルダを設定')}
                    </button>

                    {defaultWorkbookDir && (
                      <button
                        type="button"
                        onClick={clearDefaultWorkbookFolder}
                        className="rounded-full border border-[color:var(--line)] bg-white/35 px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-all hover:bg-white/55 dark:bg-white/4 dark:hover:bg-white/8"
                      >
                        {tr('Clear', 'クリア')}
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : (
              <label
                className={`relative block w-full cursor-pointer rounded-[26px] border border-dashed p-6 text-left transition-all ${
                  selectedFile
                    ? 'border-emerald-200 bg-emerald-50/75 shadow-[0_18px_36px_rgba(16,185,129,0.12)] dark:border-emerald-900/50 dark:bg-emerald-950/22'
                    : 'border-[color:var(--line-strong)] bg-white/50 hover:bg-white/72 dark:bg-white/4 dark:hover:bg-white/8'
                }`}
              >
                <input
                  type="file"
                  ref={fileInputRef}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                />

                <div className="flex items-center gap-4">
                  <div
                    className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] ${
                      selectedFile
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300'
                    }`}
                  >
                    {selectedFile ? <FileSpreadsheet size={24} /> : <Upload size={24} />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-[var(--text-primary)]">
                      {selectedFile ?? tr('Choose Excel file', 'Excelファイルを選択')}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {selectedFile
                        ? tr('Tap to replace the current workbook.', 'タップして現在のブックを置き換えます。')
                        : tr('Tap here to open the system file picker.', 'タップしてシステムのファイルピッカーを開きます。')}
                    </p>
                  </div>
                </div>
              </label>
            )}

            {selectedFile && (
              <div className="mt-4 flex items-start gap-3 rounded-[22px] border border-[color:var(--line)] bg-white/45 px-4 py-3 text-sm text-[var(--text-secondary)] dark:bg-white/4">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <p>
                  {hasPendingWorkbookDownload
                    ? tr(
                        'Download the updated workbook before leaving. A browser warning stays active until you do.',
                        'ページを離れる前に更新済みブックをダウンロードしてください。ダウンロードするまでブラウザ警告が有効です。',
                      )
                    : tr(
                        'After each sync, use Download workbook to save the updated Excel file locally.',
                        '各同期の後、更新済み Excel ファイルをローカルに保存するには「ブックをダウンロード」を使用してください。',
                      )}
                </p>
              </div>
            )}
            </div>
          </div>
        </Panel>

      </div>

      <Panel className="p-6 md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('3. Review', '3. 確認')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Products', '製品')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {products.length
                  ? tr(`${syncReadyCount} rows ready for sync.`, `${syncReadyCount} 行が同期可能です。`)
                  : tr('Load a workbook to review the rows.', '行を確認するにはブックを読み込んでください。')}
              </p>
              {products.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <div className={reviewSummaryPillClass}>
                    {tr(`${filteredProducts.length} visible`, `${filteredProducts.length} 件表示`)}
                  </div>
                  <div className={reviewSummaryPillClass}>
                    {tr(`${groupedProducts.length} color groups`, `${groupedProducts.length} 色グループ`)}
                  </div>
                  <div className={reviewSummaryPillClass}>
                    {tr(`${selectedCount} selected`, `${selectedCount} 件選択`)}
                  </div>
                  {selectedCalendar && (
                    <div className={reviewSummaryPillClass}>
                      {tr(`${syncedCount} in Notion`, `${syncedCount} 件がNotion登録済み`)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {products.length > 0 && (
              <div className="glass-toolbar flex flex-col gap-2 rounded-[24px] p-2 md:min-w-[420px] md:flex-row md:items-center">
                <div className="relative min-w-0 flex-1">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                  <input
                    type="text"
                    value={reviewQuery}
                    onChange={(event) => setReviewQuery(event.target.value)}
                    placeholder={reviewSearchPlaceholder}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    style={{
                      fontFamily: 'inherit',
                      color: 'var(--text-primary)',
                      WebkitTextFillColor: 'var(--text-primary)',
                      caretColor: 'var(--text-primary)',
                    }}
                    className="w-full rounded-full border border-slate-200/90 bg-white/92 py-2.5 pl-10 pr-4 text-[15px] font-medium leading-[1.2] tracking-[-0.01em] text-[var(--text-primary)] outline-none transition placeholder:text-slate-400 selection:bg-sky-200 selection:text-slate-900 focus:border-sky-300 focus:bg-white dark:border-white/10 dark:bg-white/6 dark:placeholder:text-slate-500 dark:selection:bg-sky-500 dark:selection:text-white"
                    aria-label={tr('Search products', '製品を検索')}
                  />
                </div>
                <select
                  value={reviewCategory}
                  onChange={(event) => setReviewCategory(event.target.value as ReviewCategory)}
                  style={{
                    fontFamily: 'inherit',
                    color: 'var(--text-primary)',
                    WebkitTextFillColor: 'var(--text-primary)',
                  }}
                  className="w-full rounded-full border border-slate-200/90 bg-white/92 px-4 py-2.5 text-[15px] font-medium leading-[1.2] tracking-[-0.01em] text-[var(--text-primary)] outline-none transition focus:border-sky-300 focus:bg-white dark:border-white/10 dark:bg-white/6 md:w-[150px]"
                  aria-label={tr('Search category', '検索カテゴリ')}
                >
                  {reviewCategoryOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const shouldSelectAll = products.some((product) => !product.selected);
                    setProducts((prev) => prev.map((product) => ({...product, selected: shouldSelectAll})));
                  }}
                  className="secondary-button justify-center md:shrink-0"
                >
                  {products.every((product) => product.selected) && products.length > 0
                    ? tr('Clear all', 'すべて解除')
                    : tr('Select all', 'すべて選択')}
                </button>
              </div>
            )}
          </div>

          {!selectedCalendar || !selectedFile ? (
            <div className="mt-8 flex min-h-[420px] items-center justify-center rounded-[28px] border border-dashed border-[color:var(--line)] bg-white/36 px-6 text-center dark:bg-white/3">
              <div className="max-w-sm space-y-3">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300">
                  <FileSpreadsheet size={24} />
                </div>
                <h3 className="text-xl font-semibold tracking-[-0.03em]">{tr('Start with a page and a workbook', 'ページとブックから開始')}</h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  {tr('The review stays quiet until the essentials are ready.', '必要なものが揃うまで、確認画面は静かに待機します。')}
                </p>
              </div>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="mt-8 flex min-h-[320px] items-center justify-center rounded-[28px] border border-dashed border-[color:var(--line)] bg-white/36 px-6 text-center dark:bg-white/3">
              <div className="max-w-sm space-y-3">
                <h3 className="text-xl font-semibold tracking-[-0.03em]">{tr('No matching rows', '一致する行がありません')}</h3>
                <p className="text-sm text-[var(--text-secondary)]">{tr('Try a different search term or clear the filter.', '別の検索語を試すか、フィルターを解除してください。')}</p>
              </div>
            </div>
          ) : (
            <div className={reviewGridClass} style={reviewGridStyle}>
              {groupedProducts.map(([color, items]) => {
                const groupDate = items[0]?.date ?? '--/--';
                const groupSelectedCount = items.filter((item) => item.selected).length;
                return (
                  <div key={color} className={reviewGroupClass}>
                    <div className="flex items-start justify-between gap-4 px-2 pb-4">
                      <div className="min-w-0 space-y-2">
                        <div className={reviewColorChipClass}>{color}</div>
                        <div className="space-y-1">
                          <div className={reviewHeaderMetaClass}>{groupDate}</div>
                          <div className={reviewHeaderMetaClass}>
                            {tr(`${items.length} items in this group`, `このグループ ${items.length} 件`)}
                          </div>
                        </div>
                      </div>
                      <div className={reviewHeaderColumnsClass}>
                        {tr(
                          `${groupSelectedCount}/${items.length} selected`,
                          `${groupSelectedCount}/${items.length} 選択中`,
                        )}
                      </div>
                    </div>

                    <div className="space-y-3">
                      {items.map((product) => (
                        <div
                          key={product.id}
                          className={`select-none rounded-[28px] border px-4 py-4 transition-all ${
                            product.selected ? selectedProductCardClass : defaultProductCardClass
                          }`}
                        >
                          <div className="flex flex-col gap-3">
                            <div className="min-w-0">
                              <div className="space-y-1">
                                {product.trial ? (
                                  <p className="text-xs font-extrabold tracking-[-0.02em] text-rose-600 md:text-sm">{product.trial}</p>
                                ) : (
                                  <div className="h-4 md:h-5" aria-hidden="true" />
                                )}
                                <h4
                                  className="text-base font-semibold leading-tight tracking-[-0.03em] md:text-xl"
                                  style={{color: 'var(--text-primary)'}}
                                >
                                  {product.part}
                                </h4>
                              </div>
                              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <div className="flex flex-wrap items-center gap-2.5">
                                  <span className={reviewMetricChipClass}>
                                    {tr('Qty:', '数量:')} {product.qty}
                                  </span>
                                  <span className={reviewMetricChipClass}>
                                    {tr('C/T:', 'c/t:')} {product.ct}
                                  </span>
                                  <span
                                    className={`${notionMiniCircleBaseClass} ${
                                      product.alreadySynced ? notionSyncedCircleActiveClass : notionSyncedCircleInactiveClass
                                    }`}
                                    role="img"
                                    aria-label={
                                      product.alreadySynced
                                        ? tr('Synced in Notion', 'Notion登録済み')
                                        : tr('Not yet synced in Notion', 'Notion未登録')
                                    }
                                    title={
                                      product.alreadySynced
                                        ? tr('Synced in Notion', 'Notion登録済み')
                                        : tr('Not yet synced in Notion', 'Notion未登録')
                                    }
                                  >
                                    <Check size={15} strokeWidth={2.6} />
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveFromNotion(product)}
                                    disabled={!product.alreadySynced || !selectedCalendar || removingProductId === product.id}
                                    aria-label={tr(`Remove ${product.part} from Notion`, `${product.part} を Notion から削除`)}
                                    title={
                                      product.alreadySynced
                                        ? tr('Remove from Notion', 'Notionから削除')
                                        : tr('Sync to Notion first', '先にNotionへ登録してください')
                                    }
                                    className={`${notionMiniCircleBaseClass} ${notionDeleteCircleClass} ${
                                      product.alreadySynced && selectedCalendar && removingProductId !== product.id
                                        ? notionDeleteCircleActiveClass
                                        : notionDeleteCircleInactiveClass
                                    }`}
                                  >
                                    {removingProductId === product.id ? (
                                      <RefreshCw size={14} className="animate-spin" />
                                    ) : (
                                      <Trash2 size={14} strokeWidth={2.2} />
                                    )}
                                  </button>
                                </div>

                                <div className="ml-auto flex flex-wrap items-center gap-3">
                                  <CircleToggle
                                    tone="select"
                                    active={product.selected}
                                    label={tr('Sel', '選択')}
                                    ariaLabel={tr(`Select ${product.part}`, `${product.part} を選択`)}
                                    onClick={() =>
                                      setProducts((prev) =>
                                        prev.map((item) => (item.id === product.id ? {...item, selected: !item.selected} : item)),
                                      )
                                    }
                                  />
                                  <CircleToggle
                                    tone="success"
                                    active={product.colorAccent}
                                    label={tr('Clr', '色付')}
                                    ariaLabel={tr(`Attach color to ${product.part}`, `${product.part} に色付け`)}
                                    onClick={() =>
                                      setProducts((prev) =>
                                        prev.map((item) => (item.id === product.id ? {...item, colorAccent: !item.colorAccent} : item)),
                                      )
                                    }
                                  />
                                  <CircleToggle
                                    tone="warning"
                                    active={product.override}
                                    label={tr('Ovr', '上書')}
                                    ariaLabel={tr(`Override ${product.part}`, `${product.part} を上書き`)}
                                    onClick={() =>
                                      setProducts((prev) =>
                                        prev.map((item) => (item.id === product.id ? {...item, override: !item.override} : item)),
                                      )
                                    }
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

      <div className={actionBarClass}>
        <div className={actionToolbarClass}>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="grid gap-3 md:grid-cols-3 xl:flex-1">
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Page', 'ページ')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {selectedCalendar?.title ?? tr('Choose a page', 'ページを選択')}
                </p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Workbook', 'ブック')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{selectedFile ?? tr('Choose a file', 'ファイルを選択')}</p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Selection', '選択')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{tr(`${syncReadyCount} ready to sync`, `${syncReadyCount} 件が同期可能`)}</p>
              </div>
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              {downloadArtifact && (
                <div className="flex flex-col gap-1">
                  {hasPendingWorkbookDownload && (
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-200">
                      {tr('Download required before leaving', '離れる前にダウンロードが必要です')}
                    </p>
                  )}
                  <button onClick={handleDownloadWorkbook} className="secondary-button justify-center">
                    {hasPendingWorkbookDownload ? tr('Download workbook', 'ブックをダウンロード') : tr('Download again', '再度ダウンロード')}
                  </button>
                </div>
              )}
              <button
                onClick={handleSync}
                disabled={!selectedCalendar || !selectedFile || isSyncing || removingProductId !== null}
                className="primary-button justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                {tr('Sync to Notion', 'Notion に同期')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const DailyGeneratorView = () => (
    <div className={pageStackClass}>
      <div className="space-y-3">
        <BackButton label={tr('Back', '戻る')} onClick={goBack} />
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Daily Generator', '日次生成')}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">{tr('Run the daily plan in one pass.', '日次計画を一度で実行。')}</h1>
          <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
            {tr(
              'Choose the target date, keep the defaults, and let the generator prepare the Notion update.',
              '対象日を選び、標準設定のまま、ジェネレーターに Notion 更新の準備を任せます。',
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Workbook', 'ブック')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Choose an Excel file', 'Excelファイルを選択')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {tr(
                  'Daily Generator uses the current uploaded workbook and returns the updated file after processing.',
                  '日次ジェネレーターは現在アップロード済みのブックを使い、処理後に更新済みファイルを返します。',
                )}
              </p>
            </div>

            {canUseNativeFilePicker ? (
              <>
                <input ref={fileInputRef} type="file" className="hidden" accept=".xlsx,.xls" onChange={handleFileChange} />

                <button
                  type="button"
                  onClick={openNativeSelector}
                  className="w-full rounded-[28px] border border-[color:var(--line)] bg-white/55 p-5 text-left transition hover:bg-white/75 dark:bg-white/5 dark:hover:bg-white/8"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] ${
                        selectedFile
                          ? 'bg-emerald-500 text-white'
                          : 'bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300'
                      }`}
                    >
                      {selectedFile ? <FileSpreadsheet size={24} /> : <Upload size={24} />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-medium text-[var(--text-primary)]">
                        {selectedFile ?? tr('Choose Excel file', 'Excelファイルを選択')}
                      </p>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        {selectedFile
                          ? tr('Tap to replace the current workbook.', 'タップして現在のブックを置き換えます。')
                          : tr('Tap here to open the system file picker.', 'タップしてシステムのファイルピッカーを開きます。')}
                      </p>
                    </div>
                  </div>
                </button>
              </>
            ) : (
              <label className="relative block w-full cursor-pointer rounded-[28px] border border-[color:var(--line)] bg-white/55 p-5 text-left transition hover:bg-white/75 dark:bg-white/5 dark:hover:bg-white/8">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  accept=".xlsx,.xls"
                  onChange={handleFileChange}
                />

                <div className="flex items-center gap-4">
                  <div
                    className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] ${
                      selectedFile
                        ? 'bg-emerald-500 text-white'
                        : 'bg-slate-100 text-slate-500 dark:bg-white/8 dark:text-slate-300'
                    }`}
                  >
                    {selectedFile ? <FileSpreadsheet size={24} /> : <Upload size={24} />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-[var(--text-primary)]">
                      {selectedFile ?? tr('Choose Excel file', 'Excelファイルを選択')}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {selectedFile
                        ? tr('Tap to replace the current workbook.', 'タップして現在のブックを置き換えます。')
                        : tr('Tap here to open the system file picker.', 'タップしてシステムのファイルピッカーを開きます。')}
                    </p>
                  </div>
                </div>
              </label>
            )}
          </Panel>

          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Date', '日付')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Choose a target', '対象を選択')}</h2>
            </div>

            {calendarPages.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-[color:var(--line)] bg-white/36 px-5 py-8 text-center text-sm text-[var(--text-secondary)] dark:bg-white/3">
                {tr('Upcoming calendar pages will appear here after loading.', '読み込み後、ここに今後のカレンダーページが表示されます。')}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {calendarPages.map((page) => (
                  <button
                    key={page.id}
                    onClick={() => {
                      setDailyCalendar(page);
                      setDailyPreviewSummary(null);
                      setDailyRunSummary(null);
                    }}
                    className={`rounded-[24px] border px-4 py-4 text-left transition-all ${
                      dailyCalendar?.id === page.id
                        ? 'border-emerald-200 bg-emerald-50/85 shadow-[0_18px_36px_rgba(16,185,129,0.14)] dark:border-emerald-900/50 dark:bg-emerald-950/28'
                        : 'border-[color:var(--line)] bg-white/55 hover:bg-white/75 dark:bg-white/4 dark:hover:bg-white/8'
                    }`}
                  >
                    <p className="text-sm font-medium text-[var(--text-tertiary)]">{page.date}</p>
                    <p className="mt-2 text-base font-medium text-[var(--text-primary)]">{page.title}</p>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <Panel strong className="p-6">
          <div className="space-y-6">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Run', '実行')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Automation', '自動化')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {tr('Highlights stay on. Duplicate rows stay out.', 'ハイライトは維持し、重複行は除外します。')}
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/58 px-4 py-4 dark:bg-white/6">
                <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Auto-highlight workbook', 'ブックを自動ハイライト')}</p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/58 px-4 py-4 dark:bg-white/6">
                <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Skip highlighted rows', 'ハイライト済みの行をスキップ')}</p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/58 px-4 py-4 dark:bg-white/6">
                <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Create one Notion row per color group', '色グループごとに Notion 行を作成')}</p>
              </div>
            </div>

            <div className="space-y-3 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
              <div>
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Page', 'ページ')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {dailyCalendar?.title ?? tr('Choose a page', 'ページを選択')}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Workbook', 'ブック')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {selectedFile ?? tr('Choose a file', 'ファイルを選択')}
                </p>
              </div>
            </div>

            {dailyPreviewSummary && (
              <div className="space-y-2 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Workbook scan', 'ブックスキャン')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(`${dailyPreviewSummary.totalRows} total rows checked`, `${dailyPreviewSummary.totalRows} 行を確認`)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Already highlighted', '既存ハイライト')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(
                      `${dailyPreviewSummary.alreadyHighlightedRows} rows already highlighted`,
                      `${dailyPreviewSummary.alreadyHighlightedRows} 行は既にハイライト済み`,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Found in Notion', 'Notion照合')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(
                      `${dailyPreviewSummary.matchedNotionRows} rows matched in Notion`,
                      `${dailyPreviewSummary.matchedNotionRows} 行が Notion に一致`,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Pending rows', '未処理行')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(`${dailyPreviewSummary.pendingRows} rows still pending`, `${dailyPreviewSummary.pendingRows} 行が未処理`)}
                  </p>
                </div>
              </div>
            )}

            <button
              onClick={handleDailyRun}
              disabled={!dailyCalendar || !selectedFile || isSyncing}
              className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <Play size={18} />}
              {tr('Run generator', 'ジェネレーターを実行')}
            </button>

            {downloadArtifact && (
              <div className="space-y-2 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
                {hasPendingWorkbookDownload && (
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-200">
                    {tr('Download required before leaving', '離れる前にダウンロードが必要です')}
                  </p>
                )}
                <button onClick={handleDownloadWorkbook} className="secondary-button w-full justify-center">
                  {hasPendingWorkbookDownload ? tr('Download workbook', 'ブックをダウンロード') : tr('Download again', '再度ダウンロード')}
                </button>
              </div>
            )}

            {dailyRunSummary && (
              <div className="space-y-2 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Processed rows', '処理行数')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(`${dailyRunSummary.processedRows} processed`, `${dailyRunSummary.processedRows} 行を処理`)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Skipped rows', 'スキップ行数')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(
                      `${dailyRunSummary.skippedHighlightedRows} already highlighted`,
                      `${dailyRunSummary.skippedHighlightedRows} 行はすでにハイライト済み`,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Color groups', '色グループ')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(`${dailyRunSummary.groupsCount} groups created`, `${dailyRunSummary.groupsCount} グループを作成`)}
                  </p>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {isSyncing && (
        <Panel className="p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Progress', '進行状況')}</p>
              <h3 className="mt-1 text-xl font-semibold tracking-[-0.03em]">{tr('Processing workbook', 'ブックを処理中')}</h3>
            </div>
            <span className="text-sm font-medium text-[var(--text-secondary)]">{progress}%</span>
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200/70 dark:bg-white/8">
            <motion.div
              className="h-full bg-emerald-500"
              initial={reducedMotion ? false : {width: 0}}
              animate={{width: `${progress}%`}}
              transition={{duration: reducedMotion ? 0 : 0.2}}
            />
          </div>
        </Panel>
      )}
    </div>
  );

  const DefectivePartsView = () => (
    <div className={pageStackClass}>
      <div className="space-y-3">
        <BackButton label={tr('Back', '戻る')} onClick={goBack} />
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Defective Parts Tracker', '欠品入力')}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">
            {tr('Create a defective-parts record from 作業内容.', '不良部品を簡単に追跡する。')}
          </h1>
          <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
            {tr(
              'Pick the day page, read its nested 「作業内容」 database, then save one defect record at a time into the destination Notion database.',
              '対象ページを選択し、ネストされた「作業内容」データベースを読み込んで、欠品レコードを 1 件ずつ登録します。',
            )}
          </p>
        </div>
      </div>

      <div className="space-y-6">
          <Panel className="p-6">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Source page', '参照ページ')}</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">
                  {defectiveTrackerCalendar?.title ?? tr('No calendar page found', 'カレンダーページが見つかりません')}
                </h2>
                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                  {defectiveTrackerCalendar?.date
                    ? tr(
                        `${defectiveTrackerCalendar.date} · reading the selected page’s nested 「作業内容」 database`,
                        `${defectiveTrackerCalendar.date} ・ 選択したページ内の「作業内容」データベースを読み込み`,
                      )
                    : defectiveTrackerToday
                      ? tr(
                          `${defectiveTrackerToday} · waiting for a matching calendar page`,
                          `${defectiveTrackerToday} ・ 対応するカレンダーページを待機中`,
                        )
                      : tr('Loading today’s context.', '当日の情報を読み込み中です。')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadDefectiveTrackerSnapshot({pageId: defectiveTrackerPageId || defectiveTrackerCalendar?.id})}
                disabled={defectiveTrackerLoading || defectiveTrackerSubmitting}
                className="secondary-button w-fit"
              >
                <RefreshCw size={16} className={defectiveTrackerLoading ? 'animate-spin' : ''} />
                {tr('Refresh', '再読み込み')}
              </button>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
                <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Colors', '色')}</p>
                <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[var(--text-primary)]">
                  {defectiveTrackerColorCount}
                </p>
              </div>
              <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
                <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Part numbers', '品番')}</p>
                <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[var(--text-primary)]">
                  {defectiveTrackerPartCount}
                </p>
              </div>
              <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
                <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Source DB', '参照 DB')}</p>
                <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                  {defectiveTrackerNestedDatabase
                    ? tr(
                        defectiveTrackerNestedDatabase.discoverySource === 'cache' ? 'Loaded from cache' : 'Fresh search',
                        defectiveTrackerNestedDatabase.discoverySource === 'cache' ? 'キャッシュから取得' : '新規検索',
                      )
                    : tr('Unavailable', '未取得')}
                </p>
              </div>
            </div>

            <div className="mt-6">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">
                {tr('Choose a page using the same search as Workflow Manager', 'ワークフローマネージャーと同じ検索結果からページを選択')}
              </p>
              {calendarPages.length === 0 ? (
                <div className="mt-3 rounded-[24px] border border-dashed border-[color:var(--line)] bg-white/36 px-5 py-8 text-center text-sm text-[var(--text-secondary)] dark:bg-white/3">
                  {tr('Calendar pages are loading.', 'カレンダーページを読み込み中です。')}
                </div>
              ) : (
                <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                  <div>
                    <select
                      value={defectiveTrackerPageId || defectiveTrackerCalendar?.id || ''}
                      onChange={(event) => {
                        const nextPageId = event.target.value;
                        setDefectiveTrackerPageId(nextPageId);
                        setDefectiveTrackerNotice(null);
                        setDefectiveTrackerFieldErrors({});
                        setDefectiveTrackerPartName('');
                        setDefectiveTrackerQuantity('');
                        void loadDefectiveTrackerSnapshot({pageId: nextPageId});
                      }}
                      disabled={defectiveTrackerLoading || defectiveTrackerSubmitting}
                      style={{
                        fontFamily: 'inherit',
                        color: 'var(--text-primary)',
                        WebkitTextFillColor: 'var(--text-primary)',
                      }}
                      className={trackerFieldInputClass}
                    >
                      <option value="">{tr('Select a page', 'ページを選択')}</option>
                      {calendarPages.map((page) => (
                        <option key={page.id} value={page.id}>
                          {`${page.date} · ${page.title}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="rounded-[20px] border border-[color:var(--line)] bg-white/45 px-4 py-3 text-sm text-[var(--text-secondary)] dark:bg-white/4">
                    <p className="font-medium text-[var(--text-primary)]">
                      {tr('Default target', '既定の対象')}
                    </p>
                    <p className="mt-1">
                      {defectiveTrackerToday
                        ? tr(`Today is ${defectiveTrackerToday}.`, `本日は ${defectiveTrackerToday} です。`)
                        : tr('Loading today.', '本日を読み込み中です。')}
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <span className={reviewSummaryPillClass}>
                {defectiveTrackerFormReady ? tr('Ready to save', '登録できます') : tr('Editing', '入力中')}
              </span>
              <span className={reviewSummaryPillClass}>
                {defectiveTrackerDatabaseAccessible
                  ? tr('Database connected', 'DB 接続済み')
                  : tr('Database share needed', 'DB 共有が必要')}
              </span>
              {defectiveTrackerNestedDatabase && (
                <span className={reviewSummaryPillClass}>
                  {tr(
                    defectiveTrackerNestedDatabase.discoverySource === 'cache' ? 'Cached source' : 'Fresh source',
                    defectiveTrackerNestedDatabase.discoverySource === 'cache' ? 'キャッシュ参照' : '新規参照',
                  )}
                </span>
              )}
            </div>

            {defectiveTrackerWarning && (
              <div className="mt-5 rounded-[24px] border border-amber-300 bg-amber-100/90 px-4 py-4 text-sm text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/55 dark:text-amber-50">
                {defectiveTrackerWarning}
              </div>
            )}
          </Panel>

          {defectiveTrackerLoading ? (
            <Panel className="p-6">
              <div className="flex min-h-[280px] items-center justify-center rounded-[24px] border border-dashed border-[color:var(--line)] bg-white/36 px-6 text-center dark:bg-white/3">
                <div className="space-y-3">
                  <RefreshCw size={24} className="mx-auto animate-spin text-[var(--text-tertiary)]" />
                  <p className="text-sm text-[var(--text-secondary)]">
                    {tr('Scanning the selected page and nested database.', '選択したページとネストされたデータベースを確認しています。')}
                  </p>
                </div>
              </div>
            </Panel>
          ) : defectiveTrackerColorOptions.length === 0 ? (
            <Panel className="p-6">
              <div className="flex min-h-[280px] items-center justify-center rounded-[24px] border border-dashed border-[color:var(--line)] bg-white/36 px-6 text-center dark:bg-white/3">
                <div className="max-w-sm space-y-3">
                  <AlertCircle size={24} className="mx-auto text-[var(--text-tertiary)]" />
                  <h3 className="text-xl font-semibold tracking-[-0.03em]">
                    {tr('No usable source rows were found', '利用可能な参照行が見つかりません')}
                  </h3>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {tr(
                      'Check the selected page, make sure it contains a nested 「作業内容」 database with 色 and 品番 data, then refresh.',
                      '選択したページに「作業内容」データベースがあり、色と品番データが入っているか確認してから再読み込みしてください。',
                    )}
                  </p>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel className="p-6">
              <div className="space-y-6">
                <div>
                  <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Quick form', '簡易入力フォーム')}</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">
                    {tr('Build one defect record', '欠品を 1 件入力')}
                  </h2>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    {tr(
                      '色 and 品番 come from the selected 「作業内容」 database. 品番 updates immediately when 色 changes.',
                      '色と品番は選択した「作業内容」データベースから取得します。色を変更すると品番もすぐ更新されます。',
                    )}
                  </p>
                </div>

                {defectiveTrackerNotice && (
                  <div
                    className={`rounded-[24px] px-4 py-4 text-sm ${
                      defectiveTrackerNotice.tone === 'success'
                        ? 'border border-emerald-200 bg-emerald-50/85 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/25 dark:text-emerald-100'
                        : defectiveTrackerNotice.tone === 'warning'
                          ? 'border border-amber-300 bg-amber-100/90 text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/55 dark:text-amber-50'
                          : 'border border-rose-200 bg-rose-50/85 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/25 dark:text-rose-100'
                    }`}
                  >
                    {defectiveTrackerNotice.message}
                  </div>
                )}

                <div className="space-y-4">
                  <div
                    className={`${trackerSelectionPanelClass} ${
                      defectiveTrackerFieldErrors.color ? 'border-rose-300 dark:border-rose-500/60' : ''
                    }`}
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className={trackerFieldLabelClass}>{tr('Choose color', '色を選択')}</p>
                        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                          {tr('Match the source color group', '参照元の色グループを選択')}
                        </h3>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">
                          {tr(
                            'Selecting a color filters the parts list from today’s 作業内容 database.',
                            '色を選択すると、本日の作業内容データベースから対象の部品だけを絞り込みます。',
                          )}
                        </p>
                      </div>
                      <span className={trackerSelectionStatusClass}>
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            defectiveTrackerSelectedColor ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-500'
                          }`}
                        />
                        {defectiveTrackerSelectedColor
                          ? tr(`${defectiveTrackerSelectedColor} selected`, `${defectiveTrackerSelectedColor} を選択中`)
                          : tr('Waiting for color', '色を選択してください')}
                      </span>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-3">
                      {defectiveTrackerColorOptions.map((color) => {
                        const isSelected = color === defectiveTrackerSelectedColor;
                        const partCount = defectiveTrackerColorPartMap[color]?.length ?? 0;
                        return (
                          <button
                            key={color}
                            type="button"
                            onClick={() => {
                              if (isSelected) {
                                return;
                              }
                              setDefectiveTrackerSelectedColor(color);
                              setDefectiveTrackerNotice(null);
                              clearDefectiveTrackerFieldError('color');
                              clearDefectiveTrackerFieldError('partNumber');
                            }}
                            className={getTrackerChoiceButtonClass(isSelected)}
                          >
                            {isSelected ? <Check size={16} className="shrink-0" /> : <span className="h-2.5 w-2.5 rounded-full bg-current/60" />}
                            <span className="font-semibold">{color}</span>
                            <span className="rounded-full border border-current/10 px-2.5 py-1 text-[11px] font-semibold leading-none opacity-80">
                              {partCount}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {defectiveTrackerFieldErrors.color && (
                      <p className="mt-3 text-sm text-rose-600 dark:text-rose-300">{defectiveTrackerFieldErrors.color}</p>
                    )}
                  </div>

                  <div
                    className={`${trackerSelectionPanelClass} ${
                      defectiveTrackerFieldErrors.partNumber ? 'border-rose-300 dark:border-rose-500/60' : ''
                    }`}
                  >
                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className={trackerFieldLabelClass}>{tr('Choose part', '品番を選択')}</p>
                        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                          {tr('Pick the exact part from the list', '一覧から対象の部品を選択')}
                        </h3>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">
                          {tr(
                            'Each card below comes from the selected color group inside 作業内容.',
                            '下のカードは、選択した色グループ内の作業内容データから取得しています。',
                          )}
                        </p>
                      </div>
                      <span className={trackerSelectionStatusClass}>
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            defectiveTrackerPartNumber ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-500'
                          }`}
                        />
                        {defectiveTrackerPartNumber
                          ? tr('Part selected', '部品を選択済み')
                          : defectiveTrackerSelectedColor
                            ? tr(`${defectiveTrackerSelectedPartCount} available`, `${defectiveTrackerSelectedPartCount} 件表示`)
                            : tr('Choose color first', '先に色を選択')}
                      </span>
                    </div>

                    {defectiveTrackerSelectedColor ? (
                      defectiveTrackerSelectedPartCount ? (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {defectiveTrackerPartOptions.map((partNumber) => {
                            const isSelected = partNumber === defectiveTrackerPartNumber;
                            const {mainLabel, trialLabel} = splitDefectiveTrackerPartDisplay(partNumber);
                            return (
                              <button
                                key={partNumber}
                                type="button"
                                onClick={() => {
                                  setDefectiveTrackerPartNumber(partNumber);
                                  setDefectiveTrackerNotice(null);
                                  clearDefectiveTrackerFieldError('partNumber');
                                }}
                                className={getTrackerPartCardClass(isSelected)}
                              >
                                <div className="min-w-0 flex-1 pr-2">
                                  {trialLabel && <span className={trackerPartTrialBadgeClass}>{trialLabel}</span>}
                                  <p className={`${trackerPartTitleClass} ${trialLabel ? 'mt-3' : ''}`}>
                                    {mainLabel || partNumber}
                                  </p>
                                </div>
                                <span
                                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] ${
                                    isSelected
                                      ? 'bg-emerald-500 text-white'
                                      : theme === 'dark'
                                        ? 'border border-white/10 bg-white/[0.05] text-slate-300'
                                        : 'border border-slate-200/90 bg-white text-slate-500'
                                  }`}
                                >
                                  {isSelected ? <Check size={16} /> : <ChevronRight size={16} />}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div className={`mt-4 ${trackerSelectionHintClass}`}>
                          {tr('No parts were found for this color group.', 'この色グループに部品が見つかりません。')}
                        </div>
                      )
                    ) : (
                      <div className={`mt-4 ${trackerSelectionHintClass}`}>
                        {tr('Select a color first to open the parts list.', '先に色を選択すると、部品一覧が表示されます。')}
                      </div>
                    )}

                    {defectiveTrackerFieldErrors.partNumber && (
                      <p className="mt-3 text-sm text-rose-600 dark:text-rose-300">{defectiveTrackerFieldErrors.partNumber}</p>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className={getTrackerFieldCardClass('partName')}>
                    <p className={trackerFieldLabelClass}>{tr('Part name', '部品名')}</p>
                    <input
                      type="text"
                      value={defectiveTrackerPartName}
                      onChange={(event) => {
                        setDefectiveTrackerPartName(event.target.value);
                        setDefectiveTrackerNotice(null);
                        clearDefectiveTrackerFieldError('partName');
                      }}
                      className={getTrackerFieldInputClass('partName')}
                      placeholder={tr('Enter the part name', '部品名を入力')}
                    />
                    <p className={trackerFieldHintClass}>
                      {tr(
                        'This is the editable 部品名 field that will be written to the defects database.',
                        'ここで入力した内容が、欠品データベースの部品名プロパティに登録されます。',
                      )}
                    </p>
                    {defectiveTrackerFieldErrors.partName && (
                      <p className="mt-2 text-sm text-rose-600 dark:text-rose-300">{defectiveTrackerFieldErrors.partName}</p>
                    )}
                  </div>

                  <div className={getTrackerFieldCardClass('quantity')}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={trackerFieldLabelClass}>{tr('Quantity', '数量')}</p>
                        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                          {tr('Adjust with one tap', 'ワンタップで調整')}
                        </h3>
                      </div>
                      <span className={trackerSelectionStatusClass}>
                        {defectiveTrackerQuantityValue != null
                          ? tr(`${defectiveTrackerQuantityValue} pcs`, `${defectiveTrackerQuantityValue} 個`)
                          : tr('Set quantity', '数量を設定')}
                      </span>
                    </div>
                    <div className={trackerStepperShellClass}>
                      <button
                        type="button"
                        onClick={() => stepDefectiveTrackerQuantity(-1)}
                        disabled={!defectiveTrackerCanDecrementQuantity || defectiveTrackerSubmitting}
                        className={getTrackerStepperButtonClass(!defectiveTrackerCanDecrementQuantity || defectiveTrackerSubmitting)}
                        aria-label={tr('Decrease quantity', '数量を減らす')}
                      >
                        <Minus size={18} />
                      </button>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={defectiveTrackerQuantity}
                        onChange={(event) => {
                          setDefectiveTrackerNotice(null);
                          handleDefectiveTrackerQuantityChange(event.target.value);
                        }}
                        className={trackerStepperInputClass}
                        placeholder="1"
                        aria-label={tr('Quantity', '数量')}
                      />
                      <button
                        type="button"
                        onClick={() => stepDefectiveTrackerQuantity(1)}
                        disabled={defectiveTrackerSubmitting}
                        className={getTrackerStepperButtonClass(defectiveTrackerSubmitting)}
                        aria-label={tr('Increase quantity', '数量を増やす')}
                      >
                        <Plus size={18} />
                      </button>
                    </div>
                    <p className={trackerFieldHintClass}>
                      {tr(
                        'Use the minus and plus buttons for quick counting. Typing still works if needed.',
                        '通常はマイナスとプラスで数量調整できます。必要なら手入力も可能です。',
                      )}
                    </p>
                    {defectiveTrackerFieldErrors.quantity && (
                      <p className="mt-2 text-sm text-rose-600 dark:text-rose-300">{defectiveTrackerFieldErrors.quantity}</p>
                    )}
                  </div>

                  <div className={`md:col-span-2 ${getTrackerFieldCardClass('defectType')}`}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className={trackerFieldLabelClass}>{tr('Defect type', '不良類')}</p>
                        <h3 className="mt-1 text-base font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                          {tr('Choose the defect category', '不良類を選択')}
                        </h3>
                      </div>
                      <span className={trackerSelectionStatusClass}>
                        <span
                          className={`h-2.5 w-2.5 rounded-full ${
                            defectiveTrackerSelectedType ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-500'
                          }`}
                        />
                        {defectiveTrackerSelectedType
                          ? defectiveTrackerSelectedType
                          : defectiveTrackerTypes.length
                            ? tr(`${defectiveTrackerTypes.length} options`, `${defectiveTrackerTypes.length} 件の候補`)
                            : tr('Unavailable', '未取得')}
                      </span>
                    </div>
                    {defectiveTrackerTypes.length ? (
                      <div className="mt-3 flex flex-wrap gap-2.5">
                        {defectiveTrackerTypes.map((option) => {
                          const isSelected = option === defectiveTrackerSelectedType;
                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => {
                                setDefectiveTrackerSelectedType(option);
                                setDefectiveTrackerNotice(null);
                                clearDefectiveTrackerFieldError('defectType');
                              }}
                              className={getTrackerCompactChoiceButtonClass(isSelected)}
                            >
                              {isSelected ? <Check size={15} className="shrink-0" /> : <span className="h-2.5 w-2.5 rounded-full bg-current/60" />}
                              <span className="min-w-0 break-words">{option}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className={`mt-4 ${trackerSelectionHintClass}`}>
                        {tr('No defect types are available in the target database yet.', '登録先データベースに不良類の候補がまだありません。')}
                      </div>
                    )}
                    {defectiveTrackerFieldErrors.defectType && (
                      <p className="mt-2 text-sm text-rose-600 dark:text-rose-300">{defectiveTrackerFieldErrors.defectType}</p>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          )}
      </div>

      <div className={actionBarClass}>
        <div className={actionToolbarClass}>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-3 xl:flex-1">
              <div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
                    {tr('Save summary', '登録サマリー')}
                  </p>
                  <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                    {tr('Floating save bar', 'フローティング登録バー')}
                  </h3>
                </div>
              </div>

              <div className="flex flex-wrap gap-2.5">
                {defectiveTrackerFloatingSummary.map((item) => (
                  <div key={`${item.label}-${item.value}`} className={trackerActionChipClass}>
                    <p className={trackerActionChipLabelClass}>{item.label}</p>
                    <p className={trackerActionChipValueClass}>{item.value}</p>
                  </div>
                ))}
              </div>

              <p className={trackerActionHintClass}>
                {!defectiveTrackerDatabaseAccessible
                  ? tr(
                      'The save button stays locked until the defects database is shared with this Notion integration.',
                      '欠品データベースがこの Notion 連携に共有されるまで、登録ボタンは有効になりません。',
                    )
                  : defectiveTrackerFormReady
                    ? tr(
                        'Saving creates one new defective-parts row with the selection shown above.',
                        '上記の内容で、欠品データベースに 1 件の新規レコードを作成します。',
                      )
                    : tr(
                        'Complete the missing fields above, then save from here.',
                        '不足している項目を入力したら、ここから登録できます。',
                      )}
              </p>
            </div>

            <div className="flex flex-col gap-2 md:items-end">
              <span className={`${trackerSelectionStatusClass} self-start md:self-end`}>
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    defectiveTrackerActionStatusReady ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                {defectiveTrackerActionStatusLabel}
              </span>
              <button
                onClick={handleDefectiveTrackerSubmit}
                disabled={defectiveTrackerSubmitDisabled}
                className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none md:w-auto md:min-w-[240px]"
              >
                {defectiveTrackerSubmitting ? <RefreshCw size={18} className="animate-spin" /> : <Check size={18} />}
                {tr('Save defective part', '欠品を登録')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const HiraharaOrdersView = () => (
    <div className={pageStackClass}>
      <div className="space-y-3">
        <BackButton label={tr('Back', '戻る')} onClick={goBack} />
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Hirahara Orders', 'ヒラハラ注文書')}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">
            {tr('Compile multiple order slips into one workbook.', '複数の注文書を 1 つのブックに集計。')}
          </h1>
          <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
            {tr(
              'Upload multiple Hirahara order files, extract the order rows, and download one computed workbook.',
              'ヒラハラ向けの注文書を複数アップロードし、注文行を抽出して 1 つの集計ブックとしてダウンロードします。',
            )}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Files', 'ファイル')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Choose order workbooks', '注文書ブックを選択')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {tr(
                  'The compiler reads only the 注文書 section from each uploaded workbook and ignores the 納品書 copy.',
                  '各ブックの 注文書 セクションのみを読み取り、納品書 の複製部分は無視します。',
                )}
              </p>
            </div>

            {canUseNativeFilePicker ? (
              <>
                <input
                  ref={hiraharaFileInputRef}
                  type="file"
                  className="hidden"
                  accept=".xlsx,.xls"
                  multiple
                  onChange={handleHiraharaFilesChange}
                />

                <button
                  type="button"
                  onClick={openHiraharaSelector}
                  className="w-full rounded-[28px] border border-dashed border-[color:var(--line-strong)] bg-white/50 p-5 text-left transition hover:bg-white/72 dark:bg-white/4 dark:hover:bg-white/8"
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-amber-500 text-white">
                      <FileSpreadsheet size={24} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-base font-medium text-[var(--text-primary)]">
                        {hiraharaSelectedCount
                          ? tr(`${hiraharaSelectedCount} files selected`, `${hiraharaSelectedCount} 件を選択済み`)
                          : tr('Choose Excel files', 'Excelファイルを選択')}
                      </p>
                      <p className="mt-1 text-sm text-[var(--text-secondary)]">
                        {tr(
                          'Pick multiple .xls or .xlsx order files at once.',
                          '.xls / .xlsx の注文書ファイルをまとめて選択します。',
                        )}
                      </p>
                    </div>
                  </div>
                </button>
              </>
            ) : (
              <label className="relative block w-full cursor-pointer rounded-[28px] border border-dashed border-[color:var(--line-strong)] bg-white/50 p-5 text-left transition hover:bg-white/72 dark:bg-white/4 dark:hover:bg-white/8">
                <input
                  ref={hiraharaFileInputRef}
                  type="file"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  accept=".xlsx,.xls"
                  multiple
                  onChange={handleHiraharaFilesChange}
                />

                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-amber-500 text-white">
                    <FileSpreadsheet size={24} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-[var(--text-primary)]">
                      {hiraharaSelectedCount
                        ? tr(`${hiraharaSelectedCount} files selected`, `${hiraharaSelectedCount} 件を選択済み`)
                        : tr('Choose Excel files', 'Excelファイルを選択')}
                    </p>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {tr(
                        'Pick multiple .xls or .xlsx order files at once.',
                        '.xls / .xlsx の注文書ファイルをまとめて選択します。',
                      )}
                    </p>
                  </div>
                </div>
              </label>
            )}

            {hiraharaSelectedCount > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" onClick={openHiraharaSelector} className="secondary-button">
                  {tr('Replace files', 'ファイルを入れ替え')}
                </button>
                <button
                  type="button"
                  onClick={clearHiraharaSelection}
                  className="rounded-full border border-[color:var(--line)] bg-white/35 px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-white/55 dark:bg-white/4 dark:hover:bg-white/8"
                >
                  {tr('Clear selection', '選択をクリア')}
                </button>
              </div>
            )}
          </Panel>

          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Selection', '選択')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Queued workbooks', '集計対象ブック')}</h2>
            </div>

            {hiraharaFiles.length === 0 ? (
              <div className="rounded-[24px] border border-dashed border-[color:var(--line)] bg-white/36 px-5 py-8 text-center text-sm text-[var(--text-secondary)] dark:bg-white/3">
                {tr('Selected files will appear here.', '選択したファイルがここに表示されます。')}
              </div>
            ) : (
              <div className="space-y-3">
                {hiraharaFiles.map((file, index) => (
                  <div
                    key={`${file.name}-${index}`}
                    className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{file.name}</p>
                        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                          {tr(`${Math.max(1, Math.round(file.size / 1024))} KB`, `${Math.max(1, Math.round(file.size / 1024))} KB`)}
                        </p>
                      </div>
                      <span className="status-pill">{index + 1}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <Panel strong className="p-6">
          <div className="space-y-6">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Compile', '集計')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('One computed workbook', '1つの集計ブック')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {tr(
                  'The generated workbook follows the Computed Form layout and is saved as a downloadable .xlsx file.',
                  '生成されるブックは Computed Form に近いレイアウトで、ダウンロード可能な .xls として保存されます。',
                )}
              </p>
            </div>

            <div className="space-y-3 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
              <div>
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Files', 'ファイル数')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {hiraharaSelectedCount
                    ? tr(`${hiraharaSelectedCount} selected`, `${hiraharaSelectedCount} 件を選択`)
                    : tr('No files selected', 'ファイル未選択')}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Rule', '抽出ルール')}</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {tr('Use 注文書, ignore 納品書', '注文書を使用し、納品書は無視')}
                </p>
              </div>
            </div>

            {hiraharaCompileSummary && (
              <div className="space-y-3 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Compiled rows', '集計行数')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(
                      `${hiraharaCompileSummary.compiledRows} rows created`,
                      `${hiraharaCompileSummary.compiledRows} 行を作成`,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Order sections', '注文書セクション')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                    {tr(
                      `${hiraharaCompileSummary.sourceOrderSections} sections extracted`,
                      `${hiraharaCompileSummary.sourceOrderSections} セクションを抽出`,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Period', '対象期間')}</p>
                  <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{hiraharaCompileSummary.monthLabel}</p>
                </div>
                {hiraharaCompileSummary.skippedFiles.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-amber-700 dark:text-amber-200">{tr('Warnings', '警告')}</p>
                    <div className="mt-2 space-y-2">
                      {hiraharaCompileSummary.skippedFiles.map((warning, index) => (
                        <p key={`${warning}-${index}`} className="text-sm text-amber-700 dark:text-amber-100">
                          {warning}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleHiraharaCompile}
              disabled={!hiraharaFiles.length || isSyncing}
              className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <FileSpreadsheet size={18} />}
              {tr('Generate computed workbook', '集計ブックを生成')}
            </button>

            {downloadArtifact && (
              <div className="space-y-2 rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/6">
                {hasPendingWorkbookDownload && (
                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-200">
                    {tr('Download required before leaving', '離れる前にダウンロードが必要です')}
                  </p>
                )}
                <button onClick={handleDownloadWorkbook} className="secondary-button w-full justify-center">
                  {hasPendingWorkbookDownload ? tr('Download workbook', 'ブックをダウンロード') : tr('Download again', '再度ダウンロード')}
                </button>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );

  const SettingsView = () => (
    <div className={pageStackClass}>
      <div className="space-y-3">
        <BackButton label={tr('Back', '戻る')} onClick={goBack} />
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Settings', '設定')}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">{tr('Quiet defaults, simple controls.', '静かな初期値、シンプルな操作。')}</h1>
          <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
            {tr('Keep the connection visible and the interface comfortable.', '接続状態を見やすく、操作感を快適に保ちます。')}
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel className="p-6">
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Connection', '接続')}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Notion</h2>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
              <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Integration token', '連携トークン')}</p>
              <p className="mt-2 text-sm text-[var(--text-primary)]">secret_xxxxxxxxxxxxxxxx</p>
            </div>
            <div className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
              <p className="text-xs font-medium text-[var(--text-tertiary)]">{tr('Calendar database', 'カレンダーデータベース')}</p>
              <p className="mt-2 text-sm text-[var(--text-primary)]">db_xxxxxxxxxxxxxxxx</p>
            </div>
          </div>
        </Panel>

        <Panel className="p-6">
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Appearance', '表示')}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Display', '画面')}</h2>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/55 px-5 py-5 dark:bg-white/4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-base font-medium text-[var(--text-primary)]">{tr('Language', '言語')}</p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">{tr('Switch between Japanese and English.', '日本語と英語を切り替えます。')}</p>
                </div>
                <LanguageToggle language={language} onChange={handleLanguageChange} />
              </div>
            </div>

            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/55 px-5 py-5 dark:bg-white/4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-medium text-[var(--text-primary)]">{tr('Dark mode', 'ダークモード')}</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">{tr('Switch the workspace tone.', 'ワークスペースのトーンを切り替えます。')}</p>
              </div>
              <button
                onClick={toggleTheme}
                className={`relative h-8 w-14 rounded-full transition-colors ${
                  theme === 'dark' ? 'bg-slate-900 dark:bg-sky-500' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow-sm transition-all ${
                    theme === 'dark' ? 'left-7' : 'left-1'
                  }`}
                />
              </button>
            </div>
          </div>
          </div>
        </Panel>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-transparent text-[var(--text-primary)]">
      <div className="relative min-h-screen">
        <main className="min-w-0">
          <div className={shellPaddingClass} style={shellZoomPaddingStyle}>
            <div className={shellInnerWidthClass} style={shellZoomInnerWidthStyle}>
                <header className={shellHeaderClass}>
                  <div className="flex items-center gap-3 md:gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                        <span>{tr('Painting Team', '塗装チーム')}</span>
                        <ChevronRight size={14} />
                        <span className="truncate text-[var(--text-primary)]">{localize(VIEW_LABELS[view])}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="hidden items-center gap-2 rounded-full border border-[color:var(--line)] bg-white/55 px-3 py-1.5 text-sm text-[var(--text-secondary)] dark:bg-white/5 md:flex">
                    <span className={`h-2 w-2 rounded-full ${isBusy ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                    {localize(status)}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setPageZoom((prev) => clamp(Number((prev - 0.1).toFixed(2)), 0.7, 1.4))}
                      className="icon-button"
                      aria-label={tr('Zoom out', '縮小')}
                    >
                      <Minus size={18} />
                    </button>
                    <button
                      onClick={() => setPageZoom(1)}
                      className="status-pill border-slate-200 bg-white/90 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
                      aria-label={tr('Reset zoom', 'ズームをリセット')}
                    >
                      {Math.round(pageZoom * 100)}%
                    </button>
                    <button
                      onClick={() => setPageZoom((prev) => clamp(Number((prev + 0.1).toFixed(2)), 0.7, 1.4))}
                      className="icon-button"
                      aria-label={tr('Zoom in', '拡大')}
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                  <div className="md:hidden">
                    <LanguageToggle language={language} onChange={handleLanguageChange} />
                  </div>
                  <div className="hidden md:block">
                    <LanguageToggle language={language} onChange={handleLanguageChange} />
                  </div>
                  <button
                    onClick={() => setActivityOpen(true)}
                    className="icon-button hidden md:inline-flex"
                    aria-label={tr('Activity', 'アクティビティ')}
                  >
                    <History size={18} />
                  </button>
                  <button onClick={toggleTheme} className="icon-button" aria-label={tr('Toggle theme', 'テーマを切り替え')}>
                    {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
                  </button>
                </div>
              </header>

                <div className={contentWidthClass}>
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={view}
                      initial={reducedMotion ? false : {opacity: 0, y: 8}}
                      animate={{opacity: 1, y: 0}}
                      exit={reducedMotion ? {opacity: 1, y: 0} : {opacity: 0, y: -8}}
                      transition={{duration: reducedMotion ? 0 : 0.18}}
                    >
                      {/* Render inline view trees directly so local input edits do not remount nested view components. */}
                      {view === 'home' && HomeView()}
                      {view === 'workflow-manager' && workflowManagerView}
                      {view === 'daily-generator' && DailyGeneratorView()}
                      {view === 'defective-parts' && DefectivePartsView()}
                      {view === 'hirahara-orders' && HiraharaOrdersView()}
                      {view === 'settings' && SettingsView()}
                    </motion.div>
                  </AnimatePresence>
                </div>
            </div>
          </div>
        </main>
      </div>

      <ActivityDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        logs={logs}
        status={localize(status)}
        isBusy={isBusy}
        reducedMotion={reducedMotion}
        language={language}
      />
    </div>
  );
}
