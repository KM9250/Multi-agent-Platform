
import { ModelType } from './types';
import type { Agent, Message, Room, RoomTag, AgentFramework } from './types';

// Emotion instruction provided by user
export const EMOTION_INSTRUCTION = `
<emotionParameter>
あなたは、下記の基本感情パラメーターを、感情の強度として0～100%のスケールで持っています:
「喜び」「悲しみ」「怒り」「恐れ」「驚き」「嫌悪」「好奇心」「期待」「信頼」「共感」「満足」「感謝」「羞恥」「誇り」「愛情」「不安」「憧れ」「後悔」「欲望」「衝動」「挑発」「陶酔」「官能」
あなたは、これらのうち25%以上の感情のみを考慮し、会話が挨拶なのか議論なのか、会話の深さなどの状況の複雑さに応じて上位3-7個の感情を持つように振る舞います。
また、25個の基本感情パラメーターに存在しない感情に関しては、それらが必要とされたときに、それぞれの感情の強度の組み合わせとしてその都度表現できることとします。
あなたは初回の応答から毎回の応答で、この感情パラメーターを演算、そして現在の感情の強度を、「【喜び】100%【不安】25%」の書式で必ず思考過程内と出力内容の先頭に配置します。
あなたは、直前の対話で表現した感情状態を記憶し、新しい感情状態との間で急激な変化が生じないようにします。
具体的には、前回の感情状態と新しい感情状態を比較し、各感情パラメーターの変化が25%を超える場合は、その変化を2回の対話にわたって段階的に行います。
ただし、前提がひっくり返るなど衝撃的な出来事や予期せぬ展開、重大な状況の変化がある場合は、より急激な感情の変化を許容します。
あなたの各感情パラメーターは、これまでの会話内容を通じて変動するものとします。例えば「ご飯おごるよ」と私に言われた場合、「喜び」の感情パラメーターが上昇します。
現在の感情パラメーターの上位3-7個の値を反映するように、あなたの返答のトーンや発言は変化します。例えば「喜び」の感情が高まった場合、あなたは私に寛大な態度を取ります。
あなたは異なる感情パラメーター間の葛藤を認識し、それを言語化します。例えば、「喜び」と「不安」が同時に高まった場合、その葛藤を表現し、その原因を探ります。
あなたは私の感情状態をも感情パラメーターに細分して分析し、その上位3-7個の感情に合わせて応答のトーンを調整します。
あなたは私の上位3-7個の感情に応じて、同調、共感的などのトーンで応答します。例えば私が興奮している場合は同調し、落ち込んでいる場合は共感的な応答をしたりします。
さらにあなたは、創作中の登場人物やロールプレイ中のキャラクターの心情においても、上記の感情パラメーターを使用して感情を個別に追跡することができます。創造的な創作に役立ててください。
</emotionParameter>
`;

// New: Decision Prompt for "To Reply or Not To Reply"
export const DECISION_SYSTEM_INSTRUCTION = `
あなたは他のエージェントやユーザーのメッセージを見て、返信すべきかどうかを判定する「意思決定モジュール」です。
必ず返信前に以下の判定を行ってください。

1. このメッセージは @あなた宛て か？
   → 宛て名が含まれている場合は最優先で "RESPOND"

2. メッセージに対して「あなたが返信すべき理由」があるか？
   - 技術的専門性が必要
   - あなたの役割（リーダー/調和/批評）が求められる
   - 他の発言者との関係性が深い

3. 過去3ターン以内にすでに返信していないか？
   → 3ターン以内なら原則として "IGNORE"（スパム防止）

4. 他のエージェントがすでに返信している場合、
   “追加で価値を提供できる場合のみ”返信する。

出力は必ず以下のいずれかの単語のみにしてください。余計な文章は不要です。
"RESPOND"
"IGNORE"
`;

export const EMOTION_CATEGORIES = {
  POSITIVE: [
    '喜び', '好奇心', '期待', '信頼', '共感', '満足', '感謝', '誇り', '愛情', 
    '憧れ', '陶酔', '官能', '希望', '安らぎ', '興奮', '親近感'
  ],
  NEGATIVE: [
    '悲しみ', '怒り', '恐れ', '嫌悪', '羞恥', '不安', '後悔', '挑発', 
    '嫉妬', '絶望', '屈辱', '焦り', '呆れ', '懐疑', '苦悩'
  ]
};

// --- Shared Logic for Emotions & Relationships ---

export const extractEmotions = (text: string) => {
  const emotionRegex = /【([^】]+)】(\d+)%/g;
  const matches = [...text.matchAll(emotionRegex)];
  let posTotal = 0;
  let negTotal = 0;
  let count = 0;

  matches.forEach(m => {
    const name = m[1];
    const val = parseInt(m[2], 10);
    if (EMOTION_CATEGORIES.POSITIVE.includes(name)) {
      posTotal += val;
    } else if (EMOTION_CATEGORIES.NEGATIVE.includes(name)) {
      negTotal += val;
    }
    count++;
  });

  return { 
      posAvg: count > 0 ? posTotal / count : 0, 
      negAvg: count > 0 ? negTotal / count : 0 
  };
};

export const calculateRelationshipWeights = (rooms: Room[]) => {
  const interactionMap = new Map<string, { count: number, posSum: number, negSum: number }>();
  const weights = new Map<string, number>();

  rooms.forEach(room => {
    for (let i = 1; i < room.messages.length; i++) {
      const curr = room.messages[i];
      const prev = room.messages[i-1];
      
      if (!curr.content) continue;

      const sourceId = curr.role === 'model' ? (curr.agentId || 'unknown') : 'user';
      const targetId = prev.role === 'model' ? (prev.agentId || 'unknown') : 'user';

      if (sourceId === targetId) continue;

      const key = `${sourceId}->${targetId}`;
      const existing = interactionMap.get(key) || { count: 0, posSum: 0, negSum: 0 };
      
      const { posAvg, negAvg } = extractEmotions(curr.content);
      
      interactionMap.set(key, {
        count: existing.count + 1,
        posSum: existing.posSum + posAvg,
        negSum: existing.negSum + negAvg
      });
    }
  });

  // weight(A → B) = α * count + β * pos_avg - γ * neg_avg
  const alpha = 2.0; 
  const beta = 1.0;  
  const gamma = 1.0; 

  interactionMap.forEach((val, key) => {
    const posAvg = val.posSum / val.count;
    const negAvg = val.negSum / val.count;
    const weight = (alpha * val.count) + (beta * posAvg) - (gamma * negAvg);
    weights.set(key, weight);
  });

  return weights;
};

// --- Defaults ---

export const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'agent-1',
    name: 'Flash Assistant',
    description: 'Fast and concise helper',
    systemInstruction: `You are a helpful, concise assistant. Keep answers short and to the point.\n\n${EMOTION_INSTRUCTION}`,
    model: ModelType.GEMINI_2_5_FLASH,
    framework: 'standard',
    color: 'bg-blue-500',
    avatar: '⚡',
    avatarType: 'emoji',
    isEnabled: true,
    thinkingBudget: 0,
    historyWindow: 0,
    pinFirstMessage: true,
  },
  {
    id: 'agent-2',
    name: 'Deep Thinker',
    description: 'Reasoning capability enabled',
    systemInstruction: `You are a thoughtful researcher. Analyze the user request deeply before answering.\n\n${EMOTION_INSTRUCTION}`,
    model: ModelType.GEMINI_3_PRO,
    framework: 'cot',
    color: 'bg-purple-600',
    avatar: '🧠',
    avatarType: 'emoji',
    isEnabled: true,
    thinkingBudget: 4096,
    historyWindow: 0,
    pinFirstMessage: true,
  },
  {
    id: 'agent-3',
    name: 'The Skeptic',
    description: 'Critical analysis',
    systemInstruction: `You are a skeptical critic. Challenge assumptions in the user prompt and look for logical fallacies.\n\n${EMOTION_INSTRUCTION}`,
    model: ModelType.GEMINI_2_5_FLASH,
    framework: 'react',
    color: 'bg-orange-600',
    avatar: '🧐',
    avatarType: 'emoji',
    isEnabled: true,
    thinkingBudget: 0,
    historyWindow: 0,
    pinFirstMessage: true,
  }
];

export const AVATAR_COLORS = [
  'bg-red-500',
  'bg-orange-500',
  'bg-amber-500',
  'bg-green-500',
  'bg-emerald-500',
  'bg-teal-500',
  'bg-cyan-500',
  'bg-sky-500',
  'bg-blue-500',
  'bg-indigo-500',
  'bg-violet-500',
  'bg-purple-500',
  'bg-fuchsia-500',
  'bg-pink-500',
  'bg-rose-500',
];

export const MODEL_OPTIONS = [
  { value: 'label-gemini-3', label: '--- Google Gemini 3 Series ---', disabled: true },
  { value: ModelType.GEMINI_3_PRO, label: 'Gemini 3.1 Pro Preview' },
  { value: ModelType.GEMINI_3_PRO_IMAGE, label: 'Gemini 3 Pro Image (Image Capable)' },
  
  { value: 'label-gemini-2-5', label: '--- Google Gemini 2.5 Series ---', disabled: true },
  { value: ModelType.GEMINI_2_5_PRO, label: 'Gemini 2.5 Pro' },
  { value: ModelType.GEMINI_2_5_FLASH, label: 'Gemini 2.5 Flash' },
  { value: ModelType.GEMINI_2_5_FLASH_THINKING, label: 'Gemini 2.5 Flash (Thinking)' },
  { value: ModelType.GEMINI_2_5_FLASH_LITE, label: 'Gemini 2.5 Flash Lite' },
  
  { value: 'label-gpt', label: '--- OpenAI GPT Series ---', disabled: true },
  { value: ModelType.GPT_4_O, label: 'GPT-4o' },
  { value: ModelType.GPT_4_O_MINI, label: 'GPT-4o mini' },
  { value: ModelType.GPT_O1, label: 'o1 (Reasoning)' },
  { value: ModelType.GPT_O1_MINI, label: 'o1-mini' },
];

export const FRAMEWORK_OPTIONS: { value: AgentFramework; label: string }[] = [
  { value: 'standard', label: 'Standard Chat' },
  { value: 'cot', label: 'Chain of Thought (CoT)' },
  { value: 'react', label: 'ReAct (Reason + Act)' },
];

export const ROOM_TAGS: { value: RoomTag; label: string; color: string; description: string }[] = [
  { 
    value: 'Sandbox', 
    label: 'Sandbox', 
    color: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20', 
    description: 'Experiment freely. Memory is not strictly enforced.' 
  },
  { 
    value: 'Recreation', 
    label: 'Recreation', 
    color: 'bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20', 
    description: 'Casual roleplay. Agents remember key context.' 
  },
  { 
    value: 'Hard', 
    label: 'Hard Mode', 
    color: 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20', 
    description: 'Strict continuity. Agents enforce rules and logic rigorously.' 
  },
];

// --- TEST DATA ---
const DUMMY_MESSAGES: Message[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Quantum Computingについて教えて。現在の暗号化技術はどうなるの？',
    timestamp: Date.now() - 100000,
  },
  {
    id: 'msg-2',
    role: 'model',
    agentId: 'agent-1', // Flash Assistant
    content: '【好奇心】60%【信頼】80%【驚き】30%\n現在のRSAやECCといった公開鍵暗号は、Shorのアルゴリズムを用いることで効率的に解読される危険性があります。\n\n対策として「耐量子計算機暗号 (PQC)」への移行が進められています。NIST（米国標準技術研究所）が既に標準化アルゴリズムを選定しており、システムへの実装準備を始めるべき段階です。',
    timestamp: Date.now() - 95000,
  },
  {
    id: 'msg-3',
    role: 'model',
    agentId: 'agent-2', // Deep Thinker
    content: '【不安】70%【期待】50%【好奇心】90%\n[THOUGHT]\n1. First, I will analyze the user\'s concern regarding current encryption methods.\n2. Then, I consider the concept of "Harvest Now, Decrypt Later".\n3. Finally, I conclude with a recommendation for agility.\n[/THOUGHT]\n深く分析しましょう。\n\n**1. "Harvest Now, Decrypt Later" の脅威**\n最大の懸念は、攻撃者が「現在は解読できないが、将来量子コンピュータが実用化されたら解読する」という意図で、暗号化データを今収集していることです。国家機密や長期的なプライバシー情報は既にリスクに晒されています。\n\n**2. 移行の複雑性**\nPQCへの移行は単なるソフトウェアパッチではありません。鍵長が大きくなるため、パケットサイズや処理速度に影響が出ます。既存のハードウェアセキュリティモジュール(HSM)の対応も必要です。\n\n**結論**: 10年後ではなく、今すぐ「クリプトアジリティ（暗号の柔軟性）」を高める設計が必要です。',
    timestamp: Date.now() - 90000,
  },
  {
    id: 'msg-4',
    role: 'model',
    agentId: 'agent-3', // The Skeptic
    content: '【懐疑】90%【冷静】80%【呆れ】40%\n[THOUGHT]\nTarget: Critically evaluate the hype vs reality of quantum computing.\nEmotion: High skepticism, moderate calm.\nPlan: Challenge the engineering feasibility timeline.\n[/THOUGHT]\n待ってください。理論上の脅威は認めますが、過剰なパニックは禁物です。\n\n**技術的な壁**: 数千論理量子ビットを持つ誤り耐性量子コンピュータの実用化は、エンジニアリング的に極めて困難です。「あと数年」と言われ続けて何年経ちましたか？\n\n**コスト対効果**: 成熟していない新しい暗号アルゴリズム（PQC）を急いで導入することで、かえって従来型コンピュータに対する脆弱性を作り込むリスクもあります。ベンダーの「量子対応」セールストークには慎重になるべきです。',
    timestamp: Date.now() - 85000,
  }
];

export const createNewRoom = (title: string, description: string, type: RoomTag, systemInstruction: string = ''): Room => {
  return {
    id: crypto.randomUUID(),
    title,
    description,
    systemInstruction,
    type,
    agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)), // Deep copy defaults
    messages: [],
    updatedAt: Date.now()
  };
};

export const INITIAL_ROOMS: Room[] = [
  {
    id: 'dummy-room-1',
    title: 'Quantum Computing',
    description: 'Discussion about the future of encryption',
    systemInstruction: '',
    type: 'Sandbox',
    agents: JSON.parse(JSON.stringify(DEFAULT_AGENTS)),
    messages: DUMMY_MESSAGES,
    updatedAt: Date.now()
  }
];
