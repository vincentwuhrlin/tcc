/**
 * uptimize-stats — Check UPTIMIZE Foundry API usage and spend.
 *
 * Makes a minimal API call (1 token) and reads the LiteLLM response headers
 * to display current spend, model info, and response cost.
 *
 * Usage:
 *   npm run uptimize:stats
 */
import { API_KEY, API_BASE_URL, API_MODEL, printHeader } from "../config.js";

export async function uptimizeStats(): Promise<void> {
  printHeader();

  if (!API_BASE_URL) {
    console.error("❌ API_BASE_URL not set. This command requires UPTIMIZE Foundry.");
    process.exit(1);
  }

  if (!API_KEY) {
    console.error("❌ API_KEY not set.");
    process.exit(1);
  }

  const url = `${API_BASE_URL}/model/${API_MODEL}/invoke`;

  console.log("📊 UPTIMIZE Foundry Stats");
  console.log(`   URL:   ${url}`);
  console.log(`   Model: ${API_MODEL}`);
  console.log();

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        "api-key": API_KEY,
        "openai-standard": "True",
      },
      body: JSON.stringify({
        model: API_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`❌ API error ${res.status}: ${body.slice(0, 200)}`);
      process.exit(1);
    }

    // Extract LiteLLM headers
    const get = (key: string) => res.headers.get(key) ?? "—";

    console.log("   ┌─────────────────────────────────────────");
    console.log(`   │ 💰 Key spend (cumulative):  $${get("x-litellm-key-spend")}`);
    console.log(`   │ 💵 This call cost:          $${get("x-litellm-response-cost")}`);
    console.log("   ├─────────────────────────────────────────");
    console.log(`   │ 🤖 Model ID:       ${get("x-litellm-model-id")}`);
    console.log(`   │ 📦 Model group:     ${get("x-litellm-model-group")}`);
    console.log(`   │ 🔧 LiteLLM version: ${get("x-litellm-version")}`);
    console.log("   ├─────────────────────────────────────────");
    console.log(`   │ ⏱️  Response time:   ${get("x-litellm-response-duration-ms")}ms`);
    console.log(`   │ 🔄 Retries:         ${get("x-litellm-attempted-retries")}`);
    console.log(`   │ 🔀 Fallbacks:       ${get("x-litellm-attempted-fallbacks")}`);
    console.log("   └─────────────────────────────────────────");
    console.log();

    // Also check nomic endpoint if available
    const nomicUrl = `${API_BASE_URL}/nomic/v1/embeddings`;
    try {
      const nomicRes = await fetch(nomicUrl, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          "api-key": API_KEY,
        },
        body: JSON.stringify({ input: "test", model: "nomic-embed-text-v1" }),
      });

      if (nomicRes.ok) {
        console.log("   ✅ Nomic embedding endpoint: accessible");
      } else {
        console.log(`   ⚠️  Nomic embedding endpoint: ${nomicRes.status}`);
      }
    } catch {
      console.log("   ⚠️  Nomic embedding endpoint: unreachable");
    }

  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
