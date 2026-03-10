'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
type Stage = 'setup' | 'idle' | 'extracting' | 'transcribing' | 'generating' | 'done' | 'error';
type TabKey = 'minutes' | 'advice' | 'outline';

interface Results { minutes: string; advice: string; outline: string; }

const TABS: { key: TabKey; label: string; icon: string; color: string }[] = [
  { key: 'minutes', label: '議事録', icon: '📋', color: 'from-blue-600 to-cyan-600' },
  { key: 'advice', label: '次回提案アドバイス', icon: '💡', color: 'from-amber-500 to-orange-500' },
  { key: 'outline', label: '資料の骨子', icon: '📐', color: 'from-violet-600 to-purple-600' },
];

const ACCEPT = '.mp3,.mp4,.wav,.m4a,.webm,.mov,.avi,.ogg,.flac,.aac,.wma,.mkv';
const CHUNK_SEC = 15 * 60;
const FFMPEG_CORE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
const LS_KEY = 'meeting_ai_groq_key';

// ──────────────────────────────────────────────
// Markdown renderer
// ──────────────────────────────────────────────
function renderMd(md: string): string {
  return md
    .replace(/\\n/g, '\n')
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-bold text-white mt-5 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-blue-300 mt-6 mb-3 pb-1 border-b border-slate-700">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-white mt-2 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>')
    .replace(/^\| (.+) \|$/gm, (line) => {
      const cells = line.split('|').filter((c) => c.trim());
      return `<tr>${cells.map((c) => `<td class="px-3 py-1.5 border border-slate-600 text-sm">${c.trim()}</td>`).join('')}</tr>`;
    })
    .replace(/^(\|[-| ]+\|)$/gm, '')
    .replace(/(<tr>.*<\/tr>\n?)+/g, (t) => `<div class="overflow-x-auto my-3"><table class="w-full border-collapse text-slate-300">${t}</table></div>`)
    .replace(/^- (.+)$/gm, '<li class="ml-5 text-slate-300 text-sm mb-1 list-disc">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-5 text-slate-300 text-sm mb-1 list-decimal">$2</li>')
    .replace(/((<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-2 space-y-0.5">$1</ul>')
    .replace(/^---$/gm, '<hr class="border-slate-700 my-4" />')
    .replace(/^(?!<[hul1-9|div|table|tr|td]).+$/gm, (l) => l.trim() ? `<p class="text-slate-300 text-sm leading-relaxed mb-2">${l}</p>` : '');
}

// ──────────────────────────────────────────────
// Main Component
// ──────────────────────────────────────────────
export default function Home() {
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('minutes');
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [copied, setCopied] = useState(false);
  const [ffmpegReady, setFfmpegReady] = useState(false);
  const [chunkInfo, setChunkInfo] = useState({ current: 0, total: 0 });

  // API key state
  const [groqKey, setGroqKey] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const [keyError, setKeyError] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  // Load API key from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEY) || '';
    setGroqKey(saved);
    setKeyInput(saved);
    if (!saved) setShowKeyPanel(true);
  }, []);

  // Load ffmpeg.wasm on mount
  useEffect(() => {
    (async () => {
      try {
        const ff = new FFmpeg();
        ffmpegRef.current = ff;
        await ff.load({
          coreURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_CORE}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        setFfmpegReady(true);
      } catch (e) {
        console.error('ffmpeg load failed', e);
      }
    })();
  }, []);

  const saveKey = () => {
    const k = keyInput.trim();
    if (!k.startsWith('gsk_')) {
      setKeyError('Groq APIキーは "gsk_" で始まる形式です。確認してください。');
      return;
    }
    setGroqKey(k);
    localStorage.setItem(LS_KEY, k);
    setShowKeyPanel(false);
    setKeyError('');
  };

  const reset = () => {
    setStage('idle');
    setProgress(0);
    setStatusMsg('');
    setResults(null);
    setErrorMsg('');
    setFileName('');
    setCopied(false);
    setChunkInfo({ current: 0, total: 0 });
  };

  const getDuration = (file: File): Promise<number> =>
    new Promise((resolve) => {
      const isVideo = file.type.startsWith('video/') ||
        ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv'].some((e) => file.name.toLowerCase().endsWith(e));
      const el = document.createElement(isVideo ? 'video' : 'audio');
      const url = URL.createObjectURL(file);
      el.onloadedmetadata = () => { resolve(el.duration); URL.revokeObjectURL(url); };
      el.onerror = () => { resolve(3600); URL.revokeObjectURL(url); };
      el.src = url;
    });

  const extractChunks = async (file: File): Promise<File[]> => {
    const ff = ffmpegRef.current!;
    setStatusMsg(`ファイルを解析中... (${(file.size / 1024 / 1024).toFixed(0)} MB)`);
    const duration = await getDuration(file);
    const numChunks = Math.max(1, Math.ceil(duration / CHUNK_SEC));
    setChunkInfo({ current: 0, total: numChunks });

    setStatusMsg('音声データを読み込み中...');
    setProgress(5);
    await ff.writeFile('input', await fetchFile(file));

    const chunks: File[] = [];
    for (let i = 0; i < numChunks; i++) {
      setChunkInfo({ current: i + 1, total: numChunks });
      setStatusMsg(`音声を抽出・圧縮中 ${i + 1}/${numChunks}...`);
      setProgress(5 + Math.round((i / numChunks) * 90));

      const out = `chunk_${i}.mp3`;
      await ff.exec(['-i', 'input', '-ss', String(i * CHUNK_SEC), '-t', String(CHUNK_SEC),
        '-vn', '-ar', '16000', '-ac', '1', '-b:a', '24k', '-f', 'mp3', out]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await ff.readFile(out);
      chunks.push(new File([new Blob([data], { type: 'audio/mpeg' })], out, { type: 'audio/mpeg' }));
      await ff.deleteFile(out);
    }
    try { await ff.deleteFile('input'); } catch { /* ignore */ }
    return chunks;
  };

  const apiHeaders = () => ({ 'x-groq-key': groqKey });

  const processFile = async (file: File) => {
    if (!groqKey) { setShowKeyPanel(true); return; }
    setFileName(file.name);
    setErrorMsg('');

    try {
      // ── Extract audio ──
      setStage('extracting');
      setProgress(0);

      let chunks: File[];
      if (ffmpegReady && ffmpegRef.current) {
        chunks = await extractChunks(file);
      } else {
        const isAudio = file.type.startsWith('audio/');
        if (!isAudio) throw new Error('動画ファイルの処理には音声抽出エンジン（ffmpeg）が必要です。ページを再読み込みして再試行してください。');
        chunks = [file];
      }
      setProgress(100);

      // ── Transcribe ──
      setStage('transcribing');
      const transcripts: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        setChunkInfo({ current: i + 1, total: chunks.length });
        setStatusMsg(`文字起こし中... ${i + 1} / ${chunks.length}`);
        setProgress(Math.round((i / chunks.length) * 100));

        const fd = new FormData();
        fd.append('audio', chunks[i]);

        const res = await fetch('/api/transcribe', { method: 'POST', headers: apiHeaders(), body: fd });
        const json = await res.json();

        if (res.status === 401) throw new Error('Groq APIキーが無効です。正しいキーを入力してください。');
        if (!res.ok) throw new Error(json.error || '文字起こしに失敗しました');
        if (json.text) transcripts.push(json.text);
      }
      setProgress(100);

      const fullTranscript = transcripts.join(' ').trim();
      if (!fullTranscript) throw new Error('音声から文字が検出されませんでした。音声が明瞭か確認してください。');

      // ── Generate ──
      setStage('generating');
      setStatusMsg('AIが議事録・アドバイス・資料骨子を生成中...');
      setProgress(0);

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiHeaders() },
        body: JSON.stringify({ transcript: fullTranscript }),
      });
      const genJson = await genRes.json();

      if (genRes.status === 401) throw new Error('Groq APIキーが無効です。正しいキーを入力してください。');
      if (!genRes.ok) throw new Error(genJson.error || 'AI生成に失敗しました');

      setResults(genJson);
      setActiveTab('minutes');
      setStage('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '処理中にエラーが発生しました';
      setErrorMsg(msg);
      setStage('error');
      if (msg.includes('APIキー')) setShowKeyPanel(true);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groqKey, ffmpegReady]);

  const handleCopy = () => {
    if (!results) return;
    navigator.clipboard.writeText(results[activeTab].replace(/\\n/g, '\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (key?: TabKey) => {
    if (!results) return;
    const k = key ?? activeTab;
    const label = TABS.find((t) => t.key === k)?.label ?? k;
    const content = `${label}\n\n${results[k].replace(/\\n/g, '\n')}`;
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })),
      download: `${label}_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt`,
    });
    a.click();
  };

  const handleDownloadAll = () => {
    if (!results) return;
    const all = TABS.map((t) => `${'='.repeat(40)}\n${t.icon} ${t.label}\n${'='.repeat(40)}\n\n${results[t.key].replace(/\\n/g, '\n')}`).join('\n\n');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([all], { type: 'text/plain;charset=utf-8' })),
      download: `会議AIレポート_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt`,
    });
    a.click();
  };

  const isProcessing = stage === 'extracting' || stage === 'transcribing' || stage === 'generating';
  const STEPS = [
    { key: 'extracting', label: '音声抽出' },
    { key: 'transcribing', label: '文字起こし' },
    { key: 'generating', label: 'AI生成' },
  ];
  const stageIdx = STEPS.findIndex((s) => s.key === stage);

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-white">
      {/* Ambient glows */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
      </div>

      {/* ══════════════════════════════════
          API KEY SETUP PANEL
      ══════════════════════════════════ */}
      {showKeyPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-3xl p-8 shadow-2xl">
            {/* Header */}
            <div className="flex items-start gap-4 mb-6">
              <div className="w-12 h-12 rounded-2xl bg-green-500/20 border border-green-500/30 flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Groq APIキーを設定</h2>
                <p className="text-slate-400 text-sm mt-0.5">無料・クレジットカード不要・2分で取得可能</p>
              </div>
            </div>

            {/* Steps */}
            <div className="bg-slate-800/60 rounded-2xl p-4 mb-5 space-y-3">
              <p className="text-slate-300 text-sm font-medium mb-2">🆓 無料APIキーの取得方法</p>
              {[
                { n: '1', text: 'ブラウザで console.groq.com を開く' },
                { n: '2', text: 'メールアドレスで無料登録（カード不要）' },
                { n: '3', text: 'ダッシュボードで「API Keys」→「Create API Key」' },
                { n: '4', text: '生成されたキー（gsk_...）を下にペースト' },
              ].map(({ n, text }) => (
                <div key={n} className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-500/20 border border-blue-500/30 text-blue-400 text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{n}</span>
                  <p className="text-slate-300 text-sm">{text}</p>
                </div>
              ))}

              <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer"
                className="mt-2 flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                console.groq.com を開く
              </a>
            </div>

            {/* Free plan note */}
            <div className="flex items-center gap-2 mb-5 p-3 rounded-xl bg-green-500/10 border border-green-500/20">
              <svg className="w-4 h-4 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p className="text-green-300 text-xs">無料プラン: 文字起こし7,200回/日 + AI生成14,400回/日 — 個人利用には十分すぎる量</p>
            </div>

            {/* Input */}
            <div className="space-y-3">
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveKey()}
                placeholder="gsk_xxxxxxxxxxxxxxxxxxxx"
                className="w-full px-4 py-3 rounded-xl bg-slate-800 border border-slate-600 focus:border-blue-500 focus:outline-none text-white placeholder-slate-500 text-sm font-mono"
              />
              {keyError && <p className="text-red-400 text-xs">{keyError}</p>}
              <div className="flex gap-2">
                <button onClick={saveKey}
                  className="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 font-medium text-sm transition-all">
                  保存して使い始める
                </button>
                {groqKey && (
                  <button onClick={() => setShowKeyPanel(false)}
                    className="px-4 py-3 rounded-xl bg-slate-700 hover:bg-slate-600 text-sm transition-all text-slate-300">
                    閉じる
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-4xl mx-auto px-4 py-12">

        {/* ── Header ── */}
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm">
              <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              Groq Whisper × Llama 3.3 70B — 完全無料
            </div>
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-blue-400 via-violet-400 to-pink-400 bg-clip-text text-transparent mb-3">
            会議AI アシスタント
          </h1>
          <p className="text-slate-400 text-lg">
            音声・動画をアップロードするだけで<br className="sm:hidden" />
            <span className="text-slate-300 font-medium">議事録 / 提案アドバイス / 資料骨子</span>を自動生成
          </p>

          {/* Key status bar */}
          <div className="flex items-center justify-center gap-3 mt-4">
            {groqKey ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                APIキー設定済み
                <button onClick={() => setShowKeyPanel(true)} className="ml-1 text-slate-400 hover:text-white transition-colors">
                  (変更)
                </button>
              </div>
            ) : (
              <button onClick={() => setShowKeyPanel(true)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs hover:bg-amber-500/20 transition-all">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                APIキーを設定してください（無料）
              </button>
            )}
            <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs ${ffmpegReady ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-slate-800 text-slate-500 border border-slate-700'}`}>
              {ffmpegReady
                ? <><span className="w-1.5 h-1.5 rounded-full bg-green-400" />音声エンジン Ready</>
                : <><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />音声エンジン読み込み中...</>
              }
            </div>
          </div>
        </div>

        {/* ── IDLE STATE ── */}
        {(stage === 'idle' || stage === 'error') && (
          <>
            {stage === 'error' && (
              <div className="mb-4 p-4 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
                <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <p className="text-red-300 font-medium text-sm">エラー</p>
                  <p className="text-red-400 text-sm mt-0.5">{errorMsg}</p>
                </div>
                <button onClick={reset} className="ml-auto text-slate-500 hover:text-white transition-colors text-xs flex-shrink-0">閉じる</button>
              </div>
            )}

            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all duration-200 ${
                isDragging ? 'border-blue-400 bg-blue-500/10 scale-[1.02]' :
                !groqKey ? 'border-slate-700 opacity-60 cursor-not-allowed' :
                'border-slate-700 hover:border-slate-500 bg-slate-900/40 hover:bg-slate-900/60'
              }`}
            >
              <input ref={fileInputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])} />

              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-slate-700 flex items-center justify-center mx-auto mb-5">
                <svg className="w-10 h-10 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <p className="text-xl font-semibold text-white mb-2">音声・動画ファイルをドロップ</p>
              <p className="text-slate-400 mb-4">または クリックしてファイルを選択（最大 2GB）</p>
              <div className="flex flex-wrap justify-center gap-1.5 text-xs text-slate-500">
                {['MP3', 'MP4', 'WAV', 'M4A', 'MOV', 'WebM', 'AVI', 'FLAC', 'AAC', 'MKV'].map((f) => (
                  <span key={f} className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700">{f}</span>
                ))}
              </div>
              {!groqKey && (
                <p className="mt-4 text-amber-400 text-sm">↑ 上の「APIキーを設定」を先に完了してください</p>
              )}
            </div>

            {/* Feature cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
              {TABS.map((tab) => (
                <div key={tab.key} className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                  <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-r ${tab.color} mb-3`}>
                    <span className="text-lg">{tab.icon}</span>
                  </div>
                  <h3 className="font-semibold text-white mb-1">{tab.label}</h3>
                  <p className="text-slate-500 text-xs leading-relaxed">
                    {tab.key === 'minutes' && '決定事項・アクションアイテム・討議内容を構造化した議事録として出力'}
                    {tab.key === 'advice' && '会議内容から次回の提案に向けた具体的なアドバイスを生成'}
                    {tab.key === 'outline' && '次回会議・プレゼン向けの資料の章立てと骨子を自動作成'}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── PROCESSING STATE ── */}
        {isProcessing && (
          <div className="py-4">
            <div className="flex items-center justify-center gap-1 mb-10 flex-wrap">
              {STEPS.map((s, i) => {
                const done = i < stageIdx;
                const active = i === stageIdx;
                return (
                  <div key={s.key} className="flex items-center">
                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                      done ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                      active ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                      'bg-slate-800/50 text-slate-600 border border-slate-700'}`}>
                      {done
                        ? <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                        : active
                        ? <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                        : <span className="w-2.5 h-2.5 rounded-full bg-slate-700" />}
                      {s.label}
                    </div>
                    {i < STEPS.length - 1 && <div className={`w-6 h-px mx-1 ${i < stageIdx ? 'bg-green-500/40' : 'bg-slate-700'}`} />}
                  </div>
                );
              })}
            </div>

            <div className="max-w-lg mx-auto bg-slate-900/60 border border-slate-800 rounded-3xl p-8 text-center">
              <div className="relative inline-flex mb-6">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-slate-700 flex items-center justify-center">
                  {stage === 'extracting' && (
                    <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
                    </svg>
                  )}
                  {stage === 'transcribing' && (
                    <svg className="w-8 h-8 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                    </svg>
                  )}
                  {stage === 'generating' && (
                    <svg className="w-8 h-8 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  )}
                </div>
                <div className="absolute -inset-2 rounded-3xl border border-blue-500/20 animate-pulse" />
              </div>

              <p className="font-medium text-white text-lg mb-1">{statusMsg}</p>
              {chunkInfo.total > 1 && (stage === 'extracting' || stage === 'transcribing') && (
                <p className="text-slate-500 text-sm mb-4">チャンク {chunkInfo.current} / {chunkInfo.total}</p>
              )}
              {stage !== 'generating' && (
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-slate-600 mb-1.5">
                    <span>{stage === 'extracting' ? '音声抽出' : '文字起こし'}</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-violet-500 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}
              {stage === 'extracting' && <p className="text-slate-600 text-xs mt-3">ブラウザ内で処理中。大きなファイルは数分かかります</p>}
              {stage === 'generating' && (
                <div className="flex justify-center mt-4 gap-1">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )}
              {fileName && <p className="text-slate-600 text-xs mt-3 truncate">{fileName}</p>}
            </div>
          </div>
        )}

        {/* ── RESULTS STATE ── */}
        {stage === 'done' && results && (
          <div>
            <div className="flex items-center justify-between mb-6 p-4 rounded-2xl bg-green-500/10 border border-green-500/20">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-green-500/20 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-green-300 font-medium text-sm">生成完了</p>
                  {fileName && <p className="text-slate-500 text-xs truncate max-w-[200px]">{fileName}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={handleDownloadAll}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  全て保存
                </button>
                <button onClick={reset} className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-xs text-blue-400 transition-all">
                  新しいファイル
                </button>
              </div>
            </div>

            <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
              {TABS.map((tab) => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm whitespace-nowrap transition-all ${
                    activeTab === tab.key
                      ? `bg-gradient-to-r ${tab.color} text-white shadow-lg`
                      : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 border border-slate-700'
                  }`}>
                  <span>{tab.icon}</span>{tab.label}
                </button>
              ))}
            </div>

            <div className="rounded-2xl bg-slate-900/60 border border-slate-800 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/40">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <span>{TABS.find((t) => t.key === activeTab)?.icon}</span>
                  <span>{TABS.find((t) => t.key === activeTab)?.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all">
                    {copied
                      ? <><svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-green-400">コピー済み</span></>
                      : <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg><span>コピー</span></>
                    }
                  </button>
                  <button onClick={() => handleDownload()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    保存
                  </button>
                </div>
              </div>
              <div className="p-6 min-h-[400px]"
                dangerouslySetInnerHTML={{ __html: renderMd(results[activeTab]) }} />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
