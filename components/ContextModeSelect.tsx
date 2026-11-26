import React from "react";

export function ContextModeOptions() {
  return <>
    <option value="auto">自動</option>
    <option value="none">参照しない</option>
    <option value="memory">Memory</option>
    <option value="archive">Archive</option>
    <option value="both">両方</option>
  </>;
}
