import { NextRequest, NextResponse } from 'next/server';
import { AssemblyAI } from 'assemblyai';

export async function POST(req: NextRequest) {
  const { audioUrl } = await req.json();

  if (!audioUrl) {
    return NextResponse.json({ error: 'audioUrl is required' }, { status: 400 });
  }

  const client = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY!,
  });

  try {
    const transcript = await client.transcripts.submit({
      audio_url: audioUrl,
      language_detection: true,
    });

    return NextResponse.json({ id: transcript.id });
  } catch (error) {
    console.error('AssemblyAI error:', error);
    return NextResponse.json({ error: '文字起こしの開始に失敗しました' }, { status: 500 });
  }
}
