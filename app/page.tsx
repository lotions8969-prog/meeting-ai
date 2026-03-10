'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
type Stage = 'idle' | 'extracting' | 'transcribing' | 'generating' | 'done' | 'error';
type TabKey = 'minutes' | 'advice' | 'outline';

interface Results {
  minutes: string;
  advice: string;
  outline: string;
}

const TABS: { key: TabKey; label: string; icon: string; color: string }[] = [
  { key: 'minutes', label: '議事録', icon: '📋', color: 'from-blue-600 to-cyan-600' },
  { key: 'advice', label: '次回提案アドバイス', icon: '💡', color: 'from-amber-500 to-orange-500' },
  { key: 'outline', label: '資料の骨子', icon: '📐', color: 'from-violet-600 to-purple-600' },
];

const ACCEPT = '.mp3,.mp4,.wav,.m4a,.webm,.mov,.avi,.ogg,.flac,.aac,.wma,.mkv';
// 15-minute chunks at 24kbps ≈ 2.6MB (well under Vercel's 4.5MB limit)
const CHUNK_SEC = 15 * 60;
const FFMPEG_CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';

// ──────────────────────────────────────────────
// Minimal Markdown renderer
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  // Load ffmpeg.wasm on mount
  useEffect(() => {
    (async () => {
      try {
        const ff = new FFmpeg();
        ffmpegRef.current = ff;
        await ff.load({
          coreURL: await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_CORE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        setFfmpegReady(true);
      } catch (e) {
        console.error('ffmpeg load failed', e);
      }
    })();
  }, []);

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

  // Get media duration via HTML5 element
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

  // Extract audio chunks via ffmpeg.wasm
  const extractChunks = async (file: File): Promise<File[]> => {
    const ff = ffmpegRef.current!;

    setStatusMsg(`ファイルを解析中... (${(file.size / 1024 / 1024).toFixed(0)} MB)`);
    const duration = await getDuration(file);
    const numChunks = Math.max(1, Math.ceil(duration / CHUNK_SEC));
    setChunkInfo({ current: 0, total: numChunks });

    setStatusMsg('音声データを読み込み中...');
    setProgress(5);

    // Write the whole file to ffmpeg virtual FS
    await ff.writeFile('input', await fetchFile(file));

    const chunks: File[] = [];

    for (let i = 0; i < numChunks; i++) {
      setChunkInfo({ current: i + 1, total: numChunks });
      setStatusMsg(`音声を抽出・圧縮中 ${i + 1}/${numChunks}...`);
      setProgress(5 + Math.round((i / numChunks) * 90));

      const start = i * CHUNK_SEC;
      const out = `chunk_${i}.mp3`;

      await ff.exec([
        '-i', 'input',
        '-ss', String(start),
        '-t', String(CHUNK_SEC),
        '-vn',          // strip video
        '-ar', '16000', // 16 kHz (speech range)
        '-ac', '1',     // mono
        '-b:a', '24k',  // 24 kbps → ~2.6 MB / 15 min (under Vercel 4.5 MB limit)
        '-f', 'mp3',
        out,
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await ff.readFile(out);
      const blob = new Blob([data], { type: 'audio/mpeg' });
      chunks.push(new File([blob], out, { type: 'audio/mpeg' }));
      await ff.deleteFile(out);
    }

    try { await ff.deleteFile('input'); } catch { /* ignore */ }
    return chunks;
  };

  const processFile = async (file: File) => {
    setFileName(file.name);
    setErrorMsg('');

    try {
      // ── Step 1: Extract audio ──────────────────────
      setStage('extracting');
      setProgress(0);

      let chunks: File[];

      if (!ffmpegReady || !ffmpegRef.current) {
        // ffmpeg not loaded: try uploading audio file directly
        const isAudio = file.type.startsWith('audio/');
        if (!isAudio) throw new Error('動画ファイルの処理には音声抽出エンジン（ffmpeg）が必要です。ページを再読み込みして再試行してください。');
        if (file.size > 24 * 1024 * 1024) throw new Error('音声ファイルが大きすぎます（24MB以下にしてください）。ffmpegの読み込みを待ってから再試行してください。');
        chunks = [file];
      } else {
        chunks = await extractChunks(file);
      }

      setProgress(100);

      // ── Step 2: Transcribe each chunk ─────────────
      setStage('transcribing');
      const transcripts: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        setChunkInfo({ current: i + 1, total: chunks.length });
        setStatusMsg(`文字起こし中... ${i + 1} / ${chunks.length}`);
        setProgress(Math.round((i / chunks.length) * 100));

        const fd = new FormData();
        fd.append('audio', chunks[i]);

        const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || '文字起こしに失敗しました');
        }
        const { text } = await res.json();
        if (text) transcripts.push(text);
      }
      setProgress(100);

      const fullTranscript = transcripts.join(' ').trim();
      if (!fullTranscript) throw new Error('音声から文字が検出されませんでした。音声が明瞭か確認してください。');

      // ── Step 3: Generate with Claude ──────────────
      setStage('generating');
      setStatusMsg('AIが議事録・アドバイス・資料骨子を生成中...');
      setProgress(0);

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: fullTranscript }),
      });
      if (!genRes.ok) {
        const err = await genRes.json();
        throw new Error(err.error || 'AI生成に失敗しました');
      }

      const genData = await genRes.json();
      setResults(genData);
      setActiveTab('minutes');
      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '処理中にエラーが発生しました');
      setStage('error');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ffmpegReady]);

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
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${label}_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt` });
    a.click();
  };

  const handleDownloadAll = () => {
    if (!results) return;
    const all = TABS.map((t) => `${'='.repeat(40)}\n${t.icon} ${t.label}\n${'='.repeat(40)}\n\n${results[t.key].replace(/\\n/g, '\n')}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([all], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `会議AIレポート_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt` });
    a.click();
  };

  const isProcessing = stage === 'extracting' || stage === 'transcribing' || stage === 'generating';

  const STAGE_STEPS = [
    { key: 'extracting', label: '音声抽出' },
    { key: 'transcribing', label: '文字起こし' },
    { key: 'generating', label: 'AI生成' },
  ];
  const stageIdx = STAGE_STEPS.findIndex((s) => s.key === stage);

  // ── Render ───────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0f1e] text-white">
      {/* Ambient glows */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/5 rounded-full blur-3xl" />
      </div>

      <div className="max-w-4xl mx-auto px-4 py-12">

        {/* ── Header ── */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm mb-5">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            Powered by OpenAI Whisper × Claude AI
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-blue-400 via-violet-400 to-pink-400 bg-clip-text text-transparent mb-3">
            会議AI アシスタント
          </h1>
          <p className="text-slate-400 text-lg">
            音声・動画をアップロードするだけで<br className="sm:hidden" />
            <span className="text-slate-300 font-medium">議事録 / 提案アドバイス / 資料骨子</span>を自動生成
          </p>
          <p className="text-slate-600 text-sm mt-2">
            最大 2GB 対応 ・ ブラウザ内で音声抽出するためファイルがサーバーに送信されません
          </p>
        </div>

        {/* ── IDLE STATE ── */}
        {stage === 'idle' && (
          <>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all duration-200 ${
                isDragging ? 'border-blue-400 bg-blue-500/10 scale-[1.02]' : 'border-slate-700 hover:border-slate-500 bg-slate-900/40 hover:bg-slate-900/60'
              }`}
            >
              <input ref={fileInputRef} type="file" accept={ACCEPT} className="hidden"
                onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])} />

              <div className="mb-5">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-slate-700 mb-1">
                  <svg className="w-10 h-10 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
              </div>

              <p className="text-xl font-semibold text-white mb-2">音声・動画ファイルをドロップ</p>
              <p className="text-slate-400 mb-4">または クリックしてファイルを選択（最大 2GB）</p>

              <div className="flex flex-wrap justify-center gap-2 text-xs text-slate-500 mb-4">
                {['MP3', 'MP4', 'WAV', 'M4A', 'MOV', 'WebM', 'AVI', 'FLAC', 'AAC', 'MKV', 'WMA'].map((f) => (
                  <span key={f} className="px-2 py-1 rounded bg-slate-800 border border-slate-700">{f}</span>
                ))}
              </div>

              {/* ffmpeg status */}
              <div className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full ${ffmpegReady ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-slate-800 text-slate-500 border border-slate-700'}`}>
                {ffmpegReady
                  ? <><span className="w-1.5 h-1.5 rounded-full bg-green-400" />音声エンジン 準備完了</>
                  : <><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />音声エンジンを読み込み中...</>
                }
              </div>
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
            {/* Step indicators */}
            <div className="flex items-center justify-center gap-1 mb-10 flex-wrap">
              {STAGE_STEPS.map((s, i) => {
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
                        : <span className="w-2.5 h-2.5 rounded-full bg-slate-700" />
                      }
                      {s.label}
                    </div>
                    {i < STAGE_STEPS.length - 1 && (
                      <div className={`w-6 h-px mx-1 ${i < stageIdx ? 'bg-green-500/40' : 'bg-slate-700'}`} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Processing card */}
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
                <p className="text-slate-500 text-sm mb-4">
                  チャンク {chunkInfo.current} / {chunkInfo.total}
                </p>
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

              {stage === 'extracting' && (
                <p className="text-slate-600 text-xs mt-3">ブラウザ内で音声を抽出・圧縮しています。大きなファイルは数分かかります</p>
              )}
              {stage === 'generating' && (
                <div className="flex justify-center mt-4">
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              )}

              {fileName && (
                <p className="text-slate-600 text-xs mt-3 truncate">{fileName}</p>
              )}
            </div>
          </div>
        )}

        {/* ── ERROR STATE ── */}
        {stage === 'error' && (
          <div className="max-w-md mx-auto py-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-white mb-2">エラーが発生しました</h3>
            <p className="text-red-400 text-sm mb-6 leading-relaxed">{errorMsg}</p>
            <button onClick={reset} className="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-medium transition-all">
              やり直す
            </button>
          </div>
        )}

        {/* ── RESULTS STATE ── */}
        {stage === 'done' && results && (
          <div>
            {/* Success banner */}
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
                <button onClick={reset}
                  className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-xs text-blue-400 transition-all">
                  新しいファイル
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
              {TABS.map((tab) => (
                <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm whitespace-nowrap transition-all ${
                    activeTab === tab.key
                      ? `bg-gradient-to-r ${tab.color} text-white shadow-lg`
                      : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 border border-slate-700'
                  }`}>
                  <span>{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content card */}
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
