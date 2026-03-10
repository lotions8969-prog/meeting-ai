import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        return {
          allowedContentTypes: [
            'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
            'audio/webm', 'audio/ogg', 'audio/flac', 'audio/x-m4a',
            'audio/aac', 'audio/*',
            'video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo',
            'video/x-ms-wmv', 'video/mpeg', 'video/*',
          ],
          maximumSizeInBytes: 2 * 1024 * 1024 * 1024, // 2GB
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('Upload completed:', blob.url);
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
