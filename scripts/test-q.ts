/**
 * Test script for Q Agent
 * 
 * Usage:
 *   # Get Q's status (no auth required)
 *   curl https://qbase.tech/api/q/status
 * 
 *   # Post a test cast (requires auth)
 *   curl -X POST https://qbase.tech/api/q/cast \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer YOUR_ADMIN_SECRET" \
 *     -d '{"text": "Testing Q agent capabilities."}'
 * 
 *   # Local development
 *   curl http://localhost:8787/api/q/status
 * 
 * Environment:
 *   QBASE_URL        Base URL (default: http://localhost:8787)
 *   QGENT_ADMIN_SECRET  Admin secret for write operations
 */

const BASE_URL = process.env.QBASE_URL || "http://localhost:8787";
const ADMIN_SECRET = process.env.QGENT_ADMIN_SECRET || "";

async function testQStatus() {
  console.log("📊 Testing Q status...");
  const response = await fetch(`${BASE_URL}/api/q/status`);
  const data = await response.json();
  console.log("Status:", JSON.stringify(data, null, 2));
  return data;
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ADMIN_SECRET) {
    headers["Authorization"] = `Bearer ${ADMIN_SECRET}`;
  }
  return headers;
}

async function testQCast(text: string) {
  console.log(`📢 Testing Q cast: "${text}"`);
  if (!ADMIN_SECRET) {
    console.log("⚠️  No QGENT_ADMIN_SECRET set - cast will fail with 401");
  }
  const response = await fetch(`${BASE_URL}/api/q/cast`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({ text }),
  });
  const data = await response.json();
  console.log("Cast result:", JSON.stringify(data, null, 2));
  return data;
}

async function testQObserve() {
  console.log("🔍 Testing Q observation...");
  if (!ADMIN_SECRET) {
    console.log("⚠️  No QGENT_ADMIN_SECRET set - observe will fail with 401");
  }
  const response = await fetch(`${BASE_URL}/api/q/observe`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      category: "pattern",
      content: "Test observation: Users engage more with questions about values than preferences.",
      confidence: 0.75,
      source: "test_script",
    }),
  });
  const data = await response.json();
  console.log("Observation result:", JSON.stringify(data, null, 2));
  return data;
}

async function testQDirective() {
  console.log("📋 Testing Q directive...");
  if (!ADMIN_SECRET) {
    console.log("⚠️  No QGENT_ADMIN_SECRET set - directive will fail with 401");
  }
  const response = await fetch(`${BASE_URL}/api/q/direct`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      target: "zoo",
      content: "Test directive: Verify Q agent is operational.",
      priority: 3,
    }),
  });
  const data = await response.json();
  console.log("Directive result:", JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  const command = process.argv[2] || "status";

  switch (command) {
    case "status":
      await testQStatus();
      break;
    case "cast":
      const text = process.argv[3] || "Hello from Q. Testing agent capabilities.";
      await testQCast(text);
      break;
    case "observe":
      await testQObserve();
      break;
    case "directive":
      await testQDirective();
      break;
    case "all":
      await testQStatus();
      await testQObserve();
      await testQDirective();
      // Don't cast by default in "all" to avoid spam
      console.log("\n⚠️  Skipping cast test. Run 'cast' explicitly to test posting.");
      break;
    default:
      console.log(`
Usage: npx tsx scripts/test-q.ts [command]

Commands:
  status     Get Q's current status (default)
  cast       Post a test cast (optional: provide text as 3rd arg)
  observe    Test recording an observation
  directive  Test issuing a directive
  all        Run all tests except cast

Environment:
  QBASE_URL  Base URL (default: http://localhost:8787)
      `);
  }
}

main().catch(console.error);
