import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Message, ResponseDecision, Room } from '../types.ts';
import { parseDecisionText } from '../utils/decisionDiagnostics.ts';
import { partitionTurnDecisions, resolveTurnDecisions, type ParticipationDecisionContext } from '../utils/turnDecisions.ts';
import { applyInitialUserTurnFallback } from '../utils/responseFallback.ts';
import { clearMessageReactions, upsertMessageReaction } from '../utils/messageReactions.ts';
import { createRecipientSnapshot } from '../utils/recipientTargets.ts';
import { normalizeAgent } from '../utils/contextFiles.ts';
import { normalizeRoom } from '../utils/persistenceMigration.ts';
import { buildParticipationDecisionPrompt } from '../services/geminiService.ts';

const agent = (id: string, enabled = true): Agent => ({ id, name: id.toUpperCase(), description: `desc-${id}`, systemInstruction: `PRIVATE-${id}`, model: 'm', framework: 'standard', color: '', avatar: '', isEnabled: enabled, thinkingBudget: 0 });
const user = (content: string, extra: Partial<Message> = {}): Message => ({ id: 'u', role: 'user', content, timestamp: 1, ...extra });
const ignore = (a: Agent) => ({ agent: a, decision: { outcome: 'IGNORE', source: 'llm_decision', latencyMs: 1 } as ResponseDecision });
const stamp = (a: Agent) => ({ agent: a, decision: { outcome: 'STAMP', reaction: 'ACK', source: 'llm_decision', latencyMs: 1 } as ResponseDecision });

test('STAMP parser accepts every semantic and rejects non-exact output', () => {
  for (const semantic of ['ACK', 'AGREE', 'THINK', 'AMUSED', 'CARE', 'DISAGREE'] as const) assert.deepEqual([parseDecisionText(`STAMP:${semantic}`).outcome, parseDecisionText(`STAMP:${semantic}`).reaction], ['STAMP', semantic]);
  assert.deepEqual([parseDecisionText(' stamp:agree ').outcome, parseDecisionText(' stamp:agree ').reaction], ['STAMP', 'AGREE']);
  for (const invalid of ['STAMP', 'STAMP:HAPPY', 'RESPOND because...']) assert.equal(parseDecisionText(invalid).outcome, 'ERROR');
});

test('structured snapshots force only enabled target members while non-targets decide', async () => {
  const agents = [agent('a'), agent('b'), agent('off', false)];
  const calls: string[] = [];
  const contexts = new Map<string, ParticipationDecisionContext>();
  const evaluateDecision = async (a: Agent, context: ParticipationDecisionContext) => { calls.push(a.id); contexts.set(a.id, context); return { outcome: 'IGNORE', source: 'llm_decision', latencyMs: 1 } as ResponseDecision; };
  const direct = await resolveTurnDecisions({ activeAgents: agents.filter(a => a.isEnabled), history: [user('@B', { recipientTarget: { type: 'agent', agentIds: ['a'] } })], turnDepth: 1, memoryRequest: false, evaluateDecision });
  assert.deepEqual(direct.map(item => item.decision.source), ['recipient_target', 'llm_decision']);
  assert.deepEqual(calls, ['b']);
  assert.deepEqual(contexts.get('b')?.recipient, { type: 'agent', isExplicitRecipient: true, isExplicitlyTargeted: false });
  calls.length = 0;
  const all = await resolveTurnDecisions({ activeAgents: agents.filter(a => a.isEnabled), history: [user('hi', { recipientTarget: { type: 'all', agentIds: ['a', 'b', 'off'] } })], turnDepth: 1, memoryRequest: false, evaluateDecision });
  assert.deepEqual(all.map(item => item.decision.source), ['recipient_target', 'recipient_target']); assert.deepEqual(calls, []);
  const group = await resolveTurnDecisions({ activeAgents: agents.filter(a => a.isEnabled), history: [user('@A', { recipientTarget: { type: 'group', groupId: 'g', agentIds: ['b'] } })], turnDepth: 1, memoryRequest: false, evaluateDecision });
  assert.deepEqual(group.map(item => item.decision.source), ['llm_decision', 'recipient_target']);
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(contexts.get('a')?.recipient, { type: 'group', isExplicitRecipient: true, isExplicitlyTargeted: false, groupId: 'g' });
  calls.length = 0;
  const legacy = await resolveTurnDecisions({ activeAgents: agents.filter(a => a.isEnabled), history: [user('@A')], turnDepth: 1, memoryRequest: false, evaluateDecision });
  assert.equal(legacy[0].decision.source, 'mentioned');
  assert.deepEqual(calls, ['b']);
  calls.length = 0;
  const auto = await resolveTurnDecisions({ activeAgents: agents.filter(a => a.isEnabled), history: [user('@A', { recipientTarget: { type: 'auto' } })], turnDepth: 1, memoryRequest: false, evaluateDecision });
  assert.deepEqual(auto.map(item => item.decision.source), ['mentioned', 'llm_decision']);
  assert.deepEqual(calls, ['b']);
  assert.deepEqual(contexts.get('b')?.recipient, { type: 'auto', isExplicitRecipient: false, isExplicitlyTargeted: false });
});

test('reaction upsert is semantic domain state and clearing is message-scoped', () => {
  let reactions = upsertMessageReaction([], { id: 'r1', messageId: 'm1', agentId: 'a', semantic: 'ACK', turnId: 't', timestamp: 1 });
  reactions = upsertMessageReaction(reactions, { messageId: 'm1', agentId: 'a', semantic: 'AGREE', turnId: 't', timestamp: 2 });
  reactions = upsertMessageReaction(reactions, { id: 'r2', messageId: 'm1', agentId: 'b', semantic: 'THINK', turnId: 't' });
  reactions = upsertMessageReaction(reactions, { id: 'r3', messageId: 'm2', agentId: 'a', semantic: 'CARE', turnId: 't' });
  assert.equal(reactions.length, 3); assert.equal(reactions.find(r => r.id === 'r1')?.semantic, 'AGREE');
  assert.deepEqual(clearMessageReactions(reactions, 'm1').map(r => r.id), ['r3']);
});

test('stamp-only decisions have no normal generation targets', () => {
  const decisions = [stamp(agent('a')), stamp(agent('b'))];
  assert.equal(partitionTurnDecisions(decisions).responding.length, 0);
  assert.equal(partitionTurnDecisions(decisions).stamping.length, 2);
});

test('fallback requires text for questions and requests but permits acknowledgement stamps', () => {
  const a = agent('a'), b = agent('b');
  for (const content of ['A案とB案ならどちらがいいですか？', 'このコードをレビューしてください', 'これ調べて', 'この2つを比較して', 'ここを修正して', '一旦まとめて', '判別不能な入力', 'それでお願いします。', 'これでお願いします。', 'その方法でお願いします。', 'これをお願いします。']) assert.equal(applyInitialUserTurnFallback([stamp(a), ignore(b)], [user(content)], 0).filter(x => x.decision.outcome === 'RESPOND').length, 1);
  for (const content of ['了解', '了解です。', 'ありがとう。', 'ありがとうございます。', '承知しました。', 'OKです。', 'ではA案で進めます。']) assert.equal(applyInitialUserTurnFallback([stamp(a), ignore(b)], [user(content)], 0).filter(x => x.decision.outcome === 'RESPOND').length, 0);
  assert.equal(applyInitialUserTurnFallback([stamp(a), ignore(b)], [user('', { attachments: [{ id: 'x', type: 'text', mimeType: 'text/plain', name: 'x', data: 'x' }] })], 0).filter(x => x.decision.outcome === 'RESPOND').length, 1);
  assert.equal(applyInitialUserTurnFallback([{ agent: a, decision: { outcome: 'ERROR', source: 'api_error', latencyMs: 1 } }], [user('?')], 0).filter(x => x.decision.outcome === 'RESPOND').length, 0);
});

test('participation prompt excludes persona instructions and migrations normalize legacy state', () => {
  const normalized = normalizeAgent({ ...agent('a'), groups: [' x ', '', 'x'], participationProfile: ' active ' });
  assert.deepEqual(normalized.groups, ['x']); assert.equal(normalized.participationProfile, 'active');
  const prompt = buildParticipationDecisionPrompt(normalized, { recentMessageCount: 3, lastSpokenDistance: 2, recipient: { type: 'group', isExplicitRecipient: true, isExplicitlyTargeted: false, groupId: 'reviewers' } });
  assert.match(prompt, /Participation Profile: active/); assert.match(prompt, /messages in last 8: 3/); assert.match(prompt, /last spoke: 2 messages ago/); assert.doesNotMatch(prompt, /PRIVATE-a/);
  assert.match(prompt, /explicit recipient: yes/); assert.match(prompt, /you are explicitly targeted: no/); assert.match(prompt, /recipient type: group/); assert.match(prompt, /recipient group: reviewers/);
  const room = normalizeRoom({ id: 'r', title: '', description: '', type: 'Sandbox', agents: [agent('a')], messages: [user('x')], updatedAt: 1 } as Room);
  assert.deepEqual(room.reactions, []); assert.deepEqual(room.agents[0].groups, []); assert.equal(room.agents[0].participationProfile, ''); assert.equal(room.messages[0].recipientTarget, undefined);
  assert.deepEqual(createRecipientSnapshot('all', [agent('a'), agent('b')]), { type: 'all', agentIds: ['a', 'b'] });
});
