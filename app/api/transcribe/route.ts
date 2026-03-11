import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-groq-key') || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Groq APIキーが設定されていません' }, { status: 401 });
  }

  const groq = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  try {
    const formData = await req.formData();
    const audio = formData.get('audio') as File;
    if (!audio) {
      return NextResponse.json({ error: '音声ファイルが見つかりません' }, { status: 400 });
    }

    const transcript = await groq.audio.transcriptions.create({
      file: audio,
      model: 'whisper-large-v3-turbo',
    });

    return NextResponse.json({ text: transcript.text });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('401') || msg.includes('invalid_api_key') ? 401 : 500;
    console.error('Transcribe error:', msg);
    return NextResponse.json({ error: '文字起こしに失敗しました: ' + msg }, { status });
  }
}
