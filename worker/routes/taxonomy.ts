/**
 * Taxonomy Classification Test Routes
 *
 * Handles:
 * - POST /api/test/taxonomy-classification/single - Test single question with latency
 * - POST /api/test/taxonomy-classification - Run taxonomy classification tests
 *
 * NOTE: These are dev-only endpoints (check isDevDomain)
 */

import { AIService } from '../services/AIService';
import { RateLimitService } from '../services/RateLimitService';

type Env = any;

/**
 * Helper function to check if request is from dev domain
 */
function isDevDomain(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'qbase-dev.z00.workers.dev' || hostname === 'localhost';
}

/**
 * Handle taxonomy classification test routes
 */
export async function handleTaxonomyRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // POST /api/test/taxonomy-classification/single - Test single question with latency
  if (pathname === "/api/test/taxonomy-classification/single" && request.method === "POST") {
    // Only allow on dev domain
    if (!isDevDomain(request)) {
      return new Response("Not Found", { status: 404 });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'test:taxonomy-single'); // 30 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    try {
      const { stem, options } = await request.json() as { stem: string; options?: string[] };

      if (!stem) {
        return Response.json({ error: 'stem is required' }, { status: 400 });
      }

      const aiService = AIService.fromEnv(env);
      const startTime = Date.now();
      const result = await aiService.classifyQuestion(stem, options);
      const endTime = Date.now();
      const latencyMs = endTime - startTime;

      return Response.json({
        result,
        latency: {
          ms: latencyMs,
          seconds: (latencyMs / 1000).toFixed(2)
        }
      });
    } catch (error) {
      console.error("Error classifying single question:", error);
      return Response.json(
        { error: 'Failed to classify question', details: String(error) },
        { status: 500 }
      );
    }
  }

  // POST /api/test/taxonomy-classification - Run taxonomy classification tests
  if (pathname === "/api/test/taxonomy-classification" && request.method === "POST") {
    // Only allow on dev domain
    if (!isDevDomain(request)) {
      return new Response("Not Found", { status: 404 });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 20, 60, 'test:taxonomy'); // 20 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    try {
      const aiService = AIService.fromEnv(env);

      // Test cases from test-taxonomy-classification.ts
      const testCases = [
        {
          name: "Identity + Complete + Preference + Low",
          stem: "What's your favorite color?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['preference'],
            sensitivity: 'low',
          }
        },
        {
          name: "Recurring + Complete + Emotional + Medium",
          stem: "How do you feel today?",
          options: undefined,
          expected: {
            primary_type: 'recurring',
            construction_type: 'complete',
            content_tags: ['emotional'],
            sensitivity: 'medium',
            temporal_markers: ['today']
          }
        },
        {
          name: "Prospective + Complete + Behavioral + Medium",
          stem: "What are your plans for 2026?",
          options: undefined,
          expected: {
            primary_type: 'prospective',
            construction_type: 'complete',
            content_tags: ['behavioral'],
            sensitivity: 'medium',
          }
        },
        {
          name: "Identity + Template + Preference + Low",
          stem: "Would you rather:",
          options: ["be rich", "be famous"],
          expected: {
            primary_type: 'identity',
            construction_type: 'template',
            content_tags: ['preference'],
            sensitivity: 'low',
            is_template: true
          }
        },
        {
          name: "Recurring + Template + Preference + Low",
          stem: "Right now, would you prefer:",
          options: ["coffee", "tea"],
          expected: {
            primary_type: 'recurring',
            construction_type: 'template',
            content_tags: ['preference'],
            sensitivity: 'low',
            is_template: true,
            temporal_markers: ['right now']
          }
        },
        {
          name: "Prospective + Complete + Belief + High",
          stem: "How do you think you'll vote in the next election?",
          options: undefined,
          expected: {
            primary_type: 'prospective',
            construction_type: 'complete',
            content_tags: ['belief'],
            sensitivity: 'high',
          }
        },
        {
          name: "Identity + Complete + Belief + High",
          stem: "What is your religious or spiritual orientation?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['belief'],
            sensitivity: 'high',
          }
        },
        {
          name: "Recurring + Complete + Behavioral + Medium",
          stem: "What's your current stress level?",
          options: undefined,
          expected: {
            primary_type: 'recurring',
            construction_type: 'complete',
            content_tags: ['emotional'],
            sensitivity: 'medium',
            temporal_markers: ['current']
          }
        },
        {
          name: "Prospective + Complete + Demographic + Medium",
          stem: "What career will you be in 5 years from now?",
          options: undefined,
          expected: {
            primary_type: 'prospective',
            construction_type: 'complete',
            content_tags: ['demographic'],
            sensitivity: 'medium',
          }
        },
        {
          name: "Identity + Template + Preference + Low (colon detection)",
          stem: "This or that:",
          options: ["cats", "dogs"],
          expected: {
            primary_type: 'identity',
            construction_type: 'template',
            content_tags: ['preference'],
            sensitivity: 'low',
            is_template: true
          }
        },
        {
          name: "Past Question: Specific Historical Event",
          stem: "How did you feel during the COVID-19 lockdown in 2020?",
          options: undefined,
          expected: {
            primary_type: 'identity', // Past memory, not tracking
            construction_type: 'complete',
            content_tags: ['behavioral'],
            sensitivity: 'medium',
          }
        },
        {
          name: "Past Question: Childhood Identity",
          stem: "What were you like as a teenager?",
          options: undefined,
          expected: {
            primary_type: 'identity', // Past self is part of identity
            construction_type: 'complete',
            content_tags: ['behavioral'],
            sensitivity: 'low',
          }
        },
        {
          name: "Past Question: Historical Belief",
          stem: "What was your worldview in 2016?",
          options: undefined,
          expected: {
            primary_type: 'identity', // Fixed past memory
            construction_type: 'complete',
            content_tags: ['belief'],
            sensitivity: 'medium',
          }
        },
        {
          name: "Knowledge + Advice + Complete",
          stem: "What's the best way to learn Rust?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'advice',
            construction_type: 'complete',
            content_tags: [], // Knowledge questions have no content_tags
            sensitivity: 'low',
          }
        },
        {
          name: "Knowledge + Problem + Complete",
          stem: "What are the most interesting open questions in science?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'problem',
            construction_type: 'complete',
            content_tags: [], // Knowledge questions have no content_tags
            sensitivity: 'low',
          }
        },
        {
          name: "Knowledge + Factual + Complete",
          stem: "How does TCP/IP work?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'factual',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'low',
          }
        },
        {
          name: "Knowledge + Discussion + Complete",
          stem: "Is Rust worth learning in 2026?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'discussion',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'low',
          }
        },
        {
          name: "Identity vs Knowledge: YOUR experience",
          stem: "How did YOU learn to code?",
          options: undefined,
          expected: {
            primary_type: 'identity', // About YOUR personal experience
            construction_type: 'complete',
            content_tags: ['behavioral'],
            sensitivity: 'low',
          }
        },
        // Prediction test cases
        {
          name: "Knowledge + Prediction: AI sentience",
          stem: "Will AI become sentient by 2030?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'prediction',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'medium',
          }
        },
        {
          name: "Knowledge + Prediction: Election",
          stem: "Who will win the 2028 US presidential election?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'prediction',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'high',
          }
        },
        {
          name: "Knowledge + Prediction: Crypto",
          stem: "What will Bitcoin be worth in 5 years?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'prediction',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'low',
          }
        },
        // Additional random test cases
        {
          name: "Identity + Preference: Food",
          stem: "What's the best pizza topping?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['preference'],
            sensitivity: 'low',
          }
        },
        {
          name: "Identity + Social: Relationships",
          stem: "What do you value most in a friendship?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['social', 'preference'],
            sensitivity: 'low',
          }
        },
        {
          name: "Identity + Behavioral: Hobbies",
          stem: "What do you do to relax on weekends?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['behavioral'],
            sensitivity: 'low',
          }
        },
        {
          name: "Identity + Hypothetical: Philosophical",
          stem: "If you could live in any era of history, which would you choose?",
          options: undefined,
          expected: {
            primary_type: 'identity',
            construction_type: 'complete',
            content_tags: ['hypothetical', 'preference'],
            sensitivity: 'low',
          }
        },
        {
          name: "Knowledge + Evaluative: Entertainment",
          stem: "How would you rate The Last of Us TV show?",
          options: undefined,
          expected: {
            primary_type: 'knowledge',
            knowledge_subtype: 'evaluative',
            construction_type: 'complete',
            content_tags: [],
            sensitivity: 'low',
          }
        }
      ];

      const results = [];

      for (const testCase of testCases) {
        try {
          const result = await aiService.classifyQuestion(testCase.stem, testCase.options);

          // Validate result
          const errors = [];

          if (result.primary_type !== testCase.expected.primary_type) {
            errors.push(`primary_type: expected ${testCase.expected.primary_type}, got ${result.primary_type}`);
          }

          // Check knowledge_subtype if primary_type is knowledge
          if (result.primary_type === 'knowledge' && testCase.expected.knowledge_subtype) {
            if (result.knowledge_subtype !== testCase.expected.knowledge_subtype) {
              errors.push(`knowledge_subtype: expected ${testCase.expected.knowledge_subtype}, got ${result.knowledge_subtype}`);
            }
          }

          if (result.construction_type !== testCase.expected.construction_type) {
            errors.push(`construction_type: expected ${testCase.expected.construction_type}, got ${result.construction_type}`);
          }

          // Sensitivity is informational only, not validated for pass/fail
          // if (result.sensitivity !== testCase.expected.sensitivity) {
          //   errors.push(`sensitivity: expected ${testCase.expected.sensitivity}, got ${result.sensitivity}`);
          // }

          // Check content_tags (at least one expected tag should be present, unless knowledge question)
          if (result.primary_type === 'knowledge') {
            // Knowledge questions should have empty content_tags
            if (result.content_tags.length > 0) {
              errors.push(`content_tags: knowledge questions should have empty content_tags, got [${result.content_tags.join(', ')}]`);
            }
          } else {
            // Identity/recurring/prospective should have at least one expected tag
            const hasExpectedTag = testCase.expected.content_tags.some((tag: string) =>
              result.content_tags.includes(tag as any)
            );
            if (!hasExpectedTag) {
              errors.push(`content_tags: expected one of [${testCase.expected.content_tags.join(', ')}], got [${result.content_tags.join(', ')}]`);
            }
          }

          // Check is_template if specified
          if (testCase.expected.is_template !== undefined && result.is_template !== testCase.expected.is_template) {
            errors.push(`is_template: expected ${testCase.expected.is_template}, got ${result.is_template}`);
          }

          // Temporal markers are informational only, not validated for pass/fail
          // if (testCase.expected.temporal_markers) {
          //   if (!result.temporal_markers || result.temporal_markers.length === 0) {
          //     errors.push(`temporal_markers: expected markers, got none`);
          //   }
          // }

          // For exploratory tests with 'unknown' expected type, don't validate primary_type
          const isExploratory = testCase.expected.primary_type === 'unknown';
          const finalErrors = isExploratory
            ? errors.filter(e => !e.startsWith('primary_type:'))
            : errors;
          results.push({
            name: testCase.name,
            stem: testCase.stem,
            options: testCase.options,
            result,
            expected: testCase.expected,
            passed: finalErrors.length === 0,
            errors: finalErrors
          });
        } catch (error) {
          results.push({
            name: testCase.name,
            stem: testCase.stem,
            options: testCase.options,
            passed: false,
            errors: [String(error)]
          });
        }
      }

      const passed = results.filter(r => r.passed).length;
      const failed = results.filter(r => !r.passed).length;

      return Response.json({
        summary: {
          total: results.length,
          passed,
          failed,
          passRate: (passed / results.length * 100).toFixed(1)
        },
        results
      });
    } catch (error) {
      console.error("Error running taxonomy classification tests:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return null;
}
