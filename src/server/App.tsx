/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {useDeferredValue, useEffect, useRef, useState} from 'react';
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Check,
  ChevronRight,
  Database,
  FileSpreadsheet,
  LayoutDashboard,
  Menu,
  Moon,
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
type StepState = 'complete' | 'current' | 'upcoming';
type WorkflowStep = {
  label: string;
  detail: string;
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
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

const VIEW_LABELS: Record<View, string> = {
  home: 'Home',
  'workflow-manager': 'Workflow',
  'daily-generator': 'Daily Generator',
  settings: 'Settings',
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

const RowToggle = ({
  label,
  active,
  tone,
  onClick,
}: {
  label: string;
  active: boolean;
  tone: 'success' | 'warning';
  onClick: () => void;
}) => {
  const activeClasses =
    tone === 'success'
      ? 'bg-emerald-500 text-white shadow-[0_12px_24px_rgba(16,185,129,0.28)]'
      : 'bg-amber-500 text-white shadow-[0_12px_24px_rgba(245,158,11,0.24)]';
  const idleClasses =
    tone === 'success'
      ? 'bg-white/80 text-[var(--text-secondary)] hover:bg-emerald-50 hover:text-emerald-700 dark:bg-white/6 dark:hover:bg-emerald-950/30 dark:hover:text-emerald-200'
      : 'bg-white/80 text-[var(--text-secondary)] hover:bg-amber-50 hover:text-amber-700 dark:bg-white/6 dark:hover:bg-amber-950/30 dark:hover:text-amber-200';

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${active ? activeClasses : idleClasses}`}
    >
      {active && <Check size={12} />}
      {label}
    </button>
  );
};

const ActivityDrawer = ({
  open,
  onClose,
  logs,
  status,
  isSyncing,
  reducedMotion,
}: {
  open: boolean;
  onClose: () => void;
  logs: LogEntry[];
  status: string;
  isSyncing: boolean;
  reducedMotion: boolean;
}) => (
  <AnimatePresence>
    {open && (
      <>
        <motion.button
          aria-label="Close activity panel"
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
                <p className="text-sm font-medium text-[var(--text-tertiary)]">Activity</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-[-0.03em]">Recent updates</h2>
              </div>
              <button onClick={onClose} className="icon-button" aria-label="Close">
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
                  No recent activity.
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
                        <p className="text-sm font-medium text-[var(--text-primary)]">{log.message}</p>
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

  const [view, setView] = useState<View>('home');
  const [theme, setTheme] = useState<Theme>('light');
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (embedMode || typeof window === 'undefined') return false;
    return window.innerWidth >= 1024;
  });
  const [activityOpen, setActivityOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      timestamp: '06:31:23',
      message: embedMode ? 'Embed share view initialized.' : 'Application initialized.',
      type: 'info',
    },
    {timestamp: '06:31:25', message: 'Connected to Notion API.', type: 'success'},
  ]);
  const [status, setStatus] = useState('Ready');
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

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString('en-GB', {hour12: false});
    setLogs((prev) => [...prev, {timestamp, message, type}]);
  };

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
        addLog(`Download triggered: ${filename}`, 'success');
        return;
      }

      replaceDownloadArtifact(artifact);
      addLog('Processed workbook ready for download.', 'success');
    } catch (error: any) {
      addLog(`Error creating download link: ${error.message}`, 'error');
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement> | null, manualFile?: File) => {
    const file = manualFile || (event?.target as HTMLInputElement)?.files?.[0];
    if (!file) return;

    if (!manualFile) {
      setFileHandle(null);
    }

    setIsSyncing(true);
    setStatus('Uploading workbook');

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
      addLog(`Workbook uploaded: ${data.filename}`, 'success');
      setStatus('Workbook ready');
    } catch (error) {
      addLog(`Upload error: ${error}`, 'error');
      setStatus('Upload failed');
    } finally {
      setIsSyncing(false);
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
        addLog(`Direct file access enabled for ${file.name}`, 'success');
        handleFileChange(null, file);
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          addLog(`File picker error: ${error.message}. Falling back.`, 'warning');
          fileInputRef.current?.click();
        }
      }
      return;
    }

    setFileHandle(null);
    addLog('Using the standard file picker for compatibility.', 'info');
    fileInputRef.current?.click();
  };

  const toggleTheme = () => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

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
        addLog(`Error loading calendar pages: ${error}`, 'error');
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
      setStatus('Loading workbook');
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
        setStatus('Review ready');
        addLog(`Loaded ${data.length} products from ${selectedFile}`, 'success');
      } catch (error) {
        addLog(`Error loading products: ${error}`, 'error');
        setStatus('Review loaded with sample data');
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
    setStatus('Syncing to Notion');
    addLog(`Starting sync for ${selectedCalendar.title}`, 'info');

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
          addLog('Writing back to the original workbook.', 'info');
          const writable = await fileHandle.createWritable();
          const binaryStr = atob(data.buffer);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          await writable.write(bytes);
          await writable.close();
          addLog('Original workbook updated in place.', 'success');
        } catch (error: any) {
          addLog(`Direct write error: ${error.message}`, 'error');
          downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
        }
      } else if (data.buffer) {
        downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
      }

      setStatus('Sync complete');
      addLog('Notion sync completed successfully.', 'success');

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
      addLog(`Sync error: ${error}`, 'error');
      setStatus('Sync failed');
    } finally {
      setIsSyncing(false);
      setProgress(0);
    }
  };

  const handleDailyRun = () => {
    if (!dailyCalendar) return;

    setIsSyncing(true);
    setStatus('Running generator');
    addLog(`Generating workflow for ${dailyCalendar.date}`, 'info');

    let nextProgress = 0;
    const interval = setInterval(() => {
      nextProgress += 5;
      setProgress(nextProgress);
      if (nextProgress >= 100) {
        clearInterval(interval);
        setIsSyncing(false);
        setProgress(0);
        setStatus('Daily run complete');
        addLog('Daily workflow generated and synced to Notion.', 'success');
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
      label: 'Choose page',
      detail: selectedCalendar ? selectedCalendar.title : 'Pick a Notion page',
      state: (selectedCalendar ? 'complete' : 'current') as StepState,
    },
    {
      label: 'Upload file',
      detail: selectedFile ?? 'Add the workbook',
      state: (selectedFile ? 'complete' : selectedCalendar ? 'current' : 'upcoming') as StepState,
    },
    {
      label: 'Review',
      detail: products.length ? `${selectedCount} items selected` : 'Check the rows',
      state: (selectedFile ? 'current' : 'upcoming') as StepState,
    },
    {
      label: 'Sync',
      detail: selectedCalendar && selectedFile ? 'Ready when you are' : 'Waiting for setup',
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
  const workflowGridClass = embedMode ? 'grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]' : 'grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]';
  const actionBarClass = embedMode ? 'sticky bottom-3 z-10 pt-3' : 'sticky bottom-4 z-10 pt-4';

  const HomeView = () => (
    <div className={pageStackClass}>
      <Panel strong className={heroPanelClass}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(255,255,255,0.7),transparent_38%)] dark:bg-[radial-gradient(circle_at_top_right,rgba(96,165,250,0.16),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(148,163,184,0.08),transparent_40%)]" />
        <div className={heroCopyClass}>
          <div className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] shadow-sm dark:border-white/10 dark:bg-white/6">
            <LayoutDashboard size={14} />
            Painting Team
          </div>
          <div className="space-y-4">
            <h1 className={heroTitleClass}>
              Quiet control for the daily plan.
            </h1>
            <p className={heroBodyClass}>
              Review the workbook, keep only the context that matters, and sync to Notion without the dashboard noise.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button onClick={() => setView('workflow-manager')} className="primary-button">
              Start workflow
              <ArrowRight size={18} />
            </button>
            <button onClick={() => setView('daily-generator')} className="secondary-button">
              Daily generator
            </button>
            <button onClick={() => setActivityOpen(true)} className="secondary-button">
              Recent activity
            </button>
          </div>

          <div className="flex flex-wrap gap-3 pt-2">
            <div className="status-pill">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              Notion connected
            </div>
            <div className="status-pill">
              <Calendar size={14} />
              {selectedCalendar ? selectedCalendar.title : 'No page selected'}
            </div>
            <div className="status-pill">
              <FileSpreadsheet size={14} />
              {selectedFile ?? 'No workbook selected'}
            </div>
          </div>
        </div>
      </Panel>

      <div className={embedHomeGridClass}>
        <Panel className="p-6 md:p-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Continue</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Workflow manager</h2>
              <p className="mt-2 max-w-md text-sm text-[var(--text-secondary)]">
                Pick up the current sync with one page, one workbook, and one clear next step.
              </p>
            </div>
            <button onClick={() => setView('workflow-manager')} className="secondary-button">
              {selectedCalendar || selectedFile ? 'Resume' : 'Open'}
            </button>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Page</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {selectedCalendar?.title ?? 'Choose a page'}
              </p>
            </div>
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Workbook</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">
                {selectedFile ?? 'Choose a file'}
              </p>
            </div>
            <div className="rounded-[24px] border border-[color:var(--line)] bg-white/60 p-5 dark:bg-white/4">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Ready</p>
              <p className="mt-3 text-base font-medium text-[var(--text-primary)]">{selectedCount} selected rows</p>
            </div>
          </div>
        </Panel>

        <Panel className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Recent</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Latest updates</h2>
            </div>
            <button onClick={() => setActivityOpen(true)} className="secondary-button">
              Open
            </button>
          </div>

          {downloadArtifact && (
            <div className="mt-6 rounded-[24px] border border-emerald-200 bg-emerald-50/80 p-5 dark:border-emerald-900/60 dark:bg-emerald-950/25">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-200">Processed workbook ready</p>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{downloadArtifact.filename}</p>
              <a
                href={downloadArtifact.url}
                download={downloadArtifact.filename}
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-emerald-700 transition hover:text-emerald-800 dark:text-emerald-200"
              >
                Download workbook
                <ArrowRight size={15} />
              </a>
            </div>
          )}

          <div className="mt-6 space-y-3">
            {recentLogs.map((log, index) => (
              <div key={`${log.timestamp}-${index}`} className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{log.message}</p>
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
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          {!embedMode && (
            <button onClick={() => setView('home')} className="secondary-button">
              Home
            </button>
          )}
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">Workflow</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">Review before you sync.</h1>
            <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
              Choose the page, add the workbook, review the rows, then send one clean update to Notion.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="status-pill">
            <span className={`h-2 w-2 rounded-full ${isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
            {status}
          </div>
        </div>
      </div>

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
            <div key={step.label} className={`rounded-[24px] border px-4 py-4 transition-all ${stateClasses[step.state]}`}>
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
                  <p className="text-sm font-semibold">{step.label}</p>
                  <p className={`text-xs ${step.state === 'complete' ? 'text-white/72 dark:text-slate-700' : 'text-[var(--text-secondary)]'}`}>
                    {step.detail}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className={workflowGridClass}>
        <div className="space-y-6">
          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">1. Choose page</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Calendar</h2>
            </div>

            <div className="space-y-3">
              {calendarPages.length === 0 ? (
                <div className="rounded-[22px] border border-dashed border-[color:var(--line)] px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
                  Loading pages...
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
          </Panel>

          <Panel className="p-6">
            <div className="mb-5">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">2. Upload file</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Workbook</h2>
            </div>

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
                    {selectedFile ?? 'Choose Excel file'}
                  </p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {selectedFile ? 'Tap to replace the current workbook.' : 'One workbook at a time.'}
                  </p>
                </div>
              </div>
            </button>

            {(embedMode || iosDevice) && (
              <div className="mt-4 flex items-start gap-3 rounded-[22px] border border-[color:var(--line)] bg-white/45 px-4 py-3 text-sm text-[var(--text-secondary)] dark:bg-white/4">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <p>Embedded and iPad views use manual download after sync.</p>
              </div>
            )}
          </Panel>
        </div>

        <Panel className="p-6 md:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">3. Review</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Products</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {products.length ? `${selectedCount} rows selected for sync.` : 'Load a workbook to review the rows.'}
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
                    placeholder="Search parts"
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
                  {products.every((product) => product.selected) && products.length > 0 ? 'Clear all' : 'Select all'}
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
                <h3 className="text-xl font-semibold tracking-[-0.03em]">Start with a page and a workbook</h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  The review stays quiet until the essentials are ready.
                </p>
              </div>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="mt-8 flex min-h-[320px] items-center justify-center rounded-[28px] border border-dashed border-[color:var(--line)] bg-white/36 px-6 text-center dark:bg-white/3">
              <div className="max-w-sm space-y-3">
                <h3 className="text-xl font-semibold tracking-[-0.03em]">No matching rows</h3>
                <p className="text-sm text-[var(--text-secondary)]">Try a different search term or clear the filter.</p>
              </div>
            </div>
          ) : (
            <div className="mt-8 space-y-5">
              {groupedProducts.map(([color, items]) => {
                const groupSelected = items.filter((item) => item.selected).length;
                return (
                  <div key={color} className="rounded-[28px] border border-[color:var(--line)] bg-white/46 p-4 dark:bg-white/4">
                    <div className="flex items-center justify-between gap-4 px-2 pb-4">
                      <div>
                        <p className="text-sm font-medium text-[var(--text-tertiary)]">{color}</p>
                        <h3 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
                          {items.length} parts
                        </h3>
                      </div>
                      <div className="status-pill">{groupSelected} selected</div>
                    </div>

                    <div className="space-y-3">
                      {items.map((product) => (
                        <div
                          key={product.id}
                          className={`rounded-[24px] border px-4 py-4 transition-all ${
                            product.selected
                              ? 'border-sky-200 bg-sky-50/80 shadow-[0_14px_30px_rgba(59,130,246,0.12)] dark:border-sky-900/50 dark:bg-sky-950/24'
                              : 'border-[color:var(--line)] bg-white/72 dark:bg-white/4'
                          }`}
                        >
                          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                            <div className="flex min-w-0 items-start gap-4">
                              <button
                                onClick={() =>
                                  setProducts((prev) =>
                                    prev.map((item) =>
                                      item.id === product.id ? {...item, selected: !item.selected} : item,
                                    ),
                                  )
                                }
                                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all ${
                                  product.selected
                                    ? 'bg-sky-600 text-white shadow-[0_12px_24px_rgba(59,130,246,0.24)]'
                                    : 'border border-[color:var(--line)] bg-white/90 text-transparent dark:bg-white/6'
                                }`}
                                aria-label={`Toggle ${product.part}`}
                              >
                                <Check size={16} strokeWidth={3} />
                              </button>

                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  {product.trial && (
                                    <span className="rounded-full bg-rose-100 px-2 py-1 text-[11px] font-medium text-rose-700 dark:bg-rose-950/30 dark:text-rose-200">
                                      {product.trial}
                                    </span>
                                  )}
                                  <h4 className="text-base font-medium text-[var(--text-primary)]">{product.part}</h4>
                                </div>
                                <p className="mt-2 text-sm text-[var(--text-secondary)]">
                                  Qty {product.qty} • C/T {product.ct}s • {product.date}
                                </p>
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 md:justify-end">
                              <RowToggle
                                label="Mark"
                                tone="success"
                                active={product.colorAccent}
                                onClick={() =>
                                  setProducts((prev) =>
                                    prev.map((item) =>
                                      item.id === product.id
                                        ? {...item, colorAccent: !item.colorAccent}
                                        : item,
                                    ),
                                  )
                                }
                              />
                              <RowToggle
                                label="Replace"
                                tone="warning"
                                active={product.override}
                                onClick={() =>
                                  setProducts((prev) =>
                                    prev.map((item) =>
                                      item.id === product.id ? {...item, override: !item.override} : item,
                                    ),
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
      </div>

      <div className={actionBarClass}>
        <div className="glass-toolbar rounded-[30px] p-4 md:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="grid gap-3 md:grid-cols-3 xl:flex-1">
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">Page</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">
                  {selectedCalendar?.title ?? 'Choose a page'}
                </p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">Workbook</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{selectedFile ?? 'Choose a file'}</p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/56 px-4 py-3 dark:bg-white/5">
                <p className="text-xs font-medium text-[var(--text-tertiary)]">Selection</p>
                <p className="mt-1 text-sm font-medium text-[var(--text-primary)]">{selectedCount} ready to sync</p>
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
                  Download workbook
                </a>
              )}
              <button
                onClick={handleSync}
                disabled={!selectedCalendar || !selectedFile || isSyncing}
                className="primary-button justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              >
                {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />}
                Sync to Notion
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
        {!embedMode && (
          <button onClick={() => setView('home')} className="secondary-button">
            Home
          </button>
        )}
        <div>
          <p className="text-sm font-medium text-[var(--text-tertiary)]">Daily Generator</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">Run the daily plan in one pass.</h1>
          <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
            Choose the target date, keep the defaults, and let the generator prepare the Notion update.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Panel className="p-6">
          <div className="mb-5">
            <p className="text-sm font-medium text-[var(--text-tertiary)]">Date</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Choose a target</h2>
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
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Run</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Automation</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                Highlights stay on. Duplicate rows stay out.
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/58 px-4 py-4 dark:bg-white/6">
                <p className="text-sm font-medium text-[var(--text-primary)]">Auto-highlight workbook</p>
              </div>
              <div className="rounded-[22px] border border-[color:var(--line)] bg-white/58 px-4 py-4 dark:bg-white/6">
                <p className="text-sm font-medium text-[var(--text-primary)]">Skip highlighted rows</p>
              </div>
            </div>

            <button
              onClick={handleDailyRun}
              disabled={!dailyCalendar || isSyncing}
              className="primary-button w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            >
              {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <Play size={18} />}
              Run generator
            </button>
          </div>
        </Panel>
      </div>

      {isSyncing && (
        <Panel className="p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-[var(--text-tertiary)]">Progress</p>
              <h3 className="mt-1 text-xl font-semibold tracking-[-0.03em]">Processing workbook</h3>
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
      <div>
        <p className="text-sm font-medium text-[var(--text-tertiary)]">Settings</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-[-0.05em] md:text-5xl">Quiet defaults, simple controls.</h1>
        <p className="mt-3 max-w-2xl text-base text-[var(--text-secondary)]">
          Keep the connection visible and the interface comfortable.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel className="p-6">
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">Connection</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Notion</h2>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
              <p className="text-xs font-medium text-[var(--text-tertiary)]">Integration token</p>
              <p className="mt-2 text-sm text-[var(--text-primary)]">secret_xxxxxxxxxxxxxxxx</p>
            </div>
            <div className="rounded-[22px] border border-[color:var(--line)] bg-white/55 px-4 py-4 dark:bg-white/4">
              <p className="text-xs font-medium text-[var(--text-tertiary)]">Calendar database</p>
              <p className="mt-2 text-sm text-[var(--text-primary)]">db_xxxxxxxxxxxxxxxx</p>
            </div>
          </div>
        </Panel>

        <Panel className="p-6">
          <div>
            <p className="text-sm font-medium text-[var(--text-tertiary)]">Appearance</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-[-0.04em]">Display</h2>
          </div>

          <div className="mt-6 rounded-[24px] border border-[color:var(--line)] bg-white/55 px-5 py-5 dark:bg-white/4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-medium text-[var(--text-primary)]">Dark mode</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">Switch the workspace tone.</p>
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
                  aria-label="Close sidebar"
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
                          <p className="text-base font-semibold tracking-[-0.03em]">Painting Team</p>
                          <p className="text-sm text-[var(--text-secondary)]">Workflow utilities</p>
                        </div>
                      </div>
                    </div>

                    <nav className="mt-6 space-y-2">
                      <NavItem icon={LayoutDashboard} label="Home" active={view === 'home'} onClick={() => setView('home')} />
                      <NavItem
                        icon={RefreshCw}
                        label="Workflow"
                        active={view === 'workflow-manager'}
                        onClick={() => setView('workflow-manager')}
                      />
                      <NavItem
                        icon={Play}
                        label="Daily Generator"
                        active={view === 'daily-generator'}
                        onClick={() => setView('daily-generator')}
                      />
                      <NavItem
                        icon={Settings}
                        label="Settings"
                        active={view === 'settings'}
                        onClick={() => setView('settings')}
                      />
                    </nav>

                    <div className="mt-auto rounded-[24px] border border-[color:var(--line)] bg-white/55 p-4 dark:bg-white/4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-[18px] bg-emerald-500 text-white">
                          <Database size={18} />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">Notion connected</p>
                          <p className="text-sm text-[var(--text-secondary)]">{status}</p>
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
                  <button onClick={() => setSidebarOpen((prev) => !prev)} className="icon-button" aria-label="Toggle sidebar">
                    {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
                  </button>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <span>Painting Team</span>
                    <ChevronRight size={14} />
                    <span className="truncate text-[var(--text-primary)]">{VIEW_LABELS[view]}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="hidden items-center gap-2 rounded-full border border-[color:var(--line)] bg-white/55 px-3 py-1.5 text-sm text-[var(--text-secondary)] dark:bg-white/5 md:flex">
                  <span className={`h-2 w-2 rounded-full ${isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                  {status}
                </div>
                <button onClick={() => setActivityOpen(true)} className="secondary-button hidden md:inline-flex">
                  Activity
                </button>
                <button onClick={toggleTheme} className="icon-button" aria-label="Toggle theme">
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
                  {view === 'home' && <HomeView />}
                  {view === 'workflow-manager' && <WorkflowManagerView />}
                  {view === 'daily-generator' && <DailyGeneratorView />}
                  {view === 'settings' && <SettingsView />}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </main>
      </div>

      <ActivityDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        logs={logs}
        status={status}
        isSyncing={isSyncing}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}
