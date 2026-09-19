/**
 * POST /api/answers — create a new answer.
 *
 * Routes by audience:
 * - Public: D1 row with the value in plain
 * - Anon: D1 row authored by the anon-bot FID + an anon_attributions row
 * - Private: D1 row with `[encrypted]` placeholder + content sealed to Q in QStorage (SecretStore)
 * - Allowlist: D1 row with placeholder + sealed content in QStorage + allowlist members
 *
 * See the storage strategy and privacy model in README.md.
 */

import { SecretStore } from '../../services/secret/SecretStore';
import { PointsService } from '../../services/PointsService';
import { VectorService } from '../../services/VectorService';
import { EligibilityService } from '../../services/EligibilityService';
import { getPoll } from '../../services/PollService';
import { resolveStickyAudience } from '../../services/AudienceService';
import { anonPlaceholderFid, anonTag, anonTagReady } from '../../services/anon/AnonTag';
import { attributionStatement } from '../../services/AnonAttributionService';
import { getExistingAnswer } from '../../services/AnswerCountService';
import { answer_cost, MAX_A_LENGTH } from '../../../src/lib/consts';
import { sealedAnswerKey, stripAnswerDataContent, type Env, type AnswerRequest } from './shared';

export async function handleCreateAnswer(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as AnswerRequest;

    // Validate required fields
    // user_id is required for Public/Private/Allowlist (injected by auth or client)
    // For Anon, user_id is optional — server substitutes anon_id
    if (!body.q_id || !body.value || !body.audience) {
      return new Response('Missing required fields', { status: 400 });
    }
    if (body.audience !== 'Anon' && !body.user_id) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Input Validation
    // 1. Validate q_id (UUID format)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(body.q_id)) {
      return new Response('Invalid q_id format', { status: 400 });
    }
    if (body.poll_id !== undefined && body.poll_id !== null && !uuidRegex.test(body.poll_id)) {
      return new Response('Invalid poll_id format', { status: 400 });
    }

    // 2. Validate value length
    if (body.value.length > MAX_A_LENGTH) {
      return new Response(`Answer value too long (max ${MAX_A_LENGTH} chars)`, { status: 400 });
    }

    // 3. Validate answer_type_id (integer FK to answer_types table)
    const allowedTypeIds = [1, 2, 3, 4, 5]; // TEXT=1, MC=2, SCALE=3, CHECKBOX=4, DATE=5
    if (body.answer_type_id && !allowedTypeIds.includes(body.answer_type_id)) {
      return new Response('Invalid answer_type_id', { status: 400 });
    }

    // 4. Validate audience
    const allowedAudiences = ['Public', 'Private', 'Anon', 'Allowlist'];
    if (!allowedAudiences.includes(body.audience)) {
      return new Response('Invalid audience', { status: 400 });
    }

    // 5. Validate Allowlist-specific fields
    if (body.audience === 'Allowlist') {
      if (!body.allowlist_id && !body.allowlist) {
        return new Response('Allowlist audience requires either allowlist_id or allowlist field', { status: 400 });
      }
      if (body.allowlist && body.allowlist.length > 100) {
        return new Response('One-off allowlists cannot exceed 100 members', { status: 400 });
      }
    }

    // Determine primary_type / question type and get question owner + cast info.
    // cast_hash falls back to farcaster_casts because question_meta isn't
    // populated for older questions; farcaster_casts is the canonical
    // cross-entity cast index.
    const query = await env.DB.prepare(
      `SELECT json_extract(q.taxonomy, '$.primary_type') as primary_type,
              q.type as query_type,
              q.coiner_fid,
              q.owner_id,
              COALESCE(qm.cast_hash, fc.cast_hash) as cast_hash,
              COALESCE(qm.author_fid, fc.caster_fid) as cast_author_fid
       FROM queries q
       LEFT JOIN question_meta qm ON qm.question_id = q.id
       LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
       WHERE q.id = ?`
    ).bind(body.q_id).first() as {
      primary_type?: string;
      query_type?: string;
      coiner_fid?: number;
      owner_id?: number;
      cast_hash?: string;
      cast_author_fid?: number;
    } | null;

    if (!query) {
      return new Response('Question not found', { status: 404 });
    }

    // ── Wave attribution + gates ──
    // A question is always answerable: a direct answer (no poll_id) never hits
    // eligibility. An answer through a wave must name a wave that belongs to
    // this question and pass the wave's gates (closes_at, eligibility_gate).
    // Anon answers do not bypass the gate: the real FID (body.user_id, injected
    // by the authenticated route) is checked, then the answer is stored anon.
    let pollId: string | null = null;
    if (body.poll_id) {
      const poll = await getPoll(env.DB, body.poll_id);
      if (!poll) {
        return Response.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
      }
      if (poll.question_id !== body.q_id) {
        return Response.json(
          { error: 'Poll does not belong to this question', code: 'poll_mismatch' },
          { status: 400 },
        );
      }
      if (!body.user_id) {
        // Only reachable off the authenticated route — the gate needs a real FID.
        return Response.json(
          { error: 'A Farcaster identity is required to answer this poll', code: 'not_eligible', reason: 'identity_required' },
          { status: 403 },
        );
      }
      const elig = await EligibilityService.check(env, poll, body.user_id);
      if (!elig.eligible) {
        if (elig.reason === 'closed') {
          return Response.json(
            { error: 'Voting has closed for this poll', code: 'poll_closed', closes_at: elig.closesAt },
            { status: 423 }, // Locked
          );
        }
        if (elig.reason === 'not_holder') {
          return Response.json(
            { error: 'You are not eligible to answer this poll', code: 'not_eligible' },
            { status: 403 },
          );
        }
        return Response.json(
          { error: 'Not eligible', code: 'not_eligible', reason: elig.reason },
          { status: 403 },
        );
      }
      pollId = poll.id;
    }

    // ── Sticky audience: a person's first tallied answer in a wave (or on the
    // question directly) decides public vs anon for their later answers
    // there, so a re-answer never links an anon vote to a name. ──
    let audienceKept = false;
    const authorTag = body.user_id && (await anonTagReady(env)) ? await anonTag(env, body.user_id, body.q_id) : null;
    if ((body.audience === 'Public' || body.audience === 'Anon') && body.user_id) {
      const sticky = await resolveStickyAudience(env.DB, body.q_id, body.user_id, pollId, body.audience, authorTag);
      if (sticky.sticky && sticky.audience !== body.audience) {
        console.log(`[Answer Creation] audience kept ${sticky.audience} on ${body.q_id} (requested ${body.audience})`);
        body.audience = sticky.audience;
        audienceKept = true;
      }
    }

    const primary_type = query.primary_type || 'recurring';
    const questionOwnerFid = query.coiner_fid; // FID of the question creator

    // For anon answers, skip user lookup and points — attribution is handled separately
    let answererFid: number | null = null;
    if (body.audience !== 'Anon') {
      // Get answerer's FID from user_id (user_id IS fid after migration)
      const answererRow = await env.DB.prepare(
        'SELECT fid FROM users WHERE fid = ?'
      ).bind(body.user_id).first() as { fid: number } | null;

      if (!answererRow) {
        return new Response('User not found', { status: 404 });
      }

      answererFid = answererRow.fid;

      // Handle points: Deduct from answerer, award to question owner
      const pointsService = PointsService.fromEnv(env);

      // Deduct answer_cost from answerer (deducts from allowance first, then balance)
      const deductResult = await pointsService.deductPoints(
        answererFid,
        answer_cost,
        `answer to question: ${body.q_id.substring(0, 8)}`
      );

      if (!deductResult) {
        // Get current points for error message
        const currentPoints = await pointsService.getPoints(answererFid);
        const totalSpendable = (currentPoints?.allowance || 0) + (currentPoints?.balance || 0);

        return new Response(
          `Insufficient QP. Required: ${answer_cost}, Available: ${totalSpendable}`,
          { status: 402 } // 402 Payment Required
        );
      }

      const { points: updatedPoints } = deductResult;
      console.log(`[Answer Creation] Deducted ${answer_cost} QP from answerer FID ${answererFid}. New state: allowance=${updatedPoints.allowance}, earned=${updatedPoints.earned}, balance=${updatedPoints.balance}`);

      // Award earned points to question owner (if it's not the same person answering their own question)
      if (questionOwnerFid && questionOwnerFid !== answererFid) {
        await pointsService.addEarnedPoints(
          questionOwnerFid,
          answer_cost,
          `earned from answer to question: ${body.q_id.substring(0, 8)}`
        );
        console.log(`[Answer Creation] Awarded ${answer_cost} earned QP to question owner FID ${questionOwnerFid}`);
      } else {
        console.log(`[Answer Creation] No points awarded - answerer is the question owner or owner FID missing`);
      }
    } else {
      console.log(`[Answer Creation] Anon answer — skipping user lookup and points`);
    }

    const answerId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Route based on audience
    try {
      if (body.audience === 'Public') {
        // ── MC append-only: always INSERT, never UPDATE ──
        // Old answers preserved for time-series. Latest row per user is canonical.
        // Only increment pub_answers on first MC answer per user for this question.
        if (body.answer_type_id === 2 && body.user_id) {
          const existing = await getExistingAnswer(env.DB, body.q_id, body.user_id, 2, undefined, authorTag);

          // Insert new MC answer (append-only)
          await env.DB.prepare(
            `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, reasoning, topics, poll_id)
             VALUES (?, ?, ?, ?, ?, ?, 'Public', ?, ?, ?, ?, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            body.value,
            String(body.answer_type_id),
            body.answer_data ? JSON.stringify(body.answer_data) : null,
            now,
            primary_type,
            body.reasoning || null,
            body.topics ? JSON.stringify(body.topics) : null,
            pollId,
          ).run();

          // Seed answer_meta
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO answer_meta
               (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
               VALUES (?, ?, NULL, NULL, ?, 'public', ?, ?, NULL, 1, ?)`
            ).bind(
              answerId,
              body.q_id,
              body.user_id,
              null,
              typeof body.value === 'string' ? body.value.slice(0, 500) : null,
              Date.now(),
            ).run();
          } catch (metaErr) {
            console.error('[MC Append] Failed to seed answer_meta:', metaErr);
          }

          // Only increment pub_answers on first answer
          if (!existing) {
            await env.DB.prepare(
              'UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?'
            ).bind(body.q_id).run();
          }

          return Response.json({
            success: true,
            storage: 'd1',
            answerId,
            updated: false,
            audience: body.audience,
            audience_kept: audienceKept,
          });
        }

        // Store Public answers in D1 (includes primary_type for routing)
        const stmt = env.DB.prepare(
          `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, reasoning, topics, poll_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          answerId,
          body.q_id,
          body.user_id,
          body.value,
          String(body.answer_type_id),
          body.answer_data ? JSON.stringify(body.answer_data) : null,
          body.audience,
          now,
          primary_type,
          body.reasoning || null,
          body.topics ? JSON.stringify(body.topics) : null,
          pollId,
        );

        await stmt.run();

        // ── Dual-write: seed answer_meta for Hypersnap data layer ──
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'public', ?, ?, NULL, 1, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            null, // storage_ref — not used for public answers
            typeof body.value === 'string' ? body.value.slice(0, 500) : null,
            Date.now(),
          ).run();
          console.log(`[DualWrite] Seeded answer_meta for public answer ${answerId}`);

          // ── Enqueue answer cast to Farcaster ──
          // Only text questions cast their answers — MC/scale/checkbox results
          // are tallied inline in the snap UI on the parent cast, so a separate
          // reply would be noise. Same rule applies regardless of submission
          // path (snap, miniapp, web) — keeps Farcaster behavior coherent.
          if (
            query.cast_hash
            && env.ANSWER_CAST_QUEUE
            && query.query_type === 'text'
          ) {
            const castText = typeof body.value === 'string' ? body.value.slice(0, 320) : String(body.value).slice(0, 320);
            await env.ANSWER_CAST_QUEUE.send({
              answerId,
              questionId: body.q_id,
              parentCastHash: query.cast_hash,
              parentAuthorFid: query.cast_author_fid || query.coiner_fid || 0,
              signer: 'anon',
              text: castText,
            });
            console.log(`[AnswerCast] Enqueued cast for answer ${answerId}`);
          }
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Update answer counts
        await env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        // Generate and store answer embedding for semantic search
        // Include question context for better semantic matching
        try {
          const questionRow = await env.DB.prepare(
            'SELECT stem FROM queries WHERE id = ?'
          ).bind(body.q_id).first() as { stem: string } | null;

          if (questionRow) {
            const vectorService = VectorService.fromEnv(env);
            const embeddingText = `Question: ${questionRow.stem} Answer: ${body.value}`;
            const vector = await vectorService.vectorize(embeddingText);

            await vectorService.addVectors([{
              id: answerId,
              values: vector,
              metadata: {
                q_id: body.q_id,
                user_id: body.user_id,
                audience: 'Public',
                answer_type_id: body.answer_type_id,
                created_at: now,
                primary_type,
              }
            }], 'a');

            console.log(`[Answer Embedding] Stored embedding for public answer ${answerId}`);
          }
        } catch (vectorError) {
          // Log but don't fail - embedding is not critical for answer creation
          console.error('[Answer Embedding] Failed to store embedding:', vectorError);
        }

        return Response.json({
          success: true,
          storage: 'd1',
          answerId,
          audience: body.audience,
          audience_kept: audienceKept,
        });

      } else if (body.audience === 'Anon') {
        // Anon answers carry the responder's real FID (like in-feed anon votes)
        // so one-vote-per-person and sticky audience hold; the audience tag is
        // The row carries the @4n0n placeholder, never the author: the only
        // link to the person is the sealed attribution, written in the same
        // batch so an anon row is never left unowned. Off the authenticated
        // route there is no user_id and therefore no attribution.
        const answerId = crypto.randomUUID();
        const anonUserId = anonPlaceholderFid(env);
        const attribution = body.user_id
          ? await attributionStatement(env, { public_id: answerId, fid: body.user_id, type: 'answer', scope_id: body.q_id, created_at: now })
          : null;

        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, poll_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            answerId,
            body.q_id,
            anonUserId,
            body.value,
            String(body.answer_type_id),
            body.answer_data ? JSON.stringify(body.answer_data) : null,
            'Anon',
            now,
            primary_type,
            pollId,
          ),
          env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'anon', NULL, ?, NULL, 0, ?)`
          ).bind(
            answerId,
            body.q_id,
            anonUserId,
            typeof body.value === 'string' ? body.value.slice(0, 500) : null,
            Date.now(),
          ),
          ...(attribution ? [attribution] : []),
        ]);

        try {

          // ── Enqueue anon answer cast to Farcaster (via @4n0n bot) ──
          // Same gate as the Public branch: text questions only,
          // parent must already be cast. Anon answers are publicly
          // visible on qbase, so they should be visible on Farcaster
          // too — and posting from @4n0n preserves the anon attribution
          // (the real author lives only in anon_attributions).
          if (
            query.cast_hash
            && env.ANSWER_CAST_QUEUE
            && query.query_type === 'text'
          ) {
            const castText = typeof body.value === 'string' ? body.value.slice(0, 320) : String(body.value).slice(0, 320);
            await env.ANSWER_CAST_QUEUE.send({
              answerId,
              questionId: body.q_id,
              parentCastHash: query.cast_hash,
              parentAuthorFid: query.cast_author_fid || query.coiner_fid || 0,
              signer: 'anon',
              text: castText,
            });
            console.log(`[AnswerCast] Enqueued anon cast for answer ${answerId}`);
          }
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Update public answer count
        await env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        // Generate and store answer embedding for anonymous answers
        try {
          const questionRow = await env.DB.prepare(
            'SELECT stem FROM queries WHERE id = ?'
          ).bind(body.q_id).first() as { stem: string } | null;

          if (questionRow) {
            const vectorService = VectorService.fromEnv(env);
            const embeddingText = `Question: ${questionRow.stem} Answer: ${body.value}`;
            const vector = await vectorService.vectorize(embeddingText);

            await vectorService.addVectors([{
              id: answerId,
              values: vector,
              metadata: {
                q_id: body.q_id,
                user_id: anonUserId, // the placeholder, never the author
                audience: 'Anon',
                answer_type_id: body.answer_type_id,
                created_at: now,
                primary_type,
              }
            }], 'a');

            console.log(`[Answer Embedding] Stored embedding for anonymous answer ${answerId}`);
          }
        } catch (vectorError) {
          console.error('[Answer Embedding] Failed to store embedding for anon answer:', vectorError);
        }

        return Response.json({
          success: true,
          storage: 'd1',
          answerId,
          audience: 'Anon',
          audience_kept: audienceKept,
        });

      } else {
        // Store Private and Allowlist answers:
        // 1. Metadata in D1 (for querying/listing) — placeholder value, and
        //    only the allowlist keys of answer_data (never the content).
        // 2. The content {value, answer_data, reasoning}, sealed under a key
        //    Q holds, in Q Storage (SecretStore; spec §7.5).
        const storageKey = sealedAnswerKey(body.audience, answerId);
        const answerData = body.allowlist && body.audience === 'Allowlist'
          ? { ...(body.answer_data ?? {}), allowlist: body.allowlist }
          : (body.answer_data ?? null);

        await SecretStore.putJSON(env, storageKey, {
          value: body.value,
          answer_data: answerData,
          reasoning: body.reasoning,
        }, {
          tier: body.audience,
          owner: body.user_id,
          meta: {
            'q-id': body.q_id,
            'user-id': String(body.user_id),
            'audience': body.audience,
            'answer-type-id': String(body.answer_type_id),
          },
        });

        // Store metadata in D1 (value is placeholder, content sealed in Q Storage)
        await env.DB.prepare(
          `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, storage_ref, poll_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          answerId,
          body.q_id,
          body.user_id,
          '[encrypted]', // placeholder - content sealed in Q Storage
          String(body.answer_type_id),
          stripAnswerDataContent(answerData),
          body.audience,
          now,
          primary_type,
          `qstorage:${storageKey}`,
          pollId,
        ).run();

        // ── Dual-write: seed answer_meta for private/allowlist answer ──
        try {
          const privacyTier = body.audience === 'Allowlist' ? 'allowlist' : 'private';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 0, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            privacyTier,
            `qstorage:${storageKey}`,
            Date.now(),
          ).run();
          console.log(`[DualWrite] Seeded answer_meta for ${privacyTier} answer ${answerId}`);
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Handle allowlist storage
        if (body.audience === 'Allowlist') {
          if (body.allowlist_id) {
            // Store reference to named allowlist
            await env.DB.prepare(
              `INSERT OR IGNORE INTO answer_allowlists (answer_id, allowlist_id) VALUES (?, ?)`
            ).bind(answerId, body.allowlist_id).run();
          }
          // One-off allowlist FIDs stored in answer_data
        }

        // Update private answer count
        await env.DB.prepare(
          `UPDATE queries SET priv_answers = priv_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        return Response.json({
          success: true,
          storage: 'qstorage',
          answerId,
          storageRef: `qstorage:${storageKey}`,
        });
      }
    } catch (storageError) {
      // Refund points if answer creation fails - only for non-anon answers
      console.error('[Answer Creation] Failed to store answer:', storageError);
      if (body.audience !== 'Anon' && answererFid) {
        const pointsService = PointsService.fromEnv(env);
        await pointsService.refundPoints(
          answererFid,
          answer_cost,
          0,
          'refund: answer creation failed'
        );
        if (questionOwnerFid && questionOwnerFid !== answererFid) {
          const ownerPoints = await pointsService.getPoints(questionOwnerFid);
          ownerPoints.earned = Math.max(0, ownerPoints.earned - answer_cost);
          await env.KV_USER_POINTS.put(
            questionOwnerFid.toString(),
            JSON.stringify(ownerPoints)
          );
          console.log(`[Answer Creation] Removed ${answer_cost} earned QP from question owner FID ${questionOwnerFid}`);
        }
      }

      throw storageError; // Re-throw to be caught by outer catch
    }

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating answer:', e);
    return new Response(`Error creating answer: ${err.message}`, { status: 500 });
  }
}

