export type StreamCompletionKind =
  | 'complete'
  | 'empty_response'
  | 'aborted_partial'
  | 'aborted_empty';

export const classifyStreamCompletion = (text: string, aborted: boolean): StreamCompletionKind => {
  const isEmpty = text.trim().length === 0;
  if (aborted) return isEmpty ? 'aborted_empty' : 'aborted_partial';
  return isEmpty ? 'empty_response' : 'complete';
};
