import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-groq-key') || process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Groq APIキーが設定されていません' }, { status: 401 });
  }

  const groq = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const { transcript } = await req.json();
  if (!transcript) {
    return NextResponse.json({ error: 'transcript is required' }, { status: 400 });
  }

  const prompt = `あなたは会議・商談のプロフェッショナルアシスタントです。以下の文字起こしを分析し、必ず次のJSON形式のみで回答してください（コードブロックや説明文は不要）。

{"minutes":"...","advice":"...","outline":"..."}

各フィールドの内容（Markdown形式）：

minutes（議事録）:
# 議事録

## 会議概要
- 日時・目的を推測して記述

## 討議内容
各議題の要点を詳しく

## 決定事項
- 箇条書きで明確に

## 課題・懸念事項
- 未解決事項・今後の検討事項

## アクションアイテム
| アクション | 担当 | 期限 |
|-----------|------|------|

---

advice（次回提案へのアドバイス）:
# 次回提案へのアドバイス

## 今回の会議から見えた課題
## 次回の提案ポイント
## 準備すべき事項
## 相手への対応方針・Win-Winの提案

---

outline（資料の骨子）:
# 資料の骨子

## 資料の目的・対象読者
## 全体構成（目次案）
1. 各章タイトル
...
## 各章のキーメッセージとデータ
## 想定Q&Aと回答方針

改行は\\nで表現してください。

---
【文字起こし】
${transcript}`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return NextResponse.json({
        minutes: parsed.minutes || '',
        advice: parsed.advice || '',
        outline: parsed.outline || '',
      });
    }
    return NextResponse.json({ minutes: raw, advice: '', outline: '' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('401') || msg.includes('invalid_api_key') ? 401 : 500;
    console.error('Generate error:', msg);
    return NextResponse.json({ error: 'AI生成に失敗しました: ' + msg }, { status });
  }
}
