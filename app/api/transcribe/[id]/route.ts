import { NextRequest, NextResponse } from 'next/server';
import { AssemblyAI } from 'assemblyai';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const client = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY!,
  });

  try {
    const transcript = await client.transcripts.get(id);

    return NextResponse.json({
      status: transcript.status,
      text: transcript.text ?? '',
      error: transcript.error ?? null,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return NextResponse.json({ error: 'ステータスの取得に失敗しました' }, { status: 500 });
  }
}
