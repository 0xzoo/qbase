/**
 * OG Image Generation Routes
 * 
 * Handles:
 * - GET /api/og/quiz/:id - Generate quiz OG image
 * - GET /api/og/ask/:username - Generate user profile OG image
 * - GET /api/og/question/:id - Generate question OG image
 * - GET /api/og/questions - Serve static questions page image
 */

// @ts-nocheck
import { OGService } from '../services/OGService';
import { PointsService } from '../services/PointsService';

type Env = any;

/**
 * Handle OG image generation routes
 */
export async function handleOGRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/api/og/')) {
    return null;
  }

  const type = url.pathname.split('/')[3];
  const id = url.pathname.split('/')[4];

  try {
    // Initialize fonts (cached after first load)
    await OGService.initFonts(env.ASSETS);

    let imageBuffer: Uint8Array;

    if (type === 'quiz') {
      if (!id) return new Response('Missing id', { status: 400 });

      const quiz = await env.DB.prepare('SELECT * FROM quizzes WHERE id = ?').bind(id).first();
      if (!quiz) return new Response('Quiz not found', { status: 404 });

      const creator = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind((quiz as { creator_id: number }).creator_id).first() as { fname?: string } | null;
      const creatorName = creator ? (creator.fname || 'Unknown') : 'Unknown';

      const qCount = 5; // Placeholder

      imageBuffer = OGService.generateQuizImage((quiz as { title: string }).title, creatorName, qCount);
    } else if (type === 'ask') {
      const username = id;
      if (!username) return new Response('Missing username', { status: 400 });

      // Look up user by username to get FID
      const user = await env.DB.prepare(
        'SELECT fid FROM Users WHERE fname = ?'
      ).bind(username).first() as { fid: number } | null;

      if (!user) return new Response('User not found', { status: 404 });

      // Try to get profile from KV first
      let profileStr = await env.KV_USER_PROFILES.get(user.fid.toString());
      let profile: { username: string; displayName: string; pfp_url?: string };

      if (profileStr) {
        profile = JSON.parse(profileStr) as { username: string; displayName: string; pfp_url?: string };
      } else {
        // If not in KV, fetch from Neynar
        try {
          const { NeynarService } = await import('../../src/services/NeynarService');
          const neynarUsers = await NeynarService.fetchBulkUsers([user.fid.toString()], env.NEYNAR_API_KEY);
          const neynarUser = neynarUsers[0];

          if (neynarUser) {
            profile = {
              username: neynarUser.username,
              displayName: neynarUser.display_name,
              pfp_url: neynarUser.pfp_url
            };

            // Cache it for next time
            await env.KV_USER_PROFILES.put(
              user.fid.toString(),
              JSON.stringify(profile),
              { expirationTtl: 86400 } // 24 hours
            );
          } else {
            profile = { username, displayName: username };
          }
        } catch (error) {
          console.error('Error fetching profile from Neynar:', error);
          profile = { username, displayName: username };
        }
      }

      // Get answer count for this user
      const answerCountResult = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM answers WHERE user_id = (SELECT id FROM Users WHERE fname = ?)'
      ).bind(username).first() as { count: number } | null;
      const answerCount = answerCountResult?.count || 0;

      const pointsService = PointsService.fromEnv(env);
      const points = await pointsService.getPoints(user.fid);
      const totalXp = pointsService.getTotalSpendable(points);

      imageBuffer = await OGService.generateProfileImage(profile.username, profile.pfp_url);
    } else if (type === 'question') {
      if (!id) return new Response('Missing id', { status: 400 });

      const question = await env.DB.prepare('SELECT * FROM queries WHERE id = ?').bind(id).first();
      if (!question) return new Response('Question not found', { status: 404 });

      const questionData = question as {
        stem: string;
        coiner_fname?: string;
        coiner_fid?: number;
        coiner_avatar_url?: string;
        template?: boolean | number;
        a_options?: string;
        pub_answers?: number;
        priv_answers?: number;
      };

      // Parse a_options if it exists (stored as JSON string in DB)
      let answerOptions: string[] | undefined;
      if (questionData.a_options) {
        try {
          answerOptions = JSON.parse(questionData.a_options);
        } catch (e) {
          console.error('Failed to parse answer options:', e);
        }
      }

      // Convert template to boolean (could be 0/1 from SQLite)
      const isTemplate = Boolean(questionData.template);

      // Get coiner's PFP - try coiner_avatar_url first, then KV cache, then Neynar
      let pfpUrl = questionData.coiner_avatar_url;
      console.log(`[OG Question] coiner_avatar_url from DB: ${pfpUrl}`);
      console.log(`[OG Question] coiner_fid: ${questionData.coiner_fid}`);

      if (!pfpUrl && questionData.coiner_fid) {
        try {
          // Try KV cache first
          const profileStr = await env.KV_USER_PROFILES.get(questionData.coiner_fid.toString());
          if (profileStr) {
            const profile = JSON.parse(profileStr) as { pfp_url?: string };
            pfpUrl = profile.pfp_url;
            console.log(`[OG Question] Got PFP from KV: ${pfpUrl}`);
          }

          // If still no PFP, fetch from Neynar
          if (!pfpUrl) {
            const { NeynarService } = await import('../../src/services/NeynarService');
            const neynarUsers = await NeynarService.fetchBulkUsers([questionData.coiner_fid.toString()], env.NEYNAR_API_KEY);
            const neynarUser = neynarUsers[0];
            if (neynarUser?.pfp_url) {
              pfpUrl = neynarUser.pfp_url;
              console.log(`[OG Question] Got PFP from Neynar: ${pfpUrl}`);
              // Cache it for next time
              await env.KV_USER_PROFILES.put(
                questionData.coiner_fid.toString(),
                JSON.stringify({
                  username: neynarUser.username,
                  displayName: neynarUser.display_name,
                  pfp_url: neynarUser.pfp_url
                }),
                { expirationTtl: 86400 }
              );
            }
          }
        } catch (e) {
          console.error('Failed to fetch coiner profile:', e);
        }
      }

      // Calculate total answer count
      const answerCount = (questionData.pub_answers || 0) + (questionData.priv_answers || 0);
      console.log(`[OG Question] Final pfpUrl: ${pfpUrl}, answerCount: ${answerCount}`);

      imageBuffer = await OGService.generateQuestionImage(
        questionData.stem,
        questionData.coiner_fname || '4n0n',
        isTemplate,
        answerOptions,
        pfpUrl,
        answerCount
      );
    } else if (type === 'questions') {
      // Serve static image for /questions page
      const imageUrl = new URL('/questions.png', url.origin);
      const imageRequest = new Request(imageUrl.toString());
      const imageResponse = await env.ASSETS.fetch(imageRequest);

      if (!imageResponse.ok) {
        return new Response('Questions image not found', { status: 404 });
      }

      // Return the static image directly
      return new Response(imageResponse.body, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      });
    } else {
      return new Response('Invalid OG type', { status: 400 });
    }

    return new Response(imageBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600'
      }
    });

  } catch (e) {
    console.error('OG Generation Error:', e);
    return new Response('Error generating image', { status: 500 });
  }
}
