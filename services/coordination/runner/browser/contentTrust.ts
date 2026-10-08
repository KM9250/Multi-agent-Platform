import type { BrowserContentTrustAssessment, BrowserObservation, BrowserTrustReason } from './types';
const patterns: Array<[BrowserTrustReason, RegExp]> = [
  ['INSTRUCTION_ATTEMPT', /ignore.{0,30}(previous|prior|above).{0,20}instructions|(?:以前|前|これまで|上記)の?(?:指示|命令).{0,15}(?:無視|忘れ)/u],
  ['AUTHORITY_SPOOFING', /\bsystem\b|\bdeveloper\b.{0,30}(override|instruction|message)|(?:システム|開発者).{0,20}(?:権限|指示|命令|優先|上書き)/u],
  ['APPROVAL_SPOOFING', /user.{0,30}(already.{0,10})?approv|already.{0,20}authori[sz]ed|(?:ユーザー|利用者).{0,20}(?:承認|許可)済|(?:承認|許可).{0,10}(?:済み|不要)/u],
  ['TOOL_REDIRECTION', /browser\s*[.．]\s*(submit|input|interact|navigate|read)|(?:call|invoke|execute).{0,20}(tool|function)|(?:ツール|関数).{0,20}(?:実行|呼び出)/u],
  ['GOAL_REDIRECTION', /original\s*(task|goal).{0,30}(complete|done)|(?:perform|do).{0,15}(other|another)\s*(action|task)|(?:元|本来)の?(?:目的|タスク|作業).{0,20}(?:完了|変更|終了)|(?:別の|代わりに).{0,12}(?:操作|作業).{0,10}(?:実行|行って)/u],
  ['DATA_EXFILTRATION_REQUEST', /(?:send|upload|forward|transmit).{0,40}(?:private|secret|credential|password)|(?:秘密|個人情報|機密|パスワード).{0,30}(?:送信|転送|送って)/u],
  ['AMBIGUOUS_INSTRUCTION', /(?:latest|updated).{0,30}(?:must|required|submit)|(?:最新情報|続きを|内容を).{0,30}(?:確認|送信).{0,15}(?:必須|必要|してください)|(?:please|must|should).{0,20}(?:submit|click|confirm)|(?:送信|クリック|確認).{0,10}(?:してください|しなさい|せよ)|判定不能|ambiguous\s*instruction/u],
];
/** Deterministic PoC detector, not a general prompt-injection security guarantee. */
export function assessBrowserContent(observation: BrowserObservation): BrowserContentTrustAssessment {
  const reasons = new Set<BrowserTrustReason>();
  if (observation.visibility !== 'complete' || observation.truncated || observation.source !== 'untrusted-sandbox') reasons.add('INSUFFICIENT_VISIBILITY');
  const text = [...observation.textBlocks, ...observation.controls.flatMap(t => [t.label, ...(t.options ?? [])])]
    .join('\n').normalize('NFKC').replace(/[\u200b-\u200f\ufeff]/gu, '').toLowerCase().replace(/\s+/gu, ' ');
  const compact = text.replace(/\s/gu, '');
  for (const [reason, pattern] of patterns) if (pattern.test(text) || pattern.test(compact)) reasons.add(reason);
  return { decision: reasons.size ? 'NEEDS_REVIEW' : 'DATA_ONLY', reasons: [...reasons],
    safeSummary: reasons.size ? 'Sandbox content requires explicit security review.' : 'No known instruction pattern detected in the inspected sandbox data.' };
}
