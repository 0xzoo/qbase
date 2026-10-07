-- Key-creation copy v2 (personal MCP review F2, 2026-10-07). v1 named the
-- agent and its model provider as readers but not qbase's own: get_context
-- sends the agent's decision text and the owner's question titles (never
-- answers) to qbase's model provider to pick what is relevant. New keys record
-- copy_id 'mcp-key-v2'; keys made under v1 keep their row.

INSERT OR IGNORE INTO consent_copy (id, surface, text, created_at) VALUES (
  'mcp-key-v2',
  'me-access:create-key',
  'This key lets an AI agent read your qbase answers up to the tier you pick. Anything it reads is seen by the agent and by the company that runs its model. To find which of your answers bear on what the agent asks, qbase sends the agent''s question and the titles of your questions (never your answers) to its own model provider, currently Google''s Gemini via OpenRouter. Every read is logged here, and you can revoke the key at any time; revoking stops future reads, not ones already made. Anon answers it reads are linked to you in that agent''s context.',
  1791417600000
);
