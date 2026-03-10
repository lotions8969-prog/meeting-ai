import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  try {
    const formData = await req.formData();
    const audio = formData.get('audio') as File;

    if (!audio) {
      return NextResponse.json({ error: '音声ファイルが見つかりません' }, { status: 400 });
    }

    const transcript = await openai.audio.transcriptions.create({
      file: audio,
      model: 'whisper-1',
    });

    return NextResponse.json({ text: transcript.text });
  } catch (err) {
    console.error('Transcribe error:', err);
    return NextResponse.json({ error: '文字起こしに失敗しました' }, { status: 500 });
  }
}
