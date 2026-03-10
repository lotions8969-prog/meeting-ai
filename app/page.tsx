'use client';

import { useState, useRef, useCallback } from 'react';
import { upload } from '@vercel/blob/client';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────
type Stage = 'idle' | 'uploading' | 'transcribing' | 'generating' | 'done' | 'error';
type TabKey = 'minutes' | 'advice' | 'outline';

interface Results {
  minutes: string;
  advice: string;
  outline: string;
}

// ──────────────────────────────────────────────
// Markdown renderer (minimal, no external deps)
// ──────────────────────────────────────────────
function renderMarkdown(md: string): string {
  return md
    .replace(/\\n/g, '\n')
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-bold text-white mt-5 mb-2">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold text-blue-300 mt-6 mb-3 pb-1 border-b border-slate-600">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-white mt-2 mb-4">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>')
    .replace(/^\| (.+) \|$/gm, (line) => {
      const cells = line.split('|').filter(c => c.trim());
      const isHeader = cells.every(c => c.trim());
      const tag = isHeader ? 'td' : 'td';
      return `<tr>${cells.map(c => `<${tag} class="px-3 py-1.5 border border-slate-600 text-sm">${c.trim()}</${tag}>`).join('')}</tr>`;
    })
    .replace(/^(\|[-| ]+\|)$/gm, '')
    .replace(/(<tr>.*<\/tr>\n?)+/g, (table) => `<div class="overflow-x-auto my-3"><table class="w-full border-collapse text-slate-300">${table}</table></div>`)
    .replace(/^- (.+)$/gm, '<li class="ml-4 text-slate-300 text-sm mb-1 list-disc">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="ml-4 text-slate-300 text-sm mb-1 list-decimal">$2</li>')
    .replace(/((<li[^>]*>.*<\/li>\n?)+)/g, '<ul class="my-2 space-y-0.5">$1</ul>')
    .replace(/^(?!<[h1-6|ul|li|div|table|tr|td]|---).+$/gm, (line) => line.trim() ? `<p class="text-slate-300 text-sm leading-relaxed mb-2">${line}</p>` : '')
    .replace(/^---$/gm, '<hr class="border-slate-700 my-4" />')
    .replace(/\n{3,}/g, '\n\n');
}

// ──────────────────────────────────────────────
// Tab config
// ──────────────────────────────────────────────
const TABS: { key: TabKey; label: string; icon: string; color: string }[] = [
  { key: 'minutes', label: '議事録', icon: '📋', color: 'from-blue-600 to-cyan-600' },
  { key: 'advice', label: '次回提案アドバイス', icon: '💡', color: 'from-amber-500 to-orange-500' },
  { key: 'outline', label: '資料の骨子', icon: '📐', color: 'from-violet-600 to-purple-600' },
];

const ACCEPT = '.mp3,.mp4,.wav,.m4a,.webm,.mov,.avi,.ogg,.flac,.aac,.wma,.mkv';

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStage('idle');
    setProgress(0);
    setStatusMsg('');
    setResults(null);
    setErrorMsg('');
    setFileName('');
    setCopied(false);
  };

  const handleError = (msg: string) => {
    setErrorMsg(msg);
    setStage('error');
  };

  const processFile = async (file: File) => {
    setFileName(file.name);
    setStage('uploading');
    setProgress(0);
    setStatusMsg('ファイルをアップロード中...');

    try {
      // 1. Upload to Vercel Blob
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/blob-upload',
        onUploadProgress: ({ percentage }) => setProgress(Math.round(percentage)),
      });

      // 2. Start transcription
      setStage('transcribing');
      setProgress(0);
      setStatusMsg('文字起こしを開始中...');

      const transcribeRes = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: blob.url }),
      });
      const { id, error: tErr } = await transcribeRes.json();
      if (tErr || !id) throw new Error(tErr || '文字起こしの開始に失敗しました');

      // 3. Poll transcription status
      setStatusMsg('AIが音声を解析中... しばらくお待ちください');
      let transcript = '';
      let dots = 0;
      while (true) {
        await new Promise((r) => setTimeout(r, 4000));
        dots = (dots + 1) % 4;
        setStatusMsg(`AIが音声を解析中${'・'.repeat(dots + 1)}`);

        const statusRes = await fetch(`/api/transcribe/${id}`);
        const { status, text, error: sErr } = await statusRes.json();

        if (status === 'completed') {
          transcript = text;
          break;
        }
        if (status === 'error') throw new Error(sErr || '文字起こしに失敗しました');
        if (status === 'queued') setStatusMsg('キューで待機中...');
        if (status === 'processing') setStatusMsg(`音声を解析中${'・'.repeat(dots + 1)}`);
      }

      if (!transcript.trim()) throw new Error('音声から文字が検出されませんでした');

      // 4. Generate with Claude
      setStage('generating');
      setStatusMsg('AIが議事録・アドバイス・資料骨子を生成中...');

      const genRes = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
      });
      const genData = await genRes.json();
      if (genData.error) throw new Error(genData.error);

      setResults(genData);
      setActiveTab('minutes');
      setStage('done');
    } catch (err) {
      handleError(err instanceof Error ? err.message : '処理中にエラーが発生しました');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCopy = () => {
    if (!results) return;
    const content = results[activeTab];
    navigator.clipboard.writeText(content.replace(/\\n/g, '\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!results) return;
    const label = TABS.find((t) => t.key === activeTab)?.label ?? activeTab;
    const content = `${label}\n\n${results[activeTab].replace(/\\n/g, '\n')}`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label}_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt`;
    a.click();
  };

  const handleDownloadAll = () => {
    if (!results) return;
    const all = TABS.map((t) => `${'='.repeat(40)}\n${t.icon} ${t.label}\n${'='.repeat(40)}\n\n${results[t.key].replace(/\\n/g, '\n')}`).join('\n\n');
    const blob = new Blob([all], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `会議AI_${new Date().toLocaleDateString('ja-JP').replace(/\//g, '-')}.txt`;
    a.click();
  };

  // ── Stage indicators
  const STAGES = [
    { key: 'uploading', label: 'アップロード' },
    { key: 'transcribing', label: '文字起こし' },
    { key: 'generating', label: 'AI生成' },
  ];
  const stageIndex = STAGES.findIndex((s) => s.key === stage);

  return (
    <div className="min-h-screen bg-[#0a0f1e] text-white">
      {/* Background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/5 rounded-full blur-3xl" />
      </div>

      <div className="max-w-4xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm mb-5">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            Powered by AssemblyAI × Claude AI
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-blue-400 via-violet-400 to-pink-400 bg-clip-text text-transparent mb-3">
            会議AI アシスタント
          </h1>
          <p className="text-slate-400 text-lg">
            音声・動画をアップロードするだけで<br className="sm:hidden" />
            <span className="text-slate-300 font-medium">議事録 / 提案アドバイス / 資料骨子</span>を自動生成
          </p>
        </div>

        {/* ── IDLE STATE ── */}
        {stage === 'idle' && (
          <>
            {/* Upload Zone */}
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-3xl p-12 text-center cursor-pointer transition-all duration-200 ${
                isDragging
                  ? 'border-blue-400 bg-blue-500/10 scale-[1.02]'
                  : 'border-slate-700 hover:border-slate-500 bg-slate-900/40 hover:bg-slate-900/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])}
              />
              <div className="mb-5">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-slate-700 mb-1">
                  <svg className="w-10 h-10 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                </div>
              </div>
              <p className="text-xl font-semibold text-white mb-2">音声・動画ファイルをドロップ</p>
              <p className="text-slate-400 mb-4">または クリックしてファイルを選択</p>
              <div className="flex flex-wrap justify-center gap-2 text-xs text-slate-500 mb-3">
                {['MP3', 'MP4', 'WAV', 'M4A', 'MOV', 'WebM', 'AVI', 'FLAC', 'AAC'].map((fmt) => (
                  <span key={fmt} className="px-2 py-1 rounded bg-slate-800 border border-slate-700">{fmt}</span>
                ))}
              </div>
              <p className="text-slate-600 text-sm">最大 2GB まで対応</p>
            </div>

            {/* Feature Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
              {TABS.map((tab) => (
                <div key={tab.key} className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                  <div className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-r ${tab.color} mb-3`}>
                    <span className="text-lg">{tab.icon}</span>
                  </div>
                  <h3 className="font-semibold text-white mb-1">{tab.label}</h3>
                  <p className="text-slate-500 text-xs leading-relaxed">
                    {tab.key === 'minutes' && '決定事項・アクションアイテム・討議内容を構造化された議事録として出力'}
                    {tab.key === 'advice' && '会議の内容から次回の提案に向けた具体的なアドバイスを生成'}
                    {tab.key === 'outline' && '次回の会議・プレゼンに向けた資料の章立て・骨子を自動作成'}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── PROCESSING STATE ── */}
        {(stage === 'uploading' || stage === 'transcribing' || stage === 'generating') && (
          <div className="py-8">
            {/* Stage Progress Bar */}
            <div className="flex items-center justify-center gap-0 mb-10">
              {STAGES.map((s, i) => {
                const isDone = i < stageIndex;
                const isActive = i === stageIndex;
                return (
                  <div key={s.key} className="flex items-center">
                    <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      isDone ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                      isActive ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                      'bg-slate-800/50 text-slate-600 border border-slate-700'
                    }`}>
                      {isDone ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : isActive ? (
                        <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <span className="w-3 h-3 rounded-full bg-slate-700" />
                      )}
                      {s.label}
                    </div>
                    {i < STAGES.length - 1 && (
                      <div className={`w-8 h-px mx-1 ${i < stageIndex ? 'bg-green-500/40' : 'bg-slate-700'}`} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* File name */}
            {fileName && (
              <div className="text-center mb-6">
                <span className="text-sm text-slate-400">
                  <span className="text-slate-500">処理中: </span>{fileName}
                </span>
              </div>
            )}

            {/* Main Processing Card */}
            <div className="max-w-md mx-auto bg-slate-900/60 border border-slate-800 rounded-3xl p-8 text-center">
              <div className="relative inline-flex mb-6">
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 border border-slate-700 flex items-center justify-center">
                  {stage === 'uploading' && (
                    <svg className="w-8 h-8 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
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

              <p className="text-white font-semibold text-lg mb-2">{statusMsg}</p>

              {stage === 'uploading' && (
                <div className="mt-4">
                  <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                    <span>アップロード中</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-500 to-violet-500 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}

              {stage === 'transcribing' && (
                <p className="text-slate-500 text-sm mt-2">音声の長さによっては数分かかる場合があります</p>
              )}
              {stage === 'generating' && (
                <p className="text-slate-500 text-sm mt-2">Claude AIが3つのドキュメントを生成しています</p>
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
            <p className="text-red-400 text-sm mb-6">{errorMsg}</p>
            <button
              onClick={reset}
              className="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-all text-sm font-medium"
            >
              やり直す
            </button>
          </div>
        )}

        {/* ── RESULTS STATE ── */}
        {stage === 'done' && results && (
          <div>
            {/* Success Banner */}
            <div className="flex items-center justify-between mb-6 p-4 rounded-2xl bg-green-500/10 border border-green-500/20">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-green-500/20 flex items-center justify-center">
                  <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <p className="text-green-300 font-medium text-sm">生成完了</p>
                  {fileName && <p className="text-slate-500 text-xs">{fileName}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDownloadAll}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  全て保存
                </button>
                <button
                  onClick={reset}
                  className="px-3 py-1.5 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-xs text-blue-400 transition-all"
                >
                  新しいファイルを処理
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm whitespace-nowrap transition-all ${
                    activeTab === tab.key
                      ? `bg-gradient-to-r ${tab.color} text-white shadow-lg`
                      : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 border border-slate-700'
                  }`}
                >
                  <span>{tab.icon}</span>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content Card */}
            <div className="rounded-2xl bg-slate-900/60 border border-slate-800 overflow-hidden">
              {/* Card Header */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/40">
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <span>{TABS.find((t) => t.key === activeTab)?.icon}</span>
                  <span>{TABS.find((t) => t.key === activeTab)?.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all"
                  >
                    {copied ? (
                      <><svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg><span className="text-green-400">コピー済み</span></>
                    ) : (
                      <><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg><span>コピー</span></>
                    )}
                  </button>
                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300 transition-all"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    保存
                  </button>
                </div>
              </div>

              {/* Markdown Content */}
              <div
                className="p-6 prose prose-invert max-w-none min-h-[400px]"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(results[activeTab]) }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
