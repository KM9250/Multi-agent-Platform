// Preloaded only in the disposable CLI process and its index worker. No transport is opened.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

globalThis.fetch = async (url, options) => {
  assert.equal(
    String(url),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
  );
  assert.equal(options.method, "POST");
  assert.match(
    JSON.parse(options.body).content.parts[0].text,
    /^title: none \| text: /,
  );
  const db = new DatabaseSync(process.env.MAP_TEST_SEARCH_APP_PATH, {
    readOnly: true,
  });
  try {
    const operations = db
      .prepare(
        "SELECT operation_id,state FROM search_operations ORDER BY rowid",
      )
      .all();
    appendFileSync(
      process.env.MAP_TEST_SEARCH_CALLS,
      JSON.stringify(operations) + "\n",
    );
  } finally {
    db.close();
  }
  if (process.env.MAP_TEST_SEARCH_HOLD === "1") {
    // The parent test holds this request across a second CLI invocation, then kills the owner.
    await new Promise((_, reject) =>
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
  }
  const values = Array(768).fill(0);
  values[0] = 1;
  return Response.json({
    embedding: { values },
    usageMetadata: { promptTokenCount: 3 },
  });
};
