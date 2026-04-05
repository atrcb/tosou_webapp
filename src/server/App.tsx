/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {useDeferredValue, useEffect, useRef, useState} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronRight,
  Database,
  FileSpreadsheet,
  Languages,
  LayoutDashboard,
  Menu,
  Minus,
  Moon,
  Plus,
  Play,
  RefreshCw,
  Search,
  Settings,
  Sun,
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

type View = 'home' | 'workflow-manager' | 'daily-generator' | 'settings';
type Theme = 'light' | 'dark';
type Language = 'en' | 'ja';
type LocalizedText = Record<Language, string>;
type StepState = 'complete' | 'current' | 'upcoming';
type WorkflowStep = {
  label: LocalizedText;
  detail: LocalizedText;
  state: StepState;
};
type DownloadArtifact = {
  filename: string;
  url: string;
};

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
}

interface LogEntry {
  timestamp: string;
  message: LocalizedText;
  type: 'info' | 'success' | 'warning' | 'error';
}

const text = (en: string, ja: string): LocalizedText => ({en, ja});

const VIEW_LABELS: Record<View, LocalizedText> = {
  home: text('Home', 'ホーム'),
  'workflow-manager': text('Workflow', 'ワークフロー'),
  'daily-generator': text('Daily Generator', '日次生成'),
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

const createDownloadArtifact = (base64: string, filename: string): DownloadArtifact => {
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
  };
};

const triggerDownload = ({filename, url}: DownloadArtifact) => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noreferrer';
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

const NavItem = ({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: any;
  label: string;
  active: boolean;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-3 rounded-[18px] px-3.5 py-3 text-left text-sm transition-all ${
      active
        ? 'bg-slate-900 text-white shadow-[0_16px_30px_rgba(15,23,42,0.18)] dark:bg-white dark:text-slate-900'
        : 'text-[var(--text-secondary)] hover:bg-white/70 dark:hover:bg-white/8'
    }`}
  >
    <Icon size={18} />
    <span className="font-medium">{label}</span>
  </button>
);

const CircleToggle = ({
  active,
  tone,
  theme,
  ariaLabel,
  onClick,
}: {
  active: boolean;
  tone: 'select' | 'success' | 'warning';
  theme: Theme;
  ariaLabel: string;
  onClick: () => void;
}) => {
  const base =
    'inline-flex h-16 w-16 items-center justify-center rounded-full border bg-white shadow-[0_10px_24px_rgba(2,6,23,0.16)] transition-all focus:outline-none focus:ring-2 focus:ring-sky-300/60';
  const inactive = 'border-slate-200 text-slate-200 hover:border-slate-300';
  const activeClasses =
    tone === 'select'
      ? 'border-sky-500 ring-2 ring-sky-200/70 text-sky-600'
      : tone === 'success'
        ? 'border-emerald-500 ring-2 ring-emerald-200/70 text-emerald-600'
        : 'border-amber-500 ring-2 ring-amber-200/70 text-amber-600';

  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`${base} ${active ? activeClasses : inactive}`}
    >
      {active ? <Check size={24} strokeWidth={3} /> : null}
    </button>
  );
};

const BackButton = ({label, onClick}: {label: string; onClick: () => void}) => (
  <button onClick={onClick} className="secondary-button w-fit">
    <ArrowLeft size={16} />
    {label}
  </button>
);

const LanguageToggle = ({
  language,
  onChange,
}: {
  language: Language;
  onChange: (nextLanguage: Language) => void;
}) => (
  <div className="inline-flex items-center gap-1 rounded-full border border-[color:var(--line)] bg-white/60 p-1 text-sm shadow-sm backdrop-blur-xl dark:bg-white/6">
    <div className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-tertiary)]">
      <Languages size={15} />
    </div>
    <button
      onClick={() => onChange('ja')}
      className={`rounded-full px-3 py-1.5 font-medium transition-all ${
        language === 'ja'
          ? 'bg-slate-900 text-white shadow-[0_10px_22px_rgba(15,23,42,0.16)] dark:bg-white dark:text-slate-900'
          : 'text-[var(--text-secondary)] hover:bg-white/80 dark:hover:bg-white/8'
      }`}
      aria-pressed={language === 'ja'}
    >
      日本語
    </button>
    <button
      onClick={() => onChange('en')}
      className={`rounded-full px-3 py-1.5 font-medium transition-all ${
        language === 'en'
          ? 'bg-slate-900 text-white shadow-[0_10px_22px_rgba(15,23,42,0.16)] dark:bg-white dark:text-slate-900'
          : 'text-[var(--text-secondary)] hover:bg-white/80 dark:hover:bg-white/8'
      }`}
      aria-pressed={language === 'en'}
    >
      EN
    </button>
  </div>
);

const ActivityDrawer = ({
  open,
  onClose,
  logs,
  status,
  isSyncing,
  reducedMotion,
  language,
}: {
  open: boolean;
  onClose: () => void;
  logs: LogEntry[];
  status: string;
  isSyncing: boolean;
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
                <span className={`h-2.5 w-2.5 rounded-full ${isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
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
  const shouldAutoDownload = !embedMode && !iosDevice;

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
  const [embedZoom, setEmbedZoom] = useState<number>(() => {
    if (typeof window === 'undefined') return 1;
    const savedZoom = window.localStorage.getItem('app-embed-zoom');
    const parsed = savedZoom ? Number(savedZoom) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0.7 && parsed <= 1.4) {
      return parsed;
    }
    return 1;
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (embedMode || typeof window === 'undefined') return false;
    return window.innerWidth >= 1024;
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

  const [selectedCalendar, setSelectedCalendar] = useState<CalendarPage | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileHandle, setFileHandle] = useState<any>(null);
  const [downloadArtifact, setDownloadArtifact] = useState<DownloadArtifact | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [calendarPages, setCalendarPages] = useState<CalendarPage[]>([]);
  const [dailyCalendar, setDailyCalendar] = useState<CalendarPage | null>(null);
  const [reviewQuery, setReviewQuery] = useState('');

  const deferredReviewQuery = useDeferredValue(reviewQuery);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const view = viewHistory[viewHistory.length - 1] ?? 'home';
  const localize = (message: LocalizedText) => message[language];
  const tr = (en: string, ja: string) => (language === 'ja' ? ja : en);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const addLog = (message: LocalizedText, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString(language === 'ja' ? 'ja-JP' : 'en-GB', {
      hour12: false,
    });
    setLogs((prev) => [...prev, {timestamp, message, type}]);
  };

  const closeSidebarOnMobile = () => {
    if (embedMode || typeof window === 'undefined') return;
    if (window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  };

  const navigateTo = (nextView: View) => {
    closeSidebarOnMobile();
    setViewHistory((prev) => (prev[prev.length - 1] === nextView ? prev : [...prev, nextView]));
  };

  const goBack = () => {
    closeSidebarOnMobile();
    setViewHistory((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  const handleLanguageChange = (nextLanguage: Language) => setLanguage(nextLanguage);

  const replaceDownloadArtifact = (nextArtifact: DownloadArtifact | null) => {
    setDownloadArtifact((currentArtifact) => {
      if (currentArtifact) {
        URL.revokeObjectURL(currentArtifact.url);
      }
      return nextArtifact;
    });
  };

  const downloadBuffer = (base64: string, filename: string) => {
    try {
      const artifact = createDownloadArtifact(base64, filename);

      if (shouldAutoDownload) {
        replaceDownloadArtifact(null);
        triggerDownload(artifact);
        window.setTimeout(() => URL.revokeObjectURL(artifact.url), 1000);
        addLog(text(`Download triggered: ${filename}`, `ダウンロードを開始しました: ${filename}`), 'success');
        return;
      }

      replaceDownloadArtifact(artifact);
      addLog(text('Processed workbook ready for download.', '処理済みのブックをダウンロードできます。'), 'success');
    } catch (error: any) {
      addLog(text(`Error creating download link: ${error.message}`, `ダウンロードリンクの作成エラー: ${error.message}`), 'error');
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement> | null, manualFile?: File) => {
    const inputElement = event?.target as HTMLInputElement | undefined;
    const file = manualFile || inputElement?.files?.[0];
    if (!file) return;

    if (!manualFile) {
      setFileHandle(null);
    }

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
      addLog(text(`Workbook uploaded: ${data.filename}`, `ブックをアップロードしました: ${data.filename}`), 'success');
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
        const [handle] = await (window as any).showOpenFilePicker({
          types: [
            {
              description: 'Excel Files',
              accept: {'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']},
            },
          ],
          multiple: false,
        });
        const file = await handle.getFile();
        setFileHandle(handle);
        addLog(text(`Direct file access enabled for ${file.name}`, `${file.name} の直接ファイルアクセスを有効にしました。`), 'success');
        handleFileChange(null, file);
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          addLog(text(`File picker error: ${error.message}. Falling back.`, `ファイルピッカーエラー: ${error.message}。標準モードに切り替えます。`), 'warning');
          fileInputRef.current?.click();
        }
      }
      return;
    }

    setFileHandle(null);
    addLog(text('Using the standard file picker for compatibility.', '互換性のため標準ファイルピッカーを使用します。'), 'info');
    fileInputRef.current?.click();
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
      window.localStorage.setItem('app-embed-zoom', String(embedZoom));
    }
  }, [embedZoom]);

  useEffect(() => {
    const loadCalendar = async () => {
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

    loadCalendar();
  }, []);

  useEffect(() => {
    return () => {
      if (downloadArtifact) {
        URL.revokeObjectURL(downloadArtifact.url);
      }
    };
  }, [downloadArtifact]);

  useEffect(() => {
    if (!selectedFile) return;

    const loadProducts = async () => {
      setIsSyncing(true);
      setStatus(text('Loading workbook', 'ブックを読み込み中'));
      try {
        const response = await apiFetch('/api/load-products', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({filePath: selectedFile}),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to load products');
        }
        const data = await response.json();
        setProducts(data);
        setStatus(text('Review ready', '確認の準備ができました'));
        addLog(text(`Loaded ${data.length} products from ${selectedFile}`, `${selectedFile} から ${data.length} 件の商品を読み込みました。`), 'success');
      } catch (error) {
        addLog(text(`Error loading products: ${error}`, `商品の読み込みエラー: ${error}`), 'error');
        setStatus(text('Review loaded with sample data', 'サンプルデータで確認画面を表示しました'));
        setProducts(MOCK_PRODUCTS);
      } finally {
        setIsSyncing(false);
      }
    };

    loadProducts();
  }, [selectedFile]);

  const handleSync = async () => {
    if (!selectedCalendar || !selectedFile) return;

    setIsSyncing(true);
    setStatus(text('Syncing to Notion', 'Notion と同期中'));
    addLog(text(`Starting sync for ${selectedCalendar.title}`, `${selectedCalendar.title} の同期を開始します。`), 'info');

    try {
      const response = await apiFetch('/api/sync', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          file_path: selectedFile,
          page_id: selectedCalendar.id,
          products,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Sync failed');
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      if (fileHandle && data.buffer && canUseNativeFilePicker) {
        try {
          addLog(text('Writing back to the original workbook.', '元のブックに書き戻しています。'), 'info');
          const writable = await fileHandle.createWritable();
          const binaryStr = atob(data.buffer);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          await writable.write(bytes);
          await writable.close();
          addLog(text('Original workbook updated in place.', '元のブックを直接更新しました。'), 'success');
        } catch (error: any) {
          addLog(text(`Direct write error: ${error.message}`, `直接書き込みエラー: ${error.message}`), 'error');
          downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
        }
      } else if (data.buffer) {
        downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
      }

      setStatus(text('Sync complete', '同期が完了しました'));
      addLog(text('Notion sync completed successfully.', 'Notion との同期が完了しました。'), 'success');

      const refreshResponse = await apiFetch('/api/load-products', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({filePath: selectedFile}),
      });
      if (refreshResponse.ok) {
        const refreshedData = await refreshResponse.json();
        setProducts(refreshedData);
      }
    } catch (error) {
      addLog(text(`Sync error: ${error}`, `同期エラー: ${error}`), 'error');
      setStatus(text('Sync failed', '同期に失敗しました'));
    } finally {
      setIsSyncing(false);
      setProgress(0);
    }
  };

  const handleDailyRun = () => {
    if (!dailyCalendar) return;

    setIsSyncing(true);
    setStatus(text('Running generator', 'ジェネレーターを実行中'));
    addLog(text(`Generating workflow for ${dailyCalendar.date}`, `${dailyCalendar.date} のワークフローを生成しています。`), 'info');

    let nextProgress = 0;
    const interval = setInterval(() => {
      nextProgress += 5;
      setProgress(nextProgress);
      if (nextProgress >= 100) {
        clearInterval(interval);
        setIsSyncing(false);
        setProgress(0);
        setStatus(text('Daily run complete', '日次実行が完了しました'));
        addLog(text('Daily workflow generated and synced to Notion.', '日次ワークフローを生成し、Notion に同期しました。'), 'success');
      }
    }, 100);
  };

  const selectedCount = products.filter((product) => product.selected).length;
  const recentLogs = logs.slice(-3).reverse();
  const normalizedQuery = deferredReviewQuery.trim().toLowerCase();
  const filteredProducts = normalizedQuery
    ? products.filter((product) =>
        [product.part, product.color, product.trial, product.date].some((field) =>
          field.toLowerCase().includes(normalizedQuery),
        ),
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
        ? text(`${selectedCount} items selected`, `${selectedCount} 件を選択中`)
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
  const shellPaddingClass = embedMode ? 'px-3 pb-5 pt-3 md:px-4' : 'px-4 pb-8 pt-4 md:px-6 lg:px-8';
  const shellHeaderClass = embedMode
    ? 'glass-toolbar sticky top-3 z-20 flex items-center justify-between rounded-[22px] px-3 py-2.5 md:px-4'
    : 'glass-toolbar sticky top-4 z-20 flex items-center justify-between rounded-[26px] px-4 py-3 md:px-5';
  const contentWidthClass = embedMode ? 'mx-auto mt-4 max-w-[980px]' : 'mx-auto mt-6 max-w-[1200px]';
  const embedHomeGridClass = embedMode ? 'grid gap-5 xl:grid-cols-[1.15fr_0.85fr]' : 'grid gap-6 lg:grid-cols-[1.2fr_0.8fr]';
  const workflowShellClass = embedMode ? 'space-y-5 pb-20' : 'space-y-6 pb-24';
  const workflowSetupGridClass = embedMode
    ? 'grid gap-5 sm:grid-cols-2 sm:items-stretch'
    : 'grid gap-6 xl:grid-cols-2 xl:items-stretch';
  const actionBarClass = embedMode ? 'sticky bottom-3 z-10 pt-3' : 'sticky bottom-4 z-10 pt-4';
  const reviewGroupClass =
    theme === 'dark'
      ? 'rounded-[44px] border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(51,65,85,0.92),rgba(2,6,23,0.96))] p-6 shadow-[0_34px_90px_rgba(2,6,23,0.45)]'
      : 'rounded-[44px] border border-slate-900/25 bg-[radial-gradient(circle_at_top_left,rgba(51,65,85,0.92),rgba(2,6,23,0.98))] p-6 shadow-[0_34px_90px_rgba(2,6,23,0.45)]';
  const reviewColorChipClass =
    theme === 'dark'
      ? 'inline-flex items-center rounded-full border border-white/40 bg-white px-7 py-3 text-2xl font-extrabold tracking-[0.01em] text-slate-950 shadow-[0_14px_30px_rgba(2,6,23,0.25)] md:text-4xl'
      : 'inline-flex items-center rounded-full border border-white/40 bg-white px-7 py-3 text-2xl font-extrabold tracking-[0.01em] text-slate-950 shadow-[0_14px_30px_rgba(2,6,23,0.25)] md:text-4xl';
  const reviewHeaderMetaClass =
    theme === 'dark'
      ? 'text-lg font-semibold italic text-white/90 md:text-2xl'
      : 'text-lg font-semibold italic text-white/90 md:text-2xl';
  const reviewHeaderColumnsClass =
    theme === 'dark'
      ? 'text-base font-semibold text-white/85 md:text-lg'
      : 'text-base font-semibold text-white/85 md:text-lg';
  const selectedProductCardClass =
    'border-sky-200 bg-white shadow-[0_22px_44px_rgba(2,6,23,0.16)] ring-2 ring-sky-400/55';
  const defaultProductCardClass =
    'border-slate-200/80 bg-white shadow-[0_18px_36px_rgba(2,6,23,0.12)]';
  const productMetricPillClass =
    theme === 'dark'
      ? 'rounded-full border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-sm font-bold text-slate-50'
      : 'rounded-full border border-slate-200 bg-white/95 px-3.5 py-1.5 text-sm font-semibold text-slate-700 shadow-[0_6px_16px_rgba(148,163,184,0.12)]';
  const productTitleClass =
    theme === 'dark' ? 'text-lg font-semibold tracking-[-0.02em] text-slate-50' : 'text-lg font-semibold tracking-[-0.02em] text-slate-950';
  const embedZoomStyle: React.CSSProperties | undefined =
    embedMode && embedZoom !== 1
      ? {
          transform: `scale(${embedZoom})`,
          transformOrigin: 'top left',
          width: `${100 / embedZoom}%`,
        }
      : undefined;

  const HomeView = () => (
    <div className={pageStackClass}>
      <Panel strong className={heroPanelClass}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.7),transparent_38%)] dark:bg-[radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(148,163,184,0.08),transparent_40%)]" />
        <div className={heroCopyClass}>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] shadow-sm dark:border-white/10 dark:bg-white/6">
            <LayoutDashboard size={14} />
            {tr('Painting Team', '塗装チーム')}
          </div>
          <div className="space-y-4">
            <h1 className={heroTitleClass}>{tr('Quiet control for the daily plan.', '日々の計画を、静かにコントロール。')}</h1>
            <p className={heroBodyClass}>
              {tr(
                'Review the workbook, keep only the context that matters, and sync to Notion without the dashboard noise.',
                'ブックを確認し、必要な情報だけを残して、余計なノイズなしで Notion に同期します。',
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button onClick={() => navigateTo('workflow-manager')} className="primary-button">
              {tr('Start workflow', 'ワークフローを開始')}
              <ArrowRight size={18} />
            </button>
            <button onClick={() => navigateTo('daily-generator')} className="secondary-button">
              {tr('Daily generator', '日次生成')}
            </button>
            <button onClick={() => setActivityOpen(true)} className="secondary-button">
              {tr('Recent activity', '最近のアクティビティ')}
            </button>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <div className="status-pill">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {tr('Notion connected', 'Notion 接続済み')}
            </div>
            <div className="status-pill">
              <Calendar size={14} />
              {selectedCalendar ? selectedCalendar.title : tr('No page selected', 'ページ未選択')}
            </div>
            <div className="status-pill">
              <FileSpreadsheet size={14} />
              {selectedFile ?? tr('No workbook selected', 'ブック未選択')}
            </div>
          </div>
        </div>
      </Panel>

      <div className={embedHomeGridClass}>
        <Panel className="p-6 md:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Continue', '続行')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Workflow manager', 'ワークフローマネージャー')}</h2>
              <p className="mt-2 max-w-md text-sm text-[var(--text-secondary)]">
                {tr(
                  'Pick up the current sync with one page, one workbook, and one clear next step.',
                  '1つのページ、1つのブック、次の1手だけに絞って現在の同期を再開します。',
                )}
              </p>
            </div>
            <button onClick={() => navigateTo('workflow-manager')} className="secondary-button">
              {selectedCalendar || selectedFile ? tr('Resume', '再開') : tr('Open', '開く')}
            </button>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
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
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Ready', '準備')}</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {tr(`${selectedCount} selected rows`, `${selectedCount} 行を選択中`)}
              </p>
            </div>
          </div>
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
            <div className="mt-6 rounded-[24px] border border-emerald-200 bg-emerald-50/80 p-5 dark:border-emerald-900/60 dark:bg-emerald-950/25">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-200">{tr('Processed workbook ready', '処理済みブックの準備完了')}</p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{downloadArtifact.filename}</p>
              <a
                href={downloadArtifact.url}
                download={downloadArtifact.filename}
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-emerald-700 transition hover:text-emerald-800 dark:text-emerald-200"
              >
                {tr('Download workbook', 'ブックをダウンロード')}
                <ArrowRight size={15} />
              </a>
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

  const WorkflowManagerView = () => (
    <div className={workflowShellClass}>
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

            {(embedMode || iosDevice) && (
              <div className="mt-4 flex items-start gap-3 rounded-[22px] border border-[color:var(--line)] bg-white/45 px-4 py-3 text-sm text-[var(--text-secondary)] dark:bg-white/4">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <p>{tr('Embedded and iPad views use manual download after sync.', '埋め込み表示と iPad 表示では、同期後に手動ダウンロードを使用します。')}</p>
              </div>
            )}
            </div>
          </div>
        </Panel>

      </div>

      <Panel className="p-6 md:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('3. Review', '3. 確認')}</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Products', '製品')}</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {products.length
                  ? tr(`${selectedCount} rows selected for sync.`, `${selectedCount} 行を同期対象に選択中です。`)
                  : tr('Load a workbook to review the rows.', '行を確認するにはブックを読み込んでください。')}
              </p>
            </div>

            {products.length > 0 && (
              <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                  <input
                    type="text"
                    value={reviewQuery}
                    onChange={(event) => setReviewQuery(event.target.value)}
                    placeholder={tr('Search parts', '部品を検索')}
                    className="w-full rounded-full border border-[color:var(--line)] bg-white/68 py-2 pl-10 pr-4 text-sm text-[var(--text-primary)] outline-none transition focus:border-sky-300 dark:bg-white/6 md:w-64"
                  />
                </div>
                <button
                  onClick={() => {
                    const shouldSelectAll = products.some((product) => !product.selected);
                    setProducts((prev) => prev.map((product) => ({...product, selected: shouldSelectAll})));
                  }}
                  className="secondary-button"
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
            <div className="mt-8 space-y-5">
              {groupedProducts.map(([color, items]) => {
                const groupDate = items[0]?.date ?? '--/--';
                return (
                  <div key={color} className={reviewGroupClass}>
                    <div className="flex flex-wrap items-center justify-between gap-4 px-2 pb-4">
                      <div className="flex flex-wrap items-center gap-4">
                        <div className={reviewColorChipClass}>{color}</div>
                        <div className={reviewHeaderMetaClass}>{groupDate}</div>
                        <div className={reviewHeaderMetaClass}>{tr(`${items.length} items`, `${items.length} 点`)}</div>
                      </div>
                      <div className={`grid min-w-[240px] grid-cols-3 gap-4 justify-items-center ${reviewHeaderColumnsClass}`}>
                        <span>{tr('Select', '選択')}</span>
                        <span>{tr('Color', '色付け')}</span>
                        <span>{tr('Override', '上書き')}</span>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {items.map((product) => (
                        <div
                          key={product.id}
                          className={`rounded-[34px] border px-7 py-7 transition-all ${
                            product.selected ? selectedProductCardClass : defaultProductCardClass
                          }`}
                        >
                          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
                            <div className="min-w-0">
                              <div className="space-y-1">
                                {product.trial ? (
                                  <p className="text-lg font-extrabold tracking-[-0.02em] text-rose-600 md:text-2xl">{product.trial}</p>
                                ) : (
                                  <div className="h-7 md:h-8" aria-hidden="true" />
                                )}
                                <h4 className="text-2xl font-extrabold tracking-[-0.03em] text-slate-950 md:text-4xl">
                                  {product.part}
                                </h4>
                              </div>
                              <div className="mt-4 flex flex-wrap items-center gap-x-10 gap-y-2 text-xl font-bold text-sky-700 md:text-3xl">
                                <span>
                                  {tr('Qty:', '数量:')} {product.qty}
                                </span>
                                <span>
                                  {tr('C/T:', 'c/t:')} {product.ct}
                                </span>
                              </div>
                            </div>

                            <div className="grid min-w-[240px] grid-cols-3 gap-5 justify-items-center md:min-w-[280px]">
                              <CircleToggle
                                theme={theme}
                                tone="select"
                                active={product.selected}
                                ariaLabel={tr(`Select ${product.part}`, `${product.part} を選択`)}
                                onClick={() =>
                                  setProducts((prev) =>
                                    prev.map((item) => (item.id === product.id ? {...item, selected: !item.selected} : item)),
                                  )
                                }
                              />
                              <CircleToggle
                                theme={theme}
                                tone="success"
                                active={product.colorAccent}
                                ariaLabel={tr(`Attach color to ${product.part}`, `${product.part} に色付け`)}
                                onClick={() =>
                                  setProducts((prev) =>
                                    prev.map((item) => (item.id === product.id ? {...item, colorAccent: !item.colorAccent} : item)),
                                  )
                                }
                              />
                              <CircleToggle
                                theme={theme}
                                tone="warning"
                                active={product.override}
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
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

      <div className={actionBarClass}>
        <div className="glass-toolbar rounded-[30px] p-4 md:p-5">
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
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{tr(`${selectedCount} ready to sync`, `${selectedCount} 件が同期可能`)}</p>
              </div>
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              {downloadArtifact && (
                <a
                  href={downloadArtifact.url}
                  download={downloadArtifact.filename}
                  rel="noreferrer"
                  className="secondary-button justify-center"
                >
                  {tr('Download workbook', 'ブックをダウンロード')}
                </a>
              )}
              <button
                onClick={handleSync}
                disabled={!selectedCalendar || !selectedFile || isSyncing}
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
        <Panel className="p-6">
          <div className="mb-5">
            <p className="text-sm font-medium text-[var(--text-tertiary)]">{tr('Date', '日付')}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">{tr('Choose a target', '対象を選択')}</h2>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {MOCK_CALENDAR_PAGES.map((page) => (
              <button
                key={page.id}
                onClick={() => setDailyCalendar(page)}
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
        </Panel>

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
            </div>

            <button
              onClick={handleDailyRun}
              disabled={!dailyCalendar || isSyncing}
              className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <Play size={18} />}
              {tr('Run generator', 'ジェネレーターを実行')}
            </button>
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
      <div className="relative min-h-screen lg:flex">
        {!embedMode && (
          <AnimatePresence>
            {sidebarOpen && (
              <>
                <motion.button
                  aria-label={tr('Close sidebar', 'サイドバーを閉じる')}
                  initial={reducedMotion ? false : {opacity: 0}}
                  animate={{opacity: 1}}
                  exit={reducedMotion ? {opacity: 1} : {opacity: 0}}
                  transition={{duration: reducedMotion ? 0 : 0.18}}
                  onClick={() => setSidebarOpen(false)}
                  className="fixed inset-0 z-30 bg-slate-950/12 backdrop-blur-[2px] lg:hidden"
                />
                <motion.aside
                  initial={reducedMotion ? false : {opacity: 0, x: -24}}
                  animate={{opacity: 1, x: 0}}
                  exit={reducedMotion ? {opacity: 1, x: 0} : {opacity: 0, x: -24}}
                  transition={{duration: reducedMotion ? 0 : 0.18}}
                  className="fixed inset-y-4 left-4 z-40 w-[280px] lg:static lg:inset-auto lg:z-0 lg:w-[300px] lg:flex-shrink-0 lg:px-4 lg:py-4"
                >
                  <div className="app-panel-strong flex h-full flex-col rounded-[32px] p-4">
                    <div className="border-b border-[color:var(--line)] px-2 pb-5">
                      <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-[18px] bg-slate-900 text-lg font-semibold text-white shadow-[0_18px_36px_rgba(15,23,42,0.16)] dark:bg-white dark:text-slate-900">
                          P
                        </div>
                        <div>
                          <p className="text-base font-semibold tracking-[-0.03em]">{tr('Painting Team', '塗装チーム')}</p>
                          <p className="text-sm text-[var(--text-secondary)]">{tr('Workflow utilities', 'ワークフローツール')}</p>
                        </div>
                      </div>
                    </div>

                    <nav className="mt-6 space-y-2">
                      <NavItem icon={LayoutDashboard} label={tr('Home', 'ホーム')} active={view === 'home'} onClick={() => navigateTo('home')} />
                      <NavItem
                        icon={RefreshCw}
                        label={tr('Workflow', 'ワークフロー')}
                        active={view === 'workflow-manager'}
                        onClick={() => navigateTo('workflow-manager')}
                      />
                      <NavItem
                        icon={Play}
                        label={tr('Daily Generator', '日次生成')}
                        active={view === 'daily-generator'}
                        onClick={() => navigateTo('daily-generator')}
                      />
                      <NavItem
                        icon={Settings}
                        label={tr('Settings', '設定')}
                        active={view === 'settings'}
                        onClick={() => navigateTo('settings')}
                      />
                    </nav>

                    <div className="mt-auto rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-[18px] bg-emerald-500 text-white">
                          <Database size={18} />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{tr('Notion connected', 'Notion 接続済み')}</p>
                          <p className="text-sm text-[var(--text-secondary)]">{localize(status)}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        )}

        <main className="min-w-0 flex-1">
          <div className={shellPaddingClass}>
            <header className={shellHeaderClass}>
              <div className="flex items-center gap-3 md:gap-4">
                {!embedMode && (
                  <button onClick={() => setSidebarOpen((prev) => !prev)} className="icon-button" aria-label={tr('Toggle sidebar', 'サイドバーを切り替え')}>
                    {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
                  </button>
                )}
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
                  <span className={`h-2 w-2 rounded-full ${isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                  {localize(status)}
                </div>
                {embedMode && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEmbedZoom((prev) => clamp(Number((prev - 0.1).toFixed(2)), 0.7, 1.4))}
                      className="icon-button"
                      aria-label={tr('Zoom out', '縮小')}
                    >
                      <Minus size={18} />
                    </button>
                    <button
                      onClick={() => setEmbedZoom(1)}
                      className="status-pill border-slate-200 bg-white/90 text-slate-800 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200"
                      aria-label={tr('Reset zoom', 'ズームをリセット')}
                    >
                      {Math.round(embedZoom * 100)}%
                    </button>
                    <button
                      onClick={() => setEmbedZoom((prev) => clamp(Number((prev + 0.1).toFixed(2)), 0.7, 1.4))}
                      className="icon-button"
                      aria-label={tr('Zoom in', '拡大')}
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                )}
                <button
                  onClick={() => handleLanguageChange(language === 'ja' ? 'en' : 'ja')}
                  className="secondary-button px-3 py-2 md:hidden"
                  aria-label={tr('Switch language', '言語を切り替え')}
                >
                  {language === 'ja' ? 'EN' : '日本語'}
                </button>
                <div className="hidden md:block">
                  <LanguageToggle language={language} onChange={handleLanguageChange} />
                </div>
                <button onClick={() => setActivityOpen(true)} className="secondary-button hidden md:inline-flex">
                  {tr('Activity', 'アクティビティ')}
                </button>
                <button onClick={toggleTheme} className="icon-button" aria-label={tr('Toggle theme', 'テーマを切り替え')}>
                  {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
                </button>
              </div>
            </header>

            <div className={contentWidthClass}>
              <div style={embedZoomStyle}>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={view}
                    initial={reducedMotion ? false : {opacity: 0, y: 8}}
                    animate={{opacity: 1, y: 0}}
                    exit={reducedMotion ? {opacity: 1, y: 0} : {opacity: 0, y: -8}}
                    transition={{duration: reducedMotion ? 0 : 0.18}}
                  >
                    {view === 'home' && <HomeView />}
                    {view === 'workflow-manager' && <WorkflowManagerView />}
                    {view === 'daily-generator' && <DailyGeneratorView />}
                    {view === 'settings' && <SettingsView />}
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
        isSyncing={isSyncing}
        reducedMotion={reducedMotion}
        language={language}
      />
    </div>
  );
}
