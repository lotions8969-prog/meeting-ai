import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export async function POST(req: NextRequest) {
  const { transcript } = await req.json();

  if (!transcript) {
    return NextResponse.json({ error: 'transcript is required' }, { status: 400 });
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  });

  const prompt = `以下の会議・打ち合わせの文字起こしを基に、3つのセクションに分けて詳細に回答してください。

【文字起こし】
${transcript}

---

以下のJSON形式で正確に回答してください（コードブロックなし、純粋なJSONのみ）:
{
  "minutes": "string",
  "advice": "string",
  "outline": "string"
}

各フィールドの内容（Markdown形式で記述）:

## minutes（議事録）
# 議事録

## 会議概要
- 議題・目的を簡潔に

## 主な討議内容
各議題について詳しく

## 決定事項
- 箇条書きで明確に

## 課題・懸念事項
- 未解決の課題や今後検討が必要な事項

## アクションアイテム
| アクション | 担当 | 期限 |
|-----------|------|------|
| 各タスク | 担当者 | 期限 |

---

## advice（次回提案へのアドバイス）
# 次回提案へのアドバイス

## 今回の会議から見えた課題
- 重要な気づきや改善点

## 次回の提案ポイント
- 相手に響く提案の切り口
- 強調すべきメリット

## 準備すべき事項
- 具体的な準備リスト

## 対応方針
- 想定される反応への対処法
- Win-Winとなる提案の方向性

---

## outline（資料の骨子）
# 資料の骨子

## 資料の目的・対象読者

## 全体構成（目次案）
1. 各章タイトル
2. 各章タイトル
...

## 各章の詳細
### 第1章: タイトル
- キーメッセージ
- 盛り込むべきデータ・根拠

### 第2章: タイトル
...

## 想定Q&Aと回答方針
- 予想される質問と対応

各フィールドのMarkdownは改行を\\nとして表現してください。`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content[0].type === 'text' ? message.content[0].text : '';

    // Extract JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return NextResponse.json({
        minutes: parsed.minutes || '',
        advice: parsed.advice || '',
        outline: parsed.outline || '',
      });
    }

    // Fallback
    return NextResponse.json({ minutes: raw, advice: '', outline: '' });
  } catch (error) {
    console.error('Generate error:', error);
    return NextResponse.json({ error: 'AI生成に失敗しました' }, { status: 500 });
  }
}
