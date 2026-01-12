# Nillion Proxy Service

A lightweight Node.js proxy that handles Nillion SecretVault operations for the main Cloudflare Workers app.

## Why?

The Nillion SDK depends on `libsodium-sumo` which requires a full Node.js environment. Cloudflare Workers run on V8 which lacks the necessary crypto APIs at module initialization time.

## Setup

### 1. Install Fly.io CLI

```bash
# macOS
brew install flyctl

# Or download from https://fly.io/docs/hands-on/install-flyctl/
```

### 2. Login to Fly.io

```bash
fly auth login
```

### 3. Create the app (first time only)

```bash
cd nillion-proxy
fly launch --no-deploy
```

When prompted:
- App name: `qbase-nillion-proxy` (or your choice)
- Region: `sjc` (San Jose) or closest to your users
- Don't set up Postgres/Redis

### 4. Set secrets

```bash
# Generate a random secret for proxy auth
export PROXY_SECRET=$(openssl rand -hex 32)
echo "Save this PROXY_SECRET: $PROXY_SECRET"

# Set all the secrets
fly secrets set \
  PROXY_SECRET="$PROXY_SECRET" \
  NILLION_ORG_KEY="your-nillion-private-key" \
  NILLION_NODES='[{"url":"https://node1.nillion.network"},...]' \
  NILLION_PRIVATE_ANSWER_SCHEMA_ID="your-private-collection-id" \
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID="your-allowlist-collection-id" \
  NILLION_ANON_ANSWER_SCHEMA_ID="your-anon-collection-id" \
  NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID="your-attribution-collection-id"
```

### 5. Deploy

```bash
fly deploy
```

### 6. Update Cloudflare Worker

Add these secrets to your Cloudflare Worker:

```bash
# In qbase root directory
echo "NILLION_PROXY_URL=https://qbase-nillion-proxy.fly.dev" >> .dev.vars
echo "NILLION_PROXY_SECRET=$PROXY_SECRET" >> .dev.vars

# For production, add via Cloudflare dashboard or:
wrangler secret put NILLION_PROXY_URL
wrangler secret put NILLION_PROXY_SECRET
```

## API Endpoints

All endpoints require `X-Proxy-Secret` header.

### Health Check
```
GET /health
```

### Store Answer
```
POST /v1/answers
{
  "q_id": "uuid",
  "user_id": 123,
  "value": "answer text",
  "answer_type_id": "text",
  "audience": "Private|Anon|Allowlist",
  "primary_type": "identity|recurring|prospective|knowledge|predictive"
}
```

### List Answers
```
GET /v1/answers?q_id=uuid&user_id=123&audience=Private,Anon
```

### Get Answer
```
GET /v1/answers/:id
```

### Create Attribution
```
POST /v1/attributions
{
  "public_id": "uuid",
  "author_id": 123,
  "type": "question|answer"
}
```

### Get Attribution
```
GET /v1/attributions/:public_id
```

## Local Development

```bash
npm install

# Create .env file
cat > .env << EOF
PORT=3000
PROXY_SECRET=dev-secret
NILLION_ORG_KEY=your-key
NILLION_NODES=[...]
NILLION_PRIVATE_ANSWER_SCHEMA_ID=xxx
NILLION_ALLOWLIST_ANSWER_SCHEMA_ID=xxx
NILLION_ANON_ANSWER_SCHEMA_ID=xxx
NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID=xxx
EOF

npm run dev
```

## Monitoring

```bash
# View logs
fly logs

# Check status
fly status

# SSH into container
fly ssh console
```

