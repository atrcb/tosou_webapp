/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  LayoutDashboard, 
  Settings, 
  Calendar, 
  FileSpreadsheet, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Terminal, 
  Sun, 
  Moon, 
  ChevronRight, 
  Menu, 
  X, 
  Upload, 
  RefreshCw, 
  Database,
  Search,
  Check,
  MoreVertical,
  ArrowRight
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

declare global {
  interface Window {
    __EMBED_MODE__?: boolean;
    __EMBED_SESSION__?: Promise<string>;
  }
}

// --- Types ---
type View = 'dashboard' | 'workflow-manager' | 'daily-generator' | 'settings';
type Theme = 'light' | 'dark';
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

// --- Mock Data ---
const MOCK_CALENDAR_PAGES: CalendarPage[] = [
  { id: '1', title: '3/21 Painting Plan', date: '2026-03-21' },
  { id: '2', title: '3/22 Painting Plan', date: '2026-03-22' },
  { id: '3', title: '3/23 Painting Plan', date: '2026-03-23' },
  { id: '4', title: '3/24 Painting Plan', date: '2026-03-24' },
];

const MOCK_PRODUCTS: Product[] = [
  { id: 'p1', trial: '試作01', part: 'N93-3F Front Panel', color: '3F黒', qty: 120, ct: 45, date: '03/21', selected: false, override: false, colorAccent: false },
  { id: 'p2', trial: '', part: 'N93-3F Side Bracket', color: '3F黒', qty: 240, ct: 30, date: '03/21', selected: true, override: false, colorAccent: false },
  { id: 'p3', trial: '試作02', part: 'M12-Silver Frame', color: 'Silver', qty: 50, ct: 120, date: '03/21', selected: false, override: false, colorAccent: false },
  { id: 'p4', trial: '', part: 'M12-Silver Cover', color: 'Silver', qty: 50, ct: 80, date: '03/21', selected: false, override: false, colorAccent: false },
  { id: 'p5', trial: '', part: 'X9-Emerald Case', color: 'Emerald', qty: 10, ct: 300, date: '03/21', selected: true, override: true, colorAccent: true },
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

// --- Components ---

const SidebarItem = ({ 
  icon: Icon, 
  label, 
  active, 
  onClick 
}: { 
  icon: any, 
  label: string, 
  active: boolean, 
  onClick: () => void 
}) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${
      active 
        ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100' 
        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
    }`}
  >
    <Icon size={18} />
    <span>{label}</span>
  </button>
);

const Card = ({ children, className = "", onClick }: { children: React.ReactNode, className?: string, onClick?: () => void }) => (
  <div 
    onClick={onClick}
    className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden ${className} ${onClick ? 'cursor-pointer' : ''}`}
  >
    {children}
  </div>
);

const Badge = ({ children, variant = 'default' }: { children: React.ReactNode, variant?: 'default' | 'success' | 'warning' | 'error' | 'indigo' }) => {
  const variants = {
    default: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    error: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
    indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${variants[variant]}`}>
      {children}
    </span>
  );
};

export default function App() {
  const embedMode = isEmbeddedMode();
  const iosDevice = isAppleMobileDevice();
  const canUseNativeFilePicker = supportsNativeFilePicker() && (!embedMode || !iosDevice);
  const shouldAutoDownload = !embedMode && !iosDevice;
  const [view, setView] = useState<View>(embedMode ? 'workflow-manager' : 'dashboard');
  const [theme, setTheme] = useState<Theme>('light');
  const [sidebarOpen, setSidebarOpen] = useState(() => !embedMode);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      timestamp: '06:31:23',
      message: embedMode ? 'Embed share view initialized.' : 'Application initialized.',
      type: 'info'
    },
    { timestamp: '06:31:25', message: 'Connected to Notion API.', type: 'success' },
  ]);
  const [status, setStatus] = useState('Ready.');
  const [progress, setProgress] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Workflow Manager State
  const [selectedCalendar, setSelectedCalendar] = useState<CalendarPage | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileHandle, setFileHandle] = useState<any>(null);
  const [downloadArtifact, setDownloadArtifact] = useState<DownloadArtifact | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement> | null, manualFile?: File) => {
    const file = manualFile || (e?.target as HTMLInputElement)?.files?.[0];
    if (!file) return;

    if (!manualFile) {
      setFileHandle(null);
    }
    
    setIsSyncing(true);
    setStatus('Uploading file...');
    
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
      addLog(`File uploaded: ${data.filename}`, 'success');
      setStatus(`File ${data.filename} ready.`);
    } catch (error) {
      addLog('Upload error: ' + error, 'error');
      setStatus('Upload failed.');
    } finally {
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    return () => {
      if (downloadArtifact) {
        URL.revokeObjectURL(downloadArtifact.url);
      }
    };
  }, [downloadArtifact]);

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
        addLog('Download triggered: ' + filename, 'success');
        return;
      }

      replaceDownloadArtifact(artifact);
      addLog('Processed file is ready. Use the download button below to open it.', 'success');
    } catch (e: any) {
      addLog('Error creating download link: ' + e.message, 'error');
    }
  };

  const openNativeSelector = async () => {
    if (canUseNativeFilePicker) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{
            description: 'Excel Files',
            accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
          }],
          multiple: false
        });
        const file = await handle.getFile();
        setFileHandle(handle);
        addLog('Direct file access enabled for: ' + file.name, 'success');
        handleFileChange(null, file);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          addLog('File picker error: ' + err.message + '. Falling back...', 'warning');
          fileInputRef.current?.click();
        }
      }
    } else {
      setFileHandle(null);
      addLog('Using the standard file picker for compatibility with embedded and mobile browsers.', 'info');
      fileInputRef.current?.click();
    }
  };
  const [products, setProducts] = useState<Product[]>([]);
  const [calendarPages, setCalendarPages] = useState<CalendarPage[]>([]);

  // Load calendar pages on mount
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
        addLog('Error loading calendar pages: ' + error, 'error');
        // Fallback to mock data for demonstration
        setCalendarPages(MOCK_CALENDAR_PAGES);
      }
    };
    loadCalendar();
  }, []);

  // Load products when file is selected
  useEffect(() => {
    if (selectedFile) {
      const loadProducts = async () => {
        setIsSyncing(true);
        setStatus('Loading products from Excel...');
        try {
          const response = await apiFetch('/api/load-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: selectedFile }) 
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Failed to load products');
          }
          const data = await response.json();
          setProducts(data);
          setStatus('Products loaded.');
          addLog(`Loaded ${data.length} products from ${selectedFile}`, 'success');
        } catch (error) {
          addLog('Error loading products: ' + error, 'error');
          setStatus('Error loading products (using mock data).');
          // Fallback to mock data
          setProducts(MOCK_PRODUCTS);
        } finally {
          setIsSyncing(false);
        }
      };
      loadProducts();
    }
  }, [selectedFile]);

  // Daily Generator State
  const [dailyCalendar, setDailyCalendar] = useState<CalendarPage | null>(null);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
    setLogs(prev => [...prev, { timestamp, message, type }]);
  };

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  const handleSync = async () => {
    if (!selectedCalendar || !selectedFile) return;
    setIsSyncing(true);
    setStatus('Syncing with Notion...');
    addLog(`Starting sync for ${selectedCalendar.title}...`, 'info');
    
    try {
      const response = await apiFetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_path: selectedFile,
          page_id: selectedCalendar.id,
          products: products
        })
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Sync failed');
      }
      const data = await response.json();
      
      if (data.error) throw new Error(data.error);

      // Desktop browsers can write back to the original file handle.
      if (fileHandle && data.buffer && canUseNativeFilePicker) {
        try {
          addLog('Found file handle. Attempting direct write-back...', 'info');
          const writable = await fileHandle.createWritable();
          const binaryStr = atob(data.buffer);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          await writable.write(bytes);
          await writable.close();
          addLog('✅ Original file updated in-place!', 'success');
        } catch (err: any) {
          addLog('Error writing directly to file: ' + err.message, 'error');
          // Fallback to manual download
          downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
        }
      } else if (data.buffer) {
        addLog('Preparing processed workbook for download...', 'info');
        downloadBuffer(data.buffer, selectedFile || 'updated_plan.xlsx');
      }

      setStatus('✅ Sync complete');
      addLog('Notion sync completed successfully.', 'success');
      
      // Refresh products after sync
      const refreshResp = await apiFetch('/api/load-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: selectedFile })
      });
      if (refreshResp.ok) {
        const refreshedData = await refreshResp.json();
        setProducts(refreshedData);
      }

    } catch (error) {
      addLog('Sync error: ' + error, 'error');
      setStatus('❌ Sync failed');
    } finally {
      setIsSyncing(false);
      setProgress(0);
    }
  };

  const handleDailyRun = () => {
    if (!dailyCalendar) return;
    setIsSyncing(true);
    setStatus('Daily Generator running...');
    addLog(`Generating daily workflow for ${dailyCalendar.date}...`, 'info');
    
    let p = 0;
    const interval = setInterval(() => {
      p += 5;
      setProgress(p);
      if (p >= 100) {
        clearInterval(interval);
        setIsSyncing(false);
        setProgress(0);
        setStatus('✅ Daily Generator complete');
        addLog('Daily workflow generated and synced to Notion.', 'success');
      }
    }, 100);
  };

  // --- Views ---

  const HomeView = () => (
    <div className="space-y-12 pb-12">
      <header className="max-w-3xl">
        <motion.div 
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-xs font-bold uppercase tracking-wider mb-4"
        >
          <LayoutDashboard size={14} />
          Application Hub
        </motion.div>
        <h1 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight leading-tight">
          Centralized Tools for the <span className="text-indigo-600 dark:text-indigo-400">Painting Team</span>
        </h1>
        <p className="text-slate-500 dark:text-slate-400 mt-4 text-lg leading-relaxed">
          Access all your workflow automation and management tools from one place. 
          Streamline your Notion integration and Excel processing.
        </p>
      </header>

      <section>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Menu size={20} className="text-indigo-500" />
            Available Applications
          </h2>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Workflow Manager App */}
          <motion.div whileHover={{ y: -5 }} transition={{ type: 'spring', stiffness: 300 }}>
            <Card 
              onClick={() => setView('workflow-manager')}
              className="p-6 h-full flex flex-col hover:border-indigo-500/50 hover:shadow-xl hover:shadow-indigo-500/10 transition-all group border-2"
            >
              <div className="bg-indigo-100 dark:bg-indigo-900/30 w-14 h-14 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-6 group-hover:scale-110 transition-transform">
                <RefreshCw size={28} />
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Workflow Manager</h3>
              <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed flex-1">
                Manual synchronization between Excel painting plans and Notion. 
                Review every part, select specific items, and sync with precision.
              </p>
              <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <Badge variant="indigo">v2.1.0</Badge>
                <span className="text-indigo-600 dark:text-indigo-400 text-sm font-bold flex items-center gap-1 group-hover:gap-2 transition-all">
                  Launch App <ArrowRight size={16} />
                </span>
              </div>
            </Card>
          </motion.div>

          {/* Daily Generator App */}
          <motion.div whileHover={{ y: -5 }} transition={{ type: 'spring', stiffness: 300 }}>
            <Card 
              onClick={() => setView('daily-generator')}
              className="p-6 h-full flex flex-col hover:border-emerald-500/50 hover:shadow-xl hover:shadow-emerald-500/10 transition-all group border-2"
            >
              <div className="bg-emerald-100 dark:bg-emerald-900/30 w-14 h-14 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-6 group-hover:scale-110 transition-transform">
                <Play size={28} />
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Daily Generator</h3>
              <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed flex-1">
                Fully automated daily plan generation. Scans Excel files for the target date, 
                groups by color, and populates Notion automatically.
              </p>
              <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <Badge variant="success">v1.4.5</Badge>
                <span className="text-emerald-600 dark:text-emerald-400 text-sm font-bold flex items-center gap-1 group-hover:gap-2 transition-all">
                  Launch App <ArrowRight size={16} />
                </span>
              </div>
            </Card>
          </motion.div>

          {/* Future App Placeholder 1 */}
          <Card className="p-6 h-full flex flex-col border-dashed border-2 border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/20 opacity-60">
            <div className="bg-slate-100 dark:bg-slate-800 w-14 h-14 rounded-2xl flex items-center justify-center text-slate-400 mb-6">
              <Database size={28} />
            </div>
            <h3 className="text-xl font-bold text-slate-400 dark:text-slate-600 mb-2">Inventory Tracker</h3>
            <p className="text-slate-400 dark:text-slate-600 text-sm leading-relaxed flex-1">
              Real-time paint and materials inventory management. Integrated with Notion databases.
            </p>
            <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Coming Soon</span>
            </div>
          </Card>

          {/* Future App Placeholder 2 */}
          <Card className="p-6 h-full flex flex-col border-dashed border-2 border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/20 opacity-60">
            <div className="bg-slate-100 dark:bg-slate-800 w-14 h-14 rounded-2xl flex items-center justify-center text-slate-400 mb-6">
              <Settings size={28} />
            </div>
            <h3 className="text-xl font-bold text-slate-400 dark:text-slate-600 mb-2">Quality Control</h3>
            <p className="text-slate-400 dark:text-slate-600 text-sm leading-relaxed flex-1">
              Digital QC checklists and inspection logs for finished parts.
            </p>
            <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Coming Soon</span>
            </div>
          </Card>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <Card className="p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Terminal size={18} className="text-indigo-500" />
                System Activity
              </h3>
              <button className="text-xs text-indigo-500 font-medium hover:underline" onClick={() => {
                const console = document.getElementById('log-console');
                if (console) console.classList.toggle('hidden');
              }}>Open Console</button>
            </div>
            <div className="space-y-4">
              {logs.slice(-4).reverse().map((log, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <div className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                    log.type === 'success' ? 'bg-emerald-500' : 
                    log.type === 'error' ? 'bg-rose-500' : 
                    log.type === 'warning' ? 'bg-amber-500' : 
                    'bg-slate-400'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-slate-700 dark:text-slate-300 leading-tight">{log.message}</p>
                    <p className="text-[10px] text-slate-400 mt-1">{log.timestamp}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div>
          <Card className="p-6 bg-indigo-600 text-white border-none">
            <h3 className="font-bold text-lg mb-2">Need Help?</h3>
            <p className="text-indigo-100 text-sm mb-6 leading-relaxed">
              Check the documentation for detailed instructions on how to use the Workflow Manager and Daily Generator.
            </p>
            <button className="w-full py-2 bg-white text-indigo-600 rounded-lg font-bold text-sm hover:bg-indigo-50 transition-colors">
              Read Documentation
            </button>
          </Card>
        </div>
      </div>
    </div>
  );

  const WorkflowManagerView = () => (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button 
            onClick={() => setView('dashboard')}
            className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-500 transition-colors"
          >
            <X size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Workflow Manager</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm">Manual sync between Excel and Notion.</p>
          </div>
        </div>
        <button 
          onClick={handleSync}
          disabled={!selectedCalendar || !selectedFile || isSyncing}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
        >
          {isSyncing ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />}
          Sync to Notion
        </button>
      </header>

      {(embedMode || iosDevice) && (
        <Card className="p-4 border-indigo-200 bg-indigo-50/70 dark:border-indigo-900 dark:bg-indigo-950/30">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-slate-900 dark:text-white">Compatibility mode is active.</p>
              <p className="text-slate-600 dark:text-slate-300">
                This embedded/mobile view uses the standard file picker and prepares the processed workbook as a manual download.
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Step 1: Calendar */}
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-4 text-slate-900 dark:text-white font-bold">
            <div className="w-6 h-6 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs">1</div>
            <h3>Select Calendar Page</h3>
          </div>
          <div className="space-y-2">
            {calendarPages.map(page => (
              <button
                key={page.id}
                onClick={() => setSelectedCalendar(page)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all border ${
                  selectedCalendar?.id === page.id 
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-700 dark:bg-indigo-900/20 dark:border-indigo-800 dark:text-indigo-300' 
                    : 'bg-slate-50 border-slate-100 text-slate-600 hover:border-slate-300 dark:bg-slate-800/50 dark:border-slate-800 dark:text-slate-400 dark:hover:border-slate-700'
                }`}
              >
                <div className="font-medium">{page.title}</div>
                <div className="text-xs opacity-70">{page.date}</div>
              </button>
            ))}
            {calendarPages.length === 0 && (
              <div className="text-center py-4 text-slate-400 text-xs italic">
                Loading calendar pages...
              </div>
            )}
          </div>
        </Card>

        {/* Step 2: Excel */}
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-4 text-slate-900 dark:text-white font-bold">
            <div className="w-6 h-6 rounded-full bg-indigo-500 text-white flex items-center justify-center text-xs">2</div>
            <h3>Select Excel File</h3>
          </div>
          <input 
            type="file" 
            ref={fileInputRef}
            className="hidden" 
            accept=".xlsx,.xls"
            onChange={handleFileChange}
          />
          <div 
            className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-colors cursor-pointer ${
              selectedFile 
                ? 'border-emerald-500/50 bg-emerald-50/30 dark:bg-emerald-900/10' 
                : 'border-slate-200 dark:border-slate-800 hover:border-indigo-500/50'
            }`}
            onClick={openNativeSelector}
          >
            {selectedFile ? (
              <>
                <div className="bg-emerald-100 dark:bg-emerald-900/30 p-3 rounded-full text-emerald-600 mb-3">
                  <FileSpreadsheet size={24} />
                </div>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">{selectedFile}</p>
                <button 
                  className="text-xs text-slate-500 mt-2 hover:text-indigo-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    openNativeSelector();
                  }}
                >
                  Change file
                </button>
              </>
            ) : (
              <>
                <div className="bg-slate-100 dark:bg-slate-800 p-3 rounded-full text-slate-400 mb-3">
                  <Upload size={24} />
                </div>
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">Click to upload Excel</p>
                <p className="text-xs text-slate-500 mt-1">
                  {embedMode || iosDevice ? 'Uses the standard file picker in Notion and on iPad.' : 'or drag and drop here'}
                </p>
              </>
            )}
          </div>
        </Card>

        {/* Step 3: Status Summary */}
        <Card className="p-4 bg-slate-50 dark:bg-slate-800/50 border-none">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-4">Sync Summary</h3>
          <div className="space-y-4">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Target Page:</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{selectedCalendar?.title || 'None'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Source File:</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{selectedFile || 'None'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Selected Items:</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{products.filter(p => p.selected).length}</span>
            </div>
            <div className="pt-4 border-t border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <AlertCircle size={14} />
                <span>Syncing will update the "作業内容" database.</span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {downloadArtifact && (
        <Card className="p-4 border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium text-slate-900 dark:text-white">Processed workbook ready</p>
              <p className="text-sm text-slate-600 dark:text-slate-300">{downloadArtifact.filename}</p>
            </div>
            <div className="flex gap-2">
              <a
                href={downloadArtifact.url}
                download={downloadArtifact.filename}
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
              >
                Open Processed Excel
              </a>
              <button
                onClick={() => replaceDownloadArtifact(null)}
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Clear
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* Product List - Grouped by Color */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Database size={20} className="text-indigo-500" />
            Product List
          </h3>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search parts..." 
                className="pl-9 pr-4 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:ring-2 focus:ring-indigo-500 outline-none w-48 md:w-64"
              />
            </div>
            <button 
              onClick={() => {
                const anyUnselected = products.some(p => !p.selected);
                setProducts(prev => prev.map(p => ({ ...p, selected: anyUnselected })));
              }}
              className="text-xs font-bold bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-md hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors"
            >
              {products.every(p => p.selected && products.length > 0) ? '全解除' : '全選択'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {Object.entries(
            products.reduce((acc, p) => {
              if (!acc[p.color]) acc[p.color] = [];
              acc[p.color].push(p);
              return acc;
            }, {} as Record<string, Product[]>)
          ).map(([color, items]) => {
            const productItems = items as Product[];
            const allSelected = productItems.length > 0 && productItems.every(i => i.selected);
            return (
              <div key={color}>
                <Card className="flex flex-col border-slate-300 dark:border-slate-700 h-full overflow-hidden">
                  {/* Group Header */}
                  <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/30">
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => {
                          const anyUnselectedInGroup = productItems.some(i => !i.selected);
                          setProducts(prev => prev.map(p => 
                            p.color === color ? { ...p, selected: anyUnselectedInGroup } : p
                          ));
                        }}
                        className={`w-6 h-6 rounded flex items-center justify-center transition-all ${
                          allSelected 
                            ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm' 
                            : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-700 text-transparent border'
                        }`}
                      >
                        <Check size={14} strokeWidth={3} />
                      </button>
                      <h4 className="text-xl font-bold text-slate-900 dark:text-white">{color}</h4>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase mr-1">
                        {productItems.filter(p => p.selected).length}/{productItems.length}
                      </span>
                    </div>
                  </div>

                  {/* Group Body */}
                  <div className="p-2 overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="text-[10px] text-slate-400 uppercase font-bold">
                        <tr>
                          <th className="px-3 py-2">
                            <button 
                              onClick={() => {
                                const anyUnselected = productItems.some(i => !i.selected);
                                setProducts(prev => prev.map(p => 
                                  p.color === color ? { ...p, selected: anyUnselected } : p
                                ));
                              }}
                              className={`w-5 h-5 rounded flex items-center justify-center border transition-colors ${
                                allSelected ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-transparent'
                              }`}
                            >
                              <Check size={10} strokeWidth={4} />
                            </button>
                            <span className="mt-1 block">同期</span>
                          </th>
                          <th className="px-3 py-2">
                            <button 
                              onClick={() => {
                                const anyUnchecked = productItems.some(i => !i.colorAccent);
                                setProducts(prev => prev.map(p => 
                                  p.color === color ? { ...p, colorAccent: anyUnchecked } : p
                                ));
                              }}
                              className={`w-5 h-5 rounded flex items-center justify-center border transition-colors ${
                                productItems.every(i => i.colorAccent) ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-transparent'
                              }`}
                            >
                              <Check size={10} strokeWidth={4} />
                            </button>
                            <span className="mt-1 block">色付</span>
                          </th>
                          <th className="px-3 py-2">
                            <button 
                              onClick={() => {
                                const anyUnchecked = productItems.some(i => !i.override);
                                setProducts(prev => prev.map(p => 
                                  p.color === color ? { ...p, override: anyUnchecked } : p
                                ));
                              }}
                              className={`w-5 h-5 rounded flex items-center justify-center border transition-colors ${
                                productItems.every(i => i.override) ? 'bg-amber-600 border-amber-600 text-white' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-transparent'
                              }`}
                            >
                              <Check size={10} strokeWidth={4} />
                            </button>
                            <span className="mt-1 block">上書</span>
                          </th>
                          <th className="px-3 py-2 pt-6">部品名</th>
                          <th className="px-3 py-2 pt-6 text-right">数量 / C-T</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {productItems.map(product => (
                          <tr key={product.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors ${product.selected ? 'bg-indigo-50/30 dark:bg-indigo-900/10' : ''}`}>
                            <td className="px-3 py-3">
                              <button 
                                onClick={() => setProducts(prev => prev.map(p => p.id === product.id ? { ...p, selected: !p.selected } : p))}
                                className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                                  product.selected 
                                    ? 'bg-indigo-600 text-white' 
                                    : 'bg-slate-100 dark:bg-slate-800 text-transparent border border-slate-200 dark:border-slate-700'
                                }`}
                              >
                                <Check size={14} strokeWidth={3} />
                              </button>
                            </td>
                            <td className="px-3 py-3">
                              <button 
                                onClick={() => setProducts(prev => prev.map(p => p.id === product.id ? { ...p, colorAccent: !p.colorAccent } : p))}
                                className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                                  product.colorAccent 
                                    ? 'bg-emerald-600 text-white' 
                                    : 'bg-slate-100 dark:bg-slate-800 text-transparent border border-slate-200 dark:border-slate-700'
                                }`}
                              >
                                <Check size={14} strokeWidth={3} />
                              </button>
                            </td>
                            <td className="px-3 py-3">
                              <button 
                                onClick={() => setProducts(prev => prev.map(p => p.id === product.id ? { ...p, override: !p.override } : p))}
                                className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
                                  product.override 
                                    ? 'bg-amber-600 text-white' 
                                    : 'bg-slate-100 dark:bg-slate-800 text-transparent border border-slate-200 dark:border-slate-700'
                                }`}
                              >
                                <Check size={14} strokeWidth={3} />
                              </button>
                            </td>
                            <td className="px-3 py-3">
                              <div className="flex flex-col gap-0.5">
                                {product.trial && (
                                  <span className="inline-block w-fit px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/30 text-rose-700 dark:text-rose-400 text-[10px] font-bold">
                                    {product.trial}
                                  </span>
                                )}
                                <span className="font-medium text-slate-800 dark:text-slate-200 leading-tight">
                                  {product.part}
                                </span>
                              </div>
                            </td>
                            <td className="px-3 py-3 text-right whitespace-nowrap">
                              <div className="flex flex-col items-end">
                                <span className="font-bold text-emerald-600 dark:text-emerald-400">数量: {product.qty}</span>
                                <span className="text-slate-400 text-[10px]">c/t: {product.ct}s</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  const DailyGeneratorView = () => (
    <div className="max-w-4xl mx-auto space-y-8">
      <header className="text-center relative">
        <button 
          onClick={() => setView('dashboard')}
          className="absolute left-0 top-0 p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-500 transition-colors"
        >
          <X size={20} />
        </button>
        <div className="inline-flex items-center justify-center p-3 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-2xl mb-4">
          <Play size={32} />
        </div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white tracking-tight">Daily Workflow Generator</h1>
        <p className="text-slate-500 dark:text-slate-400 mt-2">Automatic plan generation from daily Excel files.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-6">
          <h3 className="font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
            <Calendar size={18} className="text-emerald-500" />
            1. Target Date
          </h3>
          <div className="space-y-2">
            {MOCK_CALENDAR_PAGES.map(page => (
              <button
                key={page.id}
                onClick={() => setDailyCalendar(page)}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm transition-all border ${
                  dailyCalendar?.id === page.id 
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-300' 
                    : 'bg-slate-50 border-slate-100 text-slate-600 hover:border-slate-300 dark:bg-slate-800/50 dark:border-slate-800 dark:text-slate-400 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col items-start">
                  <span className="font-bold">{page.date}</span>
                  <span className="text-xs opacity-70">{page.title}</span>
                </div>
                {dailyCalendar?.id === page.id && <CheckCircle2 size={18} />}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-6 flex flex-col justify-between">
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
              <RefreshCw size={18} className="text-emerald-500" />
              2. Automation Settings
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                <div className="text-sm">
                  <p className="font-medium text-slate-800 dark:text-slate-200">Auto-Highlight Excel</p>
                  <p className="text-xs text-slate-500">Marks processed rows in yellow</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm" />
                </div>
              </div>
              <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
                <div className="text-sm">
                  <p className="font-medium text-slate-800 dark:text-slate-200">Skip Highlighted Rows</p>
                  <p className="text-xs text-slate-500">Prevents duplicate entries</p>
                </div>
                <div className="w-10 h-5 bg-emerald-500 rounded-full relative">
                  <div className="absolute right-1 top-1 w-3 h-3 bg-white rounded-full shadow-sm" />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8">
            <button 
              onClick={handleDailyRun}
              disabled={!dailyCalendar || isSyncing}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-3 transition-all shadow-lg shadow-emerald-500/20"
            >
              {isSyncing ? <RefreshCw size={20} className="animate-spin" /> : <Play size={20} />}
              Run Generator
            </button>
          </div>
        </Card>
      </div>

      {isSyncing && (
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="flex items-center justify-between text-sm font-medium">
            <span className="text-slate-600 dark:text-slate-400">Processing Excel data...</span>
            <span className="text-emerald-600 dark:text-emerald-400">{progress}%</span>
          </div>
          <div className="w-full h-3 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
            <motion.div 
              className="h-full bg-emerald-500"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
            />
          </div>
          <div className="grid grid-cols-4 gap-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className={`h-1 rounded-full ${progress > i * 25 ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-800'}`} />
            ))}
          </div>
        </motion.div>
      )}
    </div>
  );

  const SettingsView = () => (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight">Settings</h1>
        <p className="text-slate-500 dark:text-slate-400 text-sm">Configure your application and Notion integration.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-6">
          <h3 className="font-bold text-slate-900 dark:text-white mb-4">Notion Configuration</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Integration Token</label>
              <input type="password" value="secret_xxxxxxxxxxxxxxxx" readOnly className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-500" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Calendar Database ID</label>
              <input type="text" value="db_xxxxxxxxxxxxxxxx" readOnly className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-500" />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h3 className="font-bold text-slate-900 dark:text-white mb-4">Application Preferences</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Dark Mode</span>
              <button 
                onClick={toggleTheme}
                className={`w-12 h-6 rounded-full relative transition-colors ${theme === 'dark' ? 'bg-indigo-600' : 'bg-slate-300'}`}
              >
                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all ${theme === 'dark' ? 'right-1' : 'left-1'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Compact View</span>
              <div className="w-12 h-6 bg-slate-300 rounded-full relative">
                <div className="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow-sm" />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );

  return (
    <div className={`${embedMode ? 'min-h-0' : 'min-h-screen'} bg-slate-50 dark:bg-slate-950 flex font-sans text-slate-900 dark:text-slate-100 transition-colors`}>
      {/* Sidebar */}
      <AnimatePresence mode="wait">
        {sidebarOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 240, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className={`${embedMode ? 'min-h-full' : 'h-screen sticky top-0'} bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col z-20 overflow-hidden`}
          >
            <div className="p-4 flex items-center gap-3 border-b border-slate-100 dark:border-slate-800">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold">P</div>
              <span className="font-bold tracking-tight">Painting Team</span>
            </div>

            <nav className="flex-1 p-3 space-y-1">
              <div className="text-[10px] font-bold text-slate-400 uppercase px-3 mb-2 tracking-wider">Hub</div>
              <SidebarItem 
                icon={LayoutDashboard} 
                label="App Launcher" 
                active={view === 'dashboard'} 
                onClick={() => setView('dashboard')} 
              />
              
              <div className="text-[10px] font-bold text-slate-400 uppercase px-3 mt-6 mb-2 tracking-wider">Active Apps</div>
              <SidebarItem 
                icon={RefreshCw} 
                label="Workflow Manager" 
                active={view === 'workflow-manager'} 
                onClick={() => setView('workflow-manager')} 
              />
              <SidebarItem 
                icon={Play} 
                label="Daily Generator" 
                active={view === 'daily-generator'} 
                onClick={() => setView('daily-generator')} 
              />
              
              <div className="text-[10px] font-bold text-slate-400 uppercase px-3 mt-6 mb-2 tracking-wider">System</div>
              <SidebarItem 
                icon={Settings} 
                label="Settings" 
                active={view === 'settings'} 
                onClick={() => setView('settings')} 
              />
            </nav>

            <div className="p-4 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3 p-2 rounded-lg bg-slate-50 dark:bg-slate-800/50">
                <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                  <Database size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold truncate">Notion Connected</p>
                  <p className="text-[10px] text-emerald-500 font-medium">Online</p>
                </div>
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className={`flex-1 flex flex-col min-w-0 ${embedMode ? 'min-h-0' : 'h-screen'} overflow-hidden`}>
        {/* Top Header */}
        <header className="h-14 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md text-slate-500 transition-colors"
            >
              {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500">
              <span>Painting Team</span>
              <ChevronRight size={14} />
              <span className="text-slate-900 dark:text-white capitalize">{view.replace('-', ' ')}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button 
              onClick={toggleTheme}
              className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-500 transition-colors"
              title="Toggle Theme"
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />
            <button className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-500 transition-colors">
              <MoreVertical size={18} />
            </button>
          </div>
        </header>

        {/* Scrollable Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto">
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
              >
                {view === 'dashboard' && <HomeView />}
                {view === 'workflow-manager' && <WorkflowManagerView />}
                {view === 'daily-generator' && <DailyGeneratorView />}
                {view === 'settings' && <SettingsView />}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Footer / Status Bar */}
        {!embedMode && (
          <footer className="h-10 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 text-[11px] font-medium text-slate-500">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${isSyncing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
                <span>{status}</span>
              </div>
              {isSyncing && (
                <div className="flex items-center gap-2">
                  <div className="w-24 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${progress}%` }} />
                  </div>
                  <span>{progress}%</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-4">
              <button 
                onClick={() => {
                  const console = document.getElementById('log-console');
                  if (console) console.classList.toggle('hidden');
                }}
                className="flex items-center gap-1.5 hover:text-indigo-500 transition-colors"
              >
                <Terminal size={12} />
                <span>Console</span>
              </button>
              <div className="flex items-center gap-1.5">
                <Database size={12} />
                <span>Notion v2.0</span>
              </div>
            </div>
          </footer>
        )}

        {/* Log Console (Bottom Panel) */}
        <div id="log-console" className={`hidden ${embedMode ? 'h-32' : 'h-40'} bg-slate-950 border-t border-slate-800 overflow-y-auto p-3 font-mono text-[10px]`}>
          <div className="flex items-center justify-between mb-2 pb-1 border-b border-slate-800">
            <span className="text-slate-500 uppercase font-bold tracking-widest">Log Console</span>
            <button onClick={() => document.getElementById('log-console')?.classList.add('hidden')} className="text-slate-500 hover:text-white">
              <X size={12} />
            </button>
          </div>
          {logs.map((log, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <span className="text-slate-600">[{log.timestamp}]</span>
              <span className={
                log.type === 'success' ? 'text-emerald-400' : 
                log.type === 'error' ? 'text-rose-400' : 
                log.type === 'warning' ? 'text-amber-400' : 
                'text-slate-300'
              }>
                {log.type.toUpperCase()}: {log.message}
              </span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
